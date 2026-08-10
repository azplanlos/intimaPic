/**
 * Shared constants and utilities for supported image file types.
 *
 * Single source of truth used across the app (upload, import wizard,
 * photo service, etc.) to ensure consistent file type support everywhere.
 */

/** All supported image file extensions (lowercase, with leading dot). */
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.gif',
  '.bmp',
];

/**
 * MIME types accepted by file inputs / drag-and-drop.
 * Matches the extensions in IMAGE_EXTENSIONS.
 */
export const IMAGE_ACCEPT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/bmp',
];

/** Comma-separated accept string for use in HTML file inputs. */
export const IMAGE_ACCEPT_STRING = IMAGE_ACCEPT_TYPES.join(',');

/**
 * Check whether a filename represents a supported image file.
 */
export function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Derive the MIME type from a filename.
 * Falls back to 'image/jpeg' for .jpg/.jpeg and unknown extensions.
 */
export function getMimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}
