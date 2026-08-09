/**
 * Models for WebAuthn-based biometric authentication.
 *
 * Supports two modes:
 * - 'prf': Uses the PRF extension to derive a device-bound KEK for wrapping
 *   master keys. Most secure (keys bound to authenticator). Supported on
 *   iOS/macOS with iCloud Keychain, Android with Google Password Manager.
 * - 'gatekeeper': Uses WebAuthn only as a biometric presence check.
 *   Master keys are encrypted with a non-extractable CryptoKey stored in
 *   IndexedDB. Used on platforms without PRF support (Windows Hello).
 */

/**
 * A registered biometric credential (one per device/authenticator).
 */
export interface BiometricCredential {
  /** WebAuthn credential ID (Base64url-encoded) */
  id: string;
  /** Human-readable device name (e.g. "MacBook Pro", "iPhone 15") */
  deviceName: string;
  /** When this credential was registered */
  createdAt: string;
  /** Last successful authentication with this credential */
  lastUsedAt: string | null;
  /**
   * Authentication mode used for this credential.
   * - 'prf': PRF extension provides a hardware-bound KEK
   * - 'gatekeeper': WebAuthn is biometric gate only, keys stored with CryptoKey
   */
  mode: 'prf' | 'gatekeeper';

  // ─── PRF mode fields ───────────────────────────────────────────────

  /**
   * AES-KW wrapped encryption master key, using the PRF-derived KEK.
   * Base64-encoded. Only present in 'prf' mode.
   */
  wrappedEncryptionKey?: string;
  /**
   * AES-KW wrapped MAC master key, using the PRF-derived KEK.
   * Base64-encoded. Only present in 'prf' mode.
   */
  wrappedMacKey?: string;
  /**
   * Salt used as PRF input during registration.
   * Base64-encoded. Only present in 'prf' mode.
   */
  prfSalt?: string;

  // ─── Gatekeeper mode fields ────────────────────────────────────────

  /**
   * AES-GCM encrypted encryption master key. Format: [12-byte IV][ciphertext].
   * Base64-encoded. Only present in 'gatekeeper' mode.
   * The encryption key is a non-extractable CryptoKey stored separately in IndexedDB.
   */
  encryptedEncryptionKey?: string;
  /**
   * AES-GCM encrypted MAC master key. Format: [12-byte IV][ciphertext].
   * Base64-encoded. Only present in 'gatekeeper' mode.
   */
  encryptedMacKey?: string;
}

/**
 * Biometric credentials for a single vault.
 * Stored in IndexedDB, keyed by vault ID.
 */
export interface BiometricVaultStore {
  /** The vault this store belongs to */
  vaultId: string;
  /** All registered credentials for this vault */
  credentials: BiometricCredential[];
  /** WebAuthn Relying Party ID (typically window.location.hostname) */
  rpId: string;
}
