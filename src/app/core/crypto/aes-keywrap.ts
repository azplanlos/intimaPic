/**
 * AES Key Wrap (RFC 3394) using Web Crypto API's native wrapKey/unwrapKey.
 *
 * Used by Cryptomator to wrap/unwrap the master keys using the
 * scrypt-derived Key-Encryption Key (KEK).
 *
 * AES Key Wrap has built-in integrity checking:
 * unwrapping with a wrong key will always fail deterministically.
 */

/**
 * Wrap a key using AES Key Wrap (RFC 3394) via Web Crypto native API.
 * @param keyToWrap - The key material to wrap (must be 128, 192, or 256 bits)
 * @param kek - The Key-Encryption Key (as raw ArrayBuffer)
 * @returns Wrapped key (input length + 8 bytes)
 */
export async function aesKeyWrap(keyToWrap: ArrayBuffer, kek: ArrayBuffer): Promise<ArrayBuffer> {
  // Import the KEK
  const kekKey = await crypto.subtle.importKey(
    'raw',
    kek,
    { name: 'AES-KW' },
    false,
    ['wrapKey']
  );

  // Import the key-to-wrap as a CryptoKey so we can use wrapKey
  const keyToWrapObj = await crypto.subtle.importKey(
    'raw',
    keyToWrap,
    { name: 'AES-CBC' }, // Algorithm doesn't matter for raw export, just needs to be valid
    true, // Must be extractable for wrapping
    ['encrypt'] // Needs at least one usage
  );

  // Wrap using AES-KW (RFC 3394)
  return crypto.subtle.wrapKey('raw', keyToWrapObj, kekKey, 'AES-KW');
}

/**
 * Unwrap a key using AES Key Wrap (RFC 3394) via Web Crypto native API.
 * @param wrappedKey - The wrapped key material
 * @param kek - The Key-Encryption Key (as raw ArrayBuffer)
 * @returns Unwrapped key material as ArrayBuffer
 * @throws Error if integrity check fails (wrong KEK / wrong password)
 */
export async function aesKeyUnwrap(wrappedKey: ArrayBuffer, kek: ArrayBuffer): Promise<ArrayBuffer> {
  // Import the KEK
  const kekKey = await crypto.subtle.importKey(
    'raw',
    kek,
    { name: 'AES-KW' },
    false,
    ['unwrapKey']
  );

  // Unwrap using AES-KW (RFC 3394)
  // This will throw a DOMException if the integrity check fails (wrong password)
  const unwrappedKey = await crypto.subtle.unwrapKey(
    'raw',
    wrappedKey,
    kekKey,
    'AES-KW',
    { name: 'AES-CBC' }, // Algorithm for the unwrapped key (doesn't affect raw bytes)
    true, // extractable
    ['encrypt'] // usage
  );

  // Export the unwrapped key as raw bytes
  return crypto.subtle.exportKey('raw', unwrappedKey);
}
