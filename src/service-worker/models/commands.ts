/**
 * Commands sent from the Main Thread (Page) to the ServiceWorker.
 * Each command is a discriminated union on the `type` field.
 */

// ─── Lifecycle Commands ────────────────────────────────────────────────────────

export interface InitKeysCommand {
  type: 'INIT_KEYS';
  encryptionKey: ArrayBuffer;
  macKey: ArrayBuffer;
  vaultId: string;
}

export interface LockCommand {
  type: 'LOCK';
}

export interface SetAuthTokenCommand {
  type: 'SET_AUTH_TOKEN';
  provider: 'onedrive' | 's3';
  token: string;
  refreshToken?: string;
  expiresAt: number;
  /** Provider-specific config needed for API calls */
  providerConfig?: Record<string, unknown>;
}

// ─── Album/Directory Operations ────────────────────────────────────────────────

export interface ListAlbumsCommand {
  type: 'LIST_ALBUMS';
  forceRefresh?: boolean;
}

export interface ListPhotosCommand {
  type: 'LIST_PHOTOS';
  directoryId: string;
  forceRefresh?: boolean;
}

// ─── File Operations ───────────────────────────────────────────────────────────

export interface GetThumbnailCommand {
  type: 'GET_THUMBNAIL';
  encryptedName: string;
  directoryId: string;
  size: 'grid' | 'preview';
}

export interface GetFileCommand {
  type: 'GET_FILE';
  path: string;
}

export interface WriteFileCommand {
  type: 'WRITE_FILE';
  path: string;
  data: ArrayBuffer;
}

export interface DeleteFileCommand {
  type: 'DELETE_FILE';
  path: string;
}

export interface FileExistsCommand {
  type: 'FILE_EXISTS';
  path: string;
}

export interface CreateFolderCommand {
  type: 'CREATE_FOLDER';
  path: string;
}

export interface DeleteFolderCommand {
  type: 'DELETE_FOLDER';
  path: string;
}

// ─── Cache Management ──────────────────────────────────────────────────────────

export interface InvalidateCacheCommand {
  type: 'INVALIDATE_CACHE';
  scope: 'all' | 'directory' | 'thumbnails';
  directoryId?: string;
}

export interface GetCacheStatsCommand {
  type: 'GET_CACHE_STATS';
}

// ─── Storage Info ──────────────────────────────────────────────────────────────

export interface GetQuotaCommand {
  type: 'GET_QUOTA';
}

export interface CheckConnectivityCommand {
  type: 'CHECK_CONNECTIVITY';
}

// ─── Vault Meta ────────────────────────────────────────────────────────────────

export interface GetCachedVaultMetaCommand {
  type: 'GET_CACHED_VAULT_META';
  vaultId: string;
}

// ─── iCloud Proxy Response (Page → SW) ─────────────────────────────────────────

export interface ICloudProxyResponseCommand {
  type: 'ICLOUD_PROXY_RESPONSE';
  requestId: string;
  result?: ArrayBuffer | unknown;
  error?: string;
}

// ─── Union Type ────────────────────────────────────────────────────────────────

export type SwCommand =
  | InitKeysCommand
  | LockCommand
  | SetAuthTokenCommand
  | ListAlbumsCommand
  | ListPhotosCommand
  | GetThumbnailCommand
  | GetFileCommand
  | WriteFileCommand
  | DeleteFileCommand
  | FileExistsCommand
  | CreateFolderCommand
  | DeleteFolderCommand
  | InvalidateCacheCommand
  | GetCacheStatsCommand
  | GetQuotaCommand
  | CheckConnectivityCommand
  | GetCachedVaultMetaCommand
  | ICloudProxyResponseCommand;
