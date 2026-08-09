import { Injectable, inject } from '@angular/core';
import { BiometricCredentialStore } from './biometric-credential.store';
import { CryptoService } from '../crypto/crypto.service';
import { aesKeyWrap, aesKeyUnwrap } from '../crypto/aes-keywrap';
import { NativeWebAuthnService } from './native-webauthn.service';
import type { BiometricCredential } from './biometric.models';

/**
 * Service for WebAuthn biometric authentication with automatic fallback.
 * All operations are scoped to a specific vault ID.
 *
 * Two modes are supported:
 *
 * 1. PRF mode (preferred):
 *    Uses the WebAuthn PRF extension to derive a hardware-bound KEK that
 *    wraps/unwraps the vault master keys. Most secure – keys are bound to
 *    the authenticator hardware. Supported on iOS/macOS (iCloud Keychain),
 *    Android (Google Password Manager).
 *
 * 2. Gatekeeper mode (fallback):
 *    Used when PRF is not available (e.g. Windows Hello). WebAuthn serves
 *    only as a biometric presence check. Master keys are encrypted with a
 *    non-extractable AES-GCM CryptoKey stored in IndexedDB. After successful
 *    biometric assertion, the CryptoKey is used to decrypt the master keys.
 */
@Injectable({ providedIn: 'root' })
export class BiometricAuthService {
  private readonly credentialStore = inject(BiometricCredentialStore);
  private readonly cryptoService = inject(CryptoService);
  private readonly nativeWebAuthn = inject(NativeWebAuthnService);

  /**
   * Check if biometric authentication is available on this device.
   */
  async isAvailable(): Promise<boolean> {
    if (!window.PublicKeyCredential) return false;

    try {
      return await this.nativeWebAuthn.isPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Check if any biometric credentials are registered for a specific vault.
   */
  async hasRegisteredCredentials(vaultId: string): Promise<boolean> {
    return this.credentialStore.hasCredentials(vaultId);
  }

  /**
   * Get all registered credentials for a specific vault.
   */
  async getRegisteredCredentials(vaultId: string): Promise<BiometricCredential[]> {
    return this.credentialStore.getAllCredentials(vaultId);
  }

  // ─── Registration ──────────────────────────────────────────────────

  /**
   * Register a new biometric credential for the current device and vault.
   * Automatically selects PRF mode or gatekeeper mode based on platform support.
   * The vault must be unlocked (master keys loaded) before calling this.
   *
   * @param vaultId - The vault to register biometrics for
   * @param deviceName - User-friendly name for this device
   * @param vaultName - Display name of the vault (shown in authenticator UI)
   * @returns The registered credential, or null if registration failed/cancelled
   */
  async registerCredential(vaultId: string, deviceName: string, vaultName?: string): Promise<BiometricCredential | null> {
    if (!this.cryptoService.isUnlocked) {
      throw new Error('Vault must be unlocked to register biometric credentials');
    }

    const rpId = window.location.hostname;

    // Generate a random salt for the PRF input (used if PRF is available)
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));

    // Get existing credentials for this vault to exclude (prevent duplicate registrations)
    const existingCredentials = await this.credentialStore.getAllCredentials(vaultId);
    const excludeCredentials: PublicKeyCredentialDescriptor[] = existingCredentials.map(c => ({
      type: 'public-key' as const,
      id: this.base64UrlToBuffer(c.id),
    }));

    // Create credential options – request PRF but don't require it
    const userId = crypto.getRandomValues(new Uint8Array(32));
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const createOptions: PublicKeyCredentialCreationOptions = {
      rp: {
        name: 'IntimaPic',
        id: rpId,
      },
      user: {
        id: userId,
        // Stable vault ID as user name (for uniqueness across vaults)
        name: `vault-${vaultId}`,
        // Show vault name + device name in the authenticator UI
        displayName: vaultName ? `${vaultName} – ${deviceName}` : deviceName,
      },
      challenge,
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256
        { alg: -257, type: 'public-key' },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'required',
      },
      hints: ['client-device'],
      timeout: 60000,
      excludeCredentials,
      extensions: {
        prf: {
          eval: {
            first: prfSalt.buffer as ArrayBuffer,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    } as PublicKeyCredentialCreationOptions;

    try {
      const credential = await this.nativeWebAuthn.create({
        publicKey: createOptions,
      });

      if (!credential) return null;

      // Check if PRF extension was supported
      const extensionResults = credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
        prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
      };

      const prfEnabled = extensionResults.prf?.enabled || !!extensionResults.prf?.results?.first;

      if (prfEnabled && extensionResults.prf?.results?.first) {
        // PRF was provided during creation → use PRF mode
        const prfOutput = extensionResults.prf.results.first;
        const prfKek = await this.derivePrfKek(prfOutput);
        return this.registerWithPrf(vaultId, credential.rawId, deviceName, prfSalt, prfKek, rpId);
      }

      if (prfEnabled) {
        // PRF is enabled but output only available during assertion
        const prfKek = await this.getPrfKeyFromAssertion(credential.rawId, prfSalt, rpId);
        if (prfKek) {
          return this.registerWithPrf(vaultId, credential.rawId, deviceName, prfSalt, prfKek, rpId);
        }
      }

      // PRF not available → fall back to gatekeeper mode
      return this.registerWithGatekeeper(vaultId, credential.rawId, deviceName, rpId);

    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        return null; // User cancelled
      }
      throw err;
    }
  }

  // ─── Authentication ────────────────────────────────────────────────

  /**
   * Authenticate using biometric and unlock a specific vault.
   * Automatically handles both PRF and gatekeeper mode credentials.
   * Returns true if authentication succeeded and master keys are loaded.
   *
   * @param vaultId - The vault to authenticate for
   */
  async authenticate(vaultId: string): Promise<boolean> {
    const store = await this.credentialStore.getVaultStore(vaultId);
    if (store.credentials.length === 0) return false;

    const rpId = store.rpId || window.location.hostname;

    // Check if any credentials use PRF mode
    const prfCredentials = store.credentials.filter(c => c.mode === 'prf');
    const gatekeeperCredentials = store.credentials.filter(c => c.mode === 'gatekeeper');

    // If we have PRF credentials, try PRF authentication first
    if (prfCredentials.length > 0) {
      const result = await this.authenticateWithPrf(vaultId, prfCredentials, rpId);
      if (result) return true;
    }

    // If we have gatekeeper credentials, try gatekeeper authentication
    if (gatekeeperCredentials.length > 0) {
      return this.authenticateWithGatekeeper(vaultId, gatekeeperCredentials, rpId);
    }

    return false;
  }

  // ─── Credential Removal ────────────────────────────────────────────

  async removeCredential(vaultId: string, credentialId: string): Promise<void> {
    await this.credentialStore.removeCredential(vaultId, credentialId);
  }

  async renameCredential(vaultId: string, credentialId: string, newName: string): Promise<void> {
    await this.credentialStore.updateDeviceName(vaultId, credentialId, newName);
  }

  /**
   * Clear all biometric data for a specific vault.
   */
  async clearVault(vaultId: string): Promise<void> {
    await this.credentialStore.clearVault(vaultId);
  }

  /**
   * Clear ALL biometric data across all vaults (full reset).
   */
  async clearAll(): Promise<void> {
    await this.credentialStore.clearAll();
  }

  // ─── PRF Mode: Registration ────────────────────────────────────────

  private async registerWithPrf(
    vaultId: string,
    rawId: ArrayBuffer,
    deviceName: string,
    prfSalt: Uint8Array,
    prfKek: ArrayBuffer,
    rpId: string
  ): Promise<BiometricCredential> {
    const masterKeysRaw = await this.cryptoService.exportMasterKeys();
    const encryptionKey = masterKeysRaw.slice(0, 32);
    const macKey = masterKeysRaw.slice(32, 64);

    const wrappedEncKey = await aesKeyWrap(encryptionKey, prfKek);
    const wrappedMacKey = await aesKeyWrap(macKey, prfKek);

    const credential: BiometricCredential = {
      id: this.bufferToBase64Url(rawId),
      deviceName,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      mode: 'prf',
      wrappedEncryptionKey: this.bufferToBase64(wrappedEncKey),
      wrappedMacKey: this.bufferToBase64(wrappedMacKey),
      prfSalt: this.bufferToBase64(prfSalt.buffer as ArrayBuffer),
    };

    await this.credentialStore.addCredential(vaultId, credential, rpId);
    return credential;
  }

  // ─── PRF Mode: Authentication ──────────────────────────────────────

  private async authenticateWithPrf(
    vaultId: string,
    credentials: BiometricCredential[],
    rpId: string
  ): Promise<boolean> {
    const evalByCredential: Record<string, { first: ArrayBuffer }> = {};
    for (const cred of credentials) {
      evalByCredential[cred.id] = { first: this.base64ToBuffer(cred.prfSalt!) };
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const allowCredentials: PublicKeyCredentialDescriptor[] = credentials.map(c => ({
      type: 'public-key' as const,
      id: this.base64UrlToBuffer(c.id),
      transports: ['internal' as AuthenticatorTransport],
    }));

    const getOptions: PublicKeyCredentialRequestOptions = {
      rpId,
      challenge,
      allowCredentials,
      userVerification: 'required',
      hints: ['client-device'],
      timeout: 60000,
      extensions: {
        prf: {
          eval: {
            first: this.base64ToBuffer(credentials[0].prfSalt!),
          },
          evalByCredential,
        },
      } as AuthenticationExtensionsClientInputs,
    } as PublicKeyCredentialRequestOptions;

    try {
      const assertion = await this.nativeWebAuthn.get({
        publicKey: getOptions,
      });

      if (!assertion) return false;

      const extensionResults = assertion.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
        prf?: { results?: { first?: ArrayBuffer } };
      };

      const prfOutput = extensionResults.prf?.results?.first;
      if (!prfOutput) return false;

      const usedCredId = this.bufferToBase64Url(assertion.rawId);
      const storedCred = credentials.find(c => c.id === usedCredId);
      if (!storedCred) return false;

      const prfKek = await this.derivePrfKek(prfOutput);

      const encryptionKey = await aesKeyUnwrap(
        this.base64ToBuffer(storedCred.wrappedEncryptionKey!),
        prfKek
      );
      const macKey = await aesKeyUnwrap(
        this.base64ToBuffer(storedCred.wrappedMacKey!),
        prfKek
      );

      const combined = new Uint8Array(64);
      combined.set(new Uint8Array(encryptionKey), 0);
      combined.set(new Uint8Array(macKey), 32);
      await this.cryptoService.importMasterKeys(combined.buffer as ArrayBuffer);

      await this.credentialStore.updateLastUsed(vaultId, usedCredId);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        return false;
      }
      console.error('PRF biometric authentication failed:', err);
      return false;
    }
  }

  // ─── Gatekeeper Mode: Registration ─────────────────────────────────

  private async registerWithGatekeeper(
    vaultId: string,
    rawId: ArrayBuffer,
    deviceName: string,
    rpId: string
  ): Promise<BiometricCredential> {
    const cryptoKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt']
    );

    const masterKeysRaw = await this.cryptoService.exportMasterKeys();
    const encryptionKeyData = masterKeysRaw.slice(0, 32);
    const macKeyData = masterKeysRaw.slice(32, 64);

    const encEncKey = await this.aesGcmEncrypt(cryptoKey, encryptionKeyData);
    const encMacKey = await this.aesGcmEncrypt(cryptoKey, macKeyData);

    const credentialId = this.bufferToBase64Url(rawId);

    const credential: BiometricCredential = {
      id: credentialId,
      deviceName,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      mode: 'gatekeeper',
      encryptedEncryptionKey: this.bufferToBase64(encEncKey),
      encryptedMacKey: this.bufferToBase64(encMacKey),
    };

    await this.credentialStore.saveCryptoKey(credentialId, cryptoKey);
    await this.credentialStore.addCredential(vaultId, credential, rpId);

    return credential;
  }

  // ─── Gatekeeper Mode: Authentication ───────────────────────────────

  private async authenticateWithGatekeeper(
    vaultId: string,
    credentials: BiometricCredential[],
    rpId: string
  ): Promise<boolean> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const allowCredentials: PublicKeyCredentialDescriptor[] = credentials.map(c => ({
      type: 'public-key' as const,
      id: this.base64UrlToBuffer(c.id),
      transports: ['internal' as AuthenticatorTransport],
    }));

    const getOptions: PublicKeyCredentialRequestOptions = {
      rpId,
      challenge,
      allowCredentials,
      userVerification: 'required',
      hints: ['client-device'],
      timeout: 60000,
    } as PublicKeyCredentialRequestOptions;

    try {
      const assertion = await this.nativeWebAuthn.get({
        publicKey: getOptions,
      });

      if (!assertion) return false;

      const usedCredId = this.bufferToBase64Url(assertion.rawId);
      const storedCred = credentials.find(c => c.id === usedCredId);
      if (!storedCred) return false;

      const cryptoKey = await this.credentialStore.getCryptoKey(usedCredId);
      if (!cryptoKey) {
        console.error('CryptoKey not found for credential:', usedCredId);
        return false;
      }

      const encryptionKey = await this.aesGcmDecrypt(
        cryptoKey,
        this.base64ToBuffer(storedCred.encryptedEncryptionKey!)
      );
      const macKey = await this.aesGcmDecrypt(
        cryptoKey,
        this.base64ToBuffer(storedCred.encryptedMacKey!)
      );

      const combined = new Uint8Array(64);
      combined.set(new Uint8Array(encryptionKey), 0);
      combined.set(new Uint8Array(macKey), 32);
      await this.cryptoService.importMasterKeys(combined.buffer as ArrayBuffer);

      await this.credentialStore.updateLastUsed(vaultId, usedCredId);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        return false;
      }
      console.error('Gatekeeper biometric authentication failed:', err);
      return false;
    }
  }

  // ─── PRF Helpers ───────────────────────────────────────────────────

  private async getPrfKeyFromAssertion(
    credentialId: ArrayBuffer,
    prfSalt: Uint8Array,
    rpId: string
  ): Promise<ArrayBuffer | null> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const getOptions: PublicKeyCredentialRequestOptions = {
      rpId,
      challenge,
      allowCredentials: [{
        type: 'public-key',
        id: credentialId,
        transports: ['internal' as AuthenticatorTransport],
      }],
      userVerification: 'required',
      hints: ['client-device'],
      timeout: 60000,
      extensions: {
        prf: {
          eval: {
            first: prfSalt.buffer as ArrayBuffer,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    } as PublicKeyCredentialRequestOptions;

    try {
      const assertion = await this.nativeWebAuthn.get({
        publicKey: getOptions,
      });

      if (!assertion) return null;

      const results = assertion.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
        prf?: { results?: { first?: ArrayBuffer } };
      };

      const prfOutput = results.prf?.results?.first;
      if (!prfOutput) return null;

      return this.derivePrfKek(prfOutput);
    } catch {
      return null;
    }
  }

  private async derivePrfKek(prfOutput: ArrayBuffer): Promise<ArrayBuffer> {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      prfOutput,
      'HKDF',
      false,
      ['deriveBits']
    );

    const info = new TextEncoder().encode('intimapic-vault-kek');

    return crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info,
      },
      keyMaterial,
      256
    );
  }

  // ─── AES-GCM Helpers (for gatekeeper mode) ─────────────────────────

  private async aesGcmEncrypt(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );

    const result = new Uint8Array(12 + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), 12);
    return result.buffer as ArrayBuffer;
  }

  private async aesGcmDecrypt(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
  }

  // ─── Encoding Utilities ────────────────────────────────────────────

  private bufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private base64UrlToBuffer(base64url: string): ArrayBuffer {
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const padding = 4 - (base64.length % 4);
    if (padding !== 4) base64 += '='.repeat(padding);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer as ArrayBuffer;
  }

  private bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer as ArrayBuffer;
  }
}
