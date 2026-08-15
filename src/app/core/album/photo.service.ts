import { Injectable, inject } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import { SwClientService, SwError } from '../sw-client/sw-client.service';
import { BlobLruCache } from './lru-cache';
import { HeicConverterService } from '../upload/heic-converter.service';
import { isImageFile, getMimeType } from '../image-types';
import type { ThumbnailSize } from '../upload/thumbnail.service';

export interface PhotoItem {
  /** Encrypted filename as stored */
  encryptedName: string;
  /** Decrypted original filename */
  name: string;
  /** Full storage path to the encrypted original file */
  storagePath: string;
  /** Blob URL for the decrypted grid thumbnail */
  thumbnailUrl: string | null;
  /** Blob URL for the decrypted FullHD preview */
  previewUrl: string | null;
  /** Blob URL for the decrypted full-res original (set on demand for download) */
  fullResUrl: string | null;
  /** Whether thumbnail is currently being decrypted */
  loading: boolean;
  /** File size in bytes (of the encrypted original) */
  size: number;
}

/**
 * Service to list and decrypt photos within an album.
 *
 * Uses the ServiceWorker when available for cached/network access.
 * Falls back to direct StorageAdapter access when SW is not ready
 * (first visit, no token, keys not transferred yet).
 *
 * Supports three resolution tiers:
 * - grid: small thumbnail for gallery view (~300px)
 * - preview: FullHD image for lightbox/fullscreen (1920px)
 * - original: full-resolution file for download
 */
@Injectable({ providedIn: 'root' })
export class PhotoService {
  private readonly crypto = inject(CryptoService);
  private readonly vaultService = inject(VaultService);
  private readonly swClient = inject(SwClientService);
  private readonly heicConverter = inject(HeicConverterService);

  /** LRU cache for decrypted thumbnail blob URLs (max 80 items ~ 80 * 50KB = ~4MB) */
  private readonly thumbnailCache = new BlobLruCache(80);
  /** LRU cache for decrypted full-res blob URLs (max 5 items ~ 5 * 5MB = ~25MB) */
  private readonly fullResCache = new BlobLruCache(5);

  /**
   * List all photos in an album (by directory ID).
   * Falls back to direct storage when SW is unavailable.
   */
  async listPhotos(directoryId: string, forceRefresh = false): Promise<PhotoItem[]> {
    try {
      const { photos: entries } = await this.swClient.listPhotos(directoryId, forceRefresh);

      return entries.map(entry => ({
        encryptedName: entry.encryptedName,
        name: entry.name,
        storagePath: entry.storagePath,
        thumbnailUrl: this.thumbnailCache.get(`grid:${entry.encryptedName}`) || null,
        previewUrl: this.thumbnailCache.get(`preview:${entry.encryptedName}`) || null,
        fullResUrl: this.fullResCache.get(`full:${entry.encryptedName}`) || null,
        loading: false,
        size: entry.size,
      }));
    } catch (err) {
      if (err instanceof SwError) {
        return this.listPhotosDirect(directoryId);
      }
      throw err;
    }
  }

  /**
   * Fallback: List photos directly via storage adapter.
   */
  private async listPhotosDirect(directoryId: string): Promise<PhotoItem[]> {
    const storage = this.vaultService.getStorage();
    const dirPath = await this.crypto.encryptDirectoryId(directoryId);
    const entries = await storage.listFiles(dirPath);

    const photos: PhotoItem[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory && entry.encryptedName.endsWith('.c9r')) {
        try {
          const name = await this.crypto.decryptFilename(entry.encryptedName, directoryId);
          if (isImageFile(name)) {
            photos.push({
              encryptedName: entry.encryptedName,
              name,
              storagePath: `${dirPath}/${entry.encryptedName}`,
              thumbnailUrl: this.thumbnailCache.get(`grid:${entry.encryptedName}`) || null,
              previewUrl: this.thumbnailCache.get(`preview:${entry.encryptedName}`) || null,
              fullResUrl: this.fullResCache.get(`full:${entry.encryptedName}`) || null,
              loading: false,
              size: entry.size,
            });
          }
        } catch {
          continue;
        }
      }
    }

    return photos;
  }

  /**
   * Decrypt a thumbnail (grid or preview size).
   * Falls back to direct storage when SW is unavailable.
   */
  async decryptThumbnail(photo: PhotoItem, directoryId: string, size: ThumbnailSize = 'grid', signal?: AbortSignal): Promise<string> {
    const cacheKey = `${size}:${photo.encryptedName}`;
    const cached = this.thumbnailCache.get(cacheKey);
    if (cached) return cached;

    try {
      const { data: encryptedData } = await this.swClient.getThumbnail(
        photo.encryptedName,
        directoryId,
        size
      );

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const decryptedData = await this.crypto.decryptFile(encryptedData);
      const blob = new Blob([decryptedData], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      this.thumbnailCache.set(cacheKey, url);
      return url;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }

      // Only fall back to direct storage for unrecoverable SW errors.
      // TOKEN_EXPIRED and NEED_KEYS are handled internally by sendCommand
      // (auto-refresh/re-transfer + retry). If we reach here with those codes,
      // the retry already failed – fall back to direct.
      if (err instanceof SwError && err.code === 'SW_NOT_READY') {
        return this.decryptThumbnailDirect(photo, directoryId, size, signal);
      }

      // FILE_NOT_FOUND: thumbnail doesn't exist in storage
      if (err instanceof SwError && err.code === 'FILE_NOT_FOUND') {
        return this.decryptThumbnailDirect(photo, directoryId, size, signal);
      }

      // Other SW errors (TOKEN_EXPIRED after retry failed, OFFLINE, etc.)
      if (err instanceof SwError) {
        return this.decryptThumbnailDirect(photo, directoryId, size, signal);
      }

      throw err;
    }
  }

  /**
   * Fallback: Load and decrypt thumbnail directly via storage adapter.
   */
  private async decryptThumbnailDirect(photo: PhotoItem, directoryId: string, size: ThumbnailSize, signal?: AbortSignal): Promise<string> {
    const cacheKey = `${size}:${photo.encryptedName}`;
    const storage = this.vaultService.getStorage();
    const thumbDirId = directoryId || '_root';
    const baseName = photo.encryptedName.slice(0, -4);
    const thumbPath = `_intimapic/thumbs/${thumbDirId}/${baseName}.${size}`;

    try {
      const encryptedData = await storage.readFile(thumbPath, signal);
      const decryptedData = await this.crypto.decryptFile(encryptedData);
      const blob = new Blob([decryptedData], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      this.thumbnailCache.set(cacheKey, url);
      return url;
    } catch (innerErr) {
      if (innerErr instanceof DOMException && innerErr.name === 'AbortError') {
        throw innerErr;
      }
      // Thumbnail doesn't exist → fall back to original
      return this.decryptOriginal(photo, signal);
    }
  }

  /**
   * Decrypt the FullHD preview for lightbox display.
   */
  async decryptPreview(photo: PhotoItem, directoryId: string, signal?: AbortSignal): Promise<string> {
    return this.decryptThumbnail(photo, directoryId, 'preview', signal);
  }

  /**
   * Decrypt the original full-resolution file.
   * Falls back to direct storage when SW is unavailable.
   */
  async decryptOriginal(photo: PhotoItem, signal?: AbortSignal): Promise<string> {
    const cacheKey = `full:${photo.encryptedName}`;
    const cached = this.fullResCache.get(cacheKey);
    if (cached) return cached;

    let encryptedData: ArrayBuffer;

    try {
      encryptedData = await this.swClient.getFile(photo.storagePath);
    } catch (err) {
      if (err instanceof SwError) {
        const storage = this.vaultService.getStorage();
        encryptedData = await storage.readFile(photo.storagePath, signal);
      } else {
        throw err;
      }
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const decryptedData = await this.crypto.decryptFile(encryptedData);

    const mimeType = getMimeType(photo.name);
    let blob = new Blob([decryptedData], { type: mimeType });

    blob = await this.heicConverter.ensureDisplayable(blob, photo.name);

    const url = URL.createObjectURL(blob);
    this.fullResCache.set(cacheKey, url);
    return url;
  }

  /**
   * Decrypt the original and trigger a browser download.
   */
  async downloadOriginal(photo: PhotoItem): Promise<void> {
    const url = await this.decryptOriginal(photo);

    const a = document.createElement('a');
    a.href = url;
    a.download = photo.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /**
   * Delete a photo from an album.
   * Removes the encrypted original, its thumbnails (grid + preview), and clears caches.
   */
  async deletePhoto(photo: PhotoItem, directoryId: string): Promise<void> {
    // 1. Delete the encrypted original file
    await this.swClient.deleteFile(photo.storagePath);

    // 2. Delete thumbnails (best-effort, they may not exist)
    const baseName = photo.encryptedName.slice(0, -4); // Remove .c9r suffix
    const thumbDirId = directoryId || '_root';
    const gridThumbPath = `_intimapic/thumbs/${thumbDirId}/${baseName}.grid`;
    const previewThumbPath = `_intimapic/thumbs/${thumbDirId}/${baseName}.preview`;

    try { await this.swClient.deleteFile(gridThumbPath); } catch { /* thumbnail may not exist */ }
    try { await this.swClient.deleteFile(previewThumbPath); } catch { /* thumbnail may not exist */ }

    // 3. Clear cached blob URLs for this photo
    this.thumbnailCache.delete(`grid:${photo.encryptedName}`);
    this.thumbnailCache.delete(`preview:${photo.encryptedName}`);
    this.fullResCache.delete(`full:${photo.encryptedName}`);

    // 4. Invalidate directory cache so next listing is fresh
    await this.swClient.invalidateCache('directory', directoryId).catch(() => {});
  }

  /**
   * Move a photo from one album to another.
   * Reads the encrypted file, re-encrypts the filename for the target directory,
   * writes the file to the new location, copies thumbnails, and deletes the originals.
   *
   * @returns The new PhotoItem in the target album.
   */
  async movePhoto(photo: PhotoItem, sourceDirectoryId: string, targetDirectoryId: string): Promise<PhotoItem> {
    // 1. Read the encrypted original file data
    let encryptedData: ArrayBuffer;
    try {
      encryptedData = await this.swClient.getFile(photo.storagePath);
    } catch (err) {
      if (err instanceof SwError) {
        const storage = this.vaultService.getStorage();
        encryptedData = await storage.readFile(photo.storagePath);
      } else {
        throw err;
      }
    }

    // 2. Encrypt the filename for the target directory
    const newEncryptedName = await this.crypto.encryptFilename(photo.name, targetDirectoryId);

    // 3. Compute the target storage path
    const targetDirPath = await this.crypto.encryptDirectoryId(targetDirectoryId);
    const newStoragePath = `${targetDirPath}/${newEncryptedName}`;

    // 4. Write the file to the target directory
    await this.swClient.writeFile(newStoragePath, encryptedData);

    // 5. Copy thumbnails to target (best-effort)
    const sourceBaseName = photo.encryptedName.slice(0, -4);
    const targetBaseName = newEncryptedName.slice(0, -4);
    const sourceThumbDir = sourceDirectoryId || '_root';
    const targetThumbDir = targetDirectoryId || '_root';

    for (const size of ['grid', 'preview'] as const) {
      try {
        const thumbData = await this.swClient.getFile(`_intimapic/thumbs/${sourceThumbDir}/${sourceBaseName}.${size}`);
        await this.swClient.writeFile(`_intimapic/thumbs/${targetThumbDir}/${targetBaseName}.${size}`, thumbData);
      } catch { /* thumbnail may not exist */ }
    }

    // 6. Delete the original file and thumbnails from source
    await this.deletePhoto(photo, sourceDirectoryId);

    // 7. Invalidate target directory cache
    await this.swClient.invalidateCache('directory', targetDirectoryId).catch(() => {});

    // 8. Return the new PhotoItem
    return {
      encryptedName: newEncryptedName,
      name: photo.name,
      storagePath: newStoragePath,
      thumbnailUrl: null,
      previewUrl: null,
      fullResUrl: null,
      loading: false,
      size: photo.size,
    };
  }

  /**
   * Legacy compatibility: decrypt a photo (returns full-res blob URL).
   */
  async decryptPhoto(photo: PhotoItem): Promise<string> {
    return this.decryptOriginal(photo);
  }

  /**
   * Revoke all cached blob URLs (call on vault lock).
   */
  clearCache(): void {
    this.thumbnailCache.clear();
    this.fullResCache.clear();
  }

  /**
   * Clear only full-res cache (call on navigating away from album view).
   */
  clearFullResCache(): void {
    this.fullResCache.clear();
  }
}
