import { Injectable } from '@angular/core';
import type { StorageAdapter } from '../storage/storage-adapter.interface';

/**
 * Settings stored inside the vault itself (alongside masterkey.cryptomator).
 * This file is NOT encrypted — it stores non-sensitive metadata
 * that should be shared across devices accessing the same vault.
 */
export interface VaultSettings {
  /** Display name of the vault */
  name: string;
  /** ISO timestamp of when this settings file was created */
  createdAt: string;
  /** ISO timestamp of the last settings update */
  updatedAt: string;
}

const SETTINGS_FILENAME = 'settings.json';

/**
 * Service to read/write a settings.json file in the vault root.
 * The file lives alongside masterkey.cryptomator and vault.cryptomator
 * and is accessible to all devices that have access to the vault.
 */
@Injectable({ providedIn: 'root' })
export class VaultSettingsService {
  readonly SETTINGS_FILENAME = SETTINGS_FILENAME;

  /**
   * Read the vault settings file. Returns null if it doesn't exist.
   */
  async readSettings(adapter: StorageAdapter): Promise<VaultSettings | null> {
    try {
      const exists = await adapter.fileExists(SETTINGS_FILENAME);
      if (!exists) return null;

      const data = await adapter.readFile(SETTINGS_FILENAME);
      const text = new TextDecoder().decode(data);
      return JSON.parse(text) as VaultSettings;
    } catch {
      // File corrupt or unreadable — treat as non-existent
      return null;
    }
  }

  /**
   * Write the vault settings file.
   */
  async writeSettings(adapter: StorageAdapter, settings: VaultSettings): Promise<void> {
    settings.updatedAt = new Date().toISOString();
    const json = JSON.stringify(settings, null, 2);
    const data = new TextEncoder().encode(json).buffer as ArrayBuffer;
    await adapter.writeFile(SETTINGS_FILENAME, data);
  }

  /**
   * Ensure the settings file exists. If missing, creates it with the given name.
   * If present, returns the existing settings.
   */
  async ensureSettings(adapter: StorageAdapter, defaultName: string): Promise<VaultSettings> {
    const existing = await this.readSettings(adapter);
    if (existing) return existing;

    const now = new Date().toISOString();
    const settings: VaultSettings = {
      name: defaultName,
      createdAt: now,
      updatedAt: now,
    };

    await this.writeSettings(adapter, settings);
    return settings;
  }

  /**
   * Update the vault name in the settings file.
   */
  async updateName(adapter: StorageAdapter, newName: string): Promise<void> {
    const existing = await this.readSettings(adapter);
    if (existing) {
      existing.name = newName;
      await this.writeSettings(adapter, existing);
    } else {
      const now = new Date().toISOString();
      await this.writeSettings(adapter, {
        name: newName,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
