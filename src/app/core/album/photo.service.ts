import { Injectable, inject } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import { BlobLruCache } from './lru-cache';
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

/** IntimaPic metadata storage paths
 *  NOTE: Underscore prefix instead of dot – iCloud Drive won't sync dot-prefixed folders. */
const THUMBS_DIR = '_intimapic/thumbs';

/**
 * Service to list and decrypt photos within an album.
 * Supports three resolution tiers:
 * - grid: small thumbnail for gallery view (~300px)
 * - preview: FullHD image for lightbox/fullscreen (1920px)
 * - original: full-resolution file for download
 */
@Injectable({ providedIn: 'root' })
export class PhotoService {
  private readonly crypto = inject(CryptoService);
  private readonly vaultService = inject(VaultService);

  /** LRU cache for thumbnails (max 80 items ~ 80 * 50KB = ~4MB) */
  private readonly thumbnailCache = new BlobLruCache(80);
  /** LRU cache for full-res images (max 5 items ~ 5 * 5MB = ~25MB) */
  private readonly fullResCache = new BlobLruCache(5);

  /**
   * List all photos in an album (by directory ID).
   * Returns items with encrypted names resolved to cleartext.
   */
  async listPhotos(directoryId: string): Promise<PhotoItem[]> {
    const storage = this.vaultService.getStorage();
    const dirPath = await this.crypto.encryptDirectoryId(directoryId);
    const entries = await storage.listFiles(dirPath);

    const photos: PhotoItem[] = [];

    for (const entry of entries) {
      // Only process .c9r files (not directories)
      if (!entry.isDirectory && entry.encryptedName.endsWith('.c9r')) {
        try {
          const name = await this.crypto.decryptFilename(entry.encryptedName, directoryId);
          // Only include image files
          if (this.isImageFile(name)) {
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
          // Skip files we can't decrypt
          continue;
        }
      }
    }

    return photos;
  }

  /**
   * Decrypt a thumbnail (grid or preview size).
   * Reads from _intimapic/thumbs/<directoryId>/<baseName>.<size>
   * Falls back to decrypting the original if thumbnail file doesn't exist.
   */
  async decryptThumbnail(photo: PhotoItem, directoryId: string, size: ThumbnailSize = 'grid', signal?: AbortSignal): Promise<string> {
    const cacheKey = `${size}:${photo.encryptedName}`;
    const cached = this.thumbnailCache.get(cacheKey);
    if (cached) return cached;

    const storage = this.vaultService.getStorage();
    const thumbDirId = directoryId || '_root';
    const baseName = photo.encryptedName.slice(0, -4); // strip .c9r
    const thumbPath = `${THUMBS_DIR}/${thumbDirId}/${baseName}.${size}`;

    try {
      const encryptedData = await storage.readFile(thumbPath, signal);
      const decryptedData = await this.crypto.decryptFile(encryptedData);

      const blob = new Blob([decryptedData], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);

      this.thumbnailCache.set(cacheKey, url);
      return url;
    } catch (err) {
      // Re-throw abort errors so callers can handle cancellation
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Thumbnail file doesn't exist (legacy upload or sync issue).
      // Fall back to decrypting the original.
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
   */
  async decryptOriginal(photo: PhotoItem, signal?: AbortSignal): Promise<string> {
    const cacheKey = `full:${photo.encryptedName}`;
    const cached = this.fullResCache.get(cacheKey);
    if (cached) return cached;

    const storage = this.vaultService.getStorage();
    const encryptedData = await storage.readFile(photo.storagePath, signal);
    const decryptedData = await this.crypto.decryptFile(encryptedData);

    const mimeType = this.getMimeType(photo.name);
    const blob = new Blob([decryptedData], { type: mimeType });
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

  private isImageFile(name: string): boolean {
    const lower = name.toLowerCase();
    return (
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.png') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.heic') ||
      lower.endsWith('.gif') ||
      lower.endsWith('.bmp')
    );
  }

  private getMimeType(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.heic')) return 'image/heic';
    if (lower.endsWith('.bmp')) return 'image/bmp';
    return 'image/jpeg';
  }
}
