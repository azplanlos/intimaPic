import { Injectable } from '@angular/core';
import { aesSivEncrypt, aesSivDecrypt } from './aes-siv';
import { aesKeyWrap, aesKeyUnwrap } from './aes-keywrap';
import type { MasterKeys, MasterkeyFile, VaultConfig, FileHeader } from './crypto.models';

/**
 * CryptoService implements Cryptomator Vault Format 8 encryption.
 *
 * Key hierarchy:
 * - User password → scrypt → KEK (Key-Encryption Key, 256-bit)
 * - KEK wraps/unwraps two 256-bit Master Keys (encryption + MAC)
 * - Encryption Master Key: used for AES-GCM file content encryption
 * - MAC Master Key: used together with Encryption Key for AES-SIV filename encryption
 *
 * File format:
 * - Filenames: AES-SIV encrypted → Base64url → ".c9r" suffix
 * - File content: [68-byte header][32KiB AES-GCM chunks]
 * - Directories: Flat structure via hashed directory IDs
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  private masterKeys: MasterKeys | null = null;

  private readonly SCRYPT_COST = 32768;
  private readonly SCRYPT_BLOCK_SIZE = 8;
  private readonly SCRYPT_PARALLELISM = 1;
  private readonly SCRYPT_KEY_LENGTH = 32;
  private readonly CHUNK_SIZE = 32768; // 32 KiB

  /**
   * Whether the vault is currently unlocked (master keys loaded).
   */
  get isUnlocked(): boolean {
    return this.masterKeys !== null;
  }

  /**
   * Get the current master keys (for transferring to ServiceWorker).
   * Returns null if the vault is locked.
   */
  getMasterKeys(): MasterKeys | null {
    return this.masterKeys;
  }

  // ─── Vault Creation ────────────────────────────────────────────────

  /**
   * Create a new vault: generate master keys, wrap with password.
   * Returns the masterkey.cryptomator JSON content.
   */
  async createVault(password: string): Promise<{ masterkeyFile: MasterkeyFile; vaultConfig: VaultConfig }> {
    // Generate two 256-bit master keys
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const macKey = crypto.getRandomValues(new Uint8Array(32));

    this.masterKeys = {
      encryptionKey: encryptionKey.buffer as ArrayBuffer,
      macKey: macKey.buffer as ArrayBuffer,
    };

    const masterkeyFile = await this.wrapMasterKeys(password);

    const vaultConfig: VaultConfig = {
      format: 8,
      shorteningThreshold: 220,
      jti: crypto.randomUUID(),
      cipherCombo: 'SIV_GCM',
    };

    return { masterkeyFile, vaultConfig };
  }

  /**
   * Unlock vault: derive KEK from password, unwrap master keys.
   * Returns true if successful, false if password is wrong.
   */
  async unlockVault(password: string, masterkeyFile: MasterkeyFile): Promise<boolean> {
    try {
      const salt = this.base64ToArrayBuffer(masterkeyFile.scryptSalt);

      // NFC-normalize the password (as Cryptomator does)
      const normalizedPassword = password.normalize('NFC');
      const kek = await this.deriveKek(
        normalizedPassword,
        new Uint8Array(salt),
        masterkeyFile.scryptCostParam,
        masterkeyFile.scryptBlockSize
      );

      // Unwrap encryption key (will throw if wrong password)
      const wrappedEncKey = this.base64ToArrayBuffer(masterkeyFile.primaryMasterKey);
      const encryptionKey = await aesKeyUnwrap(wrappedEncKey, kek);

      // Unwrap MAC key
      const wrappedMacKey = this.base64ToArrayBuffer(masterkeyFile.hmacMasterKey);
      const macKey = await aesKeyUnwrap(wrappedMacKey, kek);

      this.masterKeys = { encryptionKey, macKey };
      return true;
    } catch {
      // AES Key Unwrap throws on integrity check failure = wrong password
      return false;
    }
  }

  /**
   * Lock the vault (clear keys from memory).
   */
  lockVault(): void {
    if (this.masterKeys) {
      // Zero out key material
      new Uint8Array(this.masterKeys.encryptionKey).fill(0);
      new Uint8Array(this.masterKeys.macKey).fill(0);
      this.masterKeys = null;
    }
  }

  /**
   * Change password: re-wrap master keys with new password.
   */
  async changePassword(newPassword: string): Promise<MasterkeyFile> {
    if (!this.masterKeys) throw new Error('Vault is locked');
    return this.wrapMasterKeys(newPassword);
  }

  // ─── Filename Encryption ───────────────────────────────────────────

  /**
   * Encrypt a filename using AES-SIV (Cryptomator format).
   * @param cleartextName - Original filename (UTF-8)
   * @param directoryId - Parent directory ID (empty string for root)
   * @returns Encrypted filename with .c9r extension
   */
  async encryptFilename(cleartextName: string, directoryId: string = ''): Promise<string> {
    if (!this.masterKeys) throw new Error('Vault is locked');

    const encoder = new TextEncoder();
    const plaintext = encoder.encode(cleartextName);
    const associatedData = [encoder.encode(directoryId)];

    const ciphertext = await aesSivEncrypt(
      plaintext,
      associatedData,
      this.masterKeys.encryptionKey,
      this.masterKeys.macKey
    );

    return this.arrayBufferToBase64Url(ciphertext.buffer as ArrayBuffer) + '.c9r';
  }

  /**
   * Decrypt a filename.
   * @param encryptedName - Encrypted filename (with or without .c9r)
   * @param directoryId - Parent directory ID
   * @returns Decrypted original filename
   */
  async decryptFilename(encryptedName: string, directoryId: string = ''): Promise<string> {
    if (!this.masterKeys) throw new Error('Vault is locked');

    // Remove .c9r extension
    const name = encryptedName.endsWith('.c9r')
      ? encryptedName.slice(0, -4)
      : encryptedName;

    const ciphertext = this.base64UrlToUint8Array(name);
    const encoder = new TextEncoder();
    const associatedData = [encoder.encode(directoryId)];

    const plaintext = await aesSivDecrypt(
      ciphertext,
      associatedData,
      this.masterKeys.encryptionKey,
      this.masterKeys.macKey
    );

    return new TextDecoder().decode(plaintext);
  }

  // ─── Directory ID Encryption ───────────────────────────────────────

  /**
   * Encrypt a directory ID and compute its storage path.
   * @returns The path component "d/XX/YYYYYY..." relative to vault root
   */
  async encryptDirectoryId(directoryId: string): Promise<string> {
    if (!this.masterKeys) throw new Error('Vault is locked');

    const encoder = new TextEncoder();
    const plaintext = encoder.encode(directoryId);

    const encrypted = await aesSivEncrypt(
      plaintext,
      [],
      this.masterKeys.encryptionKey,
      this.masterKeys.macKey
    );

    // SHA-1 hash of encrypted directory ID
    const hash = await crypto.subtle.digest('SHA-1', encrypted);
    const hashBase32 = this.base32Encode(new Uint8Array(hash));

    // Path: d/XX/YYYY... (first 2 chars / remaining)
    return `d/${hashBase32.substring(0, 2)}/${hashBase32.substring(2)}`;
  }

  // ─── File Content Encryption ───────────────────────────────────────

  /**
   * Encrypt file content (Cryptomator format).
   * Produces: [68-byte header][encrypted chunks]
   */
  async encryptFile(plaintext: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.masterKeys) throw new Error('Vault is locked');

    // Generate per-file content key and header
    const headerNonce = crypto.getRandomValues(new Uint8Array(12));
    const contentKey = crypto.getRandomValues(new Uint8Array(32));

    // Create header payload: 8 bytes 0xFF + 32 bytes content key
    const headerPayload = new Uint8Array(40);
    headerPayload.fill(0xff, 0, 8);
    headerPayload.set(contentKey, 8);

    // Encrypt header with AES-GCM using encryption master key
    const encMasterKey = await crypto.subtle.importKey(
      'raw',
      this.masterKeys.encryptionKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    const encryptedHeader = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: headerNonce },
      encMasterKey,
      headerPayload
    );

    // Header: 12 bytes nonce + 56 bytes (40 payload + 16 tag)
    const header = new Uint8Array(68);
    header.set(headerNonce, 0);
    header.set(new Uint8Array(encryptedHeader), 12);

    // Encrypt content in 32KiB chunks
    const contentKeyObj = await crypto.subtle.importKey(
      'raw',
      contentKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    const plaintextBytes = new Uint8Array(plaintext);
    const numChunks = Math.max(1, Math.ceil(plaintextBytes.length / this.CHUNK_SIZE));
    const encryptedChunks: Uint8Array[] = [];

    for (let i = 0; i < numChunks; i++) {
      const start = i * this.CHUNK_SIZE;
      const end = Math.min(start + this.CHUNK_SIZE, plaintextBytes.length);
      const chunk = plaintextBytes.slice(start, end);

      const chunkNonce = crypto.getRandomValues(new Uint8Array(12));

      // AAD: chunk number (8 bytes big-endian) + header nonce (12 bytes)
      const aad = new Uint8Array(20);
      const view = new DataView(aad.buffer);
      view.setBigUint64(0, BigInt(i));
      aad.set(headerNonce, 8);

      const encryptedChunk = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: chunkNonce, additionalData: aad },
        contentKeyObj,
        chunk
      );

      // Chunk format: 12 bytes nonce + encrypted payload + 16 bytes tag
      const chunkResult = new Uint8Array(12 + encryptedChunk.byteLength);
      chunkResult.set(chunkNonce, 0);
      chunkResult.set(new Uint8Array(encryptedChunk), 12);
      encryptedChunks.push(chunkResult);
    }

    // Combine header + chunks
    const totalSize = 68 + encryptedChunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalSize);
    result.set(header, 0);
    let offset = 68;
    for (const chunk of encryptedChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result.buffer as ArrayBuffer;
  }

  /**
   * Decrypt file content (Cryptomator format).
   */
  async decryptFile(encryptedData: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.masterKeys) throw new Error('Vault is locked');

    const data = new Uint8Array(encryptedData);
    if (data.length < 68) {
      throw new Error('Invalid encrypted file: too short for header');
    }

    // Parse header
    const headerNonce = data.slice(0, 12);
    const encryptedHeaderPayload = data.slice(12, 68);

    // Decrypt header
    const encMasterKey = await crypto.subtle.importKey(
      'raw',
      this.masterKeys.encryptionKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const headerPayload = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: headerNonce },
        encMasterKey,
        encryptedHeaderPayload
      )
    );

    // Extract content key (bytes 8-39 of payload)
    const contentKey = headerPayload.slice(8, 40);

    const contentKeyObj = await crypto.subtle.importKey(
      'raw',
      contentKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    // Decrypt chunks
    const chunkEncryptedSize = 12 + this.CHUNK_SIZE + 16; // nonce + payload + tag
    const contentData = data.slice(68);
    const decryptedChunks: Uint8Array[] = [];
    let chunkIndex = 0;
    let pos = 0;

    while (pos < contentData.length) {
      const chunkNonce = contentData.slice(pos, pos + 12);
      const remaining = contentData.length - pos - 12;
      const chunkCiphertext = contentData.slice(pos + 12, pos + 12 + remaining);

      // Determine actual chunk size (last chunk may be smaller)
      let actualChunkEnd: number;
      if (pos + chunkEncryptedSize <= contentData.length) {
        actualChunkEnd = pos + chunkEncryptedSize;
      } else {
        actualChunkEnd = contentData.length;
      }
      const encryptedChunk = contentData.slice(pos + 12, actualChunkEnd);

      // AAD: chunk number (8 bytes big-endian) + header nonce (12 bytes)
      const aad = new Uint8Array(20);
      const view = new DataView(aad.buffer);
      view.setBigUint64(0, BigInt(chunkIndex));
      aad.set(headerNonce, 8);

      const decryptedChunk = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: chunkNonce, additionalData: aad },
          contentKeyObj,
          encryptedChunk
        )
      );

      decryptedChunks.push(decryptedChunk);
      pos = actualChunkEnd;
      chunkIndex++;
    }

    // Combine decrypted chunks
    const totalSize = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalSize);
    let resultOffset = 0;
    for (const chunk of decryptedChunks) {
      result.set(chunk, resultOffset);
      resultOffset += chunk.length;
    }

    return result.buffer as ArrayBuffer;
  }

  // ─── Master Key Export/Import (for multi-device transfer) ──────────

  async exportMasterKeys(): Promise<ArrayBuffer> {
    if (!this.masterKeys) throw new Error('Vault is locked');
    // Concatenate both keys: 32 bytes enc + 32 bytes mac = 64 bytes
    const exported = new Uint8Array(64);
    exported.set(new Uint8Array(this.masterKeys.encryptionKey), 0);
    exported.set(new Uint8Array(this.masterKeys.macKey), 32);
    return exported.buffer as ArrayBuffer;
  }

  async importMasterKeys(rawKeys: ArrayBuffer): Promise<void> {
    const data = new Uint8Array(rawKeys);
    if (data.length !== 64) throw new Error('Invalid master key data');
    this.masterKeys = {
      encryptionKey: data.slice(0, 32).buffer as ArrayBuffer,
      macKey: data.slice(32, 64).buffer as ArrayBuffer,
    };
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  private async wrapMasterKeys(password: string): Promise<MasterkeyFile> {
    if (!this.masterKeys) throw new Error('Vault is locked');

    // Cryptomator uses 8 bytes salt (not 32!)
    const salt = crypto.getRandomValues(new Uint8Array(8));

    // NFC-normalize the password (as Cryptomator does)
    const normalizedPassword = password.normalize('NFC');
    const kek = await this.deriveKek(normalizedPassword, salt);

    const wrappedEncKey = await aesKeyWrap(this.masterKeys.encryptionKey, kek);
    const wrappedMacKey = await aesKeyWrap(this.masterKeys.macKey, kek);

    // Version MAC: HMAC-SHA256 of version (as 4-byte big-endian) using ONLY the MAC key
    const versionBytes = new Uint8Array(4);
    new DataView(versionBytes.buffer).setUint32(0, 999, false); // version 999, big-endian
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      this.masterKeys.macKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const versionMac = await crypto.subtle.sign('HMAC', hmacKey, versionBytes);

    return {
      version: 999,
      scryptSalt: this.arrayBufferToBase64(salt.buffer as ArrayBuffer),
      scryptCostParam: this.SCRYPT_COST,
      scryptBlockSize: this.SCRYPT_BLOCK_SIZE,
      primaryMasterKey: this.arrayBufferToBase64(wrappedEncKey),
      hmacMasterKey: this.arrayBufferToBase64(wrappedMacKey),
      versionMac: this.arrayBufferToBase64(versionMac),
    };
  }

  /**
   * Derive KEK using scrypt.
   * Web Crypto doesn't natively support scrypt, so we use a JS implementation.
   */
  private async deriveKek(
    password: string,
    salt: Uint8Array,
    costParam?: number,
    blockSize?: number
  ): Promise<ArrayBuffer> {
    const N = costParam || this.SCRYPT_COST;
    const r = blockSize || this.SCRYPT_BLOCK_SIZE;
    const p = this.SCRYPT_PARALLELISM;
    const dkLen = this.SCRYPT_KEY_LENGTH;

    const encoder = new TextEncoder();
    const passwordBytes = encoder.encode(password);

    // Use scrypt implementation
    return scrypt(passwordBytes, salt, N, r, p, dkLen);
  }

  // ─── Base Encoding Utilities ───────────────────────────────────────

  arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer as ArrayBuffer;
  }

  arrayBufferToBase64Url(buffer: ArrayBuffer): string {
    return this.arrayBufferToBase64(buffer)
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    // NOTE: Padding ('=') is intentionally kept! Cryptomator requires padded Base64url for filenames.
  }

  /**
   * Base64url without padding – used only for JWT segments (vault.cryptomator).
   */
  arrayBufferToBase64UrlNoPadding(buffer: ArrayBuffer): string {
    return this.arrayBufferToBase64Url(buffer).replace(/=+$/, '');
  }

  base64UrlToUint8Array(base64url: string): Uint8Array {
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding only if not already present
    const padding = 4 - (base64.length % 4);
    if (padding !== 4 && !base64.endsWith('=')) base64 += '='.repeat(padding);
    return new Uint8Array(this.base64ToArrayBuffer(base64));
  }

  base32Encode(data: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let result = '';

    for (let i = 0; i < data.length; i++) {
      value = (value << 8) | data[i];
      bits += 8;
      while (bits >= 5) {
        result += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }

    if (bits > 0) {
      result += alphabet[(value << (5 - bits)) & 31];
    }

    return result;
  }
}

// ─── scrypt Implementation ───────────────────────────────────────────

/**
 * Minimal scrypt implementation for browser use.
 * Based on RFC 7914.
 */
async function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  dkLen: number
): Promise<ArrayBuffer> {
  // Step 1: Generate initial data using PBKDF2-HMAC-SHA256
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    password,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const blockSize = 128 * r * p;
  const B = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 1, hash: 'SHA-256' },
      passwordKey,
      blockSize * 8
    )
  );

  // Step 2: Apply scryptROMix to each block
  for (let i = 0; i < p; i++) {
    const block = B.subarray(i * 128 * r, (i + 1) * 128 * r);
    scryptROMix(block, N, r);
  }

  // Step 3: Derive final key using PBKDF2 with B as salt
  const result = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: B, iterations: 1, hash: 'SHA-256' },
    passwordKey,
    dkLen * 8
  );

  return result;
}

function scryptROMix(block: Uint8Array, N: number, r: number): void {
  const blockLen = 128 * r;
  const V = new Array<Uint8Array>(N);
  let X = new Uint8Array(block);

  // Step 1: Fill V
  for (let i = 0; i < N; i++) {
    V[i] = new Uint8Array(X);
    scryptBlockMix(X, r);
  }

  // Step 2: Mix
  for (let i = 0; i < N; i++) {
    const j = integerify(X, r) % N;
    xorBlocks(X, V[j]);
    scryptBlockMix(X, r);
  }

  block.set(X);
}

function scryptBlockMix(B: Uint8Array, r: number): void {
  const blockCount = 2 * r;
  let X = B.slice((blockCount - 1) * 64, blockCount * 64);
  const Y = new Uint8Array(B.length);

  for (let i = 0; i < blockCount; i++) {
    const block = B.slice(i * 64, (i + 1) * 64);
    xorBlocks(X, block);
    salsa20_8(X);

    // Even blocks go to first half, odd to second
    const dest = i % 2 === 0 ? (i / 2) * 64 : (r + Math.floor(i / 2)) * 64;
    Y.set(X, dest);
  }

  B.set(Y);
}

function integerify(B: Uint8Array, r: number): number {
  const offset = (2 * r - 1) * 64;
  return (B[offset] | (B[offset + 1] << 8) | (B[offset + 2] << 16) | (B[offset + 3] << 24)) >>> 0;
}

function xorBlocks(a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < a.length; i++) {
    a[i] ^= b[i];
  }
}

function salsa20_8(block: Uint8Array): void {
  const B32 = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    B32[i] = block[i * 4] | (block[i * 4 + 1] << 8) | (block[i * 4 + 2] << 16) | (block[i * 4 + 3] << 24);
  }

  const x = new Uint32Array(B32);

  for (let i = 0; i < 4; i++) { // 8 rounds = 4 double-rounds
    // Column round
    x[4] ^= rotl(x[0] + x[12], 7);  x[8] ^= rotl(x[4] + x[0], 9);
    x[12] ^= rotl(x[8] + x[4], 13); x[0] ^= rotl(x[12] + x[8], 18);
    x[9] ^= rotl(x[5] + x[1], 7);   x[13] ^= rotl(x[9] + x[5], 9);
    x[1] ^= rotl(x[13] + x[9], 13); x[5] ^= rotl(x[1] + x[13], 18);
    x[14] ^= rotl(x[10] + x[6], 7); x[2] ^= rotl(x[14] + x[10], 9);
    x[6] ^= rotl(x[2] + x[14], 13); x[10] ^= rotl(x[6] + x[2], 18);
    x[3] ^= rotl(x[15] + x[11], 7); x[7] ^= rotl(x[3] + x[15], 9);
    x[11] ^= rotl(x[7] + x[3], 13); x[15] ^= rotl(x[11] + x[7], 18);
    // Row round
    x[1] ^= rotl(x[0] + x[3], 7);   x[2] ^= rotl(x[1] + x[0], 9);
    x[3] ^= rotl(x[2] + x[1], 13);  x[0] ^= rotl(x[3] + x[2], 18);
    x[6] ^= rotl(x[5] + x[4], 7);   x[7] ^= rotl(x[6] + x[5], 9);
    x[4] ^= rotl(x[7] + x[6], 13);  x[5] ^= rotl(x[4] + x[7], 18);
    x[11] ^= rotl(x[10] + x[9], 7); x[8] ^= rotl(x[11] + x[10], 9);
    x[9] ^= rotl(x[8] + x[11], 13); x[10] ^= rotl(x[9] + x[8], 18);
    x[12] ^= rotl(x[15] + x[14], 7);x[13] ^= rotl(x[12] + x[15], 9);
    x[14] ^= rotl(x[13] + x[12], 13);x[15] ^= rotl(x[14] + x[13], 18);
  }

  for (let i = 0; i < 16; i++) {
    B32[i] = (B32[i] + x[i]) >>> 0;
  }

  for (let i = 0; i < 16; i++) {
    block[i * 4] = B32[i] & 0xff;
    block[i * 4 + 1] = (B32[i] >> 8) & 0xff;
    block[i * 4 + 2] = (B32[i] >> 16) & 0xff;
    block[i * 4 + 3] = (B32[i] >> 24) & 0xff;
  }
}

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}
