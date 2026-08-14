/**
 * Responses sent from the ServiceWorker to the Main Thread (Page).
 * Each response is a discriminated union on the `type` field.
 */

// ─── Photo/Album Data Types ────────────────────────────────────────────────────

export interface CachedAlbum {
  /** Cleartext album name */
  name: string;
  /** Cryptomator directory ID (UUID) */
  directoryId: string;
  /** Storage path (d/XX/YYYY...) */
  storagePath: string;
  /** Encrypted folder name (.c9r) */
  encryptedName: string;
}

export interface CachedPhotoEntry {
  /** Encrypted filename as stored (e.g. "abc123.c9r") */
  encryptedName: string;
  /** Decrypted original filename */
  name: string;
  /** Full storage path to the encrypted original file */
  storagePath: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp (ISO string) */
  lastModified: string;
}

// ─── Success Responses ─────────────────────────────────────────────────────────

export interface AckResponse {
  type: 'ACK';
}

export interface AlbumsListResponse {
  type: 'ALBUMS_LIST';
  albums: CachedAlbum[];
  fromCache: boolean;
}

export interface PhotosListResponse {
  type: 'PHOTOS_LIST';
  directoryId: string;
  photos: CachedPhotoEntry[];
  fromCache: boolean;
}

export interface FileDataResponse {
  type: 'FILE_DATA';
  data: ArrayBuffer;
  fromCache: boolean;
}

export interface FileExistsResponse {
  type: 'FILE_EXISTS';
  exists: boolean;
}

export interface CacheStatsResponse {
  type: 'CACHE_STATS';
  totalEntries: number;
  totalSizeBytes: number;
  quotaUsedPercent: number;
  oldestEntry: number;
}

export interface QuotaResponse {
  type: 'QUOTA';
  used: number;
  total: number;
}

export interface ConnectivityResponse {
  type: 'CONNECTIVITY';
  online: boolean;
}

export interface VaultMetaResponse {
  type: 'VAULT_META';
  masterkeyFile: ArrayBuffer;
  vaultConfig?: ArrayBuffer;
}

// ─── Control Responses ─────────────────────────────────────────────────────────

export interface NeedKeysResponse {
  type: 'NEED_KEYS';
}

export interface NeedTokenResponse {
  type: 'NEED_TOKEN';
  provider: 'onedrive' | 's3';
}

export interface ErrorResponse {
  type: 'ERROR';
  code: SwErrorCode;
  message: string;
}

export type SwErrorCode =
  | 'KEYS_NOT_SET'
  | 'KEYS_ALREADY_SET'
  | 'TOKEN_EXPIRED'
  | 'NETWORK_ERROR'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'FILE_NOT_FOUND'
  | 'DECRYPT_FAILED'
  | 'PROVIDER_ERROR'
  | 'CACHE_ERROR'
  | 'OFFLINE'
  | 'NOT_CACHED'
  | 'INVALID_COMMAND';

// ─── Push Notifications (SW → Page, unsolicited) ───────────────────────────────

export interface DirectoryUpdatedPush {
  type: 'DIRECTORY_UPDATED';
  directoryId: string;
  addedCount: number;
  removedCount: number;
}

export interface ConnectivityChangedPush {
  type: 'CONNECTIVITY_CHANGED';
  online: boolean;
}

export interface CacheEvictionPush {
  type: 'CACHE_EVICTION';
  evictedCount: number;
  reason: 'quota' | 'lock' | 'manual';
}

export interface ICloudProxyRequestPush {
  type: 'ICLOUD_PROXY_REQUEST';
  requestId: string;
  operation: 'listFiles' | 'readFile' | 'writeFile' | 'deleteFile' | 'fileExists' | 'createFolder' | 'deleteFolder';
  path: string;
  data?: ArrayBuffer;
}

// ─── Union Types ───────────────────────────────────────────────────────────────

export type SwResponse =
  | AckResponse
  | AlbumsListResponse
  | PhotosListResponse
  | FileDataResponse
  | FileExistsResponse
  | CacheStatsResponse
  | QuotaResponse
  | ConnectivityResponse
  | VaultMetaResponse
  | NeedKeysResponse
  | NeedTokenResponse
  | ErrorResponse;

export type SwPushMessage =
  | DirectoryUpdatedPush
  | ConnectivityChangedPush
  | CacheEvictionPush
  | ICloudProxyRequestPush;
