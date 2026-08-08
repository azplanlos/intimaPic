import { Injectable, inject } from '@angular/core';
import { CryptoService } from './crypto.service';
import type { MasterkeyFile, VaultConfig } from './crypto.models';

/**
 * Service for managing Cryptomator vault configuration files:
 * - masterkey.cryptomator (JSON: wrapped keys + scrypt params)
 * - vault.cryptomator (JWT: vault metadata, signed with master keys)
 */
@Injectable({ providedIn: 'root' })
export class VaultConfigService {
  private readonly cryptoService = inject(CryptoService);

  readonly MASTERKEY_FILENAME = 'masterkey.cryptomator';
  readonly VAULT_CONFIG_FILENAME = 'vault.cryptomator';

  // ─── Serialization ─────────────────────────────────────────────────

  serializeMasterkeyFile(masterkeyFile: MasterkeyFile): ArrayBuffer {
    // Compact JSON without pretty-printing (Cryptomator-compatible)
    const json = JSON.stringify(masterkeyFile);
    return new TextEncoder().encode(json).buffer as ArrayBuffer;
  }

  parseMasterkeyFile(data: ArrayBuffer): MasterkeyFile {
    const json = new TextDecoder().decode(data);
    const parsed = JSON.parse(json) as MasterkeyFile;

    if (!parsed.scryptSalt || !parsed.primaryMasterKey || !parsed.hmacMasterKey) {
      throw new Error('Invalid masterkey.cryptomator: missing required fields');
    }

    return parsed;
  }

  serializeVaultConfig(config: VaultConfig, masterKeys: ArrayBuffer): Promise<ArrayBuffer> {
    // Create a JWT signed with HMAC-SHA256 using the full 64-byte raw masterkey
    const header = { kid: `masterkeyfile:${this.MASTERKEY_FILENAME}`, typ: 'JWT', alg: 'HS256' };
    const payload = config;

    const headerB64 = this.objectToBase64Url(header);
    const payloadB64 = this.objectToBase64Url(payload);
    const signingInput = `${headerB64}.${payloadB64}`;

    // Sign with HMAC-SHA256 using the concatenated 512-bit raw masterkey
    return crypto.subtle.importKey(
      'raw',
      masterKeys,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    ).then(async (hmacKey) => {
      const encoder = new TextEncoder();
      const signature = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(signingInput));
      const sigB64 = this.arrayBufferToBase64Url(signature);
      const jwt = `${signingInput}.${sigB64}`;
      return encoder.encode(jwt).buffer as ArrayBuffer;
    });
  }

  parseVaultConfig(data: ArrayBuffer): VaultConfig {
    const text = new TextDecoder().decode(data);
    // Parse JWT payload (second part)
    const parts = text.split('.');
    if (parts.length < 2) {
      throw new Error('Invalid vault.cryptomator: not a valid JWT');
    }

    const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(payloadJson) as VaultConfig;
  }

  // ─── Vault Lifecycle ───────────────────────────────────────────────

  /**
   * Create a new vault. Returns file contents to write to storage.
   */
  async createNewVault(password: string): Promise<{
    masterkeyFileBytes: ArrayBuffer;
    vaultConfigBytes: ArrayBuffer;
    masterkeyFile: MasterkeyFile;
    vaultConfig: VaultConfig;
  }> {
    const { masterkeyFile, vaultConfig } = await this.cryptoService.createVault(password);

    const masterkeyFileBytes = this.serializeMasterkeyFile(masterkeyFile);
    const masterKeysRaw = await this.cryptoService.exportMasterKeys();
    const vaultConfigBytes = await this.serializeVaultConfig(vaultConfig, masterKeysRaw);

    return { masterkeyFileBytes, vaultConfigBytes, masterkeyFile, vaultConfig };
  }

  /**
   * Unlock a vault from stored masterkey file bytes.
   */
  async unlockFromBytes(password: string, masterkeyData: ArrayBuffer): Promise<boolean> {
    const masterkeyFile = this.parseMasterkeyFile(masterkeyData);
    return this.cryptoService.unlockVault(password, masterkeyFile);
  }

  /**
   * Change the vault password. Returns new masterkey file bytes.
   */
  async changePassword(newPassword: string): Promise<ArrayBuffer> {
    const newMasterkeyFile = await this.cryptoService.changePassword(newPassword);
    return this.serializeMasterkeyFile(newMasterkeyFile);
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private objectToBase64Url(obj: object): string {
    // Use TextEncoder for proper UTF-8 handling before Base64 encoding
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private arrayBufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
