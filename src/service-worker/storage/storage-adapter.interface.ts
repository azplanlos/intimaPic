/**
 * Storage adapter interface for the ServiceWorker context.
 * Functionally identical to the main app's StorageAdapter but without
 * Angular DI and adapted for the SW environment.
 */

export interface FileEntry {
  encryptedName: string;
  path: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

export interface StorageQuota {
  used: number;
  total: number;
}

export interface SwStorageAdapter {
  readonly providerName: string;

  connect(token: string, config?: Record<string, unknown>): void;
  disconnect(): void;
  isConnected(): boolean;

  listFiles(path: string): Promise<FileEntry[]>;
  readFile(path: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  getQuota(): Promise<StorageQuota>;
}
