/**
 * LRU (Least Recently Used) cache for blob URLs.
 * Automatically revokes the oldest blob URL when the cache exceeds its max size.
 */
export class BlobLruCache {
  private readonly maxSize: number;
  private readonly map = new Map<string, string>();

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): string | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, url: string): void {
    // If key already exists, remove it first (will be re-added at end)
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    // Evict oldest entries if at capacity
    while (this.map.size >= this.maxSize) {
      const oldest = this.map.entries().next();
      if (oldest.done) break;
      const [oldKey, oldUrl] = oldest.value;
      URL.revokeObjectURL(oldUrl);
      this.map.delete(oldKey);
    }

    this.map.set(key, url);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Revoke all blob URLs and clear the cache.
   */
  clear(): void {
    for (const url of this.map.values()) {
      URL.revokeObjectURL(url);
    }
    this.map.clear();
  }

  /**
   * Delete a single entry by key. Revokes the blob URL if it exists.
   */
  delete(key: string): void {
    const url = this.map.get(key);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      this.map.delete(key);
    }
  }

  /**
   * Evict entries matching a prefix (e.g. "full:" to clear all full-res).
   */
  evictByPrefix(prefix: string): void {
    for (const [key, url] of this.map.entries()) {
      if (key.startsWith(prefix)) {
        URL.revokeObjectURL(url);
        this.map.delete(key);
      }
    }
  }
}
