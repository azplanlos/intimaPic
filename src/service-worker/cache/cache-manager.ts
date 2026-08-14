/**
 * CacheManager – Manages encrypted data in IndexedDB with LRU eviction.
 *
 * All data stored here is ENCRYPTED. No plaintext is ever persisted.
 * The cache survives vault lock (encrypted data is useless without keys).
 */

import { swCacheDb, type CachedThumbnail, type CachedDirectoryListing, type CachedVaultMeta, type CachedDirectoryId } from './cache-db';

export interface CacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  quotaUsedPercent: number;
  oldestEntry: number;
}

export class CacheManager {
  // ─── Thumbnails ────────────────────────────────────────────────────────────

  /**
   * Get an encrypted thumbnail from cache.
   * Updates lastAccess for LRU tracking.
   */
  async getThumbnail(key: string, vaultId: string): Promise<ArrayBuffer | null> {
    try {
      const entry = await swCacheDb.thumbnails.get(key);
      if (!entry || entry.vaultId !== vaultId) return null;

      // Update lastAccess (fire-and-forget)
      swCacheDb.thumbnails.update(key, { lastAccess: Date.now() }).catch(() => {});

      return entry.data;
    } catch {
      return null;
    }
  }

  /**
   * Store an encrypted thumbnail in cache.
   * Triggers eviction check if cache is getting large.
   */
  async putThumbnail(
    key: string,
    vaultId: string,
    data: ArrayBuffer,
    sizeType: 'grid' | 'preview'
  ): Promise<void> {
    const now = Date.now();

    await swCacheDb.thumbnails.put({
      key,
      vaultId,
      data,
      sizeType,
      cachedAt: now,
      lastAccess: now,
      size: data.byteLength,
    });

    // Check if we need to evict (async, non-blocking)
    this.maybeEvict(vaultId).catch(() => {});
  }

  // ─── Directory Listings ────────────────────────────────────────────────────

  /**
   * Get a cached directory listing.
   */
  async getDirectoryListing(key: string): Promise<CachedDirectoryListing | null> {
    try {
      return (await swCacheDb.directories.get(key)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Store a directory listing.
   */
  async putDirectoryListing(listing: CachedDirectoryListing): Promise<void> {
    await swCacheDb.directories.put(listing);
  }

  /**
   * Clear a specific directory listing.
   */
  async clearDirectoryListing(key: string): Promise<void> {
    await swCacheDb.directories.delete(key);
  }

  // ─── Vault Meta ────────────────────────────────────────────────────────────

  /**
   * Get cached vault metadata (for offline unlock).
   */
  async getVaultMeta(vaultId: string): Promise<CachedVaultMeta | null> {
    try {
      return (await swCacheDb.vaultMeta.get(vaultId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Store vault metadata.
   */
  async putVaultMeta(meta: CachedVaultMeta): Promise<void> {
    await swCacheDb.vaultMeta.put(meta);
  }

  /**
   * Delete vault metadata.
   */
  async deleteVaultMeta(vaultId: string): Promise<void> {
    await swCacheDb.vaultMeta.delete(vaultId);
  }

  // ─── Directory IDs (dir.c9r content cache) ─────────────────────────────────

  /**
   * Get a cached directory ID for an encrypted folder name.
   */
  async getDirectoryId(vaultId: string, encryptedName: string): Promise<string | null> {
    try {
      const key = `${vaultId}:${encryptedName}`;
      const entry = await swCacheDb.directoryIds.get(key);
      return entry?.directoryId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Store a directory ID mapping (encryptedName → directoryId).
   */
  async putDirectoryId(vaultId: string, encryptedName: string, directoryId: string): Promise<void> {
    const key = `${vaultId}:${encryptedName}`;
    await swCacheDb.directoryIds.put({
      key,
      vaultId,
      encryptedName,
      directoryId,
      cachedAt: Date.now(),
    });
  }

  /**
   * Get all cached directory IDs for a vault (for offline album listing).
   */
  async getAllDirectoryIds(vaultId: string): Promise<Map<string, string>> {
    try {
      const entries = await swCacheDb.directoryIds.where('vaultId').equals(vaultId).toArray();
      const map = new Map<string, string>();
      for (const entry of entries) {
        map.set(entry.encryptedName, entry.directoryId);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  // ─── Cache Management ──────────────────────────────────────────────────────

  /**
   * Clear all cached data for a specific vault.
   */
  async clearAllForVault(vaultId: string): Promise<void> {
    await swCacheDb.thumbnails.where('vaultId').equals(vaultId).delete();
    await swCacheDb.directories.where('vaultId').equals(vaultId).delete();
    // Vault meta is intentionally NOT cleared (needed for offline unlock)
  }

  /**
   * Clear all thumbnails for a vault.
   */
  async clearThumbnailsForVault(vaultId: string): Promise<void> {
    await swCacheDb.thumbnails.where('vaultId').equals(vaultId).delete();
  }

  /**
   * Get cache statistics.
   */
  async getStats(vaultId: string): Promise<CacheStats> {
    const thumbnails = await swCacheDb.thumbnails.where('vaultId').equals(vaultId).toArray();
    const directories = await swCacheDb.directories.where('vaultId').equals(vaultId).toArray();

    const totalEntries = thumbnails.length + directories.length;
    const totalSizeBytes = thumbnails.reduce((sum, t) => sum + t.size, 0);

    let oldestEntry = Date.now();
    for (const t of thumbnails) {
      if (t.lastAccess < oldestEntry) oldestEntry = t.lastAccess;
    }

    // Quota estimation
    let quotaUsedPercent = 0;
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ?? 0;
        const quota = estimate.quota ?? 1;
        quotaUsedPercent = (used / quota) * 100;
      } catch {
        // navigator.storage may not be available in all SW contexts
      }
    }

    return { totalEntries, totalSizeBytes, quotaUsedPercent, oldestEntry };
  }

  // ─── Eviction ──────────────────────────────────────────────────────────────

  /**
   * Run LRU eviction if storage pressure is detected.
   */
  private async maybeEvict(vaultId: string): Promise<void> {
    let quotaPercent = 0;

    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ?? 0;
        const quota = estimate.quota ?? 1;
        quotaPercent = (used / quota) * 100;
      } catch {
        return;
      }
    }

    if (quotaPercent > 90) {
      // Critical: evict grid thumbnails too
      await this.evictOldest(vaultId, 'grid', 200);
      await this.evictOldest(vaultId, 'preview', 100);
    } else if (quotaPercent > 80) {
      // Warning: evict only preview thumbnails (larger, less critical)
      await this.evictOldest(vaultId, 'preview', 100);
    }
  }

  /**
   * Evict the oldest thumbnails of a specific type.
   */
  private async evictOldest(vaultId: string, sizeType: 'grid' | 'preview', count: number): Promise<void> {
    const oldest = await swCacheDb.thumbnails
      .where('[vaultId+sizeType]')
      .equals([vaultId, sizeType])
      .sortBy('lastAccess');

    const toDelete = oldest.slice(0, count).map(e => e.key);
    if (toDelete.length > 0) {
      await swCacheDb.thumbnails.bulkDelete(toDelete);
    }
  }
}
