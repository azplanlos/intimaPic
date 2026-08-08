import { Injectable, inject, signal } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';

export interface Album {
  /** Cleartext album name */
  name: string;
  /** Cryptomator directory ID (UUID) */
  directoryId: string;
  /** Storage path (d/XX/YYYY...) */
  storagePath: string;
  /** Encrypted folder name (.c9r) as stored in parent directory */
  encryptedName: string;
}

/**
 * Service for managing photo albums (Cryptomator directories).
 *
 * In Cryptomator's format, a subdirectory is represented by:
 * 1. A folder with the encrypted name + .c9r extension in the parent directory
 * 2. Inside that folder, a file called "dir.c9r" containing the directory ID
 * 3. The actual content lives at d/<hash of encrypted dirId>/
 *
 * Example:
 *   d/AB/ROOT_HASH/
 *     ├── encryptedAlbumName.c9r/    ← folder marker
 *     │   └── dir.c9r                ← contains the directory ID (UUID)
 *     ...
 *   d/CD/ALBUM_HASH/                 ← actual album content
 *     ├── encryptedPhoto1.c9r        ← photos in this album
 *     └── encryptedPhoto2.c9r
 */
@Injectable({ providedIn: 'root' })
export class AlbumService {
  private readonly crypto = inject(CryptoService);
  private readonly vaultService = inject(VaultService);

  private readonly _albums = signal<Album[]>([]);
  readonly albums = this._albums.asReadonly();

  private readonly ROOT_DIR_ID = ''; // Cryptomator root = empty string

  /**
   * Load all albums from the root directory.
   */
  async loadAlbums(): Promise<Album[]> {
    const storage = this.vaultService.getStorage();

    // Get the storage path for the root directory
    const rootPath = await this.crypto.encryptDirectoryId(this.ROOT_DIR_ID);

    // List all entries in root
    const entries = await storage.listFiles(rootPath);

    const albums: Album[] = [];

    for (const entry of entries) {
      // Directories in Cryptomator are .c9r folders containing a dir.c9r file
      if (entry.isDirectory && entry.encryptedName.endsWith('.c9r')) {
        try {
          // Read the dir.c9r file inside this folder to get the directory ID
          const dirIdPath = `${rootPath}/${entry.encryptedName}/dir.c9r`;
          const dirIdData = await storage.readFile(dirIdPath);
          const directoryId = new TextDecoder().decode(dirIdData).trim();

          // Decrypt the folder name
          const decryptedName = await this.crypto.decryptFilename(
            entry.encryptedName,
            this.ROOT_DIR_ID
          );

          // Compute the storage path for this album's content
          const storagePath = await this.crypto.encryptDirectoryId(directoryId);

          albums.push({
            name: decryptedName,
            directoryId,
            storagePath,
            encryptedName: entry.encryptedName,
          });
        } catch {
          // Skip entries we can't decrypt (might be corrupted or not a directory)
          continue;
        }
      }
    }

    this._albums.set(albums);
    return albums;
  }

  /**
   * Create a new album in the vault root.
   */
  async createAlbum(name: string): Promise<Album> {
    const storage = this.vaultService.getStorage();

    // Generate a unique directory ID for the new album
    const directoryId = crypto.randomUUID();

    // Encrypt the album name for the parent (root) directory
    const encryptedName = await this.crypto.encryptFilename(name, this.ROOT_DIR_ID);

    // Compute root storage path
    const rootPath = await this.crypto.encryptDirectoryId(this.ROOT_DIR_ID);

    // Create the .c9r folder in root
    const folderPath = `${rootPath}/${encryptedName}`;
    await storage.createFolder(folderPath);

    // Write dir.c9r file with the directory ID
    const dirIdBytes = new TextEncoder().encode(directoryId);
    await storage.writeFile(`${folderPath}/dir.c9r`, dirIdBytes.buffer as ArrayBuffer);

    // Compute and create the actual content directory for this album.
    // Each level gets its own try/catch so a "folder exists" error on d/XX
    // doesn't prevent d/XX/YYYYYY from being created.
    const albumStoragePath = await this.crypto.encryptDirectoryId(directoryId);
    const parts = albumStoragePath.split('/');
    // parts = ['d', 'XX', 'YYYYYY...']

    try { await storage.createFolder(parts[0]); }
    catch { /* d/ may already exist */ }

    try { await storage.createFolder(`${parts[0]}/${parts[1]}`); }
    catch { /* d/XX may already exist */ }

    await storage.createFolder(albumStoragePath);

    const album: Album = {
      name,
      directoryId,
      storagePath: albumStoragePath,
      encryptedName,
    };

    this._albums.update(albums => [...albums, album]);
    return album;
  }

  /**
   * Delete an album and all its contents.
   */
  async deleteAlbum(album: Album): Promise<void> {
    const storage = this.vaultService.getStorage();

    // Delete the album content directory
    try {
      await storage.deleteFolder(album.storagePath);
    } catch {
      // Content dir might not exist or already deleted
    }

    // Delete the .c9r folder marker in root
    const rootPath = await this.crypto.encryptDirectoryId(this.ROOT_DIR_ID);
    try {
      await storage.deleteFolder(`${rootPath}/${album.encryptedName}`);
    } catch {
      // May already be gone
    }

    this._albums.update(albums => albums.filter(a => a.directoryId !== album.directoryId));
  }

  /**
   * Get the directory ID for the root (for uploading to root directly).
   */
  getRootDirectoryId(): string {
    return this.ROOT_DIR_ID;
  }
}
