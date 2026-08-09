import { Injectable, inject, signal, computed, Injector } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { VaultConfigService } from '../crypto/vault-config.service';
import { BiometricAuthService } from '../biometric/biometric-auth.service';
import { BiometricCredentialStore } from '../biometric/biometric-credential.store';
import { StorageAdapterFactory } from '../storage/storage-adapter.factory';
import { VaultRegistryService } from './vault-registry.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import type { StorageSettings } from '../crypto/crypto.models';

export type VaultStatus = 'none' | 'locked' | 'unlocked';

/**
 * Central state service managing vault lifecycle.
 * Tracks whether a vault exists, is locked/unlocked,
 * and which storage adapter is active.
 *
 * Works with VaultRegistryService to support multiple vaults.
 * Only one vault can be unlocked at a time.
 */
@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly cryptoService = inject(CryptoService);
  private readonly vaultConfigService = inject(VaultConfigService);
  private readonly biometricAuth = inject(BiometricAuthService);
  private readonly biometricStore = inject(BiometricCredentialStore);
  private readonly storageFactory = inject(StorageAdapterFactory);
  private readonly registry = inject(VaultRegistryService);
  private readonly injector = inject(Injector);

  // ─── State (Signals) ──────────────────────────────────────────────

  private readonly _status = signal<VaultStatus>('none');
  private readonly _error = signal<string | null>(null);

  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  readonly isUnlocked = computed(() => this._status() === 'unlocked');

  /** Storage settings of the currently active vault (convenience accessor) */
  readonly storageSettings = computed(() => {
    const vault = this.registry.activeVault();
    return vault?.storageSettings ?? null;
  });

  private activeAdapter: StorageAdapter | null = null;

  // ─── Initialization ───────────────────────────────────────────────

  /**
   * Initialize the vault system. Loads the registry and migrates
   * from the legacy single-vault format if needed.
   */
  async initialize(): Promise<void> {
    this.registry.initialize();

    // Migrate legacy single-vault localStorage keys to registry
    if (!this.registry.hasVaults()) {
      const legacyExists = localStorage.getItem('intimapic_vault_exists') === 'true';
      if (legacyExists) {
        this.registry.migrateFromLegacy();
      }
    }

    // Determine status based on registry
    if (this.registry.hasVaults()) {
      this._status.set('locked');
    } else {
      this._status.set('none');
    }
  }

  // ─── Vault Creation ───────────────────────────────────────────────

  /**
   * Create a new Cryptomator-compatible vault with the given password and storage settings.
   * Registers the vault in the registry.
   */
  async createVault(password: string, settings: StorageSettings, vaultName?: string): Promise<boolean> {
    try {
      this._error.set(null);

      // 1. Configure and connect storage
      this.activeAdapter = await this.storageFactory.connectAdapter(settings);

      // 2. Create the root folder if needed
      try {
        await this.activeAdapter.createFolder('');
      } catch {
        // Folder might already exist
      }

      // 3. Create vault (generates master keys + Cryptomator config files)
      const { masterkeyFileBytes, vaultConfigBytes } =
        await this.vaultConfigService.createNewVault(password);

      // 4. Upload masterkey.cryptomator
      await this.activeAdapter.writeFile(
        this.vaultConfigService.MASTERKEY_FILENAME,
        masterkeyFileBytes
      );

      // 5. Upload vault.cryptomator
      await this.activeAdapter.writeFile(
        this.vaultConfigService.VAULT_CONFIG_FILENAME,
        vaultConfigBytes
      );

      // 6. Create Cryptomator directory structure
      const rootDirPath = await this.cryptoService.encryptDirectoryId('');
      const rootDirParts = rootDirPath.split('/');

      try { await this.activeAdapter.createFolder('d'); }
      catch { /* may already exist */ }

      try { await this.activeAdapter.createFolder(`d/${rootDirParts[1]}`); }
      catch { /* may already exist */ }

      await this.activeAdapter.createFolder(rootDirPath);

      // 7. Register vault in the registry
      const name = vaultName || 'Mein Tresor';
      this.registry.addVault(name, settings);

      this._status.set('unlocked');
      return true;
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'Vault creation failed');
      return false;
    }
  }

  // ─── Connect Existing Vault ─────────────────────────────────────────

  /**
   * Connect to an existing vault on a new device.
   * Validates that masterkey.cryptomator exists, registers it,
   * and sets status to 'locked' so the unlock screen appears.
   */
  async connectExistingVault(settings: StorageSettings, vaultName?: string): Promise<boolean> {
    try {
      this._error.set(null);

      // 1. Connect to storage
      const adapter = await this.storageFactory.connectAdapter(settings);

      // 2. Verify that masterkey.cryptomator exists
      const masterkeyExists = await adapter.fileExists(
        this.vaultConfigService.MASTERKEY_FILENAME
      );

      if (!masterkeyExists) {
        await adapter.disconnect();
        this._error.set(
          'Kein Tresor gefunden. Die Datei masterkey.cryptomator existiert nicht am angegebenen Speicherort.'
        );
        return false;
      }

      // 3. Disconnect (will reconnect on unlock)
      await adapter.disconnect();

      // 4. Register vault in the registry
      const name = vaultName || 'Mein Tresor';
      this.registry.addVault(name, settings);

      this._status.set('locked');
      return true;
    } catch (err) {
      this._error.set(
        err instanceof Error ? err.message : 'Verbindung zum bestehenden Tresor fehlgeschlagen.'
      );
      return false;
    }
  }

  // ─── Vault Existence Check ────────────────────────────────────────

  /**
   * Check if a vault already exists at the given storage location.
   * Used by createVault to prevent accidental overwriting.
   */
  async vaultExistsAtStorage(settings: StorageSettings): Promise<boolean> {
    try {
      const adapter = await this.storageFactory.connectAdapter(settings);
      const exists = await adapter.fileExists(
        this.vaultConfigService.MASTERKEY_FILENAME
      );
      await adapter.disconnect();
      return exists;
    } catch {
      return false;
    }
  }

  // ─── Vault Unlock ─────────────────────────────────────────────────

  /**
   * Unlock the active vault by connecting to storage and unwrapping master keys.
   */
  async unlockVault(password: string): Promise<boolean> {
    try {
      this._error.set(null);
      const vault = this.registry.activeVault();

      if (!vault) {
        this._error.set('Kein Tresor ausgewählt. Bitte wähle einen Tresor.');
        return false;
      }

      const settings = vault.storageSettings;

      // 1. Connect to storage
      this.activeAdapter = await this.storageFactory.connectAdapter(settings);

      // 2. Read masterkey.cryptomator
      const masterkeyData = await this.activeAdapter.readFile(
        this.vaultConfigService.MASTERKEY_FILENAME
      );

      // 3. Unlock vault with password (AES Key Unwrap fails deterministically on wrong PW)
      const success = await this.vaultConfigService.unlockFromBytes(password, masterkeyData);

      if (!success) {
        this._error.set('Falsches Passwort. Bitte erneut versuchen.');
        await this.activeAdapter.disconnect();
        this.activeAdapter = null;
        return false;
      }

      this._status.set('unlocked');
      return true;
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'Unlock failed');
      return false;
    }
  }

  // ─── Biometric Unlock ─────────────────────────────────────────────

  /**
   * Unlock the vault using biometric authentication (FaceID/Windows Hello).
   * PRF extension provides a device-bound KEK to unwrap the master keys.
   */
  async unlockWithBiometric(): Promise<boolean> {
    try {
      this._error.set(null);
      const vault = this.registry.activeVault();

      if (!vault) {
        this._error.set('Kein Tresor ausgewählt. Bitte wähle einen Tresor.');
        return false;
      }

      const settings = vault.storageSettings;

      // 1. Authenticate biometrically (loads master keys via PRF)
      const authSuccess = await this.biometricAuth.authenticate();
      if (!authSuccess) {
        this._error.set('Biometrische Authentifizierung fehlgeschlagen.');
        return false;
      }

      // 2. Connect to storage
      this.activeAdapter = await this.storageFactory.connectAdapter(settings);

      this._status.set('unlocked');
      return true;
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'Biometric unlock failed');
      return false;
    }
  }

  /**
   * Check if biometric unlock is available for the active vault.
   */
  async isBiometricAvailable(): Promise<boolean> {
    const [platformAvailable, hasCredentials] = await Promise.all([
      this.biometricAuth.isAvailable(),
      this.biometricAuth.hasRegisteredCredentials(),
    ]);
    return platformAvailable && hasCredentials;
  }

  // ─── Vault Lock ───────────────────────────────────────────────────

  async lockVault(): Promise<void> {
    // Lazy-resolve PhotoService to avoid circular dependency
    const { PhotoService } = await import('../album/photo.service');
    const photoService = this.injector.get(PhotoService);
    photoService.clearCache();

    this.cryptoService.lockVault();
    if (this.activeAdapter) {
      await this.activeAdapter.disconnect();
      this.activeAdapter = null;
    }
    this._status.set('locked');
  }

  // ─── Vault Switch ─────────────────────────────────────────────────

  /**
   * Switch to a different vault. Locks the current vault first.
   */
  async switchVault(vaultId: string): Promise<void> {
    if (this._status() === 'unlocked') {
      await this.lockVault();
    }
    this.registry.setActiveVault(vaultId);
    this._status.set('locked');
  }

  // ─── Storage Access ───────────────────────────────────────────────

  getStorage(): StorageAdapter {
    if (!this.activeAdapter) {
      throw new Error('Vault is locked or no storage connected.');
    }
    return this.activeAdapter;
  }

  // ─── Settings ─────────────────────────────────────────────────────

  updateSettings(settings: StorageSettings): void {
    const vault = this.registry.activeVault();
    if (vault) {
      // Update settings in the registry
      const updatedVault = { ...vault, storageSettings: settings };
      const vaults = this.registry.vaults().map(v =>
        v.id === vault.id ? updatedVault : v
      );
      // Persist via registry (re-persist the whole list)
      localStorage.setItem('intimapic_vault_registry', JSON.stringify(vaults));
    }
  }

  // ─── Reset ────────────────────────────────────────────────────────

  /**
   * Remove the active vault from the registry and reset state.
   */
  async reset(): Promise<void> {
    await this.lockVault();
    await this.biometricStore.clear();

    const activeId = this.registry.activeVaultId();
    if (activeId) {
      this.registry.removeVault(activeId);
    }

    if (this.registry.hasVaults()) {
      this._status.set('locked');
    } else {
      this._status.set('none');
    }
  }

  /**
   * Full reset: remove all vaults.
   */
  async resetAll(): Promise<void> {
    await this.lockVault();
    await this.biometricStore.clear();
    this.registry.clearAll();
    this._status.set('none');
  }
}
