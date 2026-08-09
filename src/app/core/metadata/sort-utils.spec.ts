import type { PhotoItem } from '../album/photo.service';
import type { MetadataRecord } from './metadata.models';
import {
  sortByFilename,
  sortByCaptureDate,
  sortByRating,
  getSortPreference,
  setSortPreference,
} from './sort-utils';

/** Helper to create a minimal PhotoItem for testing. */
function makePhoto(name: string, encryptedName?: string): PhotoItem {
  return {
    name,
    encryptedName: encryptedName ?? `enc_${name}`,
    storagePath: `/vault/photos/${encryptedName ?? `enc_${name}`}`,
    thumbnailUrl: null,
    previewUrl: null,
    fullResUrl: null,
    loading: false,
    size: 1024,
  };
}

/** Helper to create a MetadataRecord for testing. */
function makeMetadata(
  photoId: string,
  overrides: Partial<MetadataRecord> = {}
): MetadataRecord {
  return {
    photoId,
    captureDate: null,
    cameraMake: null,
    cameraModel: null,
    rating: null,
    isFavorite: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Property 8: Filename Sort Correctness
 *
 * For any list of PhotoItems, applying sortByFilename SHALL produce a list where
 * for all adjacent pairs (a, b), a.name.localeCompare(b.name) <= 0
 * (ascending alphabetical order with natural numeric sorting).
 *
 * **Validates: Requirements 6.3**
 */
describe('Sort Utils – Property 8: Filename Sort Correctness', () => {
  it('should sort with natural numeric ordering (photo1 < photo2 < photo10)', () => {
    const photos = [
      makePhoto('photo10'),
      makePhoto('photo2'),
      makePhoto('photo1'),
    ];

    const sorted = [...photos].sort(sortByFilename);

    expect(sorted.map(p => p.name)).toEqual(['photo1', 'photo2', 'photo10']);
  });

  it('should sort case-insensitively', () => {
    const photos = [
      makePhoto('Banana'),
      makePhoto('apple'),
      makePhoto('Cherry'),
    ];

    const sorted = [...photos].sort(sortByFilename);

    expect(sorted.map(p => p.name)).toEqual(['apple', 'Banana', 'Cherry']);
  });

  it('should handle an empty list', () => {
    const sorted: PhotoItem[] = [].sort(sortByFilename);
    expect(sorted).toEqual([]);
  });

  it('should handle a single item', () => {
    const photos = [makePhoto('only-one.jpg')];
    const sorted = [...photos].sort(sortByFilename);
    expect(sorted.map(p => p.name)).toEqual(['only-one.jpg']);
  });

  it('should sort mixed numeric prefixes correctly', () => {
    const photos = [
      makePhoto('img100'),
      makePhoto('img20'),
      makePhoto('img3'),
      makePhoto('img1'),
    ];

    const sorted = [...photos].sort(sortByFilename);

    expect(sorted.map(p => p.name)).toEqual(['img1', 'img3', 'img20', 'img100']);
  });

  it('should sort identical names as equal (stable)', () => {
    const photos = [
      makePhoto('same.jpg', 'enc_a'),
      makePhoto('same.jpg', 'enc_b'),
    ];

    const sorted = [...photos].sort(sortByFilename);

    // Both have same name, order among them doesn't matter, but sort should not crash
    expect(sorted.length).toBe(2);
    expect(sorted.every(p => p.name === 'same.jpg')).toBeTrue();
  });

  it('should sort special characters and unicode filenames', () => {
    const photos = [
      makePhoto('zzz.jpg'),
      makePhoto('aaa.jpg'),
      makePhoto('ÄÖÜ.jpg'),
    ];

    const sorted = [...photos].sort(sortByFilename);

    // 'aaa' should come first, exact locale order of Ä vs z varies but should not throw
    expect(sorted[0].name).toBe('aaa.jpg');
  });

  it('should maintain ascending order property for diverse inputs', () => {
    const photos = [
      makePhoto('z-file'),
      makePhoto('a-file'),
      makePhoto('m-file'),
      makePhoto('b-file2'),
      makePhoto('b-file10'),
      makePhoto('b-file1'),
    ];

    const sorted = [...photos].sort(sortByFilename);

    // Verify the ordering property: for all i < j, sorted[i].name <= sorted[j].name
    for (let i = 0; i < sorted.length - 1; i++) {
      const cmp = sorted[i].name.localeCompare(sorted[i + 1].name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });
});

/**
 * Property 9: Capture Date Sort Correctness
 *
 * For any list of PhotoItems with associated metadata, applying sortByCaptureDate SHALL
 * produce a list where: (1) all items with non-null captureDate appear before items with
 * null captureDate, and (2) among items with non-null captureDate, each item's captureDate
 * is >= the next item's captureDate (descending chronological order).
 *
 * **Validates: Requirements 6.4**
 */
describe('Sort Utils – Property 9: Capture Date Sort Correctness', () => {
  it('should sort newest first (descending)', () => {
    const photos = [
      makePhoto('old.jpg', 'enc_old'),
      makePhoto('new.jpg', 'enc_new'),
      makePhoto('mid.jpg', 'enc_mid'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_old', makeMetadata('enc_old', { captureDate: '2020-01-01T00:00:00.000Z' })],
      ['enc_new', makeMetadata('enc_new', { captureDate: '2024-06-15T12:00:00.000Z' })],
      ['enc_mid', makeMetadata('enc_mid', { captureDate: '2022-03-10T08:30:00.000Z' })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByCaptureDate(a, b, metadata));

    expect(sorted.map(p => p.name)).toEqual(['new.jpg', 'mid.jpg', 'old.jpg']);
  });

  it('should place nulls at the end', () => {
    const photos = [
      makePhoto('no-date.jpg', 'enc_nodate'),
      makePhoto('has-date.jpg', 'enc_hasdate'),
      makePhoto('also-no-date.jpg', 'enc_alsonodate'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_nodate', makeMetadata('enc_nodate', { captureDate: null })],
      ['enc_hasdate', makeMetadata('enc_hasdate', { captureDate: '2023-05-20T15:00:00.000Z' })],
      ['enc_alsonodate', makeMetadata('enc_alsonodate', { captureDate: null })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByCaptureDate(a, b, metadata));

    // The one with a date should be first
    expect(sorted[0].name).toBe('has-date.jpg');
    // The two with null dates should be at the end
    expect(sorted[1].encryptedName).toMatch(/enc_nodate|enc_alsonodate/);
    expect(sorted[2].encryptedName).toMatch(/enc_nodate|enc_alsonodate/);
  });

  it('should handle all nulls (order preserved, no crash)', () => {
    const photos = [
      makePhoto('a.jpg', 'enc_a'),
      makePhoto('b.jpg', 'enc_b'),
      makePhoto('c.jpg', 'enc_c'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_a', makeMetadata('enc_a', { captureDate: null })],
      ['enc_b', makeMetadata('enc_b', { captureDate: null })],
      ['enc_c', makeMetadata('enc_c', { captureDate: null })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByCaptureDate(a, b, metadata));

    // All nulls compare as 0, so sort is stable — original order preserved
    expect(sorted.length).toBe(3);
  });

  it('should handle mixed null and non-null dates with proper partitioning', () => {
    const photos = [
      makePhoto('p1', 'enc_1'),
      makePhoto('p2', 'enc_2'),
      makePhoto('p3', 'enc_3'),
      makePhoto('p4', 'enc_4'),
      makePhoto('p5', 'enc_5'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_1', makeMetadata('enc_1', { captureDate: '2021-01-01T00:00:00.000Z' })],
      ['enc_2', makeMetadata('enc_2', { captureDate: null })],
      ['enc_3', makeMetadata('enc_3', { captureDate: '2024-12-25T10:00:00.000Z' })],
      ['enc_4', makeMetadata('enc_4', { captureDate: null })],
      ['enc_5', makeMetadata('enc_5', { captureDate: '2022-06-01T00:00:00.000Z' })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByCaptureDate(a, b, metadata));

    // Verify property: non-null dates before null dates
    const nullIndex = sorted.findIndex(
      p => metadata.get(p.encryptedName)?.captureDate === null
    );
    // All items before nullIndex should have non-null captureDate
    for (let i = 0; i < nullIndex; i++) {
      expect(metadata.get(sorted[i].encryptedName)?.captureDate).not.toBeNull();
    }
    // All items from nullIndex onward should have null captureDate
    for (let i = nullIndex; i < sorted.length; i++) {
      expect(metadata.get(sorted[i].encryptedName)?.captureDate).toBeNull();
    }

    // Verify descending order among non-null dates
    for (let i = 0; i < nullIndex - 1; i++) {
      const dateA = metadata.get(sorted[i].encryptedName)!.captureDate!;
      const dateB = metadata.get(sorted[i + 1].encryptedName)!.captureDate!;
      expect(dateA >= dateB).toBeTrue();
    }
  });

  it('should handle photos with no metadata entry (treat as null date)', () => {
    const photos = [
      makePhoto('known.jpg', 'enc_known'),
      makePhoto('unknown.jpg', 'enc_unknown'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_known', makeMetadata('enc_known', { captureDate: '2023-01-01T00:00:00.000Z' })],
      // enc_unknown is NOT in the metadata map
    ]);

    const sorted = [...photos].sort((a, b) => sortByCaptureDate(a, b, metadata));

    expect(sorted[0].name).toBe('known.jpg');
    expect(sorted[1].name).toBe('unknown.jpg');
  });

  it('should handle an empty list', () => {
    const metadata = new Map<string, MetadataRecord>();
    const sorted: PhotoItem[] = [].sort((a, b) => sortByCaptureDate(a, b, metadata));
    expect(sorted).toEqual([]);
  });
});

/**
 * Property 10: Rating Sort Correctness
 *
 * For any list of PhotoItems with associated metadata, applying sortByRating SHALL
 * produce a list where: (1) all items with non-null rating appear before items with
 * null rating, (2) among items with non-null rating, each item's rating is >= the
 * next item's rating, and (3) among items with equal rating, favorites appear before
 * non-favorites.
 *
 * **Validates: Requirements 6.5**
 */
describe('Sort Utils – Property 10: Rating Sort Correctness', () => {
  it('should sort higher ratings first (descending)', () => {
    const photos = [
      makePhoto('low.jpg', 'enc_low'),
      makePhoto('high.jpg', 'enc_high'),
      makePhoto('mid.jpg', 'enc_mid'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_low', makeMetadata('enc_low', { rating: 1 })],
      ['enc_high', makeMetadata('enc_high', { rating: 5 })],
      ['enc_mid', makeMetadata('enc_mid', { rating: 3 })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByRating(a, b, metadata));

    expect(sorted.map(p => p.name)).toEqual(['high.jpg', 'mid.jpg', 'low.jpg']);
  });

  it('should place unrated photos at the end', () => {
    const photos = [
      makePhoto('unrated.jpg', 'enc_unrated'),
      makePhoto('rated.jpg', 'enc_rated'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_unrated', makeMetadata('enc_unrated', { rating: null })],
      ['enc_rated', makeMetadata('enc_rated', { rating: 2 })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByRating(a, b, metadata));

    expect(sorted[0].name).toBe('rated.jpg');
    expect(sorted[1].name).toBe('unrated.jpg');
  });

  it('should place favorites first among equal ratings', () => {
    const photos = [
      makePhoto('nonfav.jpg', 'enc_nonfav'),
      makePhoto('fav.jpg', 'enc_fav'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_nonfav', makeMetadata('enc_nonfav', { rating: 4, isFavorite: false })],
      ['enc_fav', makeMetadata('enc_fav', { rating: 4, isFavorite: true })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByRating(a, b, metadata));

    expect(sorted[0].name).toBe('fav.jpg');
    expect(sorted[1].name).toBe('nonfav.jpg');
  });

  it('should place favorites first among all unrated photos', () => {
    const photos = [
      makePhoto('unrated-nonfav.jpg', 'enc_a'),
      makePhoto('unrated-fav.jpg', 'enc_b'),
      makePhoto('unrated-nonfav2.jpg', 'enc_c'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_a', makeMetadata('enc_a', { rating: null, isFavorite: false })],
      ['enc_b', makeMetadata('enc_b', { rating: null, isFavorite: true })],
      ['enc_c', makeMetadata('enc_c', { rating: null, isFavorite: false })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByRating(a, b, metadata));

    // Favorite unrated should come first among unrated
    expect(sorted[0].name).toBe('unrated-fav.jpg');
  });

  it('should handle comprehensive rating + favorite combinations', () => {
    const photos = [
      makePhoto('p1', 'enc_1'),
      makePhoto('p2', 'enc_2'),
      makePhoto('p3', 'enc_3'),
      makePhoto('p4', 'enc_4'),
      makePhoto('p5', 'enc_5'),
      makePhoto('p6', 'enc_6'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_1', makeMetadata('enc_1', { rating: 3, isFavorite: false })],
      ['enc_2', makeMetadata('enc_2', { rating: 5, isFavorite: true })],
      ['enc_3', makeMetadata('enc_3', { rating: null, isFavorite: true })],
      ['enc_4', makeMetadata('enc_4', { rating: 5, isFavorite: false })],
      ['enc_5', makeMetadata('enc_5', { rating: null, isFavorite: false })],
      ['enc_6', makeMetadata('enc_6', { rating: 3, isFavorite: true })],
    ]);

    const sorted = [...photos].sort((a, b) => sortByRating(a, b, metadata));

    // Verify the properties:
    // 1) Rated items before unrated
    const ratedItems = sorted.filter(p => metadata.get(p.encryptedName)?.rating !== null);
    const unratedItems = sorted.filter(p => metadata.get(p.encryptedName)?.rating === null);

    // All rated should come before all unrated
    const lastRatedIndex = sorted.indexOf(ratedItems[ratedItems.length - 1]);
    const firstUnratedIndex = sorted.indexOf(unratedItems[0]);
    expect(lastRatedIndex).toBeLessThan(firstUnratedIndex);

    // 2) Among rated: descending rating
    for (let i = 0; i < ratedItems.length - 1; i++) {
      const rA = metadata.get(ratedItems[i].encryptedName)!.rating!;
      const rB = metadata.get(ratedItems[i + 1].encryptedName)!.rating!;
      expect(rA).toBeGreaterThanOrEqual(rB);
    }

    // 3) Among equal rating: favorites first
    // Rating 5: enc_2 (fav) before enc_4 (non-fav)
    const rating5 = sorted.filter(p => metadata.get(p.encryptedName)?.rating === 5);
    expect(rating5[0].encryptedName).toBe('enc_2'); // favorite
    expect(rating5[1].encryptedName).toBe('enc_4'); // non-favorite

    // Rating 3: enc_6 (fav) before enc_1 (non-fav)
    const rating3 = sorted.filter(p => metadata.get(p.encryptedName)?.rating === 3);
    expect(rating3[0].encryptedName).toBe('enc_6'); // favorite
    expect(rating3[1].encryptedName).toBe('enc_1'); // non-favorite

    // Among unrated: favorites first
    expect(unratedItems[0].encryptedName).toBe('enc_3'); // favorite
    expect(unratedItems[1].encryptedName).toBe('enc_5'); // non-favorite
  });

  it('should handle photos with no metadata entry (treat as unrated, non-favorite)', () => {
    const photos = [
      makePhoto('no-meta.jpg', 'enc_nometa'),
      makePhoto('rated.jpg', 'enc_rated'),
    ];
    const metadata = new Map<string, MetadataRecord>([
      ['enc_rated', makeMetadata('enc_rated', { rating: 3, isFavorite: false })],
      // enc_nometa not in metadata map
    ]);

    const sorted = [...photos].sort((a, b) => sortByRating(a, b, metadata));

    expect(sorted[0].name).toBe('rated.jpg');
    expect(sorted[1].name).toBe('no-meta.jpg');
  });

  it('should handle an empty list', () => {
    const metadata = new Map<string, MetadataRecord>();
    const sorted: PhotoItem[] = [].sort((a, b) => sortByRating(a, b, metadata));
    expect(sorted).toEqual([]);
  });
});

/**
 * Property 11: Sort Preference Persistence Round-Trip
 *
 * For any albumId and SortCriterion value, calling setSortPreference then
 * getSortPreference with the same albumId SHALL return the same SortCriterion value.
 *
 * **Validates: Requirements 6.6**
 */
describe('Sort Utils – Property 11: Sort Preference Persistence Round-Trip', () => {
  beforeEach(() => {
    // Clear any sort preferences from localStorage
    localStorage.clear();
  });

  it('should return "filename" as default when nothing is stored', () => {
    const result = getSortPreference('album-never-set');
    expect(result).toBe('filename');
  });

  it('should round-trip "filename" criterion', () => {
    setSortPreference('album-1', 'filename');
    expect(getSortPreference('album-1')).toBe('filename');
  });

  it('should round-trip "captureDate" criterion', () => {
    setSortPreference('album-2', 'captureDate');
    expect(getSortPreference('album-2')).toBe('captureDate');
  });

  it('should round-trip "rating" criterion', () => {
    setSortPreference('album-3', 'rating');
    expect(getSortPreference('album-3')).toBe('rating');
  });

  it('should persist independently per album', () => {
    setSortPreference('album-a', 'rating');
    setSortPreference('album-b', 'captureDate');
    setSortPreference('album-c', 'filename');

    expect(getSortPreference('album-a')).toBe('rating');
    expect(getSortPreference('album-b')).toBe('captureDate');
    expect(getSortPreference('album-c')).toBe('filename');
  });

  it('should overwrite previous preference on re-set', () => {
    setSortPreference('album-x', 'filename');
    expect(getSortPreference('album-x')).toBe('filename');

    setSortPreference('album-x', 'rating');
    expect(getSortPreference('album-x')).toBe('rating');

    setSortPreference('album-x', 'captureDate');
    expect(getSortPreference('album-x')).toBe('captureDate');
  });

  it('should default to "filename" for invalid stored values', () => {
    // Manually set an invalid value in localStorage
    localStorage.setItem('intimapic_sort_album-invalid', 'bogus_value');
    expect(getSortPreference('album-invalid')).toBe('filename');
  });

  it('should handle special characters in albumId', () => {
    const specialId = 'album/with spaces & special=chars!';
    setSortPreference(specialId, 'rating');
    expect(getSortPreference(specialId)).toBe('rating');
  });
});
