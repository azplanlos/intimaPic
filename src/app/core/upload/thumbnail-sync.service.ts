import { Injectable, inject, signal } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { ThumbnailService } from './thumbnail.service';
import { HeicConverterService } from './heic-converter.service';
import { AlbumService, type Album } from '../album/album.service';
import { VaultService } from '../vault/vault.service';
import { SwClientService } from '../sw-client/sw-client.service';

export interface ThumbnailSyncProgress {
  /** Total files that need thumbnails */
  total: number;
  /** Files processed so far */
  processed: number;
  /** Currently processing file name */
  currentFile: string;
  /** Whether sync is running */
  running: boolean;
}

/** IntimaPic thumbnail storage paths */
const INTIMAPIC_META_ROOT = '_intimapic';
const THUMBS_DIR = `${INTIMAPIC_META_ROOT}/thumbs`;

/**
 * Service that synchronises thumbnails for photos in all album directories.
 *
 * On vault open:
 * 1. Scans all album directories (and root) for .c9r photo files
 * 2. Checks whether corresponding thumbnail files exist in _intimapic/thumbs/
 * 3. For any missing thumbnails: decrypts the original, generates grid+preview, encrypts and uploads
 *
 * All storage operations now go through the ServiceWorker via SwClientService.
 * This ensures thumbnails fetched during sync are also cached in the SW's IndexedDB.
 */
@Injectable({ providedIn: 'root' })
export class ThumbnailSyncService {
  private readonly crypto = inject(CryptoService);
  private readonly thumbnailService = inject(ThumbnailService);
  private readonly heicConverter = inject(HeicConverterService);
  private readonly albumService = inject(AlbumService);
  private readonly vaultService = inject(VaultService);
  private readonly swClient = inject(SwClientService);

  private readonly _progress = signal<ThumbnailSyncProgress>({
    total: 0,
    processed: 0,
    currentFile: '',
    running: false,
  });
  readonly progress = this._progress.asReadonly();

  private readonly IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif', '.bmp'];

  /**
   * Run thumbnail sync for all albums + root directory.
   * Finds photos without thumbnails and generates them.
   */
  async syncAll(): Promise<void> {
    if (this._progress().running) return;

    this._progress.set({ total: 0, processed: 0, currentFile: '', running: true });

    try {
      // Load all albums via SW
      const albums = await this.albumService.loadAlbums();

      // Sync root directory (directoryId = '')
      await this.syncDirectory('', '_root');

      // Sync each album
      for (const album of albums) {
        await this.syncDirectory(album.directoryId, album.directoryId);
      }
    } catch (err) {
      console.error('[ThumbnailSync] Error during sync:', err);
    } finally {
      this._progress.update(p => ({ ...p, running: false }));
    }
  }

  /**
   * Sync thumbnails for a single directory (album or root).
   * Uses a single listFiles call on the thumbs directory to batch-check
   * which thumbnails already exist (instead of one fileExists per photo).
   */
  async syncDirectory(directoryId: string, thumbDirKey: string): Promise<void> {
    // Use SW to list photos (already decrypted names)
    let photos: Array<{ encryptedName: string; name: string; storagePath: string; size: number }>;
    try {
      const result = await this.swClient.listPhotos(directoryId);
      photos = result.photos;
    } catch {
      // Directory might not exist yet or offline
      return;
    }

    if (photos.length === 0) return;

    // Batch-check: List existing thumbnails in one request instead of N fileExists calls
    const thumbDir = `${THUMBS_DIR}/${thumbDirKey}`;
    let existingThumbs: Set<string>;
    try {
      existingThumbs = await this.listThumbDirectory(thumbDir);
    } catch {
      // Directory doesn't exist yet – all thumbs are missing
      existingThumbs = new Set();
    }

    // Determine which photos are missing thumbnails
    const missingThumbs: Array<{ encryptedName: string; name: string; storagePath: string }> = [];

    for (const photo of photos) {
      const baseName = photo.encryptedName.slice(0, -4); // strip .c9r
      const gridFileName = `${baseName}.grid`;

      if (!existingThumbs.has(gridFileName)) {
        if (this.isImageFile(photo.name)) {
          missingThumbs.push(photo);
        }
      }
    }

    if (missingThumbs.length === 0) return;

    this._progress.update(p => ({
      ...p,
      total: p.total + missingThumbs.length,
    }));

    // Generate thumbnails for each missing photo
    for (const photo of missingThumbs) {
      try {
        this._progress.update(p => ({ ...p, currentFile: photo.name }));

        await this.generateAndUploadThumbnails(photo, thumbDir);
      } catch (err) {
        console.warn(`[ThumbnailSync] Failed to generate thumbnail for ${photo.encryptedName}:`, err);
      } finally {
        this._progress.update(p => ({ ...p, processed: p.processed + 1 }));
      }
    }
  }

  /**
   * List all files in a thumbnail directory (single request via StorageAdapter).
   * Returns a Set of filenames for O(1) lookup.
   */
  private async listThumbDirectory(thumbDir: string): Promise<Set<string>> {
    const storage = this.vaultService.getStorage();
    const entries = await storage.listFiles(thumbDir);
    return new Set(entries.map(e => e.encryptedName));
  }

  /**
   * Decrypt original photo, generate grid+preview thumbnails, encrypt and upload.
   */
  private async generateAndUploadThumbnails(
    photo: { encryptedName: string; name: string; storagePath: string },
    thumbDir: string
  ): Promise<void> {
    // Read and decrypt the original photo via SW
    const encryptedData = await this.swClient.getFile(photo.storagePath);
    const decryptedData = await this.crypto.decryptFile(encryptedData);

    // Determine the correct MIME type
    const mimeType = this.getMimeType(photo.name);

    // Create a Blob from the decrypted data
    let blob: Blob = new Blob([decryptedData], { type: mimeType });

    // Convert HEIC to JPEG if needed (for browsers without native HEIC support)
    blob = await this.heicConverter.ensureDisplayable(blob, photo.name);

    // Generate both thumbnail sizes
    const thumbs = await this.thumbnailService.generateAll(blob);

    // Encrypt thumbnails
    const encryptedGrid = await this.crypto.encryptFile(thumbs.grid.data);
    const encryptedPreview = await this.crypto.encryptFile(thumbs.preview.data);

    // Ensure thumbnail directory exists
    await this.ensureThumbDirectory(thumbDir);

    // Upload thumbnails via SW
    const baseName = photo.encryptedName.slice(0, -4); // strip .c9r
    await this.swClient.writeFile(`${thumbDir}/${baseName}.grid`, encryptedGrid);
    await this.swClient.writeFile(`${thumbDir}/${baseName}.preview`, encryptedPreview);
  }

  /**
   * Ensure the thumbnail directory hierarchy exists.
   */
  private async ensureThumbDirectory(thumbDir: string): Promise<void> {
    const segments = thumbDir.split('/');
    let path = '';
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      try {
        await this.swClient.createFolder(path);
      } catch {
        /* may already exist */
      }
    }
  }

  private isImageFile(name: string): boolean {
    const lower = name.toLowerCase();
    return this.IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
  }

  private getMimeType(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic';
    if (lower.endsWith('.bmp')) return 'image/bmp';
    return 'image/jpeg';
  }
}
