import { Injectable, inject, signal } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { ThumbnailService } from './thumbnail.service';
import { UploadQueueService } from './upload-queue.service';
import { VaultService } from '../vault/vault.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';

export interface UploadProgress {
  id: string;
  fileName: string;
  step: 'queued' | 'thumbnail' | 'encrypting' | 'uploading' | 'done' | 'error';
  progress: number; // 0-100
  error?: string;
}

/**
 * Thumbnail storage layout (IntimaPic-specific, outside Cryptomator d/ structure):
 *
 *   _intimapic/thumbs/<directoryId>/<encryptedName>.grid    ← encrypted 300px thumbnail
 *   _intimapic/thumbs/<directoryId>/<encryptedName>.preview ← encrypted FullHD preview
 *
 * This keeps thumbnails separate from the Cryptomator vault data so that
 * Cryptomator Desktop/iOS can still read the vault without interference.
 */

/** Folder prefix for IntimaPic metadata (thumbnails etc.)
 *  NOTE: Using underscore prefix instead of dot prefix because iCloud Drive
 *  does not reliably sync dot-prefixed folders (treated as hidden/system files). */
const INTIMAPIC_META_ROOT = '_intimapic';
const THUMBS_DIR = `${INTIMAPIC_META_ROOT}/thumbs`;

/**
 * Orchestrates the full upload pipeline:
 * 1. Generate grid + preview thumbnails
 * 2. Encrypt filename
 * 3. Encrypt original file → upload to Cryptomator d/ structure
 * 4. Encrypt thumbnails → upload to _intimapic/thumbs/
 */
@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly crypto = inject(CryptoService);
  private readonly thumbnailService = inject(ThumbnailService);
  private readonly uploadQueue = inject(UploadQueueService);
  private readonly vaultService = inject(VaultService);

  private readonly _activeUploads = signal<UploadProgress[]>([]);
  readonly activeUploads = this._activeUploads.asReadonly();

  private processing = false;

  /**
   * Add files to the upload queue and start processing.
   */
  async addFiles(files: File[], targetFolder: string = ''): Promise<void> {
    for (const file of files) {
      const entry = await this.uploadQueue.enqueue(file, targetFolder);
      this._activeUploads.update(uploads => [
        ...uploads,
        {
          id: entry.id,
          fileName: file.name,
          step: 'queued',
          progress: 0,
        },
      ]);
    }

    this.processQueue();
  }

  /**
   * Retry failed uploads.
   */
  async retryFailed(): Promise<void> {
    const failed = this.uploadQueue.getPending();
    for (const entry of failed) {
      await this.uploadQueue.updateStatus(entry.id, 'pending');
      this.updateProgress(entry.id, { step: 'queued', progress: 0, error: undefined });
    }
    this.processQueue();
  }

  /**
   * Process the upload queue sequentially.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const pending = this.uploadQueue.getPending();

      for (const entry of pending) {
        await this.processEntry(entry.id, entry.file as File, entry.targetPath);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processEntry(
    id: string,
    file: File,
    targetFolder: string
  ): Promise<void> {
    let storage: StorageAdapter;

    try {
      storage = this.vaultService.getStorage();
    } catch {
      this.updateProgress(id, { step: 'error', progress: 0, error: 'Nicht verbunden' });
      await this.uploadQueue.updateStatus(id, 'error', 'Nicht verbunden');
      return;
    }

    try {
      // The targetFolder is the Cryptomator directory ID (empty string = root)
      const directoryId = targetFolder || '';

      // Step 1: Generate both thumbnail sizes
      this.updateProgress(id, { step: 'thumbnail', progress: 5 });
      await this.uploadQueue.updateStatus(id, 'encrypting');
      const thumbs = await this.thumbnailService.generateAll(file);

      // Step 2: Encrypt filename (AES-SIV with directoryId as AAD)
      this.updateProgress(id, { step: 'encrypting', progress: 20 });
      const encryptedName = await this.crypto.encryptFilename(file.name, directoryId);
      // encryptedName already has .c9r suffix from CryptoService

      // Step 3: Encrypt full file (Cryptomator file format: header + GCM chunks)
      this.updateProgress(id, { step: 'encrypting', progress: 30 });
      const fileBuffer = await file.arrayBuffer();
      const encryptedFile = await this.crypto.encryptFile(fileBuffer);

      // Step 4: Encrypt thumbnails
      this.updateProgress(id, { step: 'encrypting', progress: 50 });
      const encryptedGrid = await this.crypto.encryptFile(thumbs.grid.data);
      const encryptedPreview = await this.crypto.encryptFile(thumbs.preview.data);

      // Step 5: Upload original to Cryptomator directory structure
      this.updateProgress(id, { step: 'uploading', progress: 60 });
      await this.uploadQueue.updateStatus(id, 'uploading');

      const dirPath = await this.crypto.encryptDirectoryId(directoryId);
      // dirPath is like "d/AB/CDEFGHIJKLMNOPQRSTUVWXYZ234567"

      // Ensure the Cryptomator directory exists (separate try/catch per level)
      const parts = dirPath.split('/');

      try { await storage.createFolder(parts[0]); }
      catch { /* d/ may already exist */ }

      try { await storage.createFolder(`${parts[0]}/${parts[1]}`); }
      catch { /* d/XX may already exist */ }

      try { await storage.createFolder(dirPath); }
      catch { /* may already exist */ }

      // Upload encrypted original
      const filePath = `${dirPath}/${encryptedName}`;
      await storage.writeFile(filePath, encryptedFile);

      // Step 6: Upload thumbnails to _intimapic/thumbs/<directoryId>/
      this.updateProgress(id, { step: 'uploading', progress: 80 });
      const thumbDir = `${THUMBS_DIR}/${directoryId || '_root'}`;
      await this.ensureThumbDirectory(storage, thumbDir);

      // Strip .c9r suffix for thumb names, add size suffix
      const baseName = encryptedName.slice(0, -4); // remove .c9r
      await storage.writeFile(`${thumbDir}/${baseName}.grid`, encryptedGrid);

      this.updateProgress(id, { step: 'uploading', progress: 90 });
      await storage.writeFile(`${thumbDir}/${baseName}.preview`, encryptedPreview);

      // Done
      this.updateProgress(id, { step: 'done', progress: 100 });
      await this.uploadQueue.updateStatus(id, 'done');

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Upload fehlgeschlagen';
      this.updateProgress(id, { step: 'error', progress: 0, error: errorMsg });
      await this.uploadQueue.updateStatus(id, 'error', errorMsg);
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
      try { await storage.createFolder(path); }
      catch { /* may already exist */ }
    }
  }

  private updateProgress(
    id: string,
    update: Partial<UploadProgress>
  ): void {
    this._activeUploads.update(uploads =>
      uploads.map(u => (u.id === id ? { ...u, ...update } : u))
    );
  }
}
