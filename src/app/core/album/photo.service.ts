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
 * Listing is delegated to the ServiceWorker (cached directory listings +
 * filename decryption). Thumbnail/original fetching goes through the SW
 * for encrypted cache access, then decryption happens locally in the
 * main thread via CryptoService.
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
   * Uses the ServiceWorker for cached/network directory listing + filename decryption.
   * Falls back to direct storage access if SW is unavailable.
   * Returns items with decrypted names and existing in-memory blob URLs.
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
      // Fall back to direct storage when SW is unavailable
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
   *
   * Flow:
   * 1. Check in-memory LRU cache (decrypted blob URL)
   * 2. Request encrypted thumbnail from SW (SW checks its IndexedDB cache, then network)
   * 3. Decrypt locally via CryptoService
   * 4. Create blob URL and cache in memory
   *
   * Falls back to decrypting the original if thumbnail file doesn't exist.
   */
  async decryptThumbnail(photo: PhotoItem, directoryId: string, size: ThumbnailSize = 'grid', signal?: AbortSignal): Promise<string> {
    const cacheKey = `${size}:${photo.encryptedName}`;
    const cached = this.thumbnailCache.get(cacheKey);
    if (cached) return cached;

    try {
      // Request encrypted thumbnail from SW (may come from IndexedDB cache or network)
      const { data: encryptedData } = await this.swClient.getThumbnail(
        photo.encryptedName,
        directoryId,
        size
      );

      // Check abort before expensive decrypt
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Decrypt locally
      const decryptedData = await this.crypto.decryptFile(encryptedData);

      const blob = new Blob([decryptedData], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);

      this.thumbnailCache.set(cacheKey, url);
      return url;
    } catch (err) {
      // Re-throw abort errors
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }

      // SW not ready or thumbnail not found → fall back to direct storage
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
   * Used for download or as fallback when thumbnails aren't available.
   *
   * Flow:
   * 1. Check in-memory LRU cache
   * 2. Request encrypted original from SW (always network, not cached by SW)
   * 3. Decrypt locally
   * 4. HEIC conversion if needed
   * 5. Create blob URL and cache in memory
   */
  async decryptOriginal(photo: PhotoItem, signal?: AbortSignal): Promise<string> {
    const cacheKey = `full:${photo.encryptedName}`;
    const cached = this.fullResCache.get(cacheKey);
    if (cached) return cached;

    let encryptedData: ArrayBuffer;

    try {
      // Try via SW first (benefits from throttling, error handling)
      encryptedData = await this.swClient.getFile(photo.storagePath);
    } catch (err) {
      // SW not ready → fall back to direct storage
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

    // Convert HEIC to JPEG for browsers without native HEIC support
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
