import { Injectable } from '@angular/core';
import { StorageAdapter, StorageQuota } from './storage-adapter.interface';
import type { FileEntry, S3Config } from '../crypto/crypto.models';

/**
 * Response from the Lambda pre-signed URL endpoint.
 */
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

/**
 * S3 storage adapter that uses a Lambda endpoint to generate pre-signed URLs.
 *
 * Architecture:
 * - Client requests pre-signed URLs from a Lambda endpoint (API Gateway)
 * - Client performs direct uploads/downloads to/from S3 using those URLs
 * - This avoids storing AWS credentials on the client
 *
 * Lambda endpoints expected:
 * - POST /presign  → { action: 'get'|'put'|'delete', key: string } → { url, method }
 * - POST /list     → { prefix: string } → { files: [...] }
 * - GET  /quota    → { used, total }
 */
@Injectable({ providedIn: 'root' })
export class S3Adapter implements StorageAdapter {
  readonly providerName = 'AWS S3';

  private config: S3Config | null = null;
  private rootPath = '';
  private connected = false;
  private authToken: string | null = null;

  /**
   * Configure the adapter with S3/Lambda-specific settings.
   */
  configure(config: S3Config, rootPath?: string): void {
    this.config = config;
    if (rootPath) {
      this.rootPath = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
    }
  }

  /**
   * Set the auth token for Lambda API calls (e.g. Cognito JWT).
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  async connect(): Promise<void> {
    if (!this.config) {
      throw new Error('S3 adapter not configured. Call configure() first.');
    }

    // Verify connectivity by requesting a listing of the root
    try {
      await this.apiRequest<ListObjectsResponse>('/list', { prefix: this.rootPath });
      this.connected = true;
    } catch (err) {
      throw new Error(`S3 connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.authToken = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    this.ensureConnected();

    const prefix = this.resolveKey(path);
    const response = await this.apiRequest<ListObjectsResponse>('/list', { prefix });

    return response.files.map(file => ({
      encryptedName: this.extractName(file.key, prefix),
      path: path ? `${path}/${this.extractName(file.key, prefix)}` : this.extractName(file.key, prefix),
      size: file.size,
      lastModified: new Date(file.lastModified),
      isDirectory: file.isDirectory,
    }));
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    this.ensureConnected();

    const key = this.resolveKey(path);
    const { url } = await this.getPreSignedUrl('get', key);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`S3 readFile failed: ${response.status} ${response.statusText}`);
    }

    return response.arrayBuffer();
  }

  async writeFile(path: string, data: ArrayBuffer): Promise<void> {
    this.ensureConnected();

    const key = this.resolveKey(path);
    const { url } = await this.getPreSignedUrl('put', key);

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: data,
    });

    if (!response.ok) {
      throw new Error(`S3 writeFile failed: ${response.status} ${response.statusText}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    this.ensureConnected();

    const key = this.resolveKey(path);
    const { url } = await this.getPreSignedUrl('delete', key);

    const response = await fetch(url, { method: 'DELETE' });

    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 deleteFile failed: ${response.status} ${response.statusText}`);
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

    // In S3, folders are created by putting a zero-byte object with trailing slash
    const key = this.resolveKey(path).replace(/\/?$/, '/');
    const { url } = await this.getPreSignedUrl('put', key);

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-directory' },
      body: new ArrayBuffer(0),
    });

    if (!response.ok) {
      throw new Error(`S3 createFolder failed: ${response.status} ${response.statusText}`);
    }
  }

  async deleteFolder(path: string): Promise<void> {
    this.ensureConnected();

    // List all objects with this prefix and delete them
    const prefix = this.resolveKey(path).replace(/\/?$/, '/');
    const listResult = await this.apiRequest<ListObjectsResponse>('/list', { prefix });

    // Delete each object (in parallel batches)
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

    // Delete the folder marker itself
    try {
      const presigned = await this.getPreSignedUrl('delete', prefix);
      await fetch(presigned.url, { method: 'DELETE' });
    } catch {
      // Folder marker may not exist, that's fine
    }
  }

  async getQuota(): Promise<StorageQuota> {
    this.ensureConnected();

    try {
      const response = await this.apiRequest<{ used: number; total: number }>('/quota', {});
      return response;
    } catch {
      // S3 doesn't have a natural quota; return large defaults
      return { used: 0, total: 5 * 1024 * 1024 * 1024 * 1024 }; // 5TB default
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private resolveKey(relativePath: string): string {
    if (!relativePath || relativePath === '/' || relativePath === '.') {
      return this.rootPath;
    }
    const clean = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return `${this.rootPath}${clean}`;
  }

  private extractName(key: string, prefix: string): string {
    const withoutPrefix = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    // Remove trailing slash for directory entries
    return withoutPrefix.replace(/\/$/, '');
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('S3 adapter is not connected. Call connect() first.');
    }
  }

  private async getPreSignedUrl(action: string, key: string): Promise<PreSignedUrlResponse> {
    return this.apiRequest<PreSignedUrlResponse>('/presign', { action, key });
  }

  /**
   * Make a request to the Lambda API endpoint.
   */
  private async apiRequest<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    if (!this.config) {
      throw new Error('S3 adapter not configured');
    }

    const url = `${this.config.apiEndpoint}${endpoint}`;
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
      throw new Error(`S3 API request to ${endpoint} failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }
}
