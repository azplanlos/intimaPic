/**
 * Models for WebAuthn-based biometric authentication.
 * Uses the PRF extension to derive device-bound keys for vault unlock.
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
   * AES-KW wrapped encryption master key, using the PRF-derived KEK.
   * Base64-encoded.
   */
  wrappedEncryptionKey: string;
  /**
   * AES-KW wrapped MAC master key, using the PRF-derived KEK.
   * Base64-encoded.
   */
  wrappedMacKey: string;
  /**
   * Salt used as PRF input during registration.
   * Base64-encoded. Must be stored to reproduce the same PRF output.
   */
  prfSalt: string;
}

/**
 * Collection of all biometric credentials for this vault.
 * Stored in IndexedDB.
 */
export interface BiometricStore {
  /** All registered credentials */
  credentials: BiometricCredential[];
  /** WebAuthn Relying Party ID (typically window.location.hostname) */
  rpId: string;
}
