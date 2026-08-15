import { Injectable, inject } from '@angular/core';
import { MetadataStore } from './metadata-store';
import { ExifExtractor } from './exif-extractor';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import { MetadataRecord, VaultMetadataPayload } from './metadata.models';

const METADATA_PATH = '_intimapic/metadata.enc';

@Injectable({ providedIn: 'root' })
export class MetadataService {
  private readonly store = inject(MetadataStore);
  private readonly exifExtractor = inject(ExifExtractor);
  private readonly cryptoService = inject(CryptoService);
  private readonly vaultService = inject(VaultService);

  /** In-memory cache for fast reads (populated on vault open) */
  private cache = new Map<string, MetadataRecord>();

  /** Flush timer handle */
  private flushTimerHandle: ReturnType<typeof setTimeout> | null = null;

  /** Whether a flush is currently in progress */
  private flushing = false;

  /** Whether there are pending changes since last flush */
  private dirty = false;

  private readonly FLUSH_DELAY_MS = 30_000;

  /** Bound visibilitychange handler for cleanup */
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && this.dirty) {
      this.flush();
    }
  };

  /**
   * Promise that resolves when background remote merge completes.
   * Exposed for testing — production code should NOT await this during unlock.
   * @internal
   */
  remoteMergeComplete: Promise<void> = Promise.resolve();

  // ─── Lifecycle ─────────────────────────────────────────────────

  /** Called when vault is opened. Loads local metadata immediately, then merges remote in background. */
  async initialize(): Promise<void> {
    await this.store.open();

    // Load local records first — this is instant (IndexedDB)
    const localRecords = await this.store.getAll();

    // Populate in-memory cache immediately so the gallery can render
    this.cache.clear();
    for (const record of localRecords) {
      this.cache.set(record.photoId, record);
    }

    // Register visibility change listener for immediate flush on page hide
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    // Merge remote records in the background (non-blocking)
    this.remoteMergeComplete = this.mergeRemoteInBackground(localRecords);
  }

  /**
   * Download remote metadata and merge with local records in the background.
   * Does not block the UI — the gallery works with local data in the meantime.
   */
  private async mergeRemoteInBackground(localRecords: MetadataRecord[]): Promise<void> {
    try {
      const remoteRecords = await this.downloadRemoteRecords();

      if (remoteRecords.length === 0) return; // Nothing to merge

      const merged = this.mergeRecords(localRecords, remoteRecords);

      // Only update store and cache if there were actual changes from remote
      const hasChanges = merged.length !== localRecords.length ||
        merged.some(m => {
          const local = this.cache.get(m.photoId);
          return !local || local.updatedAt !== m.updatedAt;
        });

      if (hasChanges) {
        await this.store.putBatch(merged);
        for (const record of merged) {
          this.cache.set(record.photoId, record);
        }
      }
    } catch {
      // Non-critical: remote merge failure doesn't affect local operation.
      // Will retry on next vault open.
    }
  }

  /** Called when vault is locked. Flush pending, clear cache and store. */
  async teardown(): Promise<void> {
    // Cancel any pending flush timer
    if (this.flushTimerHandle !== null) {
      clearTimeout(this.flushTimerHandle);
      this.flushTimerHandle = null;
    }

    // Remove visibility change listener
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    // Flush any remaining changes to remote storage
    await this.flush();

    this.dirty = false;
    this.cache.clear();
    // NOTE: Do NOT clear the IndexedDB store on lock.
    // Metadata records (EXIF dates, ratings, favorites) should persist
    // locally across sessions to avoid re-downloading originals for
    // EXIF extraction on every vault open.
    // The store is only cleared on vault deletion (reset).
  }

  // ─── EXIF Extraction ───────────────────────────────────────────

  /** Extract EXIF and create a metadata record for a newly imported photo. */
  async extractAndStore(photoId: string, imageData: ArrayBuffer): Promise<MetadataRecord> {
    const exifData = await this.exifExtractor.extract(imageData);
    const record: MetadataRecord = {
      photoId,
      captureDate: exifData.captureDate ?? null,
      cameraMake: exifData.cameraMake ?? null,
      cameraModel: exifData.cameraModel ?? null,
      rating: null,
      isFavorite: false,
      updatedAt: Date.now(),
    };
    await this.store.put(record);
    this.cache.set(photoId, record);
    this.resetFlushTimer();
    return record;
  }

  /** Queue background EXIF extraction for photos without metadata. */
  queueBackgroundExtraction(photos: Array<{ encryptedName: string; storagePath: string }>): void {
    // Filter to only photos not already in cache
    const missing = photos.filter(p => !this.cache.has(p.encryptedName));
    if (missing.length === 0) return;
    // Limit to 5 photos per batch to avoid excessive network usage.
    // The rest will be extracted when the user scrolls to them or next time the album opens.
    const batch = missing.slice(0, 5);
    // Process asynchronously without blocking
    this.processBackgroundQueue(batch);
  }

  private async processBackgroundQueue(photos: Array<{ encryptedName: string; storagePath: string }>): Promise<void> {
    const storage = this.vaultService.getStorage();

    for (const photo of photos) {
      try {
        // Read the encrypted file from storage
        const encryptedData = await storage.readFile(photo.storagePath);

        // Decrypt to get raw image bytes
        const imageData = await this.cryptoService.decryptFile(encryptedData);

        // Extract EXIF and store metadata
        await this.extractAndStore(photo.encryptedName, imageData);

        // Long pause between items to avoid network saturation.
        // EXIF extraction is low-priority background work.
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        // Skip failed photos, continue with next
        continue;
      }
    }
  }

  // ─── Read ──────────────────────────────────────────────────────

  /** Get metadata for a single photo (from cache). */
  getMetadata(photoId: string): MetadataRecord | undefined {
    return this.cache.get(photoId);
  }

  /** Get metadata for a batch of photos (from cache). */
  getMetadataBatch(photoIds: string[]): Map<string, MetadataRecord> {
    const result = new Map<string, MetadataRecord>();
    for (const id of photoIds) {
      const record = this.cache.get(id);
      if (record) result.set(id, record);
    }
    return result;
  }

  // ─── Rating & Favorites ────────────────────────────────────────

  /** Toggle isFavorite for a photo. Returns new value. */
  async toggleFavorite(photoId: string): Promise<boolean> {
    const existing = this.cache.get(photoId);
    const newValue = !(existing?.isFavorite ?? false);
    const record: MetadataRecord = existing
      ? { ...existing, isFavorite: newValue, updatedAt: Date.now() }
      : { photoId, captureDate: null, cameraMake: null, cameraModel: null, rating: null, isFavorite: newValue, updatedAt: Date.now() };
    await this.store.put(record);
    this.cache.set(photoId, record);
    this.resetFlushTimer();
    return newValue;
  }

  /** Delete metadata for a photo (e.g. when photo is deleted from album). */
  async deleteMetadata(photoId: string): Promise<void> {
    this.cache.delete(photoId);
    await this.store.delete(photoId);
    this.resetFlushTimer();
  }

  /** Set rating (1–5) or clear (null if same star tapped). */
  async setRating(photoId: string, value: number): Promise<number | null> {
    const existing = this.cache.get(photoId);
    const currentRating = existing?.rating ?? null;
    const newRating = currentRating === value ? null : value;
    const record: MetadataRecord = existing
      ? { ...existing, rating: newRating, updatedAt: Date.now() }
      : { photoId, captureDate: null, cameraMake: null, cameraModel: null, rating: newRating, isFavorite: false, updatedAt: Date.now() };
    await this.store.put(record);
    this.cache.set(photoId, record);
    this.resetFlushTimer();
    return newRating;
  }

  // ─── Merge ─────────────────────────────────────────────────────

  /** Merge remote records with local using last-write-wins strategy. */
  mergeRecords(local: MetadataRecord[], remote: MetadataRecord[]): MetadataRecord[] {
    const merged = new Map<string, MetadataRecord>();

    for (const record of local) {
      merged.set(record.photoId, record);
    }

    for (const record of remote) {
      const existing = merged.get(record.photoId);
      if (!existing || record.updatedAt > existing.updatedAt) {
        merged.set(record.photoId, record);
      }
    }

    return Array.from(merged.values());
  }

  // ─── Private Helpers ───────────────────────────────────────────

  /** Download and decrypt remote metadata file. Returns empty array on failure. */
  private async downloadRemoteRecords(): Promise<MetadataRecord[]> {
    try {
      const storage = this.vaultService.getStorage();
      const exists = await storage.fileExists(METADATA_PATH);
      if (!exists) {
        return [];
      }

      const encrypted = await storage.readFile(METADATA_PATH);
      const decrypted = await this.cryptoService.decryptFile(encrypted);

      const json = new TextDecoder().decode(decrypted);
      const payload: VaultMetadataPayload = JSON.parse(json);

      if (payload.version === 1 && Array.isArray(payload.records)) {
        return payload.records;
      }

      return [];
    } catch (err) {
      console.error('Failed to download/decrypt remote metadata:', err);
      return [];
    }
  }

  /** Flush metadata to cloud (serialize → encrypt → write). */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    this.dirty = false;

    if (this.flushTimerHandle !== null) {
      clearTimeout(this.flushTimerHandle);
      this.flushTimerHandle = null;
    }

    try {
      const records = await this.store.getAll();
      if (records.length === 0) {
        return;
      }

      const payload: VaultMetadataPayload = { version: 1, records };
      const json = JSON.stringify(payload);
      const encoder = new TextEncoder();
      const plaintext = encoder.encode(json).buffer as ArrayBuffer;

      const encrypted = await this.cryptoService.encryptFile(plaintext);

      const storage = this.vaultService.getStorage();
      await storage.writeFile(METADATA_PATH, encrypted);
    } catch (err) {
      console.error('Metadata flush failed:', err);
      // Mark dirty again so next timer or visibility change retries
      this.dirty = true;
    } finally {
      this.flushing = false;
    }
  }

  /** Reset the flush timer (called on every metadata change). */
  resetFlushTimer(): void {
    if (this.flushTimerHandle !== null) {
      clearTimeout(this.flushTimerHandle);
    }
    this.dirty = true;
    this.flushTimerHandle = setTimeout(() => this.flush(), this.FLUSH_DELAY_MS);
  }
}
