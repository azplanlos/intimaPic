/**
 * AES-SIV (Synthetic Initialization Vector) implementation using Web Crypto API.
 *
 * AES-SIV provides deterministic authenticated encryption.
 * It uses AES-CMAC for authentication and AES-CTR for encryption.
 *
 * Reference: RFC 5297
 * Used by Cryptomator for filename encryption.
 */

/**
 * Encrypt using AES-SIV.
 * @param plaintext - Data to encrypt
 * @param associatedData - Array of associated data items (not encrypted, but authenticated)
 * @param encryptionKey - 256-bit encryption key
 * @param macKey - 256-bit MAC key
 * @returns Ciphertext with prepended 16-byte SIV tag
 */
export async function aesSivEncrypt(
  plaintext: Uint8Array,
  associatedData: Uint8Array[],
  encryptionKey: ArrayBuffer,
  macKey: ArrayBuffer
): Promise<Uint8Array> {
  // Step 1: Calculate SIV (S2V)
  const siv = await s2v(macKey, associatedData, plaintext);

  // Step 2: Clear bits 31 and 63 of the SIV for use as CTR IV
  const ctrIv = new Uint8Array(siv);
  ctrIv[8] &= 0x7f;
  ctrIv[12] &= 0x7f;

  // Step 3: Encrypt plaintext with AES-CTR using modified SIV as IV
  const ctrKey = await crypto.subtle.importKey(
    'raw',
    encryptionKey,
    { name: 'AES-CTR' },
    false,
    ['encrypt']
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: ctrIv, length: 128 },
      ctrKey,
      plaintext
    )
  );

  // Step 4: Prepend SIV to ciphertext
  const result = new Uint8Array(16 + ciphertext.length);
  result.set(siv, 0);
  result.set(ciphertext, 16);
  return result;
}

/**
 * Decrypt using AES-SIV.
 * @param ciphertext - Data to decrypt (16-byte SIV prepended)
 * @param associatedData - Array of associated data items
 * @param encryptionKey - 256-bit encryption key
 * @param macKey - 256-bit MAC key
 * @returns Decrypted plaintext
 * @throws Error if authentication fails
 */
export async function aesSivDecrypt(
  ciphertext: Uint8Array,
  associatedData: Uint8Array[],
  encryptionKey: ArrayBuffer,
  macKey: ArrayBuffer
): Promise<Uint8Array> {
  if (ciphertext.length < 16) {
    throw new Error('AES-SIV: ciphertext too short');
  }

  // Step 1: Extract SIV and encrypted data
  const siv = ciphertext.slice(0, 16);
  const encryptedData = ciphertext.slice(16);

  // Step 2: Clear bits 31 and 63 of the SIV for use as CTR IV
  const ctrIv = new Uint8Array(siv);
  ctrIv[8] &= 0x7f;
  ctrIv[12] &= 0x7f;

  // Step 3: Decrypt with AES-CTR
  const ctrKey = await crypto.subtle.importKey(
    'raw',
    encryptionKey,
    { name: 'AES-CTR' },
    false,
    ['decrypt']
  );

  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: ctrIv, length: 128 },
      ctrKey,
      encryptedData
    )
  );

  // Step 4: Verify SIV
  const computedSiv = await s2v(macKey, associatedData, plaintext);

  if (!constantTimeEqual(siv, computedSiv)) {
    throw new Error('AES-SIV: authentication failed');
  }

  return plaintext;
}

// ─── S2V (String-to-Vector) ──────────────────────────────────────────

/**
 * S2V as defined in RFC 5297 Section 2.4.
 */
async function s2v(
  macKey: ArrayBuffer,
  associatedData: Uint8Array[],
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const zero = new Uint8Array(16);

  // D = CMAC(K, 0^n)
  let d = await aesCmac(macKey, zero);

  // For each associated data element
  for (const ad of associatedData) {
    d = xor(dbl(d), await aesCmac(macKey, ad));
  }

  // Final step with plaintext
  let t: Uint8Array;
  if (plaintext.length >= 16) {
    // T = plaintext XOR_END D
    t = xorEnd(plaintext, d);
  } else {
    // T = dbl(D) XOR pad(plaintext)
    t = xor(dbl(d), pad(plaintext));
  }

  return aesCmac(macKey, t);
}

// ─── AES-CMAC ────────────────────────────────────────────────────────

/**
 * AES-CMAC (RFC 4493) using Web Crypto API.
 */
async function aesCmac(key: ArrayBuffer, message: Uint8Array): Promise<Uint8Array> {
  const cmacKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );

  // Generate subkeys
  const [k1, k2] = await generateSubkeys(cmacKey);

  const blockSize = 16;
  const numBlocks = Math.max(1, Math.ceil(message.length / blockSize));
  const lastBlockIndex = numBlocks - 1;
  const isComplete = message.length > 0 && message.length % blockSize === 0;

  // Process last block
  let lastBlock = new Uint8Array(blockSize);
  if (isComplete) {
    const start = lastBlockIndex * blockSize;
    lastBlock = xor(message.slice(start, start + blockSize), k1);
  } else {
    const start = lastBlockIndex * blockSize;
    const partial = message.slice(start);
    lastBlock = xor(pad(partial), k2);
  }

  // CBC-MAC
  let x = new Uint8Array(blockSize);
  const zeroIv = new Uint8Array(blockSize);

  for (let i = 0; i < lastBlockIndex; i++) {
    const block = message.slice(i * blockSize, (i + 1) * blockSize);
    const y = xor(x, block);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: zeroIv },
        cmacKey,
        y
      )
    );
    x = encrypted.slice(0, blockSize);
  }

  // Final block
  const y = xor(x, lastBlock);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: zeroIv },
      cmacKey,
      y
    )
  );

  return encrypted.slice(0, blockSize);
}

async function generateSubkeys(key: CryptoKey): Promise<[Uint8Array, Uint8Array]> {
  const zeroBlock = new Uint8Array(16);
  const zeroIv = new Uint8Array(16);

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: zeroIv },
      key,
      zeroBlock
    )
  );

  const l = encrypted.slice(0, 16);
  const k1 = dbl(l);
  const k2 = dbl(k1);

  return [k1, k2];
}

// ─── Helper Functions ────────────────────────────────────────────────

function dbl(input: Uint8Array): Uint8Array {
  const result = new Uint8Array(16);
  let carry = 0;

  for (let i = 15; i >= 0; i--) {
    const b = input[i];
    result[i] = ((b << 1) | carry) & 0xff;
    carry = (b >> 7) & 1;
  }

  // If MSB was set, XOR with Rb (0x87 for 128-bit block)
  if ((input[0] >> 7) & 1) {
    result[15] ^= 0x87;
  }

  return result;
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(Math.max(a.length, b.length));
  for (let i = 0; i < result.length; i++) {
    result[i] = (a[i] || 0) ^ (b[i] || 0);
  }
  return result;
}

function xorEnd(data: Uint8Array, block: Uint8Array): Uint8Array {
  const result = new Uint8Array(data);
  const offset = data.length - 16;
  for (let i = 0; i < 16; i++) {
    result[offset + i] ^= block[i];
  }
  return result;
}

function pad(input: Uint8Array): Uint8Array {
  const padded = new Uint8Array(16);
  padded.set(input);
  padded[input.length] = 0x80;
  // Rest is already zero
  return padded;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
