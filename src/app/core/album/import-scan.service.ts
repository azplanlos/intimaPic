import { Injectable, inject, signal } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import type { FileEntry } from '../crypto/crypto.models';

export interface UnsortedPhoto {
  /** Encrypted filename as stored (e.g. xyz.c9r) */
  encryptedName: string;
  /** Decrypted original filename */
  name: string;
  /** Full storage path */
  storagePath: string;
  /** File size in bytes */
  size: number;
}

/**
 * Scans the vault root directory for unsorted photos.
 *
 * In Cryptomator, the root directory contains both:
 * - Album folders: .c9r directories with a dir.c9r file inside
 * - Photo files: .c9r files (non-directories)
 *
 * Photos in the root are "unsorted" — they haven't been assigned to an album.
 * This happens when photos are imported externally via iOS Shortcuts + Cryptomator,
 * which places them directly in the vault root without album assignment.
 */
@Injectable({ providedIn: 'root' })
export class ImportScanService {
  private readonly crypto = inject(CryptoService);
  private readonly vaultService = inject(VaultService);

  private readonly _unsortedPhotos = signal<UnsortedPhoto[]>([]);
  readonly unsortedPhotos = this._unsortedPhotos.asReadonly();

  private readonly _scanning = signal(false);
  readonly scanning = this._scanning.asReadonly();

  private readonly ROOT_DIR_ID = ''; // Cryptomator root = empty string

  private readonly IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif', '.bmp'];

  /**
   * Scan the vault root for unsorted photo files.
   * Returns true if unsorted photos were found.
   */
  async scanRoot(): Promise<boolean> {
    if (this._scanning()) return false;
    this._scanning.set(true);

    try {
      const storage = this.vaultService.getStorage();
      const rootPath = await this.crypto.encryptDirectoryId(this.ROOT_DIR_ID);

      let entries: FileEntry[];
      try {
        entries = await storage.listFiles(rootPath);
      } catch {
        this._unsortedPhotos.set([]);
        return false;
      }

      const unsorted: UnsortedPhoto[] = [];

      for (const entry of entries) {
        // Skip directories (those are album folders)
        if (entry.isDirectory) continue;

        // Only process .c9r files
        if (!entry.encryptedName.endsWith('.c9r')) continue;

        try {
          const name = await this.crypto.decryptFilename(
            entry.encryptedName,
            this.ROOT_DIR_ID
          );

          // Only include image files
          if (this.isImageFile(name)) {
            unsorted.push({
              encryptedName: entry.encryptedName,
              name,
              storagePath: `${rootPath}/${entry.encryptedName}`,
              size: entry.size,
            });
          }
        } catch {
          // Can't decrypt — skip
          continue;
        }
      }

      this._unsortedPhotos.set(unsorted);
      return unsorted.length > 0;
    } finally {
      this._scanning.set(false);
    }
  }

  /**
   * Move a photo from root to a target album.
   * This re-encrypts the filename for the target directory and moves the file.
   */
  async moveToAlbum(photo: UnsortedPhoto, targetDirectoryId: string): Promise<void> {
    const storage = this.vaultService.getStorage();

    // Read the encrypted file
    const encryptedData = await storage.readFile(photo.storagePath);

    // Deduplicate: if a file with the same name already exists in the target,
    // append a counter (e.g. "IMG_001 (2).jpg") to avoid encryption collisions.
    const uniqueName = await this.deduplicateName(photo.name, targetDirectoryId, storage);

    // Encrypt the filename for the target directory (new AES-SIV with different AAD)
    const newEncryptedName = await this.crypto.encryptFilename(uniqueName, targetDirectoryId);

    // Compute target directory path
    const targetDirPath = await this.crypto.encryptDirectoryId(targetDirectoryId);

    // Ensure target directory exists
    const parts = targetDirPath.split('/');
    try { await storage.createFolder(parts[0]); } catch { /* d/ exists */ }
    try { await storage.createFolder(`${parts[0]}/${parts[1]}`); } catch { /* d/XX exists */ }
    try { await storage.createFolder(targetDirPath); } catch { /* exists */ }

    // Write file to target location
    const targetPath = `${targetDirPath}/${newEncryptedName}`;
    await storage.writeFile(targetPath, encryptedData);

    // Delete from root
    await storage.deleteFile(photo.storagePath);

    // Remove from unsorted list
    this._unsortedPhotos.update(photos =>
      photos.filter(p => p.encryptedName !== photo.encryptedName)
    );
  }

  /**
   * Check if there are unsorted photos without re-scanning.
   */
  hasUnsortedPhotos(): boolean {
    return this._unsortedPhotos().length > 0;
  }

  /**
   * Clear the unsorted photos state.
   */
  clear(): void {
    this._unsortedPhotos.set([]);
  }

  private isImageFile(name: string): boolean {
    const lower = name.toLowerCase();
    return this.IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
  }

  /**
   * Ensure the filename is unique in the target directory.
   * If a file with the same encrypted name already exists, appends a counter.
   * E.g. "IMG_001.jpg" → "IMG_001 (2).jpg" → "IMG_001 (3).jpg"
   */
  private async deduplicateName(
    name: string,
    targetDirectoryId: string,
    storage: StorageAdapter
  ): Promise<string> {
    const targetDirPath = await this.crypto.encryptDirectoryId(targetDirectoryId);

    // Check if the encrypted version of this name already exists
    const encryptedName = await this.crypto.encryptFilename(name, targetDirectoryId);
    const targetPath = `${targetDirPath}/${encryptedName}`;

    const exists = await storage.fileExists(targetPath).catch(() => false);
    if (!exists) return name;

    // Collision detected — find a unique name by appending a counter
    const dotIdx = name.lastIndexOf('.');
    const baseName = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    const ext = dotIdx > 0 ? name.slice(dotIdx) : '';

    for (let counter = 2; counter <= 100; counter++) {
      const candidate = `${baseName} (${counter})${ext}`;
      const candidateEncrypted = await this.crypto.encryptFilename(candidate, targetDirectoryId);
      const candidatePath = `${targetDirPath}/${candidateEncrypted}`;
      const candidateExists = await storage.fileExists(candidatePath).catch(() => false);
      if (!candidateExists) return candidate;
    }

    // Fallback: append timestamp
    const ts = Date.now();
    return `${baseName} (${ts})${ext}`;
  }
}
