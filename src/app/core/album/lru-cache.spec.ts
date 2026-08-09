import { BlobLruCache } from './lru-cache';

describe('BlobLruCache', () => {
  let cache: BlobLruCache;

  // Mock URL.revokeObjectURL
  let revokedUrls: string[];

  beforeEach(() => {
    cache = new BlobLruCache(3);
    revokedUrls = [];
    spyOn(URL, 'revokeObjectURL').and.callFake((url: string) => {
      revokedUrls.push(url);
    });
  });

  it('should be created with correct max size', () => {
    expect(cache.size).toBe(0);
  });

  describe('get / set', () => {
    it('should store and retrieve values', () => {
      cache.set('key1', 'blob:url1');
      expect(cache.get('key1')).toBe('blob:url1');
    });

    it('should return undefined for missing keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should overwrite existing keys', () => {
      cache.set('key1', 'blob:old');
      cache.set('key1', 'blob:new');
      expect(cache.get('key1')).toBe('blob:new');
      expect(cache.size).toBe(1);
    });
  });

  describe('eviction', () => {
    it('should evict oldest entry when at capacity', () => {
      cache.set('a', 'blob:a');
      cache.set('b', 'blob:b');
      cache.set('c', 'blob:c');
      // Cache is full (3 items)
      cache.set('d', 'blob:d');

      // 'a' should have been evicted
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('d')).toBe('blob:d');
      expect(cache.size).toBe(3);
    });

    it('should revoke evicted blob URLs', () => {
      cache.set('a', 'blob:a');
      cache.set('b', 'blob:b');
      cache.set('c', 'blob:c');
      cache.set('d', 'blob:d');

      expect(revokedUrls).toContain('blob:a');
    });

    it('should update LRU order on get (recently accessed items survive)', () => {
      cache.set('a', 'blob:a');
      cache.set('b', 'blob:b');
      cache.set('c', 'blob:c');

      // Access 'a' to make it most recently used
      cache.get('a');

      // Adding 'd' should evict 'b' (least recently used), not 'a'
      cache.set('d', 'blob:d');

      expect(cache.get('a')).toBe('blob:a');
      expect(cache.get('b')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for existing keys', () => {
      cache.set('key', 'blob:url');
      expect(cache.has('key')).toBeTrue();
    });

    it('should return false for missing keys', () => {
      expect(cache.has('missing')).toBeFalse();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      cache.set('a', 'blob:a');
      cache.set('b', 'blob:b');

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });

    it('should revoke all blob URLs on clear', () => {
      cache.set('a', 'blob:a');
      cache.set('b', 'blob:b');

      cache.clear();

      expect(revokedUrls).toContain('blob:a');
      expect(revokedUrls).toContain('blob:b');
    });
  });

  describe('evictByPrefix', () => {
    it('should remove entries matching prefix', () => {
      cache.set('grid:photo1', 'blob:1');
      cache.set('grid:photo2', 'blob:2');
      cache.set('full:photo1', 'blob:3');

      cache.evictByPrefix('grid:');

      expect(cache.get('grid:photo1')).toBeUndefined();
      expect(cache.get('grid:photo2')).toBeUndefined();
      expect(cache.get('full:photo1')).toBe('blob:3');
      expect(cache.size).toBe(1);
    });

    it('should revoke URLs of evicted entries', () => {
      cache.set('grid:a', 'blob:grid-a');
      cache.set('full:a', 'blob:full-a');

      cache.evictByPrefix('grid:');

      expect(revokedUrls).toContain('blob:grid-a');
      expect(revokedUrls).not.toContain('blob:full-a');
    });

    it('should do nothing when no entries match', () => {
      cache.set('grid:a', 'blob:a');

      cache.evictByPrefix('preview:');

      expect(cache.size).toBe(1);
      expect(revokedUrls.length).toBe(0);
    });
  });
});
