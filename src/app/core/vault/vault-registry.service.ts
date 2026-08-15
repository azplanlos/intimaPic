import { Injectable, signal, computed } from '@angular/core';
import type { StorageSettings } from '../crypto/crypto.models';
import type { VaultInfo } from './vault-registry.models';

const REGISTRY_KEY = 'intimapic_vault_registry';
const ACTIVE_VAULT_KEY = 'intimapic_active_vault_id';

/**
 * Manages the list of registered vaults on this device.
 * Each vault entry stores its name, provider config, and ID.
 * Only one vault can be active (unlocked) at a time.
 */
@Injectable({ providedIn: 'root' })
export class VaultRegistryService {
  private readonly _vaults = signal<VaultInfo[]>([]);
  private readonly _activeVaultId = signal<string | null>(null);

  /** All registered vaults */
  readonly vaults = this._vaults.asReadonly();

  /** ID of the currently active (selected) vault */
  readonly activeVaultId = this._activeVaultId.asReadonly();

  /** The currently active vault info, or null */
  readonly activeVault = computed(() => {
    const id = this._activeVaultId();
    if (!id) return null;
    return this._vaults().find(v => v.id === id) ?? null;
  });

  /** Whether multiple vaults are registered */
  readonly hasMultipleVaults = computed(() => this._vaults().length > 1);

  /** Whether at least one vault is registered */
  readonly hasVaults = computed(() => this._vaults().length > 0);

  // ─── Initialization ───────────────────────────────────────────────

  /**
   * Load the registry from localStorage.
   * Called once during app startup.
   */
  initialize(): void {
    const json = localStorage.getItem(REGISTRY_KEY);
    if (json) {
      try {
        const vaults: VaultInfo[] = JSON.parse(json);
        this._vaults.set(vaults);
      } catch {
        localStorage.removeItem(REGISTRY_KEY);
      }
    }

    const activeId = localStorage.getItem(ACTIVE_VAULT_KEY);
    if (activeId && this._vaults().some(v => v.id === activeId)) {
      this._activeVaultId.set(activeId);
    } else if (this._vaults().length === 1) {
      // Auto-select if only one vault exists
      this._activeVaultId.set(this._vaults()[0].id);
      localStorage.setItem(ACTIVE_VAULT_KEY, this._vaults()[0].id);
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────

  /**
   * Register a new vault and make it the active vault.
   */
  addVault(name: string, storageSettings: StorageSettings): VaultInfo {
    const now = new Date().toISOString();
    const vault: VaultInfo = {
      id: crypto.randomUUID(),
      name,
      storageSettings,
      createdAt: now,
      nameUpdatedAt: now,
    };

    const updated = [...this._vaults(), vault];
    this._vaults.set(updated);
    this.persist(updated);

    this.setActiveVault(vault.id);
    return vault;
  }

  /**
   * Remove a vault from the registry.
   */
  removeVault(id: string): void {
    const updated = this._vaults().filter(v => v.id !== id);
    this._vaults.set(updated);
    this.persist(updated);

    if (this._activeVaultId() === id) {
      const newActive = updated.length > 0 ? updated[0].id : null;
      this._activeVaultId.set(newActive);
      if (newActive) {
        localStorage.setItem(ACTIVE_VAULT_KEY, newActive);
      } else {
        localStorage.removeItem(ACTIVE_VAULT_KEY);
      }
    }
  }

  /**
   * Update vault display name and record the timestamp of this change.
   * The timestamp is used for cross-device sync to determine which name is newer.
   */
  renameVault(id: string, newName: string, nameUpdatedAt?: string): void {
    const ts = nameUpdatedAt || new Date().toISOString();
    const updated = this._vaults().map(v =>
      v.id === id ? { ...v, name: newName, nameUpdatedAt: ts } : v
    );
    this._vaults.set(updated);
    this.persist(updated);
  }

  /**
   * Set the active vault by ID.
   */
  setActiveVault(id: string): void {
    if (!this._vaults().some(v => v.id === id)) {
      throw new Error(`Vault with ID ${id} not found in registry.`);
    }
    this._activeVaultId.set(id);
    localStorage.setItem(ACTIVE_VAULT_KEY, id);
  }

  /**
   * Get a vault by its ID.
   */
  getVault(id: string): VaultInfo | undefined {
    return this._vaults().find(v => v.id === id);
  }

  /**
   * Clear all vaults (used on full reset).
   */
  clearAll(): void {
    this._vaults.set([]);
    this._activeVaultId.set(null);
    localStorage.removeItem(REGISTRY_KEY);
    localStorage.removeItem(ACTIVE_VAULT_KEY);
  }

  // ─── Migration ────────────────────────────────────────────────────

  /**
   * Migrate from old single-vault localStorage keys to the registry.
   * Called once during initialization if old keys exist but registry is empty.
   */
  migrateFromLegacy(): VaultInfo | null {
    const settingsJson = localStorage.getItem('intimapic_storage_settings');
    const vaultExists = localStorage.getItem('intimapic_vault_exists') === 'true';

    if (!vaultExists || !settingsJson) return null;

    try {
      const storageSettings: StorageSettings = JSON.parse(settingsJson);
      const vault = this.addVault('Mein Tresor', storageSettings);

      // Clean up legacy keys
      localStorage.removeItem('intimapic_storage_settings');
      localStorage.removeItem('intimapic_vault_exists');

      return vault;
    } catch {
      return null;
    }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private persist(vaults: VaultInfo[]): void {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(vaults));
  }
}
