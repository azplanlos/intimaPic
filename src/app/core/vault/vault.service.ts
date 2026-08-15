import { Injectable, inject, signal, computed, Injector } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { VaultConfigService } from '../crypto/vault-config.service';
import { BiometricAuthService } from '../biometric/biometric-auth.service';
import { BiometricCredentialStore } from '../biometric/biometric-credential.store';
import { StorageAdapterFactory } from '../storage/storage-adapter.factory';
import { VaultRegistryService } from './vault-registry.service';
import { VaultSettingsService } from './vault-settings.service';
import { SwClientService } from '../sw-client/sw-client.service';
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
  private readonly vaultSettings = inject(VaultSettingsService);
  private readonly swClient = inject(SwClientService);
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

      // 7. Write vault settings file with the chosen name
      const name = vaultName || 'Mein Tresor';
      await this.vaultSettings.ensureSettings(this.activeAdapter, name);

      // 8. Register vault in the registry
      this.registry.addVault(name, settings);

      // 9. Initialize metadata service
      const { MetadataService } = await import('../metadata/metadata.service');
      const metadataService = this.injector.get(MetadataService);
      await metadataService.initialize();

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
   * Validates that masterkey.cryptomator exists, reads the vault name from
   * the remote settings.json (if available), registers the vault,
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

      // 3. Read the vault name from remote settings.json (shared across devices)
      let name = vaultName || 'Mein Tresor';
      let nameUpdatedAt: string | undefined;
      try {
        const remoteSettings = await this.vaultSettings.readSettings(adapter);
        if (remoteSettings?.name) {
          name = remoteSettings.name;
          nameUpdatedAt = remoteSettings.updatedAt;
        }
      } catch {
        // Non-critical — use fallback name if settings.json can't be read
      }

      // 4. Disconnect (will reconnect on unlock)
      await adapter.disconnect();

      // 5. Register vault in the registry with the remote name + timestamp
      const vault = this.registry.addVault(name, settings);
      if (nameUpdatedAt) {
        this.registry.renameVault(vault.id, name, nameUpdatedAt);
      }

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
   * Supports offline unlock via locally cached masterkey.cryptomator.
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
      let masterkeyData: ArrayBuffer;

      if (navigator.onLine) {
        // Online: Connect to storage and read masterkey
        this.activeAdapter = await this.storageFactory.connectAdapter(settings);
        masterkeyData = await this.activeAdapter.readFile(
          this.vaultConfigService.MASTERKEY_FILENAME
        );
      } else {
        // Offline: Use cached vault meta from SW (gracefully handle SW not ready)
        let cached: { masterkeyFile: ArrayBuffer; vaultConfig?: ArrayBuffer } | null = null;
        try {
          cached = await this.swClient.getCachedVaultMeta(vault.id);
        } catch {
          // SW not active – can't do offline unlock
        }
        if (!cached) {
          this._error.set('Offline und kein lokaler Cache vorhanden. Bitte zuerst online den Tresor öffnen.');
          return false;
        }
        masterkeyData = cached.masterkeyFile;
      }

      // Unlock vault with password (AES Key Unwrap fails deterministically on wrong PW)
      const success = await this.vaultConfigService.unlockFromBytes(password, masterkeyData);

      if (!success) {
        this._error.set('Falsches Passwort. Bitte erneut versuchen.');
        if (this.activeAdapter) {
          await this.activeAdapter.disconnect();
          this.activeAdapter = null;
        }
        return false;
      }

      // Transfer keys to ServiceWorker (non-blocking: unlock must succeed
      // even if SW is not yet active – keys will be re-transferred on demand)
      const keys = this.cryptoService.getMasterKeys();
      if (keys) {
        try {
          await this.swClient.initKeys(keys.encryptionKey, keys.macKey, vault.id);
        } catch {
          // SW not ready yet – that's fine. The SwClientService will
          // re-transfer keys via NEED_KEYS when the SW becomes active.
        }

        // Register this service as key provider for re-transfer
        this.swClient.setKeyProvider({
          getMasterKeys: () => this.cryptoService.getMasterKeys(),
          getVaultId: () => this.registry.activeVault()?.id ?? null,
        });

        // Register token provider for SW token refresh requests
        this.swClient.setTokenProvider({
          refreshToken: async (provider: 'onedrive' | 's3') => {
            try {
              const vault = this.registry.activeVault();
              if (!vault) return null;
              await this.transferAuthTokenToSw(vault.storageSettings);
              // Return the token we just transferred
              if (provider === 'onedrive') {
                const { OneDriveAdapter } = await import('../storage/onedrive-adapter.service');
                const adapter = this.injector.get(OneDriveAdapter);
                const t = adapter.getAccessToken();
                return t ? { token: t, expiresAt: Date.now() + 3600_000 } : null;
              }
              return null;
            } catch {
              return null;
            }
          },
        });
      }

      // Transfer auth token to SW (if online and using OneDrive/S3)
      if (navigator.onLine && this.activeAdapter) {
        try {
          await this.transferAuthTokenToSw(settings);
        } catch {
          // Non-critical: SW will request token via NEED_TOKEN when needed
        }
      }

      // Ensure vault settings file exists and sync name (only if online)
      if (navigator.onLine) {
        await this.syncVaultSettings(vault.id, vault.name);
      }

      // Initialize metadata service (load & merge local+remote metadata)
      const { MetadataService } = await import('../metadata/metadata.service');
      const metadataService = this.injector.get(MetadataService);
      await metadataService.initialize();

      this._status.set('unlocked');
      return true;
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'Unlock failed');
      return false;
    }
  }

  /**
   * Transfer the current auth token to the ServiceWorker.
   * Reads the token directly from the active storage adapter instance
   * (tokens are acquired via MSAL/Cognito and not stored in settings).
   */
  private async transferAuthTokenToSw(settings: StorageSettings): Promise<void> {
    try {
      const provider = settings.provider;
      if (provider === 'icloud') return; // iCloud doesn't use SW storage

      // Get token from the active adapter (where MSAL stores it after auth)
      let token: string | null = null;

      if (provider === 'onedrive') {
        const { OneDriveAdapter } = await import('../storage/onedrive-adapter.service');
        const adapter = this.injector.get(OneDriveAdapter);
        token = adapter.getAccessToken();
      } else if (provider === 's3') {
        const { S3Adapter } = await import('../storage/s3-adapter.service');
        const adapter = this.injector.get(S3Adapter);
        token = adapter.getAuthToken();
      }

      if (!token) return;

      await this.swClient.setAuthToken(
        provider,
        token,
        Date.now() + 3600 * 1000, // 1 hour default
        { rootPath: settings.rootPath }
      );
    } catch {
      // Non-critical: fallback to direct storage will handle requests
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

      // 1. Connect to storage FIRST – while the user-gesture is still active.
      //    This ensures that if an interactive MSAL popup is needed (expired
      //    refresh token), the browser allows the popup because we're still
      //    within the original click event's trust window.
      //    If we did biometric auth first (WebAuthn), the async authenticator
      //    call consumes the user-gesture, causing popup blockers to fire.
      this.activeAdapter = await this.storageFactory.connectAdapter(settings);

      // 2. Authenticate biometrically (loads master keys via PRF)
      const authSuccess = await this.biometricAuth.authenticate(vault.id);
      if (!authSuccess) {
        this._error.set('Biometrische Authentifizierung fehlgeschlagen.');
        await this.activeAdapter.disconnect();
        this.activeAdapter = null;
        return false;
      }

      // 3. Ensure vault settings file exists and sync name
      await this.syncVaultSettings(vault.id, vault.name);

      // 4. Initialize metadata service (load & merge local+remote metadata)
      const { MetadataService } = await import('../metadata/metadata.service');
      const metadataService = this.injector.get(MetadataService);
      await metadataService.initialize();

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
    const vault = this.registry.activeVault();
    if (!vault) return false;

    const [platformAvailable, hasCredentials] = await Promise.all([
      this.biometricAuth.isAvailable(),
      this.biometricAuth.hasRegisteredCredentials(vault.id),
    ]);
    return platformAvailable && hasCredentials;
  }

  // ─── Vault Settings Sync ────────────────────────────────────────────

  /**
   * Ensure settings.json exists in the vault and sync the vault name
   * bidirectionally using timestamps to determine the authoritative source.
   *
   * - If no remote settings.json exists → push the local name.
   * - If names differ → compare local `nameUpdatedAt` vs remote `updatedAt`.
   *   The newer timestamp wins. On tie or missing local timestamp, remote wins
   *   (favors the shared state over a potentially stale local default).
   */
  private async syncVaultSettings(vaultId: string, localName: string): Promise<void> {
    if (!this.activeAdapter) return;

    try {
      const vault = this.registry.getVault(vaultId);
      const localNameUpdatedAt = vault?.nameUpdatedAt ?? null;

      const remoteSettings = await this.vaultSettings.readSettings(this.activeAdapter);

      if (!remoteSettings) {
        // No settings file yet — create it with the local name
        await this.vaultSettings.ensureSettings(this.activeAdapter, localName);
      } else if (remoteSettings.name !== localName) {
        // Names differ — use timestamps to decide which is newer
        const remoteUpdatedAt = remoteSettings.updatedAt;

        const localIsNewer = localNameUpdatedAt
          && remoteUpdatedAt
          && new Date(localNameUpdatedAt).getTime() > new Date(remoteUpdatedAt).getTime();

        if (localIsNewer) {
          // Local was explicitly renamed after remote — push to remote
          await this.vaultSettings.updateName(this.activeAdapter, localName);
        } else {
          // Remote is newer (or no local timestamp) — pull remote name to local
          this.registry.renameVault(vaultId, remoteSettings.name, remoteUpdatedAt);
        }
      }
    } catch {
      // Non-critical — don't block unlock if settings sync fails
    }
  }

  // ─── Vault Lock ───────────────────────────────────────────────────

  async lockVault(): Promise<void> {
    // Flush and tear down metadata before disconnecting storage
    const { MetadataService } = await import('../metadata/metadata.service');
    const metadataService = this.injector.get(MetadataService);
    await metadataService.teardown();

    // Lazy-resolve PhotoService to avoid circular dependency
    const { PhotoService } = await import('../album/photo.service');
    const photoService = this.injector.get(PhotoService);
    photoService.clearCache();

    // Lock the ServiceWorker (zeroizes keys, clears tokens)
    try {
      await this.swClient.lock();
    } catch {
      // SW might not be ready – non-critical
    }

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

    const activeId = this.registry.activeVaultId();
    if (activeId) {
      await this.biometricStore.clearVault(activeId);
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
    await this.biometricStore.clearAll();
    this.registry.clearAll();
    this._status.set('none');
  }
}
