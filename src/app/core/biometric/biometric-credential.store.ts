import { Injectable } from '@angular/core';
import type { BiometricCredential, BiometricVaultStore } from './biometric.models';

const DB_NAME = 'intimapic_biometric';
const DB_VERSION = 2;
const STORE_NAME = 'credentials';
const KEY_STORE_NAME = 'crypto_keys';

/**
 * IndexedDB-backed store for biometric credential metadata and CryptoKeys.
 * All operations are scoped by vault ID – each vault has its own set of
 * biometric credentials and associated CryptoKeys.
 *
 * Storage layout:
 * - 'credentials' object store: keyed by `vault_<vaultId>` → BiometricVaultStore
 * - 'crypto_keys' object store: keyed by `key_<credentialId>` → CryptoKey
 */
@Injectable({ providedIn: 'root' })
export class BiometricCredentialStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  // ─── Database ──────────────────────────────────────────────────────

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
          if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
            db.createObjectStore(KEY_STORE_NAME);
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  // ─── Vault-scoped Credential Metadata ──────────────────────────────

  async getVaultStore(vaultId: string): Promise<BiometricVaultStore> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(`vault_${vaultId}`);

      request.onsuccess = () => {
        resolve(request.result ?? { vaultId, credentials: [], rpId: '' });
      };
      request.onerror = () => reject(request.error);
    });
  }

  private async saveVaultStore(data: BiometricVaultStore): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(data, `vault_${data.vaultId}`);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ─── CryptoKey Storage (for gatekeeper mode) ───────────────────────

  /**
   * Store a non-extractable CryptoKey for a credential.
   * IndexedDB structured clone supports CryptoKey objects natively.
   */
  async saveCryptoKey(credentialId: string, key: CryptoKey): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
      const store = tx.objectStore(KEY_STORE_NAME);
      const request = store.put(key, `key_${credentialId}`);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Retrieve the CryptoKey for a credential.
   */
  async getCryptoKey(credentialId: string): Promise<CryptoKey | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE_NAME, 'readonly');
      const store = tx.objectStore(KEY_STORE_NAME);
      const request = store.get(`key_${credentialId}`);

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Remove the CryptoKey for a credential.
   */
  private async removeCryptoKey(credentialId: string): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
      const store = tx.objectStore(KEY_STORE_NAME);
      const request = store.delete(`key_${credentialId}`);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ─── Credential Management (vault-scoped) ──────────────────────────

  async addCredential(vaultId: string, credential: BiometricCredential, rpId: string): Promise<void> {
    const data = await this.getVaultStore(vaultId);
    data.rpId = rpId;
    data.credentials.push(credential);
    await this.saveVaultStore(data);
  }

  async removeCredential(vaultId: string, credentialId: string): Promise<void> {
    const data = await this.getVaultStore(vaultId);
    data.credentials = data.credentials.filter(c => c.id !== credentialId);
    await this.saveVaultStore(data);
    await this.removeCryptoKey(credentialId);
  }

  async getCredentialById(vaultId: string, credentialId: string): Promise<BiometricCredential | null> {
    const data = await this.getVaultStore(vaultId);
    return data.credentials.find(c => c.id === credentialId) ?? null;
  }

  async getAllCredentials(vaultId: string): Promise<BiometricCredential[]> {
    const data = await this.getVaultStore(vaultId);
    return data.credentials;
  }

  async hasCredentials(vaultId: string): Promise<boolean> {
    const data = await this.getVaultStore(vaultId);
    return data.credentials.length > 0;
  }

  async updateLastUsed(vaultId: string, credentialId: string): Promise<void> {
    const data = await this.getVaultStore(vaultId);
    const cred = data.credentials.find(c => c.id === credentialId);
    if (cred) {
      cred.lastUsedAt = new Date().toISOString();
      await this.saveVaultStore(data);
    }
  }

  async updateDeviceName(vaultId: string, credentialId: string, newName: string): Promise<void> {
    const data = await this.getVaultStore(vaultId);
    const cred = data.credentials.find(c => c.id === credentialId);
    if (cred) {
      cred.deviceName = newName;
      await this.saveVaultStore(data);
    }
  }

  /**
   * Clear all biometric data for a specific vault.
   */
  async clearVault(vaultId: string): Promise<void> {
    const data = await this.getVaultStore(vaultId);
    // Remove all CryptoKeys for this vault's credentials
    for (const cred of data.credentials) {
      await this.removeCryptoKey(cred.id);
    }
    await this.saveVaultStore({ vaultId, credentials: [], rpId: '' });
  }

  /**
   * Clear ALL biometric data across all vaults (full reset).
   */
  async clearAll(): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
      const store = tx.objectStore(KEY_STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}
