import { Injectable } from '@angular/core';
import { StorageAdapter, StorageQuota } from './storage-adapter.interface';
import type { FileEntry, OneDriveConfig } from '../crypto/crypto.models';
import { environment } from '../../../environments/environment';

/**
 * Microsoft Graph API response types (minimal subset).
 */
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

interface GraphQuotaResponse {
  quota: {
    total: number;
    used: number;
    remaining: number;
  };
}

// ─── Request Throttle ─────────────────────────────────────────────────────────

/**
 * Limits the number of concurrent in-flight fetch() requests to avoid
 * hitting the browser's per-host connection limit and triggering
 * ERR_INSUFFICIENT_RESOURCES.
 */
class RequestThrottle {
  private active = 0;
  private readonly queue: Array<{ resolve: () => void; signal?: AbortSignal }> = [];

  constructor(private readonly maxConcurrent: number = 4) {}

  /**
   * Acquire a throttle slot. If an AbortSignal is provided and it fires
   * while waiting in the queue, the promise rejects with an AbortError
   * so the request never starts and the slot is never consumed.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, signal };
      this.queue.push(entry);

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  release(): void {
    this.active--;
    // Process next entry in queue that hasn't been aborted
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) {
        // Skip aborted entries (already rejected)
        continue;
      }
      this.active++;
      next.resolve();
      return;
    }
  }
}

// ─── Retry helpers ────────────────────────────────────────────────────────────

/** Errors considered transient and eligible for retry. */
function isTransientError(err: unknown): boolean {
  if (err instanceof TypeError) {
    // Network-level failures (ERR_INSUFFICIENT_RESOURCES, ERR_FAILED, etc.)
    return true;
  }
  return false;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 504;
}

/** Wait ms milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensures the response body is fully consumed so the browser can
 * free the underlying TCP socket immediately.
 */
async function drainResponse(response: Response): Promise<void> {
  try {
    // arrayBuffer() consumes the body regardless of content type
    await response.arrayBuffer();
  } catch {
    // Body may already have been consumed or stream errored – safe to ignore.
  }
}

/**
 * OneDrive storage adapter using Microsoft Graph API.
 * Authentication uses OAuth 2.0 PKCE via MSAL.js (browser flow).
 *
 * Files are stored in the user's OneDrive under /Apps/IntimaPic/ by default.
 */
@Injectable({ providedIn: 'root' })
export class OneDriveAdapter implements StorageAdapter {
  readonly providerName = 'OneDrive';

  private config: OneDriveConfig | null = null;
  private rootPath = '/Apps/IntimaPic';
  private accessToken: string | null = null;
  private connected = false;

  private readonly GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
  private readonly SCOPES = ['Files.ReadWrite.AppFolder', 'Files.ReadWrite'];

  /**
   * Limits concurrent HTTP requests to prevent ERR_INSUFFICIENT_RESOURCES.
   * Browsers cap connections per host at ~6 (HTTP/1.1) or higher for H2,
   * but even with multiplexing the socket/memory budget can be exceeded
   * when many large-body requests are queued in rapid succession.
   */
  private readonly throttle = new RequestThrottle(4);

  /** Maximum number of retry attempts for transient errors. */
  private readonly MAX_RETRIES = 3;
  /** Base delay (ms) for exponential backoff. */
  private readonly BASE_DELAY_MS = 500;

  /**
   * Configure the adapter with OneDrive-specific settings.
   */
  configure(config: OneDriveConfig, rootPath?: string): void {
    this.config = config;
    if (rootPath) {
      this.rootPath = rootPath;
    }
    if (config.accessToken) {
      this.accessToken = config.accessToken;
    }
  }

  async connect(): Promise<void> {
    if (!this.config) {
      throw new Error('OneDrive adapter not configured. Call configure() first.');
    }

    // If we already have a token, validate it
    if (this.accessToken) {
      const isValid = await this.validateToken();
      if (isValid) {
        this.connected = true;
        return;
      }
    }

    // Initiate OAuth 2.0 PKCE flow
    this.accessToken = await this.authenticate();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.accessToken = null;
    this.connected = false;
    // Reset MSAL instance so a fresh one is created on next connect (e.g. different tenant)
    this.msalInstance = null;
    this.msalInitPromise = null;
  }

  isConnected(): boolean {
    return this.connected && this.accessToken !== null;
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
      // Simple upload for files <= 4MB
      await this.simpleUpload(fullPath, data);
    } else {
      // Resumable upload for larger files
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
      throw new Error(`OneDrive deleteFile failed: ${response.status} ${response.statusText}`);
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

    if (!folderName) {
      throw new Error('Invalid folder path');
    }

    const url = parentPath === this.rootPath
      ? `${this.GRAPH_BASE}/me/drive/root:${parentPath}:/children`
      : `${this.GRAPH_BASE}/me/drive/root:${parentPath}:/children`;

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
      throw new Error(`OneDrive createFolder failed: ${response.status} ${response.statusText}`);
    }

    await drainResponse(response);
  }

  async deleteFolder(path: string): Promise<void> {
    // Graph API handles recursive delete automatically
    await this.deleteFile(path);
  }

  async getQuota(): Promise<StorageQuota> {
    this.ensureConnected();

    const url = `${this.GRAPH_BASE}/me/drive?$select=quota`;
    const response = await this.graphRequest<GraphQuotaResponse>(url);

    return {
      used: response.quota.used,
      total: response.quota.total,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private resolvePath(relativePath: string): string {
    if (!relativePath || relativePath === '/' || relativePath === '.') {
      return this.rootPath;
    }
    const clean = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    return `${this.rootPath}${clean}`;
  }

  private ensureConnected(): void {
    if (!this.connected || !this.accessToken) {
      throw new Error('OneDrive adapter is not connected. Call connect() first.');
    }
  }

  private mapToFileEntry(item: GraphDriveItem, parentPath: string): FileEntry {
    return {
      encryptedName: item.name,
      path: parentPath ? `${parentPath}/${item.name}` : item.name,
      size: item.size,
      lastModified: new Date(item.lastModifiedDateTime),
      isDirectory: !!item.folder,
    };
  }

  private async graphRequest<T>(url: string): Promise<T> {
    const response = await this.throttledFetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      await drainResponse(response);
      throw new Error(`Graph API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Central fetch wrapper that:
   * 1. Acquires a throttle slot (limits concurrency)
   * 2. Retries on transient network/server errors with exponential backoff
   * 3. Ensures responses from failed retries are always drained
   */
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
          // Respect Retry-After header if present, else use exponential backoff
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
        if (isTransientError(err) && attempt < this.MAX_RETRIES) {
          await delay(this.BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }

    // Should not reach here, but satisfy TS
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
      throw new Error(`OneDrive upload failed: ${response.status} ${response.statusText}`);
    }

    // Drain the successful response body (contains item metadata we don't need)
    await drainResponse(response);
  }

  private async resumableUpload(fullPath: string, data: ArrayBuffer): Promise<void> {
    // Step 1: Create upload session
    const sessionUrl = `${this.GRAPH_BASE}/me/drive/root:${fullPath}:/createUploadSession`;
    const sessionResponse = await this.throttledFetch(sessionUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'replace' },
      }),
    });

    if (!sessionResponse.ok) {
      await drainResponse(sessionResponse);
      throw new Error(`OneDrive upload session creation failed: ${sessionResponse.status}`);
    }

    const session = await sessionResponse.json() as { uploadUrl: string };

    // Step 2: Upload in 5MB chunks
    const chunkSize = 5 * 1024 * 1024; // 5MB
    const totalSize = data.byteLength;
    let offset = 0;

    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize, totalSize);
      const chunk = data.slice(offset, end);

      // Chunk uploads go directly to the upload URL (not Graph API)
      // Still throttle to avoid overwhelming the browser
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
        throw new Error(`OneDrive chunk upload failed at offset ${offset}: ${chunkResponse.status}`);
      }

      // Drain chunk response (intermediate 202s have a small JSON body)
      await drainResponse(chunkResponse);

      offset = end;
    }
  }

  private async validateToken(): Promise<boolean> {
    try {
      const response = await this.throttledFetch(`${this.GRAPH_BASE}/me/drive`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      const valid = response.ok;
      await drainResponse(response);
      return valid;
    } catch {
      return false;
    }
  }

  /** Singleton MSAL instance – reused across calls to avoid interaction_in_progress errors. */
  private msalInstance: import('@azure/msal-browser').IPublicClientApplication | null = null;
  private msalInitPromise: Promise<import('@azure/msal-browser').IPublicClientApplication> | null = null;

  /**
   * Lazily create and initialize a single MSAL PublicClientApplication.
   * Reuses the same instance for the lifetime of this adapter (same clientId/tenantId).
   */
  private async getMsalInstance(): Promise<import('@azure/msal-browser').IPublicClientApplication> {
    if (this.msalInstance) {
      return this.msalInstance;
    }

    // Prevent multiple concurrent initializations
    if (this.msalInitPromise) {
      return this.msalInitPromise;
    }

    this.msalInitPromise = (async () => {
      const { PublicClientApplication, BrowserCacheLocation } = await import('@azure/msal-browser');

      // Use configured clientId, falling back to environment default
      const clientId = this.config!.clientId || environment.azure.defaultClientId;
      const tenantId = this.config!.tenantId || environment.azure.defaultTenantId || 'common';

      if (!clientId) {
        throw new Error('No Azure Client ID configured. Set it in environment or provide it via configure().');
      }

      const msalConfig = {
        auth: {
          clientId,
          authority: `https://login.microsoftonline.com/${tenantId}`,
          // Use the MSAL v5 redirect bridge route as the popup redirect URI.
          // This route calls broadcastResponseToMainFrame() which relays the
          // auth response back to the parent window and closes the popup.
          redirectUri: `${window.location.origin}/auth-redirect`,
        },
        cache: {
          cacheLocation: BrowserCacheLocation.LocalStorage,
        },
      };

      // Clear any stale MSAL interaction-in-progress keys before initializing.
      // These keys get stuck when a popup is closed without completing the flow.
      this.clearStaleInteractionStatus();

      const instance = new PublicClientApplication(msalConfig);
      await instance.initialize();

      // handleRedirectPromise() clears redirect-based interaction state.
      await instance.handleRedirectPromise();

      this.msalInstance = instance;
      return instance;
    })();

    return this.msalInitPromise;
  }

  /**
   * Remove stale MSAL interaction status entries from browser storage.
   * MSAL stores a temporary "interaction_in_progress" marker that can get stuck
   * when a popup is closed by the user or fails to complete.
   * In MSAL v5, these markers may exist in both sessionStorage and localStorage.
   */
  private clearStaleInteractionStatus(): void {
    // Clear from sessionStorage
    const sessionKeysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && (key.includes('interaction.status') || key.includes('interaction_in_progress'))) {
        sessionKeysToRemove.push(key);
      }
    }
    sessionKeysToRemove.forEach(key => sessionStorage.removeItem(key));

    // Clear from localStorage (MSAL cacheLocation is set to localStorage)
    const localKeysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes('interaction.status') || key.includes('interaction_in_progress'))) {
        localKeysToRemove.push(key);
      }
    }
    localKeysToRemove.forEach(key => localStorage.removeItem(key));
  }

  /**
   * Initiate OAuth 2.0 PKCE popup authentication.
   * This uses the MSAL.js library for token acquisition.
   */
  private async authenticate(): Promise<string> {
    let msalInstance = await this.getMsalInstance();

    try {
      // Try silent token acquisition first
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        const silentResult = await msalInstance.acquireTokenSilent({
          scopes: this.SCOPES,
          account: accounts[0],
        });
        return silentResult.accessToken;
      }
    } catch {
      // Silent acquisition failed, fall through to popup
    }

    // Interactive login via popup – with retry on stale interaction state
    try {
      const result = await msalInstance.acquireTokenPopup({
        scopes: this.SCOPES,
      });
      return result.accessToken;
    } catch (err: unknown) {
      // If interaction_in_progress, destroy the instance, clear storage state, and rebuild
      if (err instanceof Error && err.message.includes('interaction_in_progress')) {
        this.clearStaleInteractionStatus();
        // Force a completely new MSAL instance
        this.msalInstance = null;
        this.msalInitPromise = null;
        msalInstance = await this.getMsalInstance();

        const result = await msalInstance.acquireTokenPopup({
          scopes: this.SCOPES,
        });
        return result.accessToken;
      }
      throw err;
    }
  }
}
