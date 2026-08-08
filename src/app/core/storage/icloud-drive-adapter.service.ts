import { Injectable } from '@angular/core';
import { StorageAdapter, StorageQuota } from './storage-adapter.interface';
import type { FileEntry, ICloudConfig } from '../crypto/crypto.models';

/**
 * iCloud Drive storage adapter using the File System Access API.
 *
 * This adapter works only on Apple devices where iCloud Drive is accessible
 * via the local file system. It uses the File System Access API
 * (showDirectoryPicker) to get a handle to the iCloud Drive folder.
 *
 * Limitations:
 * - Only available on supported browsers (Safari, Chrome)
 * - Requires user gesture to pick directory
 * - No web-based iCloud API available
 */
@Injectable({ providedIn: 'root' })
export class ICloudDriveAdapter implements StorageAdapter {
  readonly providerName = 'iCloud Drive';

  private config: ICloudConfig | null = null;
  private rootHandle: FileSystemDirectoryHandle | null = null;
  private connected = false;

  /**
   * Configure the adapter.
   */
  configure(config: ICloudConfig, _rootPath?: string): void {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (!this.isFileSystemAccessSupported()) {
      throw new Error(
        'File System Access API is not supported in this browser. ' +
        'iCloud Drive access requires a compatible browser on an Apple device.'
      );
    }

    // If we have a stored handle, try to re-use it
    if (this.rootHandle) {
      const handle = this.rootHandle as any;
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        this.connected = true;
        return;
      }
      // Try requesting permission again
      const newPermission = await handle.requestPermission({ mode: 'readwrite' });
      if (newPermission === 'granted') {
        this.connected = true;
        return;
      }
    }

    // Need user gesture to pick directory
    try {
      this.rootHandle = await (window as any).showDirectoryPicker({
        id: 'intimapic-icloud',
        mode: 'readwrite',
        startIn: 'documents',
      });
      this.connected = true;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Directory picker was cancelled by user.');
      }
      throw new Error(`Failed to access iCloud Drive: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  async disconnect(): Promise<void> {
    this.rootHandle = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.rootHandle !== null;
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    this.ensureConnected();
    const dirHandle = await this.navigateToPath(path);
    const entries: FileEntry[] = [];

    for await (const [name, handle] of (dirHandle as any).entries()) {
      const isDir = handle.kind === 'directory';
      let size = 0;
      let lastModified = new Date();

      if (!isDir) {
        const file = await (handle as FileSystemFileHandle).getFile();
        size = file.size;
        lastModified = new Date(file.lastModified);
      }

      entries.push({
        encryptedName: name,
        path: path ? `${path}/${name}` : name,
        size,
        lastModified,
        isDirectory: isDir,
      });
    }

    return entries;
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    this.ensureConnected();
    const { dir, fileName } = this.splitPath(path);
    const dirHandle = await this.navigateToPath(dir);
    const fileHandle = await dirHandle.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return file.arrayBuffer();
  }

  async writeFile(path: string, data: ArrayBuffer): Promise<void> {
    this.ensureConnected();
    const { dir, fileName } = this.splitPath(path);
    const dirHandle = await this.navigateToPath(dir);
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await (fileHandle as any).createWritable();
    await writable.write(data);
    await writable.close();
  }

  async deleteFile(path: string): Promise<void> {
    this.ensureConnected();
    const { dir, fileName } = this.splitPath(path);
    const dirHandle = await this.navigateToPath(dir);
    await dirHandle.removeEntry(fileName);
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      const { dir, fileName } = this.splitPath(path);
      const dirHandle = await this.navigateToPath(dir);
      await dirHandle.getFileHandle(fileName);
      return true;
    } catch {
      return false;
    }
  }

  async createFolder(path: string): Promise<void> {
    this.ensureConnected();
    const { dir, fileName } = this.splitPath(path);
    const dirHandle = await this.navigateToPath(dir);
    await dirHandle.getDirectoryHandle(fileName, { create: true });
  }

  async deleteFolder(path: string): Promise<void> {
    this.ensureConnected();
    const { dir, fileName } = this.splitPath(path);
    const dirHandle = await this.navigateToPath(dir);
    await dirHandle.removeEntry(fileName, { recursive: true });
  }

  async getQuota(): Promise<StorageQuota> {
    // File System Access API doesn't expose quota info
    // Return estimate from StorageManager if available
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      return {
        used: estimate.usage ?? 0,
        total: estimate.quota ?? 0,
      };
    }
    return { used: 0, total: 0 };
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.connected || !this.rootHandle) {
      throw new Error('iCloud Drive adapter is not connected. Call connect() first.');
    }
  }

  private splitPath(path: string): { dir: string; fileName: string } {
    const parts = path.split('/').filter(p => p.length > 0);
    const fileName = parts.pop() || '';
    return { dir: parts.join('/'), fileName };
  }

  private async navigateToPath(path: string): Promise<FileSystemDirectoryHandle> {
    if (!this.rootHandle) {
      throw new Error('No root directory handle');
    }

    if (!path || path === '/' || path === '.') {
      return this.rootHandle;
    }

    const parts = path.split('/').filter(p => p.length > 0);
    let current = this.rootHandle;

    for (const part of parts) {
      current = await current.getDirectoryHandle(part);
    }

    return current;
  }

  private isFileSystemAccessSupported(): boolean {
    return 'showDirectoryPicker' in window;
  }
}
