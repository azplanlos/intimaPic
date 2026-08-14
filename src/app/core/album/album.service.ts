import { Injectable, inject, signal } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import { SwClientService, SwError } from '../sw-client/sw-client.service';

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
 * Album listing is now delegated to the ServiceWorker which handles
 * caching, network access, and filename decryption. The SW returns
 * already-decrypted album names.
 *
 * Write operations (create/delete) still use the SW for storage access.
 */
@Injectable({ providedIn: 'root' })
export class AlbumService {
  private readonly crypto = inject(CryptoService);
  private readonly vaultService = inject(VaultService);
  private readonly swClient = inject(SwClientService);

  private readonly _albums = signal<Album[]>([]);
  readonly albums = this._albums.asReadonly();

  private readonly ROOT_DIR_ID = ''; // Cryptomator root = empty string

  /**
   * Load all albums from the root directory.
   * Uses the ServiceWorker for cached/network access + filename decryption.
   */
  async loadAlbums(forceRefresh = false): Promise<Album[]> {
    try {
      const { albums: cachedAlbums } = await this.swClient.listAlbums(forceRefresh);

      // Map SW response to local Album interface
      const albums: Album[] = cachedAlbums.map(a => ({
        name: a.name,
        directoryId: a.directoryId,
        storagePath: a.storagePath,
        encryptedName: a.encryptedName,
      }));

      this._albums.set(albums);
      return albums;
    } catch (err) {
      // If SW is not ready or keys not set, fall back to direct access
      if (err instanceof SwError && err.code === 'SW_NOT_READY') {
        return this.loadAlbumsDirect();
      }
      throw err;
    }
  }

  /**
   * Fallback: Load albums directly via storage adapter (used during initial setup
   * or when SW is not yet registered).
   */
  private async loadAlbumsDirect(): Promise<Album[]> {
    const storage = this.vaultService.getStorage();
    const rootPath = await this.crypto.encryptDirectoryId(this.ROOT_DIR_ID);
    const entries = await storage.listFiles(rootPath);

    const albums: Album[] = [];

    for (const entry of entries) {
      if (entry.isDirectory && entry.encryptedName.endsWith('.c9r')) {
        try {
          const dirIdPath = `${rootPath}/${entry.encryptedName}/dir.c9r`;
          const dirIdData = await storage.readFile(dirIdPath);
          const directoryId = new TextDecoder().decode(dirIdData).trim();
          const decryptedName = await this.crypto.decryptFilename(
            entry.encryptedName,
            this.ROOT_DIR_ID
          );
          const storagePath = await this.crypto.encryptDirectoryId(directoryId);

          albums.push({
            name: decryptedName,
            directoryId,
            storagePath,
            encryptedName: entry.encryptedName,
          });
        } catch {
          continue;
        }
      }
    }

    this._albums.set(albums);
    return albums;
  }

  /**
   * Create a new album in the vault root.
   * Uses the ServiceWorker for storage operations.
   */
  async createAlbum(name: string): Promise<Album> {
    // Generate a unique directory ID for the new album
    const directoryId = crypto.randomUUID();

    // Encrypt the album name for the parent (root) directory
    const encryptedName = await this.crypto.encryptFilename(name, this.ROOT_DIR_ID);

    // Compute root storage path
    const rootPath = await this.crypto.encryptDirectoryId(this.ROOT_DIR_ID);

    // Create the .c9r folder in root
    const folderPath = `${rootPath}/${encryptedName}`;
    await this.swClient.createFolder(folderPath);

    // Write dir.c9r file with the directory ID
    const dirIdBytes = new TextEncoder().encode(directoryId);
    await this.swClient.writeFile(`${folderPath}/dir.c9r`, dirIdBytes.buffer as ArrayBuffer);

    // Compute and create the actual content directory for this album.
    const albumStoragePath = await this.crypto.encryptDirectoryId(directoryId);
    const parts = albumStoragePath.split('/');

    try { await this.swClient.createFolder(parts[0]); }
    catch { /* d/ may already exist */ }

    try { await this.swClient.createFolder(`${parts[0]}/${parts[1]}`); }
    catch { /* d/XX may already exist */ }

    await this.swClient.createFolder(albumStoragePath);

    const album: Album = {
      name,
      directoryId,
      storagePath: albumStoragePath,
      encryptedName,
    };

    this._albums.update(albums => [...albums, album]);

    // Invalidate directory cache so next load picks up the new album
    await this.swClient.invalidateCache('directory', '_albums').catch(() => {});

    return album;
  }

  /**
   * Delete an album and all its contents.
   * Uses the ServiceWorker for storage operations.
   */
  async deleteAlbum(album: Album): Promise<void> {
    // Delete the album content directory
    try {
      await this.swClient.deleteFolder(album.storagePath);
    } catch {
      // Content dir might not exist or already deleted
    }

    // Delete the .c9r folder marker in root
    const rootPath = await this.crypto.encryptDirectoryId(this.ROOT_DIR_ID);
    try {
      await this.swClient.deleteFolder(`${rootPath}/${album.encryptedName}`);
    } catch {
      // May already be gone
    }

    this._albums.update(albums => albums.filter(a => a.directoryId !== album.directoryId));

    // Invalidate caches
    await this.swClient.invalidateCache('directory', '_albums').catch(() => {});
    await this.swClient.invalidateCache('directory', album.directoryId).catch(() => {});
  }

  /**
   * Get the directory ID for the root (for uploading to root directly).
   */
  getRootDirectoryId(): string {
    return this.ROOT_DIR_ID;
  }
}
