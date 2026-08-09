import { TestBed } from '@angular/core/testing';
import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  let service: CryptoService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CryptoService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('isUnlocked', () => {
    it('should be false initially', () => {
      expect(service.isUnlocked).toBeFalse();
    });

    it('should be true after createVault', async () => {
      await service.createVault('testpassword');
      expect(service.isUnlocked).toBeTrue();
    });

    it('should be false after lockVault', async () => {
      await service.createVault('testpassword');
      service.lockVault();
      expect(service.isUnlocked).toBeFalse();
    });
  });

  describe('createVault', () => {
    it('should generate a masterkey file with correct format', async () => {
      const { masterkeyFile, vaultConfig } = await service.createVault('mypassword');

      expect(masterkeyFile).toBeDefined();
      expect(masterkeyFile.version).toBe(999);
      expect(masterkeyFile.scryptSalt).toBeTruthy();
      expect(masterkeyFile.scryptCostParam).toBe(32768);
      expect(masterkeyFile.scryptBlockSize).toBe(8);
      expect(masterkeyFile.primaryMasterKey).toBeTruthy();
      expect(masterkeyFile.hmacMasterKey).toBeTruthy();
      expect(masterkeyFile.versionMac).toBeTruthy();
    });

    it('should generate a vault config with format 8', async () => {
      const { vaultConfig } = await service.createVault('mypassword');

      expect(vaultConfig.format).toBe(8);
      expect(vaultConfig.shorteningThreshold).toBe(220);
      expect(vaultConfig.cipherCombo).toBe('SIV_GCM');
      expect(vaultConfig.jti).toBeTruthy();
    });
  });

  describe('unlockVault', () => {
    it('should unlock with correct password', async () => {
      const { masterkeyFile } = await service.createVault('correctpassword');
      service.lockVault();

      const result = await service.unlockVault('correctpassword', masterkeyFile);
      expect(result).toBeTrue();
      expect(service.isUnlocked).toBeTrue();
    });

    it('should fail with wrong password', async () => {
      const { masterkeyFile } = await service.createVault('correctpassword');
      service.lockVault();

      const result = await service.unlockVault('wrongpassword', masterkeyFile);
      expect(result).toBeFalse();
      expect(service.isUnlocked).toBeFalse();
    });
  });

  describe('lockVault', () => {
    it('should clear master keys', async () => {
      await service.createVault('password');
      service.lockVault();

      expect(service.isUnlocked).toBeFalse();
    });
  });

  describe('encryptFilename / decryptFilename', () => {
    beforeEach(async () => {
      await service.createVault('password');
    });

    it('should throw when vault is locked', async () => {
      service.lockVault();
      await expectAsync(service.encryptFilename('test.jpg', '')).toBeRejectedWithError('Vault is locked');
    });

    it('should encrypt and produce a .c9r suffix', async () => {
      const encrypted = await service.encryptFilename('photo.jpg', '');
      expect(encrypted).toMatch(/\.c9r$/);
    });

    it('should decrypt back to original filename', async () => {
      const original = 'vacation_2024.jpg';
      const encrypted = await service.encryptFilename(original, '');
      const decrypted = await service.decryptFilename(encrypted, '');
      expect(decrypted).toBe(original);
    });

    it('should produce different ciphertexts for different directory IDs', async () => {
      const name = 'photo.jpg';
      const enc1 = await service.encryptFilename(name, 'dir-id-1');
      const enc2 = await service.encryptFilename(name, 'dir-id-2');
      expect(enc1).not.toBe(enc2);
    });

    it('should produce deterministic output for same inputs (AES-SIV)', async () => {
      const name = 'photo.jpg';
      const enc1 = await service.encryptFilename(name, 'same-dir');
      const enc2 = await service.encryptFilename(name, 'same-dir');
      expect(enc1).toBe(enc2);
    });

    it('should handle special characters in filenames', async () => {
      const names = ['foto (1).jpg', 'Ünïcödé.png', '日本語.heic', 'file name with spaces.webp'];
      for (const name of names) {
        const encrypted = await service.encryptFilename(name, '');
        const decrypted = await service.decryptFilename(encrypted, '');
        expect(decrypted).toBe(name);
      }
    });

    it('should handle empty filename', async () => {
      const encrypted = await service.encryptFilename('', '');
      const decrypted = await service.decryptFilename(encrypted, '');
      expect(decrypted).toBe('');
    });
  });

  describe('encryptDirectoryId', () => {
    beforeEach(async () => {
      await service.createVault('password');
    });

    it('should throw when vault is locked', async () => {
      service.lockVault();
      await expectAsync(service.encryptDirectoryId('')).toBeRejectedWithError('Vault is locked');
    });

    it('should produce path in d/XX/YYYY format', async () => {
      const path = await service.encryptDirectoryId('');
      expect(path).toMatch(/^d\/[A-Z2-7]{2}\/[A-Z2-7]+$/);
    });

    it('should be deterministic for same input', async () => {
      const path1 = await service.encryptDirectoryId('test-dir-id');
      const path2 = await service.encryptDirectoryId('test-dir-id');
      expect(path1).toBe(path2);
    });

    it('should produce different paths for different directory IDs', async () => {
      const path1 = await service.encryptDirectoryId('dir-a');
      const path2 = await service.encryptDirectoryId('dir-b');
      expect(path1).not.toBe(path2);
    });
  });

  describe('encryptFile / decryptFile', () => {
    beforeEach(async () => {
      await service.createVault('password');
    });

    it('should throw when vault is locked', async () => {
      service.lockVault();
      const data = new ArrayBuffer(10);
      await expectAsync(service.encryptFile(data)).toBeRejectedWithError('Vault is locked');
      await expectAsync(service.decryptFile(data)).toBeRejectedWithError('Vault is locked');
    });

    it('should encrypt and decrypt small data correctly', async () => {
      const original = new TextEncoder().encode('Hello, IntimaPic!');
      const encrypted = await service.encryptFile(original.buffer as ArrayBuffer);

      expect(encrypted.byteLength).toBeGreaterThan(68); // At least header size

      const decrypted = await service.decryptFile(encrypted);
      const decoded = new TextDecoder().decode(decrypted);
      expect(decoded).toBe('Hello, IntimaPic!');
    });

    it('should encrypt and decrypt empty data', async () => {
      const original = new Uint8Array(0);
      const encrypted = await service.encryptFile(original.buffer as ArrayBuffer);
      const decrypted = await service.decryptFile(encrypted);
      expect(new Uint8Array(decrypted).length).toBe(0);
    });

    it('should encrypt and decrypt larger data (multiple chunks)', async () => {
      // Create data larger than 32KiB to span multiple chunks
      const size = 65536; // 64 KiB = 2 chunks
      const original = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        original[i] = i % 256;
      }

      const encrypted = await service.encryptFile(original.buffer as ArrayBuffer);
      const decrypted = await service.decryptFile(encrypted);
      const decryptedBytes = new Uint8Array(decrypted);

      expect(decryptedBytes.length).toBe(size);
      expect(decryptedBytes).toEqual(original);
    });

    it('should reject decryption of too-short data', async () => {
      const tooShort = new ArrayBuffer(10);
      await expectAsync(service.decryptFile(tooShort))
        .toBeRejectedWithError('Invalid encrypted file: too short for header');
    });

    it('should produce different ciphertexts for same plaintext (random nonces)', async () => {
      const data = new TextEncoder().encode('same input');
      const enc1 = await service.encryptFile(data.buffer as ArrayBuffer);
      const enc2 = await service.encryptFile(data.buffer as ArrayBuffer);

      const bytes1 = new Uint8Array(enc1);
      const bytes2 = new Uint8Array(enc2);

      // Nonces are random, so outputs should differ
      let allSame = true;
      for (let i = 0; i < Math.min(bytes1.length, bytes2.length); i++) {
        if (bytes1[i] !== bytes2[i]) { allSame = false; break; }
      }
      expect(allSame).toBeFalse();
    });
  });

  describe('changePassword', () => {
    it('should re-wrap master keys with new password', async () => {
      await service.createVault('oldpassword');
      const newMasterkeyFile = await service.changePassword('newpassword');

      // Lock and unlock with new password
      service.lockVault();
      const result = await service.unlockVault('newpassword', newMasterkeyFile);
      expect(result).toBeTrue();
    });

    it('should fail to unlock with old password after change', async () => {
      await service.createVault('oldpassword');
      const newMasterkeyFile = await service.changePassword('newpassword');

      service.lockVault();
      const result = await service.unlockVault('oldpassword', newMasterkeyFile);
      expect(result).toBeFalse();
    });

    it('should throw if vault is locked', async () => {
      await expectAsync(service.changePassword('new')).toBeRejectedWithError('Vault is locked');
    });
  });

  describe('exportMasterKeys / importMasterKeys', () => {
    it('should export 64 bytes', async () => {
      await service.createVault('password');
      const exported = await service.exportMasterKeys();
      expect(exported.byteLength).toBe(64);
    });

    it('should restore functionality after import', async () => {
      await service.createVault('password');
      const exported = await service.exportMasterKeys();
      const encryptedName = await service.encryptFilename('test.jpg', '');

      // Lock and reimport
      service.lockVault();
      await service.importMasterKeys(exported);

      // Should be able to decrypt
      const decrypted = await service.decryptFilename(encryptedName, '');
      expect(decrypted).toBe('test.jpg');
    });

    it('should reject invalid key data length', async () => {
      await expectAsync(service.importMasterKeys(new ArrayBuffer(32)))
        .toBeRejectedWithError('Invalid master key data');
    });
  });
});
