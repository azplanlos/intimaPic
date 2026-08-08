import { Injectable, inject, signal } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { ThumbnailService } from './thumbnail.service';
import { VaultService } from '../vault/vault.service';
import { AlbumService, type Album } from '../album/album.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import type { FileEntry } from '../crypto/crypto.models';

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
 * This ensures photos added externally (e.g. via iOS Shortcuts + Cryptomator)
 * always have thumbnails available in the gallery.
 */
@Injectable({ providedIn: 'root' })
export class ThumbnailSyncService {
  private readonly crypto = inject(CryptoService);
  private readonly thumbnailService = inject(ThumbnailService);
  private readonly vaultService = inject(VaultService);
  private readonly albumService = inject(AlbumService);

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
      const storage = this.vaultService.getStorage();

      // Load all albums
      const albums = await this.albumService.loadAlbums();

      // Sync root directory (directoryId = '')
      await this.syncDirectory(storage, '', '_root');

      // Sync each album
      for (const album of albums) {
        await this.syncDirectory(storage, album.directoryId, album.directoryId);
      }
    } catch (err) {
      console.error('[ThumbnailSync] Error during sync:', err);
    } finally {
      this._progress.update(p => ({ ...p, running: false }));
    }
  }

  /**
   * Sync thumbnails for a single directory (album or root).
   * @param storage - The active storage adapter
   * @param directoryId - Cryptomator directory ID (empty string for root)
   * @param thumbDirKey - Key used in _intimapic/thumbs/ (directoryId or '_root')
   */
  async syncDirectory(
    storage: StorageAdapter,
    directoryId: string,
    thumbDirKey: string
  ): Promise<void> {
    const dirPath = await this.crypto.encryptDirectoryId(directoryId);

    // List all files in this album directory
    let entries: FileEntry[];
    try {
      entries = await storage.listFiles(dirPath);
    } catch {
      // Directory might not exist yet
      return;
    }

    // Filter to photo .c9r files (not directories)
    const photoEntries = entries.filter(
      e => !e.isDirectory && e.encryptedName.endsWith('.c9r')
    );

    // Determine which photos are missing thumbnails
    const thumbDir = `${THUMBS_DIR}/${thumbDirKey}`;
    const missingThumbs: FileEntry[] = [];

    for (const entry of photoEntries) {
      const baseName = entry.encryptedName.slice(0, -4); // strip .c9r
      const gridPath = `${thumbDir}/${baseName}.grid`;

      const exists = await this.thumbnailExists(storage, gridPath);
      if (!exists) {
        // Verify it's actually an image by decrypting the name
        try {
          const decryptedName = await this.crypto.decryptFilename(
            entry.encryptedName,
            directoryId
          );
          if (this.isImageFile(decryptedName)) {
            missingThumbs.push(entry);
          }
        } catch {
          // Can't decrypt = skip
          continue;
        }
      }
    }

    if (missingThumbs.length === 0) return;

    this._progress.update(p => ({
      ...p,
      total: p.total + missingThumbs.length,
    }));

    // Generate thumbnails for each missing photo
    for (const entry of missingThumbs) {
      try {
        const decryptedName = await this.crypto.decryptFilename(
          entry.encryptedName,
          directoryId
        );
        this._progress.update(p => ({ ...p, currentFile: decryptedName }));

        await this.generateAndUploadThumbnails(
          storage,
          entry,
          dirPath,
          thumbDir
        );
      } catch (err) {
        console.warn(`[ThumbnailSync] Failed to generate thumbnail for ${entry.encryptedName}:`, err);
      } finally {
        this._progress.update(p => ({ ...p, processed: p.processed + 1 }));
      }
    }
  }

  /**
   * Decrypt original photo, generate grid+preview thumbnails, encrypt and upload.
   */
  private async generateAndUploadThumbnails(
    storage: StorageAdapter,
    entry: FileEntry,
    dirPath: string,
    thumbDir: string
  ): Promise<void> {
    // Read and decrypt the original photo
    const filePath = `${dirPath}/${entry.encryptedName}`;
    const encryptedData = await storage.readFile(filePath);
    const decryptedData = await this.crypto.decryptFile(encryptedData);

    // Create a Blob from the decrypted data for thumbnail generation
    const blob = new Blob([decryptedData], { type: 'image/jpeg' });

    // Generate both thumbnail sizes
    const thumbs = await this.thumbnailService.generateAll(blob);

    // Encrypt thumbnails
    const encryptedGrid = await this.crypto.encryptFile(thumbs.grid.data);
    const encryptedPreview = await this.crypto.encryptFile(thumbs.preview.data);

    // Ensure thumbnail directory exists
    await this.ensureThumbDirectory(storage, thumbDir);

    // Upload thumbnails
    const baseName = entry.encryptedName.slice(0, -4); // strip .c9r
    await storage.writeFile(`${thumbDir}/${baseName}.grid`, encryptedGrid);
    await storage.writeFile(`${thumbDir}/${baseName}.preview`, encryptedPreview);
  }

  /**
   * Check if a thumbnail file exists in storage.
   */
  private async thumbnailExists(storage: StorageAdapter, path: string): Promise<boolean> {
    try {
      return await storage.fileExists(path);
    } catch {
      return false;
    }
  }

  /**
   * Ensure the thumbnail directory hierarchy exists.
   */
  private async ensureThumbDirectory(storage: StorageAdapter, thumbDir: string): Promise<void> {
    const segments = thumbDir.split('/');
    let path = '';
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      try {
        await storage.createFolder(path);
      } catch {
        /* may already exist */
      }
    }
  }

  private isImageFile(name: string): boolean {
    const lower = name.toLowerCase();
    return this.IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
  }
}
