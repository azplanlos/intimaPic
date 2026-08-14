import { Injectable, inject } from '@angular/core';
import { StorageAdapter } from './storage-adapter.interface';
import { OneDriveAdapter } from './onedrive-adapter.service';
import { S3Adapter } from './s3-adapter.service';
import { ICloudDriveAdapter } from './icloud-drive-adapter.service';
import type { StorageProviderType, StorageSettings, OneDriveConfig, S3Config, ICloudConfig } from '../crypto/crypto.models';

/**
 * Factory service that creates and manages StorageAdapter instances.
 *
 * POST-MIGRATION NOTE:
 * After the ServiceWorker migration, this factory is only used for:
 * 1. Vault creation (initial setup – writes masterkey.cryptomator etc.)
 * 2. Vault connection verification (connectExistingVault)
 * 3. iCloud Drive access (File System Access API is not available in SW)
 *
 * For regular read/write operations during normal usage, the ServiceWorker
 * handles all storage access directly. See SwClientService.
 */
@Injectable({ providedIn: 'root' })
export class StorageAdapterFactory {
  private readonly oneDriveAdapter = inject(OneDriveAdapter);
  private readonly s3Adapter = inject(S3Adapter);
  private readonly iCloudDriveAdapter = inject(ICloudDriveAdapter);

  private activeAdapter: StorageAdapter | null = null;

  /**
   * Get a StorageAdapter for the given provider type.
   */
  getAdapter(provider: StorageProviderType): StorageAdapter {
    switch (provider) {
      case 'onedrive':
        return this.oneDriveAdapter;
      case 's3':
        return this.s3Adapter;
      case 'icloud':
        return this.iCloudDriveAdapter;
      default:
        throw new Error(`Unknown storage provider: ${provider}`);
    }
  }

  /**
   * Configure and connect an adapter based on StorageSettings.
   * Used during vault creation and initial connection verification.
   */
  async connectAdapter(settings: StorageSettings): Promise<StorageAdapter> {
    const adapter = this.getAdapter(settings.provider);

    switch (settings.provider) {
      case 'onedrive':
        (adapter as OneDriveAdapter).configure(settings.config as OneDriveConfig, settings.rootPath);
        break;
      case 's3':
        (adapter as S3Adapter).configure(settings.config as S3Config, settings.rootPath);
        break;
      case 'icloud':
        (adapter as ICloudDriveAdapter).configure(settings.config as ICloudConfig, settings.rootPath);
        break;
    }

    await adapter.connect();
    this.activeAdapter = adapter;
    return adapter;
  }

  /**
   * Get the currently active (connected) adapter.
   * Primarily used for iCloud Drive (which stays in the main thread).
   */
  getActiveAdapter(): StorageAdapter | null {
    return this.activeAdapter;
  }

  /**
   * Disconnect the currently active adapter.
   */
  async disconnectActive(): Promise<void> {
    if (this.activeAdapter) {
      await this.activeAdapter.disconnect();
      this.activeAdapter = null;
    }
  }
}
