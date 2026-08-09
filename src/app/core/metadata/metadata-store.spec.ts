import { MetadataStore } from './metadata-store';
import { MetadataRecord } from './metadata.models';

/**
 * Property 2: Metadata Write Round-Trip
 *
 * For any MetadataRecord, writing it to MetadataStore and immediately reading
 * it back by photoId SHALL produce a record equal to the original.
 *
 * **Validates: Requirements 2.2**
 */
describe('MetadataStore – Property 2: Metadata Write Round-Trip', () => {
  let store: MetadataStore;

  beforeEach(() => {
    store = new MetadataStore();
    // Force in-memory fallback directly (simulates IndexedDB unavailable scenario)
    store['inMemoryFallback'] = new Map();
  });

  /**
   * Diverse sample inputs approximating property-based testing.
   * Each record exercises different field combinations (nulls, boundaries, unicode, etc.)
   */
  const sampleRecords: MetadataRecord[] = [
    // Typical record with all fields populated
    {
      photoId: 'enc_abc123.jpg',
      captureDate: '2024-06-15T10:30:00.000Z',
      cameraMake: 'Canon',
      cameraModel: 'EOS R5',
      rating: 5,
      isFavorite: true,
      updatedAt: 1718450000000,
    },
    // All nullable fields set to null
    {
      photoId: 'photo_null_fields',
      captureDate: null,
      cameraMake: null,
      cameraModel: null,
      rating: null,
      isFavorite: false,
      updatedAt: 0,
    },
    // Minimum rating boundary
    {
      photoId: 'min-rating-photo',
      captureDate: '2020-01-01T00:00:00.000Z',
      cameraMake: 'Sony',
      cameraModel: 'A7III',
      rating: 1,
      isFavorite: false,
      updatedAt: 1577836800000,
    },
    // Unicode characters in make/model
    {
      photoId: 'unicode_日本語_photo.heic',
      captureDate: '2023-12-31T23:59:59.999Z',
      cameraMake: 'フジフイルム',
      cameraModel: 'X-T5 カメラ',
      rating: 3,
      isFavorite: true,
      updatedAt: 1704067199999,
    },
    // Empty string photoId edge case
    {
      photoId: '',
      captureDate: '1999-01-01T00:00:00.000Z',
      cameraMake: '',
      cameraModel: '',
      rating: null,
      isFavorite: false,
      updatedAt: 1,
    },
    // Very long photoId (simulating encrypted filename)
    {
      photoId: 'a'.repeat(256) + '.enc',
      captureDate: '2025-03-10T08:15:30.500Z',
      cameraMake: 'Nikon',
      cameraModel: 'Z9',
      rating: 4,
      isFavorite: true,
      updatedAt: Number.MAX_SAFE_INTEGER,
    },
    // Special characters in photoId
    {
      photoId: 'photo/with spaces & special=chars!.jpg',
      captureDate: null,
      cameraMake: 'Apple',
      cameraModel: 'iPhone 15 Pro Max',
      rating: 2,
      isFavorite: false,
      updatedAt: 42,
    },
    // Rating at maximum boundary
    {
      photoId: 'max-rating-test',
      captureDate: '2024-01-15T12:00:00.000Z',
      cameraMake: null,
      cameraModel: 'Unknown Model',
      rating: 5,
      isFavorite: true,
      updatedAt: 1705320000000,
    },
    // isFavorite true with null rating
    {
      photoId: 'fav-no-rating',
      captureDate: '2022-07-04T20:00:00.000Z',
      cameraMake: 'Google',
      cameraModel: 'Pixel 8',
      rating: null,
      isFavorite: true,
      updatedAt: 1656964800000,
    },
    // Record with updatedAt of 0 (epoch)
    {
      photoId: 'epoch-timestamp-record',
      captureDate: '1970-01-01T00:00:00.000Z',
      cameraMake: 'Kodak',
      cameraModel: 'DC210',
      rating: 1,
      isFavorite: false,
      updatedAt: 0,
    },
  ];

  sampleRecords.forEach((record, index) => {
    it(`should round-trip record #${index + 1} (photoId: "${record.photoId.substring(0, 30)}...")`, async () => {
      // Write
      await store.put(record);

      // Read back
      const retrieved = await store.get(record.photoId);

      // Assert equality
      expect(retrieved).toBeDefined();
      expect(retrieved).toEqual(record);
    });
  });

  it('should round-trip multiple records written via putBatch and read individually', async () => {
    await store.putBatch(sampleRecords);

    for (const record of sampleRecords) {
      const retrieved = await store.get(record.photoId);
      expect(retrieved).toEqual(record);
    }
  });

  it('should return undefined for a photoId that was never written', async () => {
    const result = await store.get('nonexistent-photo-id');
    expect(result).toBeUndefined();
  });

  it('should round-trip an overwritten record (last write wins locally)', async () => {
    const original: MetadataRecord = {
      photoId: 'overwrite-test',
      captureDate: '2024-01-01T00:00:00.000Z',
      cameraMake: 'Canon',
      cameraModel: 'R5',
      rating: 3,
      isFavorite: false,
      updatedAt: 1000,
    };

    const updated: MetadataRecord = {
      ...original,
      rating: 5,
      isFavorite: true,
      updatedAt: 2000,
    };

    await store.put(original);
    await store.put(updated);

    const retrieved = await store.get('overwrite-test');
    expect(retrieved).toEqual(updated);
  });
});
