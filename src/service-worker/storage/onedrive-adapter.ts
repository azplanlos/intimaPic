/**
 * OneDrive storage adapter for the ServiceWorker context.
 * Uses Microsoft Graph API with pre-provided access tokens.
 *
 * Unlike the main-thread version, this adapter:
 * - Does NOT do OAuth/MSAL (token is provided via SET_AUTH_TOKEN)
 * - Includes the same RequestThrottle for concurrent request limiting
 * - Includes exponential backoff retry for transient errors
 */

import type { SwStorageAdapter, FileEntry, StorageQuota } from './storage-adapter.interface';

// ─── Graph API Response Types ──────────────────────────────────────────────────

interface GraphDriveItem {
  id: string;
  name: string;
  size: number;
  lastModifiedDateTime: string;
  folder?: { childCount: number };
  file?: { mimeType: string };
}

interface GraphDriveItemsResponse {
  value: GraphDriveItem[];
  '@odata.nextLink'?: string;
}

// ─── Request Throttle ──────────────────────────────────────────────────────────

class RequestThrottle {
  private active = 0;
  private readonly queue: Array<{ resolve: () => void; signal?: AbortSignal }> = [];

  constructor(private readonly maxConcurrent: number = 4) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, signal };
      this.queue.push(entry);
      if (signal) {
        signal.addEventListener('abort', () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        }, { once: true });
      }
    });
  }

  release(): void {
    this.active--;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) continue;
      this.active++;
      next.resolve();
      return;
    }
  }
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 504;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function drainResponse(response: Response): Promise<void> {
  try { await response.arrayBuffer(); } catch {}
}

// ─── Adapter Implementation ────────────────────────────────────────────────────

export class SwOneDriveAdapter implements SwStorageAdapter {
  readonly providerName = 'OneDrive';

  private rootPath = '/Apps/IntimaPic';
  private accessToken: string | null = null;
  private connected = false;

  private readonly GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
  private readonly throttle = new RequestThrottle(4);
  private readonly MAX_RETRIES = 3;
  private readonly BASE_DELAY_MS = 500;

  connect(token: string, config?: Record<string, unknown>): void {
    this.accessToken = token;
    if (config?.rootPath && typeof config.rootPath === 'string') {
      this.rootPath = config.rootPath;
    }
    this.connected = true;
  }

  disconnect(): void {
    this.accessToken = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.accessToken !== null;
  }

  /**
   * Update the access token (e.g., after refresh).
   */
  updateToken(token: string): void {
    this.accessToken = token;
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    this.ensureConnected();

    const fullPath = this.resolvePath(path);
    const url = `${this.GRAPH_BASE}/me/drive/root:${fullPath}:/children?$select=id,name,size,lastModifiedDateTime,folder,file`;

    const items: GraphDriveItem[] = [];
    let nextLink: string | undefined = url;

    while (nextLink) {
      const response: GraphDriveItemsResponse = await this.graphRequest<GraphDriveItemsResponse>(nextLink);
      items.push(...response.value);
      nextLink = response['@odata.nextLink'];
    }

    return items.map(item => this.mapToFileEntry(item, path));
  }

  async readFile(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    this.ensureConnected();

    const fullPath = this.resolvePath(path);
    const url = `${this.GRAPH_BASE}/me/drive/root:${fullPath}:/content`;

    const response = await this.throttledFetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal,
    });

    if (!response.ok) {
      await drainResponse(response);
      throw new Error(`OneDrive readFile failed: ${response.status} ${response.statusText}`);
    }

    return response.arrayBuffer();
  }

  async writeFile(path: string, data: ArrayBuffer): Promise<void> {
    this.ensureConnected();

    const fullPath = this.resolvePath(path);

    if (data.byteLength <= 4 * 1024 * 1024) {
      await this.simpleUpload(fullPath, data);
    } else {
      await this.resumableUpload(fullPath, data);
    }
  }

  async deleteFile(path: string): Promise<void> {
    this.ensureConnected();

    const fullPath = this.resolvePath(path);
    const url = `${this.GRAPH_BASE}/me/drive/root:${fullPath}`;

    const response = await this.throttledFetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok && response.status !== 404) {
      await drainResponse(response);
      throw new Error(`OneDrive deleteFile failed: ${response.status}`);
    }
    await drainResponse(response);
  }

  async fileExists(path: string): Promise<boolean> {
    this.ensureConnected();

    const fullPath = this.resolvePath(path);
    const url = `${this.GRAPH_BASE}/me/drive/root:${fullPath}`;

    const response = await this.throttledFetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    const exists = response.ok;
    await drainResponse(response);
    return exists;
  }

  async createFolder(path: string): Promise<void> {
    this.ensureConnected();

    const parts = path.split('/').filter(p => p.length > 0);
    const folderName = parts.pop();
    const parentPath = this.resolvePath(parts.join('/'));

    if (!folderName) throw new Error('Invalid folder path');

    const url = `${this.GRAPH_BASE}/me/drive/root:${parentPath}:/children`;

    const response = await this.throttledFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });

    if (!response.ok && response.status !== 409) {
      await drainResponse(response);
      throw new Error(`OneDrive createFolder failed: ${response.status}`);
    }
    await drainResponse(response);
  }

  async deleteFolder(path: string): Promise<void> {
    await this.deleteFile(path);
  }

  async getQuota(): Promise<StorageQuota> {
    this.ensureConnected();
    const url = `${this.GRAPH_BASE}/me/drive?$select=quota`;
    const response = await this.graphRequest<{ quota: { used: number; total: number } }>(url);
    return { used: response.quota.used, total: response.quota.total };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private resolvePath(relativePath: string): string {
    if (!relativePath || relativePath === '/' || relativePath === '.') {
      return this.rootPath;
    }
    const clean = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    return `${this.rootPath}${clean}`;
  }

  private ensureConnected(): void {
    if (!this.connected || !this.accessToken) {
      throw new Error('OneDrive adapter not connected.');
    }
  }

  private mapToFileEntry(item: GraphDriveItem, parentPath: string): FileEntry {
    return {
      encryptedName: item.name,
      path: parentPath ? `${parentPath}/${item.name}` : item.name,
      size: item.size,
      lastModified: item.lastModifiedDateTime,
      isDirectory: !!item.folder,
    };
  }

  private async graphRequest<T>(url: string): Promise<T> {
    const response = await this.throttledFetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      await drainResponse(response);
      throw new Error(`Graph API failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private async throttledFetch(url: string, init?: RequestInit): Promise<Response> {
    await this.throttle.acquire(init?.signal ?? undefined);
    try {
      return await this.fetchWithRetry(url, init);
    } finally {
      this.throttle.release();
    }
  }

  private async fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, init);

        if (isRetryableStatus(response.status) && attempt < this.MAX_RETRIES) {
          const retryAfter = response.headers.get('Retry-After');
          const waitMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : this.BASE_DELAY_MS * Math.pow(2, attempt);
          await drainResponse(response);
          await delay(waitMs);
          continue;
        }

        return response;
      } catch (err) {
        lastError = err;
        if (err instanceof TypeError && attempt < this.MAX_RETRIES) {
          await delay(this.BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  private async simpleUpload(fullPath: string, data: ArrayBuffer): Promise<void> {
    const url = `${this.GRAPH_BASE}/me/drive/root:${fullPath}:/content`;
    const response = await this.throttledFetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: data,
    });

    if (!response.ok) {
      await drainResponse(response);
      throw new Error(`OneDrive upload failed: ${response.status}`);
    }
    await drainResponse(response);
  }

  private async resumableUpload(fullPath: string, data: ArrayBuffer): Promise<void> {
    const sessionUrl = `${this.GRAPH_BASE}/me/drive/root:${fullPath}:/createUploadSession`;
    const sessionResponse = await this.throttledFetch(sessionUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });

    if (!sessionResponse.ok) {
      await drainResponse(sessionResponse);
      throw new Error(`OneDrive upload session failed: ${sessionResponse.status}`);
    }

    const session = await sessionResponse.json() as { uploadUrl: string };
    const chunkSize = 5 * 1024 * 1024;
    const totalSize = data.byteLength;
    let offset = 0;

    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize, totalSize);
      const chunk = data.slice(offset, end);

      const chunkResponse = await this.throttledFetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': `${chunk.byteLength}`,
          'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
        },
        body: chunk,
      });

      if (!chunkResponse.ok && chunkResponse.status !== 202) {
        await drainResponse(chunkResponse);
        throw new Error(`OneDrive chunk upload failed at ${offset}: ${chunkResponse.status}`);
      }
      await drainResponse(chunkResponse);
      offset = end;
    }
  }
}
