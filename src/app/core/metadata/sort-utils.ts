import type { PhotoItem } from '../album/photo.service';
import type { MetadataRecord, SortCriterion } from './metadata.models';

const SORT_PREF_KEY_PREFIX = 'intimapic_sort_';

/**
 * Sort photos alphabetically by decrypted filename in ascending order.
 * Uses natural numeric sorting (e.g., "photo2" before "photo10").
 */
export function sortByFilename(a: PhotoItem, b: PhotoItem): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Sort photos by capture date in descending order (newest first).
 * Photos with null captureDate are placed at the end.
 */
export function sortByCaptureDate(
  a: PhotoItem,
  b: PhotoItem,
  metadata: Map<string, MetadataRecord>
): number {
  const dateA = metadata.get(a.encryptedName)?.captureDate ?? null;
  const dateB = metadata.get(b.encryptedName)?.captureDate ?? null;

  if (dateA === null && dateB === null) return 0;
  if (dateA === null) return 1;
  if (dateB === null) return -1;

  return dateB.localeCompare(dateA);
}

/**
 * Sort photos by rating in descending order (highest first).
 * Unrated photos are placed at the end.
 * Among photos with equal rating, favorites appear first.
 */
export function sortByRating(
  a: PhotoItem,
  b: PhotoItem,
  metadata: Map<string, MetadataRecord>
): number {
  const metaA = metadata.get(a.encryptedName);
  const metaB = metadata.get(b.encryptedName);
  const ratingA = metaA?.rating ?? null;
  const ratingB = metaB?.rating ?? null;
  const favA = metaA?.isFavorite ?? false;
  const favB = metaB?.isFavorite ?? false;

  if (ratingA === null && ratingB === null) {
    if (favA !== favB) return favA ? -1 : 1;
    return 0;
  }
  if (ratingA === null) return 1;
  if (ratingB === null) return -1;

  if (ratingA !== ratingB) return ratingB - ratingA;
  if (favA !== favB) return favA ? -1 : 1;
  return 0;
}

/**
 * Get the persisted sort preference for an album from localStorage.
 * Returns 'filename' as default when no preference is stored.
 */
export function getSortPreference(albumId: string): SortCriterion {
  const stored = localStorage.getItem(`${SORT_PREF_KEY_PREFIX}${albumId}`);
  if (stored === 'captureDate' || stored === 'rating') return stored;
  return 'filename';
}

/**
 * Persist the sort preference for an album to localStorage.
 */
export function setSortPreference(albumId: string, criterion: SortCriterion): void {
  localStorage.setItem(`${SORT_PREF_KEY_PREFIX}${albumId}`, criterion);
}
