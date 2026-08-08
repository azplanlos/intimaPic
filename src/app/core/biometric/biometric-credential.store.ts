import { Injectable } from '@angular/core';
import type { BiometricCredential, BiometricStore } from './biometric.models';

const DB_NAME = 'intimapic_biometric';
const DB_VERSION = 1;
const STORE_NAME = 'credentials';
const STORE_KEY = 'biometric_store';

/**
 * IndexedDB-backed store for biometric credential metadata.
 * Stores wrapped master keys per credential so each device can
 * independently unlock the vault using its PRF-derived KEK.
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
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  // ─── Read/Write ────────────────────────────────────────────────────

  async getStore(): Promise<BiometricStore> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(STORE_KEY);

      request.onsuccess = () => {
        resolve(request.result ?? { credentials: [], rpId: '' });
      };
      request.onerror = () => reject(request.error);
    });
  }

  private async saveStore(data: BiometricStore): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(data, STORE_KEY);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ─── Credential Management ─────────────────────────────────────────

  async addCredential(credential: BiometricCredential, rpId: string): Promise<void> {
    const data = await this.getStore();
    data.rpId = rpId;
    data.credentials.push(credential);
    await this.saveStore(data);
  }

  async removeCredential(credentialId: string): Promise<void> {
    const data = await this.getStore();
    data.credentials = data.credentials.filter(c => c.id !== credentialId);
    await this.saveStore(data);
  }

  async getCredentialById(credentialId: string): Promise<BiometricCredential | null> {
    const data = await this.getStore();
    return data.credentials.find(c => c.id === credentialId) ?? null;
  }

  async getAllCredentials(): Promise<BiometricCredential[]> {
    const data = await this.getStore();
    return data.credentials;
  }

  async hasCredentials(): Promise<boolean> {
    const data = await this.getStore();
    return data.credentials.length > 0;
  }

  async updateLastUsed(credentialId: string): Promise<void> {
    const data = await this.getStore();
    const cred = data.credentials.find(c => c.id === credentialId);
    if (cred) {
      cred.lastUsedAt = new Date().toISOString();
      await this.saveStore(data);
    }
  }

  async updateDeviceName(credentialId: string, newName: string): Promise<void> {
    const data = await this.getStore();
    const cred = data.credentials.find(c => c.id === credentialId);
    if (cred) {
      cred.deviceName = newName;
      await this.saveStore(data);
    }
  }

  /**
   * Clear all biometric data (used when vault is reset).
   */
  async clear(): Promise<void> {
    await this.saveStore({ credentials: [], rpId: '' });
  }
}
