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

  /**
   * Promise that resolves when the storage adapter is connected and ready.
   * Resolves immediately if the adapter was connected synchronously during unlock.
   * Resolves later if the adapter is being connected in the background (cache path).
   * Services that need storage access (e.g. ImportScanService) can await this.
   */
  storageReady: Promise<void> = Promise.resolve();

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

  /** Timeout for network operations during unlock (ms). If exceeded, cached data is used. */
  private readonly UNLOCK_NETWORK_TIMEOUT_MS = 4000;

  /**
   * Unlock the active vault by connecting to storage and unwrapping master keys.
   * Uses a "race against cache" strategy: on slow connections the locally cached
   * masterkey.cryptomator is used so the user doesn't wait for the network.
   * Post-unlock tasks (settings sync, metadata merge) run in the background.
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
      let usedCache = false;

      if (navigator.onLine) {
        // Race: try network with timeout, fall back to cache if slow/unavailable
        const result = await this.raceMasterkeyFetch(vault.id, settings);
        if (!result) {
          this._error.set('Masterkey konnte weder vom Netzwerk noch aus dem Cache geladen werden.');
          return false;
        }
        masterkeyData = result.data;
        usedCache = result.fromCache;

        // If network succeeded, adapter is already connected → storageReady resolves immediately
        if (!usedCache && this.activeAdapter) {
          this.storageReady = Promise.resolve();
        }
      } else {
        // Fully offline: use cached vault meta from SW
        const cached = await this.getCachedMasterkeyData(vault.id);
        if (!cached) {
          this._error.set('Offline und kein lokaler Cache vorhanden. Bitte zuerst online den Tresor öffnen.');
          return false;
        }
        masterkeyData = cached;
        usedCache = true;
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

      // Transfer auth token to SW (if online and adapter is connected)
      if (navigator.onLine && this.activeAdapter) {
        try {
          await this.transferAuthTokenToSw(settings);
        } catch {
          // Non-critical: SW will request token via NEED_TOKEN when needed
        }
      }

      // ─── Mark as unlocked IMMEDIATELY ────────────────────────────────
      // Background tasks (settings sync, metadata) run non-blocking so the
      // user can navigate to the gallery without waiting for the network.
      this._status.set('unlocked');

      // ─── Non-blocking background tasks ───────────────────────────────
      this.runPostUnlockBackgroundTasks(vault.id, vault.name, usedCache, settings);

      return true;
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'Unlock failed');
      return false;
    }
  }

  /**
   * Race the network masterkey fetch against the local SW cache.
   * Returns the masterkey data from whichever source responds first.
   * On slow connections, the cache wins after UNLOCK_NETWORK_TIMEOUT_MS.
   */
  private async raceMasterkeyFetch(
    vaultId: string,
    settings: StorageSettings
  ): Promise<{ data: ArrayBuffer; fromCache: boolean } | null> {
    // Start both in parallel
    const networkPromise = this.fetchMasterkeyFromNetwork(settings);
    const cachePromise = this.getCachedMasterkeyData(vaultId);

    // Create a timeout that resolves as "timed out" marker
    const timeout = new Promise<'TIMEOUT'>(resolve =>
      setTimeout(() => resolve('TIMEOUT'), this.UNLOCK_NETWORK_TIMEOUT_MS)
    );

    // Try network first, but with timeout
    const networkOrTimeout = Promise.race([networkPromise, timeout]);
    const result = await networkOrTimeout;

    if (result !== 'TIMEOUT' && result !== null) {
      // Network responded in time
      return { data: result, fromCache: false };
    }

    // Network was slow or failed — try cache
    const cached = await cachePromise;
    if (cached) {
      // Start storage connection in background so it's ready for later operations
      this.connectStorageInBackground(settings);
      return { data: cached, fromCache: true };
    }

    // No cache available — must wait for network (first-time unlock scenario)
    if (result === 'TIMEOUT') {
      // Network is still in-flight, wait for it (no choice without cache)
      const networkResult = await networkPromise;
      if (networkResult) {
        return { data: networkResult, fromCache: false };
      }
    }

    return null;
  }

  /**
   * Fetch masterkey from network via storage adapter.
   * Returns null on failure (instead of throwing).
   */
  private async fetchMasterkeyFromNetwork(settings: StorageSettings): Promise<ArrayBuffer | null> {
    try {
      this.activeAdapter = await this.storageFactory.connectAdapter(settings);
      return await this.activeAdapter.readFile(this.vaultConfigService.MASTERKEY_FILENAME);
    } catch {
      return null;
    }
  }

  /**
   * Get cached masterkey data from the ServiceWorker's IndexedDB.
   * Returns null if not available.
   */
  private async getCachedMasterkeyData(vaultId: string): Promise<ArrayBuffer | null> {
    try {
      const cached = await this.swClient.getCachedVaultMeta(vaultId);
      return cached?.masterkeyFile ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Connect storage adapter in the background (fire-and-forget).
   * Used when cache was used for unlock but we still want a connection for later ops.
   * Sets this.storageReady so callers can await the connection.
   */
  private connectStorageInBackground(settings: StorageSettings): void {
    this.storageReady = this.storageFactory.connectAdapter(settings).then(adapter => {
      this.activeAdapter = adapter;
      // Transfer token to SW once connected
      this.transferAuthTokenToSw(settings).catch(() => {});
    }).catch(() => {
      // Will retry on next operation that needs storage
    });
  }

  /**
   * Run post-unlock housekeeping tasks in the background.
   * These do NOT block the unlock — the vault is already usable.
   */
  private runPostUnlockBackgroundTasks(
    vaultId: string,
    vaultName: string,
    usedCache: boolean,
    settings: StorageSettings
  ): void {
    // Use queueMicrotask to ensure this runs after the current call stack
    // but without blocking the UI or navigation.
    queueMicrotask(async () => {
      try {
        // Sync vault settings (only if online and adapter is available)
        if (navigator.onLine && this.activeAdapter) {
          await this.syncVaultSettings(vaultId, vaultName);
        }
      } catch {
        // Non-critical
      }

      try {
        // Initialize metadata service (local-first, remote merge in background)
        const { MetadataService } = await import('../metadata/metadata.service');
        const metadataService = this.injector.get(MetadataService);
        await metadataService.initialize();
      } catch {
        // Non-critical — metadata will be initialized on next access
      }

      // If we used cache for masterkey, the network fetch may still be completing.
      // Once the adapter is connected, transfer the auth token.
      if (usedCache && navigator.onLine && this.activeAdapter) {
        try {
          await this.transferAuthTokenToSw(settings);
        } catch {
          // Non-critical
        }
      }
    });
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
   *
   * NOTE: The storage connection MUST happen before biometric auth because
   * the user-gesture is consumed by WebAuthn. If MSAL needs an interactive
   * popup (expired refresh token), it must fire while the gesture is active.
   * However, post-auth tasks (settings sync, metadata) run in the background.
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
      //    Use timeout: if connection is slow but we have cached credentials,
      //    we proceed with biometric auth anyway.
      let storageConnected = false;
      try {
        this.activeAdapter = await this.connectStorageWithTimeout(settings, this.UNLOCK_NETWORK_TIMEOUT_MS);
        storageConnected = true;
        this.storageReady = Promise.resolve();
      } catch {
        // Storage connection failed or timed out.
        // We can still proceed with biometric unlock using cached keys.
        // Storage will be connected in background afterwards.
      }

      // 2. Authenticate biometrically (loads master keys via PRF)
      const authSuccess = await this.biometricAuth.authenticate(vault.id);
      if (!authSuccess) {
        this._error.set('Biometrische Authentifizierung fehlgeschlagen.');
        if (this.activeAdapter) {
          await this.activeAdapter.disconnect();
          this.activeAdapter = null;
        }
        return false;
      }

      // 3. Transfer keys to SW
      const keys = this.cryptoService.getMasterKeys();
      if (keys) {
        try {
          await this.swClient.initKeys(keys.encryptionKey, keys.macKey, vault.id);
        } catch {
          // SW not ready – fine
        }

        this.swClient.setKeyProvider({
          getMasterKeys: () => this.cryptoService.getMasterKeys(),
          getVaultId: () => this.registry.activeVault()?.id ?? null,
        });

        this.swClient.setTokenProvider({
          refreshToken: async (provider: 'onedrive' | 's3') => {
            try {
              const v = this.registry.activeVault();
              if (!v) return null;
              await this.transferAuthTokenToSw(v.storageSettings);
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

      // Transfer auth token to SW (if connected)
      if (storageConnected && this.activeAdapter) {
        try {
          await this.transferAuthTokenToSw(settings);
        } catch {
          // Non-critical
        }
      }

      // ─── Mark as unlocked IMMEDIATELY ────────────────────────────────
      this._status.set('unlocked');

      // ─── Non-blocking background tasks ───────────────────────────────
      this.runPostUnlockBackgroundTasks(vault.id, vault.name, !storageConnected, settings);

      // If storage wasn't connected, try in background
      if (!storageConnected) {
        this.connectStorageInBackground(settings);
      }

      return true;
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'Biometric unlock failed');
      return false;
    }
  }

  /**
   * Connect to storage with a timeout. Throws if connection doesn't complete in time.
   */
  private async connectStorageWithTimeout(settings: StorageSettings, timeoutMs: number): Promise<StorageAdapter> {
    return this.storageFactory.connectAdapterWithTimeout(settings, timeoutMs);
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

  // ─── Vault Rename ────────────────────────────────────────────────────

  /**
   * Rename the currently active vault.
   * Updates the local registry immediately (with timestamp) and pushes
   * the new name to remote settings.json if online and the vault is unlocked.
   * If offline, the name is cached locally and will be synced on next unlock.
   */
  async renameActiveVault(newName: string): Promise<void> {
    const vault = this.registry.activeVault();
    if (!vault) return;

    // 1. Update local registry (records nameUpdatedAt timestamp)
    this.registry.renameVault(vault.id, newName);

    // 2. Push to remote if online and adapter is connected
    if (navigator.onLine && this.activeAdapter) {
      try {
        await this.vaultSettings.updateName(this.activeAdapter, newName);
      } catch {
        // Non-critical: will sync on next unlock via syncVaultSettings
      }
    }
    // If offline: local nameUpdatedAt is newer than remote updatedAt,
    // so syncVaultSettings will push the local name on next online unlock.
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
