export interface MetadataRecord {
  /** Encrypted filename (primary key, same as PhotoItem.encryptedName) */
  photoId: string;
  /** EXIF DateTimeOriginal or DateTimeDigitized, null if unavailable */
  captureDate: string | null; // ISO 8601 string for IndexedDB compatibility
  /** EXIF Make field */
  cameraMake: string | null;
  /** EXIF Model field */
  cameraModel: string | null;
  /** User rating 1–5, null if unrated */
  rating: number | null;
  /** User favorite flag */
  isFavorite: boolean;
  /** Last modification timestamp (ms since epoch) for sync merge */
  updatedAt: number;
}

export type SortCriterion = 'filename' | 'captureDate' | 'rating';

export interface VaultMetadataPayload {
  version: 1;
  records: MetadataRecord[];
}
