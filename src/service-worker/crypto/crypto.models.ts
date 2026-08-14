/**
 * Minimal crypto models for the ServiceWorker context.
 * These are a subset of the main app's crypto.models.ts.
 */

export interface MasterKeys {
  encryptionKey: ArrayBuffer;
  macKey: ArrayBuffer;
}

export interface FileEntry {
  encryptedName: string;
  path: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}
