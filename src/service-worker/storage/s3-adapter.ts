/**
 * S3 storage adapter for the ServiceWorker context.
 * Uses a Lambda endpoint for pre-signed URL generation.
 *
 * Architecture identical to main-thread version:
 * - POST /presign → { action, key } → { url, method }
 * - POST /list → { prefix } → { files: [...] }
 * - GET /quota → { used, total }
 */

import type { SwStorageAdapter, FileEntry, StorageQuota } from './storage-adapter.interface';

interface PreSignedUrlResponse {
  url: string;
  method: string;
}

interface ListObjectsResponse {
  files: Array<{
    key: string;
    size: number;
    lastModified: string;
    isDirectory: boolean;
  }>;
}

export class SwS3Adapter implements SwStorageAdapter {
  readonly providerName = 'AWS S3';

  private apiEndpoint: string | null = null;
  private rootPath = '';
  private authToken: string | null = null;
  private connected = false;

  connect(token: string, config?: Record<string, unknown>): void {
    this.authToken = token;
    if (config?.['apiEndpoint'] && typeof config['apiEndpoint'] === 'string') {
      this.apiEndpoint = config['apiEndpoint'];
    }
    if (config?.['rootPath'] && typeof config['rootPath'] === 'string') {
      this.rootPath = config['rootPath'].endsWith('/') ? config['rootPath'] : `${config['rootPath']}/`;
    }
    this.connected = true;
  }

  disconnect(): void {
    this.authToken = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.authToken !== null && this.apiEndpoint !== null;
  }

  updateToken(token: string): void {
    this.authToken = token;
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    this.ensureConnected();

    const prefix = this.resolveKey(path);
    const response = await this.apiRequest<ListObjectsResponse>('/list', { prefix });

    return response.files.map(file => ({
      encryptedName: this.extractName(file.key, prefix),
      path: path ? `${path}/${this.extractName(file.key, prefix)}` : this.extractName(file.key, prefix),
      size: file.size,
      lastModified: file.lastModified,
      isDirectory: file.isDirectory,
    }));
  }

  async readFile(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    this.ensureConnected();

    const key = this.resolveKey(path);
    const { url } = await this.getPreSignedUrl('get', key);

    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`S3 readFile failed: ${response.status}`);
    }
    return response.arrayBuffer();
  }

  async writeFile(path: string, data: ArrayBuffer): Promise<void> {
    this.ensureConnected();

    const key = this.resolveKey(path);
    const { url } = await this.getPreSignedUrl('put', key);

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    });

    if (!response.ok) {
      throw new Error(`S3 writeFile failed: ${response.status}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    this.ensureConnected();

    const key = this.resolveKey(path);
    const { url } = await this.getPreSignedUrl('delete', key);

    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 deleteFile failed: ${response.status}`);
    }
  }

  async fileExists(path: string): Promise<boolean> {
    this.ensureConnected();
    const key = this.resolveKey(path);
    try {
      const { url } = await this.getPreSignedUrl('head', key);
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async createFolder(path: string): Promise<void> {
    this.ensureConnected();

    const key = this.resolveKey(path).replace(/\/?$/, '/');
    const { url } = await this.getPreSignedUrl('put', key);

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-directory' },
      body: new ArrayBuffer(0),
    });

    if (!response.ok) {
      throw new Error(`S3 createFolder failed: ${response.status}`);
    }
  }

  async deleteFolder(path: string): Promise<void> {
    this.ensureConnected();

    const prefix = this.resolveKey(path).replace(/\/?$/, '/');
    const listResult = await this.apiRequest<ListObjectsResponse>('/list', { prefix });

    const batchSize = 10;
    for (let i = 0; i < listResult.files.length; i += batchSize) {
      const batch = listResult.files.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async file => {
          const presigned = await this.getPreSignedUrl('delete', file.key);
          await fetch(presigned.url, { method: 'DELETE' });
        })
      );
    }

    try {
      const presigned = await this.getPreSignedUrl('delete', prefix);
      await fetch(presigned.url, { method: 'DELETE' });
    } catch { /* folder marker may not exist */ }
  }

  async getQuota(): Promise<StorageQuota> {
    this.ensureConnected();
    try {
      return await this.apiRequest<StorageQuota>('/quota', {});
    } catch {
      return { used: 0, total: 5 * 1024 * 1024 * 1024 * 1024 };
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private resolveKey(relativePath: string): string {
    if (!relativePath || relativePath === '/' || relativePath === '.') return this.rootPath;
    const clean = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return `${this.rootPath}${clean}`;
  }

  private extractName(key: string, prefix: string): string {
    const withoutPrefix = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    return withoutPrefix.replace(/\/$/, '');
  }

  private ensureConnected(): void {
    if (!this.connected || !this.authToken || !this.apiEndpoint) {
      throw new Error('S3 adapter not connected.');
    }
  }

  private async getPreSignedUrl(action: string, key: string): Promise<PreSignedUrlResponse> {
    return this.apiRequest<PreSignedUrlResponse>('/presign', { action, key });
  }

  private async apiRequest<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.apiEndpoint}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`S3 API ${endpoint} failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}
