/**
 * Directory ID encryption for the ServiceWorker context.
 *
 * Computes the storage path for a given directory ID:
 * directoryId → AES-SIV encrypt → SHA-1 hash → Base32 → "d/XX/YYYY..."
 *
 * This is needed in the SW to resolve where album/photo files live in storage.
 */

import type { MasterKeys } from './crypto.models';
import { FilenameCrypto } from './filename-crypto';

export class DirectoryIdCrypto {
  private keys: MasterKeys | null = null;
  /** Re-use the FilenameCrypto's AES-SIV for directory ID encryption */
  private readonly filenameCrypto = new FilenameCrypto();

  /** Cache of already-computed directory paths to avoid redundant crypto */
  private readonly pathCache = new Map<string, string>();

  setKeys(keys: MasterKeys): void {
    this.keys = keys;
    this.filenameCrypto.setKeys(keys);
    this.pathCache.clear();
  }

  clearKeys(): void {
    this.keys = null;
    this.filenameCrypto.clearKeys();
    this.pathCache.clear();
  }

  get isReady(): boolean {
    return this.keys !== null;
  }

  /**
   * Encrypt a directory ID and compute its storage path.
   * @param directoryId - The directory ID (UUID for albums, empty string for root)
   * @returns The path "d/XX/YYYY..." relative to vault root
   */
  async encryptDirectoryId(directoryId: string): Promise<string> {
    if (!this.keys) throw new Error('Keys not set');

    // Check cache first
    const cached = this.pathCache.get(directoryId);
    if (cached) return cached;

    const encoder = new TextEncoder();
    const plaintext = encoder.encode(directoryId);

    // AES-SIV encrypt the directory ID (no associated data for dir IDs)
    const encrypted = await this.aesSivEncryptRaw(plaintext, []);

    // SHA-1 hash of encrypted directory ID
    const hash = await crypto.subtle.digest('SHA-1', encrypted);
    const hashBase32 = this.base32Encode(new Uint8Array(hash));

    // Path: d/XX/YYYY... (first 2 chars / remaining)
    const path = `d/${hashBase32.substring(0, 2)}/${hashBase32.substring(2)}`;

    this.pathCache.set(directoryId, path);
    return path;
  }

  // ─── AES-SIV (raw, for directory IDs) ──────────────────────────────────────

  private async aesSivEncryptRaw(
    plaintext: Uint8Array,
    associatedData: Uint8Array[]
  ): Promise<Uint8Array> {
    if (!this.keys) throw new Error('Keys not set');

    const siv = await this.s2v(this.keys.macKey, associatedData, plaintext);

    const ctrIv = new Uint8Array(siv);
    ctrIv[8] &= 0x7f;
    ctrIv[12] &= 0x7f;

    const ctrKey = await crypto.subtle.importKey(
      'raw', this.keys.encryptionKey, { name: 'AES-CTR' }, false, ['encrypt']
    );

    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-CTR', counter: ctrIv, length: 128 },
        ctrKey,
        plaintext
      )
    );

    const result = new Uint8Array(16 + ciphertext.length);
    result.set(siv, 0);
    result.set(ciphertext, 16);
    return result;
  }

  // ─── S2V ─────────────────────────────────────────────────────────────────────

  private async s2v(
    macKey: ArrayBuffer,
    associatedData: Uint8Array[],
    plaintext: Uint8Array
  ): Promise<Uint8Array> {
    const zero = new Uint8Array(16);
    let d = await this.aesCmac(macKey, zero);

    for (const ad of associatedData) {
      d = this.xor(this.dbl(d), await this.aesCmac(macKey, ad));
    }

    let t: Uint8Array;
    if (plaintext.length >= 16) {
      t = this.xorEnd(plaintext, d);
    } else {
      t = this.xor(this.dbl(d), this.pad(plaintext));
    }

    return this.aesCmac(macKey, t);
  }

  // ─── AES-CMAC ────────────────────────────────────────────────────────────────

  private async aesCmac(key: ArrayBuffer, message: Uint8Array): Promise<Uint8Array> {
    const cmacKey = await crypto.subtle.importKey(
      'raw', key, { name: 'AES-CBC' }, false, ['encrypt']
    );

    const [k1, k2] = await this.generateSubkeys(cmacKey);

    const blockSize = 16;
    const numBlocks = Math.max(1, Math.ceil(message.length / blockSize));
    const lastBlockIndex = numBlocks - 1;
    const isComplete = message.length > 0 && message.length % blockSize === 0;

    let lastBlock = new Uint8Array(blockSize);
    if (isComplete) {
      const start = lastBlockIndex * blockSize;
      lastBlock = this.xor(message.slice(start, start + blockSize), k1);
    } else {
      const start = lastBlockIndex * blockSize;
      const partial = message.slice(start);
      lastBlock = this.xor(this.pad(partial), k2);
    }

    let x = new Uint8Array(blockSize);
    const zeroIv = new Uint8Array(blockSize);

    for (let i = 0; i < lastBlockIndex; i++) {
      const block = message.slice(i * blockSize, (i + 1) * blockSize);
      const y = this.xor(x, block);
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, cmacKey, y)
      );
      x = encrypted.slice(0, blockSize);
    }

    const y = this.xor(x, lastBlock);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, cmacKey, y)
    );
    return encrypted.slice(0, blockSize);
  }

  private async generateSubkeys(key: CryptoKey): Promise<[Uint8Array, Uint8Array]> {
    const zeroBlock = new Uint8Array(16);
    const zeroIv = new Uint8Array(16);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, key, zeroBlock)
    );
    const l = encrypted.slice(0, 16);
    return [this.dbl(l), this.dbl(this.dbl(l))];
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  private dbl(input: Uint8Array): Uint8Array {
    const result = new Uint8Array(16);
    let carry = 0;
    for (let i = 15; i >= 0; i--) {
      result[i] = ((input[i] << 1) | carry) & 0xff;
      carry = (input[i] >> 7) & 1;
    }
    if ((input[0] >> 7) & 1) result[15] ^= 0x87;
    return result;
  }

  private xor(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(Math.max(a.length, b.length));
    for (let i = 0; i < result.length; i++) {
      result[i] = (a[i] || 0) ^ (b[i] || 0);
    }
    return result;
  }

  private xorEnd(data: Uint8Array, block: Uint8Array): Uint8Array {
    const result = new Uint8Array(data);
    const offset = data.length - 16;
    for (let i = 0; i < 16; i++) {
      result[offset + i] ^= block[i];
    }
    return result;
  }

  private pad(input: Uint8Array): Uint8Array {
    const padded = new Uint8Array(16);
    padded.set(input);
    padded[input.length] = 0x80;
    return padded;
  }

  /**
   * RFC 4648 Base32 encoding (uppercase, no padding).
   */
  private base32Encode(data: Uint8Array): string {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let result = '';
    let bits = 0;
    let value = 0;

    for (let i = 0; i < data.length; i++) {
      value = (value << 8) | data[i];
      bits += 8;
      while (bits >= 5) {
        result += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }

    if (bits > 0) {
      result += ALPHABET[(value << (5 - bits)) & 31];
    }

    return result;
  }
}
