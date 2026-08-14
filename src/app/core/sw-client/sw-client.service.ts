/**
 * SwClientService – Messaging API for communication with the Custom ServiceWorker.
 *
 * Provides a typed request/response interface over MessageChannel.
 * Handles:
 * - Key re-transfer after SW termination (NEED_KEYS response)
 * - Token refresh when SW reports TOKEN_EXPIRED
 * - Error propagation to callers
 * - Push message reception from SW (unsolicited updates)
 */

import { Injectable, inject, signal } from '@angular/core';
import type { SwCommand } from '../../../service-worker/models/commands';
import type { SwResponse, SwPushMessage, CachedAlbum, CachedPhotoEntry } from '../../../service-worker/models/responses';

export class SwError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SwError';
  }
}

/**
 * Interface for the key provider (to avoid circular dependency with CryptoService).
 */
export interface SwKeyProvider {
  getMasterKeys(): { encryptionKey: ArrayBuffer; macKey: ArrayBuffer } | null;
  getVaultId(): string | null;
}

/**
 * Interface for the token provider (to avoid circular dependency with auth services).
 */
export interface SwTokenProvider {
  refreshToken(provider: 'onedrive' | 's3'): Promise<{ token: string; expiresAt: number } | null>;
}

@Injectable({ providedIn: 'root' })
export class SwClientService {
  /** Whether the SW is registered and ready */
  private readonly _ready = signal(false);
  readonly ready = this._ready.asReadonly();

  /** Online status as reported by SW */
  private readonly _online = signal(navigator.onLine);
  readonly online = this._online.asReadonly();

  /** Callback for directory update pushes */
  private directoryUpdateCallback: ((directoryId: string, added: number, removed: number) => void) | null = null;

  /** Key provider (set by VaultService after DI resolution) */
  private keyProvider: SwKeyProvider | null = null;

  /** Token provider (set by auth service) */
  private tokenProvider: SwTokenProvider | null = null;

  /** Track if we're currently re-transferring keys (prevent infinite loops) */
  private reTransferring = false;

  constructor() {
    this.listenForPushMessages();
  }

  // ─── Configuration ─────────────────────────────────────────────────────────

  /**
   * Set the key provider (called by VaultService during initialization).
   */
  setKeyProvider(provider: SwKeyProvider): void {
    this.keyProvider = provider;
  }

  /**
   * Set the token provider (called by auth service during initialization).
   */
  setTokenProvider(provider: SwTokenProvider): void {
    this.tokenProvider = provider;
  }

  /**
   * Register a callback for directory update notifications.
   */
  onDirectoryUpdate(callback: (directoryId: string, added: number, removed: number) => void): void {
    this.directoryUpdateCallback = callback;
  }

  // ─── Lifecycle Commands ────────────────────────────────────────────────────

  /**
   * Initialize keys in the ServiceWorker.
   */
  async initKeys(encryptionKey: ArrayBuffer, macKey: ArrayBuffer, vaultId: string): Promise<void> {
    await this.sendCommand({ type: 'INIT_KEYS', encryptionKey, macKey, vaultId });
  }

  /**
   * Lock the vault (clears keys and tokens in SW).
   */
  async lock(): Promise<void> {
    await this.sendCommand({ type: 'LOCK' });
  }

  /**
   * Set an auth token for a storage provider.
   */
  async setAuthToken(
    provider: 'onedrive' | 's3',
    token: string,
    expiresAt: number,
    providerConfig?: Record<string, unknown>,
    refreshToken?: string
  ): Promise<void> {
    await this.sendCommand({
      type: 'SET_AUTH_TOKEN',
      provider,
      token,
      refreshToken,
      expiresAt,
      providerConfig,
    });
  }

  // ─── Album/Photo Commands ──────────────────────────────────────────────────

  /**
   * List all albums (from cache or network).
   */
  async listAlbums(forceRefresh = false): Promise<{ albums: CachedAlbum[]; fromCache: boolean }> {
    const response = await this.sendCommand({ type: 'LIST_ALBUMS', forceRefresh });
    if (response.type === 'ALBUMS_LIST') {
      return { albums: response.albums, fromCache: response.fromCache };
    }
    throw new SwError('UNEXPECTED', `Unexpected response type: ${response.type}`);
  }

  /**
   * List photos in a directory (from cache or network).
   */
  async listPhotos(directoryId: string, forceRefresh = false): Promise<{ photos: CachedPhotoEntry[]; fromCache: boolean }> {
    const response = await this.sendCommand({ type: 'LIST_PHOTOS', directoryId, forceRefresh });
    if (response.type === 'PHOTOS_LIST') {
      return { photos: response.photos, fromCache: response.fromCache };
    }
    throw new SwError('UNEXPECTED', `Unexpected response type: ${response.type}`);
  }

  // ─── File Commands ─────────────────────────────────────────────────────────

  /**
   * Get an encrypted thumbnail (from cache or network).
   */
  async getThumbnail(encryptedName: string, directoryId: string, size: 'grid' | 'preview'): Promise<{ data: ArrayBuffer; fromCache: boolean }> {
    const response = await this.sendCommand({ type: 'GET_THUMBNAIL', encryptedName, directoryId, size });
    if (response.type === 'FILE_DATA') {
      return { data: response.data, fromCache: response.fromCache };
    }
    throw new SwError('UNEXPECTED', `Unexpected response type: ${response.type}`);
  }

  /**
   * Read a file from cloud storage (no caching).
   */
  async getFile(path: string): Promise<ArrayBuffer> {
    const response = await this.sendCommand({ type: 'GET_FILE', path });
    if (response.type === 'FILE_DATA') {
      return response.data;
    }
    throw new SwError('UNEXPECTED', `Unexpected response type: ${response.type}`);
  }

  /**
   * Write a file to cloud storage.
   */
  async writeFile(path: string, data: ArrayBuffer): Promise<void> {
    await this.sendCommand({ type: 'WRITE_FILE', path, data });
  }

  /**
   * Delete a file from cloud storage.
   */
  async deleteFile(path: string): Promise<void> {
    await this.sendCommand({ type: 'DELETE_FILE', path });
  }

  /**
   * Check if a file exists.
   */
  async fileExists(path: string): Promise<boolean> {
    const response = await this.sendCommand({ type: 'FILE_EXISTS', path });
    if (response.type === 'FILE_EXISTS') {
      return response.exists;
    }
    throw new SwError('UNEXPECTED', `Unexpected response type: ${response.type}`);
  }

  /**
   * Create a folder in cloud storage.
   */
  async createFolder(path: string): Promise<void> {
    await this.sendCommand({ type: 'CREATE_FOLDER', path });
  }

  /**
   * Delete a folder from cloud storage.
   */
  async deleteFolder(path: string): Promise<void> {
    await this.sendCommand({ type: 'DELETE_FOLDER', path });
  }

  // ─── Vault Meta (for offline unlock) ───────────────────────────────────────

  /**
   * Get cached vault metadata for offline unlock.
   */
  async getCachedVaultMeta(vaultId: string): Promise<{ masterkeyFile: ArrayBuffer; vaultConfig?: ArrayBuffer } | null> {
    try {
      const response = await this.sendCommand({ type: 'GET_CACHED_VAULT_META', vaultId });
      if (response.type === 'VAULT_META') {
        return { masterkeyFile: response.masterkeyFile, vaultConfig: response.vaultConfig };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── Cache Management ──────────────────────────────────────────────────────

  /**
   * Invalidate cache entries.
   */
  async invalidateCache(scope: 'all' | 'directory' | 'thumbnails', directoryId?: string): Promise<void> {
    await this.sendCommand({ type: 'INVALIDATE_CACHE', scope, directoryId });
  }

  /**
   * Get cache statistics.
   */
  async getCacheStats(): Promise<{ totalEntries: number; totalSizeBytes: number; quotaUsedPercent: number }> {
    const response = await this.sendCommand({ type: 'GET_CACHE_STATS' });
    if (response.type === 'CACHE_STATS') {
      return {
        totalEntries: response.totalEntries,
        totalSizeBytes: response.totalSizeBytes,
        quotaUsedPercent: response.quotaUsedPercent,
      };
    }
    throw new SwError('UNEXPECTED', `Unexpected response type: ${response.type}`);
  }

  // ─── Core Messaging ────────────────────────────────────────────────────────

  /**
   * Send a command to the SW and await the response.
   * Handles NEED_KEYS and NEED_TOKEN automatically.
   */
  private async sendCommand(command: SwCommand): Promise<SwResponse> {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) {
      throw new SwError('SW_NOT_READY', 'ServiceWorker is not active.');
    }

    const response = await this.postMessage(sw, command);

    // Handle control responses
    if (response.type === 'NEED_KEYS') {
      return this.handleNeedKeys(command);
    }

    if (response.type === 'ERROR' && response.code === 'TOKEN_EXPIRED') {
      return this.handleTokenExpired(command);
    }

    if (response.type === 'ERROR') {
      throw new SwError(response.code, response.message);
    }

    return response;
  }

  /**
   * Low-level postMessage with MessageChannel for response correlation.
   */
  private postMessage(sw: ServiceWorker, command: SwCommand): Promise<SwResponse> {
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();

      const timeout = setTimeout(() => {
        port1.close();
        reject(new SwError('TIMEOUT', 'ServiceWorker did not respond within 30 seconds.'));
      }, 30_000);

      port1.onmessage = (event: MessageEvent<SwResponse>) => {
        clearTimeout(timeout);
        port1.close();
        resolve(event.data);
      };

      sw.postMessage(command, [port2]);
    });
  }

  /**
   * Handle NEED_KEYS: Re-transfer keys from CryptoService and retry the command.
   */
  private async handleNeedKeys(originalCommand: SwCommand): Promise<SwResponse> {
    if (this.reTransferring) {
      throw new SwError('KEYS_NOT_SET', 'Keys are not available for re-transfer.');
    }

    if (!this.keyProvider) {
      throw new SwError('KEYS_NOT_SET', 'No key provider configured.');
    }

    const keys = this.keyProvider.getMasterKeys();
    const vaultId = this.keyProvider.getVaultId();

    if (!keys || !vaultId) {
      throw new SwError('KEYS_NOT_SET', 'Vault is locked – no keys available.');
    }

    try {
      this.reTransferring = true;

      // Re-transfer keys
      const sw = navigator.serviceWorker?.controller;
      if (!sw) throw new SwError('SW_NOT_READY', 'ServiceWorker is not active.');

      await this.postMessage(sw, {
        type: 'INIT_KEYS',
        encryptionKey: keys.encryptionKey,
        macKey: keys.macKey,
        vaultId,
      });

      // Retry original command
      return this.postMessage(sw, originalCommand);
    } finally {
      this.reTransferring = false;
    }
  }

  /**
   * Handle TOKEN_EXPIRED: Refresh the token and retry.
   */
  private async handleTokenExpired(originalCommand: SwCommand): Promise<SwResponse> {
    if (!this.tokenProvider) {
      throw new SwError('TOKEN_EXPIRED', 'No token provider configured.');
    }

    // Determine which provider needs refresh (heuristic: try onedrive first)
    const result = await this.tokenProvider.refreshToken('onedrive');
    if (!result) {
      throw new SwError('TOKEN_EXPIRED', 'Token refresh failed.');
    }

    // Update token in SW
    const sw = navigator.serviceWorker?.controller;
    if (!sw) throw new SwError('SW_NOT_READY', 'ServiceWorker not active.');

    await this.postMessage(sw, {
      type: 'SET_AUTH_TOKEN',
      provider: 'onedrive',
      token: result.token,
      expiresAt: result.expiresAt,
    });

    // Retry original command
    return this.postMessage(sw, originalCommand);
  }

  // ─── Push Messages (unsolicited SW → Page) ────────────────────────────────

  private listenForPushMessages(): void {
    if (!navigator.serviceWorker) return;

    navigator.serviceWorker.addEventListener('message', (event) => {
      const message = event.data as SwPushMessage;
      if (!message || !message.type) return;

      switch (message.type) {
        case 'DIRECTORY_UPDATED':
          if (this.directoryUpdateCallback) {
            this.directoryUpdateCallback(message.directoryId, message.addedCount, message.removedCount);
          }
          break;

        case 'CONNECTIVITY_CHANGED':
          this._online.set(message.online);
          break;

        case 'CACHE_EVICTION':
          // Could emit a signal or notification here
          break;
      }
    });

    // When a new SW takes over via clients.claim(), automatically
    // re-transfer keys so it can start handling requests immediately.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      this._ready.set(true);
      this.transferKeysToNewController();
    });
  }

  /**
   * Automatically transfer keys when a new SW controller becomes active.
   * This handles the case where the SW installs and claims while the page is open.
   */
  private async transferKeysToNewController(): Promise<void> {
    if (!this.keyProvider) return;

    const keys = this.keyProvider.getMasterKeys();
    const vaultId = this.keyProvider.getVaultId();
    if (!keys || !vaultId) return;

    const sw = navigator.serviceWorker?.controller;
    if (!sw) return;

    try {
      await this.postMessage(sw, {
        type: 'INIT_KEYS',
        encryptionKey: keys.encryptionKey,
        macKey: keys.macKey,
        vaultId,
      });
    } catch {
      // Non-critical – NEED_KEYS will handle it on next request
    }
  }

  // ─── SW Registration ───────────────────────────────────────────────────────

  /**
   * Register the custom ServiceWorker.
   * Should be called once during app bootstrap.
   */
  async register(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      console.warn('[SwClient] ServiceWorker not supported.');
      return;
    }

    try {
      // Use the app's base href to determine the SW URL.
      // In production with --base-href /intimaPic/, sw.js lives at /intimaPic/sw.js
      const swUrl = new URL('sw.js', document.baseURI).href;
      const scope = new URL('./', document.baseURI).href;

      const registration = await navigator.serviceWorker.register(swUrl, { scope });

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'activated') {
              this._ready.set(true);
            }
          });
        }
      });

      // If already active
      if (registration.active) {
        this._ready.set(true);
      }

      // Wait for the SW to be ready
      await navigator.serviceWorker.ready;
      this._ready.set(true);
    } catch (err) {
      console.error('[SwClient] Registration failed:', err);
    }
  }
}
