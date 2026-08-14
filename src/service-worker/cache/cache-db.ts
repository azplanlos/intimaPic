/**
 * IndexedDB schema for the ServiceWorker encrypted cache.
 * Uses Dexie for structured access.
 *
 * Stores:
 * - thumbnails: Encrypted grid/preview thumbnail blobs
 * - directories: Encrypted directory listing snapshots
 * - vaultMeta: masterkey.cryptomator + vault.cryptomator for offline unlock
 */

import Dexie, { type Table } from 'dexie';

// ─── Record Types ──────────────────────────────────────────────────────────────

export interface CachedThumbnail {
  /** Composite key: '<size>:<encryptedName>' */
  key: string;
  /** Vault ID for multi-vault isolation */
  vaultId: string;
  /** Encrypted thumbnail data */
  data: ArrayBuffer;
  /** Thumbnail size type */
  sizeType: 'grid' | 'preview';
  /** Time when cached */
  cachedAt: number;
  /** Last access time (for LRU eviction) */
  lastAccess: number;
  /** Size in bytes */
  size: number;
}

export interface CachedDirectoryListing {
  /** Composite key: '<vaultId>:<directoryId>' */
  key: string;
  /** Vault ID */
  vaultId: string;
  /** Directory ID (or '_albums' for root listing) */
  directoryId: string;
  /** Raw file entries (encrypted names, still need decryption) */
  entries: Array<{
    encryptedName: string;
    path: string;
    size: number;
    lastModified: string;
    isDirectory: boolean;
  }>;
  /** When last synced from network */
  syncedAt: number;
  /** Optional ETag for change detection */
  etag?: string;
}

export interface CachedVaultMeta {
  /** Vault ID */
  vaultId: string;
  /** masterkey.cryptomator content (wrapped keys – safe to persist) */
  masterkeyFile: ArrayBuffer;
  /** vault.cryptomator content (JWT) */
  vaultConfig?: ArrayBuffer;
  /** When last updated */
  updatedAt: number;
}

export interface CachedDirectoryId {
  /** Composite key: '<vaultId>:<encryptedName>' */
  key: string;
  /** Vault ID */
  vaultId: string;
  /** Encrypted folder name (e.g. "abc123.c9r") */
  encryptedName: string;
  /** The directory ID read from dir.c9r */
  directoryId: string;
  /** When cached */
  cachedAt: number;
}

// ─── Database Definition ───────────────────────────────────────────────────────

export class SwCacheDatabase extends Dexie {
  thumbnails!: Table<CachedThumbnail, string>;
  directories!: Table<CachedDirectoryListing, string>;
  vaultMeta!: Table<CachedVaultMeta, string>;
  directoryIds!: Table<CachedDirectoryId, string>;

  constructor() {
    super('intimapic_sw_cache');

    this.version(1).stores({
      thumbnails: 'key, vaultId, sizeType, lastAccess, size',
      directories: 'key, vaultId, directoryId, syncedAt',
      vaultMeta: 'vaultId',
    });

    this.version(2).stores({
      thumbnails: 'key, vaultId, sizeType, lastAccess, size',
      directories: 'key, vaultId, directoryId, syncedAt',
      vaultMeta: 'vaultId',
      directoryIds: 'key, vaultId, encryptedName',
    });
  }
}

/** Singleton database instance for the SW context. */
export const swCacheDb = new SwCacheDatabase();
