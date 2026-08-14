/**
 * Storage adapter factory for the ServiceWorker context.
 * Creates and manages provider-specific adapters.
 */

import type { SwStorageAdapter } from './storage-adapter.interface';
import { SwOneDriveAdapter } from './onedrive-adapter';
import { SwS3Adapter } from './s3-adapter';

export type StorageProviderType = 'onedrive' | 's3' | 'icloud';

/**
 * Pending iCloud proxy requests (resolved by Main Thread).
 */
interface PendingProxy {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class SwStorageFactory {
  private adapter: SwStorageAdapter | null = null;
  private currentProvider: StorageProviderType | null = null;

  /** Pending iCloud proxy requests */
  private readonly pendingICloudRequests = new Map<string, PendingProxy>();

  /**
   * Get or create a storage adapter based on provider type.
   * Reuses existing adapter if provider hasn't changed.
   */
  getOrCreateAdapter(
    provider: StorageProviderType,
    token: string,
    config?: Record<string, unknown>
  ): SwStorageAdapter {
    // If provider changed, disconnect old adapter
    if (this.currentProvider !== provider && this.adapter) {
      this.adapter.disconnect();
      this.adapter = null;
    }

    if (!this.adapter) {
      switch (provider) {
        case 'onedrive':
          this.adapter = new SwOneDriveAdapter();
          break;
        case 's3':
          this.adapter = new SwS3Adapter();
          break;
        case 'icloud':
          // iCloud is handled via main-thread proxy – not a real SW adapter
          // For now, throw – iCloud requests must go through ICLOUD_PROXY_REQUEST
          throw new Error('iCloud adapter not available in ServiceWorker. Use main-thread proxy.');
        default:
          throw new Error(`Unknown storage provider: ${provider}`);
      }
    }

    this.currentProvider = provider;
    this.adapter.connect(token, config);
    return this.adapter;
  }

  /**
   * Get the current adapter (or null if none connected).
   */
  getAdapter(): SwStorageAdapter | null {
    return this.adapter;
  }

  /**
   * Disconnect and clear the current adapter.
   */
  disconnect(): void {
    if (this.adapter) {
      this.adapter.disconnect();
      this.adapter = null;
      this.currentProvider = null;
    }
  }

  // ─── iCloud Proxy Support ──────────────────────────────────────────────────

  /**
   * Create a pending iCloud proxy request.
   * Returns a promise that resolves when the Main Thread responds.
   */
  createICloudProxyRequest(requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pendingICloudRequests.set(requestId, { resolve, reject });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingICloudRequests.has(requestId)) {
          this.pendingICloudRequests.delete(requestId);
          reject(new Error('iCloud proxy request timed out'));
        }
      }, 30_000);
    });
  }

  /**
   * Resolve a pending iCloud proxy request (called when Main Thread responds).
   */
  resolveICloudProxy(requestId: string, result?: unknown, error?: string): void {
    const pending = this.pendingICloudRequests.get(requestId);
    if (!pending) return;

    this.pendingICloudRequests.delete(requestId);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }
}
