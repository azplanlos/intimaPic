import { FileEntry } from '../crypto/crypto.models';

/**
 * Quota information for a storage provider.
 */
export interface StorageQuota {
  /** Used space in bytes */
  used: number;
  /** Total available space in bytes */
  total: number;
}

/**
 * Abstract interface for cloud storage providers.
 * Each provider (OneDrive, S3, iCloud) implements this interface.
 */
export interface StorageAdapter {
  /** Human-readable provider name */
  readonly providerName: string;

  // ─── Connection ──────────────────────────────────────────────────

  /**
   * Establish connection / authenticate with the provider.
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the provider.
   */
  disconnect(): Promise<void>;

  /**
   * Whether currently connected/authenticated.
   */
  isConnected(): boolean;

  // ─── File Operations ─────────────────────────────────────────────

  /**
   * List files and folders at the given path.
   * @param path - Relative path within the encrypted root
   */
  listFiles(path: string): Promise<FileEntry[]>;

  /**
   * Read a file's contents.
   * @param path - Full path to the file
   * @param signal - Optional AbortSignal to cancel the request
   * @returns Raw file bytes
   */
  readFile(path: string, signal?: AbortSignal): Promise<ArrayBuffer>;

  /**
   * Write/upload a file.
   * @param path - Full path where the file should be stored
   * @param data - File contents as ArrayBuffer
   */
  writeFile(path: string, data: ArrayBuffer): Promise<void>;

  /**
   * Delete a file.
   * @param path - Full path to the file
   */
  deleteFile(path: string): Promise<void>;

  /**
   * Check if a file exists at the given path.
   */
  fileExists(path: string): Promise<boolean>;

  // ─── Folder Operations ───────────────────────────────────────────

  /**
   * Create a folder.
   * @param path - Full path for the new folder
   */
  createFolder(path: string): Promise<void>;

  /**
   * Delete a folder and all its contents.
   * @param path - Full path to the folder
   */
  deleteFolder(path: string): Promise<void>;

  // ─── Metadata ────────────────────────────────────────────────────

  /**
   * Get storage quota information.
   */
  getQuota(): Promise<StorageQuota>;
}
