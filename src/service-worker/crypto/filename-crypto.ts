/**
 * Filename encryption/decryption for the ServiceWorker context.
 *
 * This is a minimal port of the relevant AES-SIV functionality from
 * the main app's CryptoService – only filename operations, no file content
 * encryption/decryption (that stays in the Main Thread).
 *
 * Uses Web Crypto API (available in ServiceWorker context).
 */

import type { MasterKeys } from './crypto.models';

export class FilenameCrypto {
  private keys: MasterKeys | null = null;

  setKeys(keys: MasterKeys): void {
    this.keys = keys;
  }

  clearKeys(): void {
    this.keys = null;
  }

  get isReady(): boolean {
    return this.keys !== null;
  }

  /**
   * Encrypt a filename using AES-SIV.
   * @param name - Cleartext filename
   * @param directoryId - Parent directory ID (associated data)
   * @returns Encrypted filename with .c9r extension
   */
  async encryptFilename(name: string, directoryId: string = ''): Promise<string> {
    if (!this.keys) throw new Error('Keys not set');

    const encoder = new TextEncoder();
    const plaintext = encoder.encode(name);
    const associatedData = [encoder.encode(directoryId)];

    const ciphertext = await this.aesSivEncrypt(
      plaintext,
      associatedData,
      this.keys.encryptionKey,
      this.keys.macKey
    );

    return this.uint8ArrayToBase64Url(ciphertext) + '.c9r';
  }

  /**
   * Decrypt a filename using AES-SIV.
   * @param encryptedName - Encrypted filename (with or without .c9r)
   * @param directoryId - Parent directory ID
   * @returns Decrypted original filename
   */
  async decryptFilename(encryptedName: string, directoryId: string = ''): Promise<string> {
    if (!this.keys) throw new Error('Keys not set');

    // Remove .c9r extension
    const name = encryptedName.endsWith('.c9r')
      ? encryptedName.slice(0, -4)
      : encryptedName;

    const ciphertext = this.base64UrlToUint8Array(name);
    const encoder = new TextEncoder();
    const associatedData = [encoder.encode(directoryId)];

    const plaintext = await this.aesSivDecrypt(
      ciphertext,
      associatedData,
      this.keys.encryptionKey,
      this.keys.macKey
    );

    return new TextDecoder().decode(plaintext);
  }

  // ─── AES-SIV Implementation ─────────────────────────────────────────────────

  private async aesSivEncrypt(
    plaintext: Uint8Array,
    associatedData: Uint8Array[],
    encryptionKey: ArrayBuffer,
    macKey: ArrayBuffer
  ): Promise<Uint8Array> {
    const siv = await this.s2v(macKey, associatedData, plaintext);

    const ctrIv = new Uint8Array(siv);
    ctrIv[8] &= 0x7f;
    ctrIv[12] &= 0x7f;

    const ctrKey = await crypto.subtle.importKey(
      'raw', encryptionKey, { name: 'AES-CTR' }, false, ['encrypt']
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

  private async aesSivDecrypt(
    ciphertext: Uint8Array,
    associatedData: Uint8Array[],
    encryptionKey: ArrayBuffer,
    macKey: ArrayBuffer
  ): Promise<Uint8Array> {
    if (ciphertext.length < 16) {
      throw new Error('AES-SIV: ciphertext too short');
    }

    const siv = ciphertext.slice(0, 16);
    const encryptedData = ciphertext.slice(16);

    const ctrIv = new Uint8Array(siv);
    ctrIv[8] &= 0x7f;
    ctrIv[12] &= 0x7f;

    const ctrKey = await crypto.subtle.importKey(
      'raw', encryptionKey, { name: 'AES-CTR' }, false, ['decrypt']
    );

    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: ctrIv, length: 128 },
        ctrKey,
        encryptedData
      )
    );

    const computedSiv = await this.s2v(macKey, associatedData, plaintext);
    if (!this.constantTimeEqual(siv, computedSiv)) {
      throw new Error('AES-SIV: authentication failed');
    }

    return plaintext;
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
    const k1 = this.dbl(l);
    const k2 = this.dbl(k1);
    return [k1, k2];
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  private dbl(input: Uint8Array): Uint8Array {
    const result = new Uint8Array(16);
    let carry = 0;
    for (let i = 15; i >= 0; i--) {
      const b = input[i];
      result[i] = ((b << 1) | carry) & 0xff;
      carry = (b >> 7) & 1;
    }
    if ((input[0] >> 7) & 1) {
      result[15] ^= 0x87;
    }
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

  private constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }

  private base64UrlToUint8Array(base64url: string): Uint8Array {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const binary = atob(base64 + padding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private uint8ArrayToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
