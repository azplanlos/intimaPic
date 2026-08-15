import type { StorageSettings } from '../crypto/crypto.models';

/**
 * Metadata for a registered vault.
 * Persisted in localStorage so the user can switch between vaults.
 */
export interface VaultInfo {
  /** Unique vault identifier (UUID) */
  id: string;
  /** User-defined display name */
  name: string;
  /** Storage settings (provider type + config + root path) */
  storageSettings: StorageSettings;
  /** When the vault was first registered on this device */
  createdAt: string;
  /** ISO timestamp of the last local name change (used for cross-device sync) */
  nameUpdatedAt?: string;
}
