import { Injectable, inject } from '@angular/core';
import { BiometricCredentialStore } from './biometric-credential.store';
import { CryptoService } from '../crypto/crypto.service';
import { aesKeyWrap, aesKeyUnwrap } from '../crypto/aes-keywrap';
import type { BiometricCredential } from './biometric.models';

/**
 * Service for WebAuthn biometric authentication using the PRF extension.
 *
 * The PRF (Pseudo-Random Function) extension allows generating a
 * deterministic, device-bound secret during WebAuthn authentication.
 * This secret is used as a KEK to wrap/unwrap the vault's master keys,
 * enabling passwordless unlock via FaceID, Windows Hello, or Touch ID.
 *
 * Flow:
 * 1. Registration: User authenticates with password first, then registers
 *    a biometric credential. The PRF output is used to AES-KW wrap the
 *    currently-loaded master keys.
 * 2. Authentication: PRF output is derived from biometric auth, used to
 *    AES-KW unwrap the stored wrapped keys → master keys loaded.
 */
@Injectable({ providedIn: 'root' })
export class BiometricAuthService {
  private readonly credentialStore = inject(BiometricCredentialStore);
  private readonly cryptoService = inject(CryptoService);

  /**
   * Check if WebAuthn with PRF extension is available on this device.
   */
  async isAvailable(): Promise<boolean> {
    if (!window.PublicKeyCredential) return false;

    // Check platform authenticator availability (FaceID, Windows Hello, Touch ID)
    try {
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      return available;
    } catch {
      return false;
    }
  }

  /**
   * Check if any biometric credentials are registered for this vault.
   */
  async hasRegisteredCredentials(): Promise<boolean> {
    return this.credentialStore.hasCredentials();
  }

  /**
   * Get all registered credentials.
   */
  async getRegisteredCredentials(): Promise<BiometricCredential[]> {
    return this.credentialStore.getAllCredentials();
  }

  // ─── Registration ──────────────────────────────────────────────────

  /**
   * Register a new biometric credential for the current device.
   * The vault must be unlocked (master keys loaded) before calling this.
   *
   * @param deviceName - User-friendly name for this device
   * @returns The registered credential, or null if registration failed
   */
  async registerCredential(deviceName: string): Promise<BiometricCredential | null> {
    if (!this.cryptoService.isUnlocked) {
      throw new Error('Vault must be unlocked to register biometric credentials');
    }

    const rpId = window.location.hostname;

    // Generate a random salt for the PRF input
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));

    // Build the PRF extension input
    const prfExtension = {
      prf: {
        eval: {
          first: prfSalt.buffer as ArrayBuffer,
        },
      },
    };

    // Get existing credentials to exclude (prevent duplicate registrations)
    const existingCredentials = await this.credentialStore.getAllCredentials();
    const excludeCredentials: PublicKeyCredentialDescriptor[] = existingCredentials.map(c => ({
      type: 'public-key' as const,
      id: this.base64UrlToBuffer(c.id),
    }));

    // Create credential options
    const userId = crypto.getRandomValues(new Uint8Array(32));
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const createOptions: PublicKeyCredentialCreationOptions = {
      rp: {
        name: 'IntimaPic',
        id: rpId,
      },
      user: {
        id: userId,
        name: 'vault-user',
        displayName: deviceName,
      },
      challenge,
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256
        { alg: -257, type: 'public-key' },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
      excludeCredentials,
      extensions: prfExtension as AuthenticationExtensionsClientInputs,
    };

    try {
      const credential = await navigator.credentials.create({
        publicKey: createOptions,
      }) as PublicKeyCredential | null;

      if (!credential) return null;

      // Check if PRF extension was supported
      const extensionResults = credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
        prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
      };

      if (!extensionResults.prf?.enabled && !extensionResults.prf?.results?.first) {
        // PRF not supported – need to try authentication to get PRF output
        // Some authenticators only provide PRF output during assertion, not creation.
        // We'll do an immediate get() to obtain the PRF output.
        const prfKey = await this.getPrfKeyFromAssertion(
          credential.rawId,
          prfSalt,
          rpId
        );

        if (!prfKey) {
          throw new Error('PRF extension not supported by this authenticator');
        }

        return this.wrapAndStoreCredential(
          credential.rawId,
          deviceName,
          prfSalt,
          prfKey,
          rpId
        );
      }

      // PRF was provided during creation
      const prfOutput = extensionResults.prf!.results!.first!;
      const prfKey = await this.derivePrfKek(prfOutput);

      return this.wrapAndStoreCredential(
        credential.rawId,
        deviceName,
        prfSalt,
        prfKey,
        rpId
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        // User cancelled
        return null;
      }
      throw err;
    }
  }

  // ─── Authentication ────────────────────────────────────────────────

  /**
   * Authenticate using biometric and unlock the vault.
   * Returns true if authentication succeeded and master keys are loaded.
   */
  async authenticate(): Promise<boolean> {
    const store = await this.credentialStore.getStore();
    if (store.credentials.length === 0) return false;

    const rpId = store.rpId || window.location.hostname;

    // Allow any registered credential
    const allowCredentials: PublicKeyCredentialDescriptor[] = store.credentials.map(c => ({
      type: 'public-key' as const,
      id: this.base64UrlToBuffer(c.id),
    }));

    // We need PRF for each credential's salt – we'll try all and see which one the user picks
    // Since we can only supply one PRF eval per assertion, we use a two-step approach:
    // 1. First assertion without PRF to identify which credential was used
    // 2. Then a second assertion with the correct salt for that credential
    // ... Actually, we can use evalByCredential to provide salts for all credentials at once!

    const evalByCredential: Record<string, { first: ArrayBuffer }> = {};
    for (const cred of store.credentials) {
      const credIdB64 = cred.id;
      const salt = this.base64ToBuffer(cred.prfSalt);
      evalByCredential[credIdB64] = { first: salt };
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const getOptions: PublicKeyCredentialRequestOptions = {
      rpId,
      challenge,
      allowCredentials,
      userVerification: 'required',
      timeout: 60000,
      extensions: {
        prf: {
          eval: {
            // Use the first credential's salt as fallback
            first: this.base64ToBuffer(store.credentials[0].prfSalt),
          },
          evalByCredential,
        },
      } as AuthenticationExtensionsClientInputs,
    };

    try {
      const assertion = await navigator.credentials.get({
        publicKey: getOptions,
      }) as PublicKeyCredential | null;

      if (!assertion) return false;

      // Get PRF output
      const extensionResults = assertion.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
        prf?: { results?: { first?: ArrayBuffer } };
      };

      const prfOutput = extensionResults.prf?.results?.first;
      if (!prfOutput) {
        throw new Error('PRF output not available');
      }

      // Find which credential was used
      const usedCredId = this.bufferToBase64Url(assertion.rawId);
      const storedCred = store.credentials.find(c => c.id === usedCredId);
      if (!storedCred) {
        throw new Error('Unknown credential used');
      }

      // Derive KEK from PRF output
      const prfKek = await this.derivePrfKek(prfOutput);

      // Unwrap master keys
      const encryptionKey = await aesKeyUnwrap(
        this.base64ToBuffer(storedCred.wrappedEncryptionKey),
        prfKek
      );
      const macKey = await aesKeyUnwrap(
        this.base64ToBuffer(storedCred.wrappedMacKey),
        prfKek
      );

      // Load keys into CryptoService
      const combined = new Uint8Array(64);
      combined.set(new Uint8Array(encryptionKey), 0);
      combined.set(new Uint8Array(macKey), 32);
      await this.cryptoService.importMasterKeys(combined.buffer as ArrayBuffer);

      // Update last used
      await this.credentialStore.updateLastUsed(usedCredId);

      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        return false; // User cancelled
      }
      console.error('Biometric authentication failed:', err);
      return false;
    }
  }

  // ─── Credential Removal ────────────────────────────────────────────

  async removeCredential(credentialId: string): Promise<void> {
    await this.credentialStore.removeCredential(credentialId);
  }

  async renameCredential(credentialId: string, newName: string): Promise<void> {
    await this.credentialStore.updateDeviceName(credentialId, newName);
  }

  /**
   * Clear all biometric data (used on vault reset).
   */
  async clearAll(): Promise<void> {
    await this.credentialStore.clear();
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  /**
   * Get PRF output via a get() assertion (for authenticators that don't
   * provide PRF during create()).
   */
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
      }],
      userVerification: 'required',
      timeout: 60000,
      extensions: {
        prf: {
          eval: {
            first: prfSalt.buffer as ArrayBuffer,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    };

    try {
      const assertion = await navigator.credentials.get({
        publicKey: getOptions,
      }) as PublicKeyCredential | null;

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

  /**
   * Wrap master keys and store the credential.
   */
  private async wrapAndStoreCredential(
    rawId: ArrayBuffer,
    deviceName: string,
    prfSalt: Uint8Array,
    prfKek: ArrayBuffer,
    rpId: string
  ): Promise<BiometricCredential> {
    // Export current master keys
    const masterKeysRaw = await this.cryptoService.exportMasterKeys();
    const encryptionKey = masterKeysRaw.slice(0, 32);
    const macKey = masterKeysRaw.slice(32, 64);

    // Wrap with PRF-derived KEK
    const wrappedEncKey = await aesKeyWrap(encryptionKey, prfKek);
    const wrappedMacKey = await aesKeyWrap(macKey, prfKek);

    const credential: BiometricCredential = {
      id: this.bufferToBase64Url(rawId),
      deviceName,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      wrappedEncryptionKey: this.bufferToBase64(wrappedEncKey),
      wrappedMacKey: this.bufferToBase64(wrappedMacKey),
      prfSalt: this.bufferToBase64(prfSalt.buffer as ArrayBuffer),
    };

    await this.credentialStore.addCredential(credential, rpId);
    return credential;
  }

  /**
   * Derive a 256-bit KEK from PRF output using HKDF-SHA256.
   * The PRF output is already pseudorandom, but HKDF ensures proper
   * key separation and fixed output length.
   */
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
        salt: new Uint8Array(32), // Fixed empty salt – PRF output is already keyed
        info,
      },
      keyMaterial,
      256
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
