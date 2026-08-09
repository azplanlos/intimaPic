import { TestBed } from '@angular/core/testing';
import { VaultConfigService } from './vault-config.service';
import { CryptoService } from './crypto.service';
import type { MasterkeyFile, VaultConfig } from './crypto.models';

describe('VaultConfigService', () => {
  let service: VaultConfigService;
  let cryptoService: CryptoService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(VaultConfigService);
    cryptoService = TestBed.inject(CryptoService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('constants', () => {
    it('should have correct masterkey filename', () => {
      expect(service.MASTERKEY_FILENAME).toBe('masterkey.cryptomator');
    });

    it('should have correct vault config filename', () => {
      expect(service.VAULT_CONFIG_FILENAME).toBe('vault.cryptomator');
    });
  });

  describe('serializeMasterkeyFile / parseMasterkeyFile', () => {
    it('should serialize and parse back correctly', () => {
      const masterkeyFile: MasterkeyFile = {
        version: 999,
        scryptSalt: 'dGVzdHNhbHQ=',
        scryptCostParam: 32768,
        scryptBlockSize: 8,
        primaryMasterKey: 'cHJpbWFyeUtleQ==',
        hmacMasterKey: 'aG1hY0tleQ==',
        versionMac: 'dmVyc2lvbk1hYw==',
      };

      const bytes = service.serializeMasterkeyFile(masterkeyFile);
      expect(bytes.byteLength).toBeGreaterThan(0);

      const parsed = service.parseMasterkeyFile(bytes);
      expect(parsed.version).toBe(999);
      expect(parsed.scryptSalt).toBe('dGVzdHNhbHQ=');
      expect(parsed.scryptCostParam).toBe(32768);
      expect(parsed.scryptBlockSize).toBe(8);
      expect(parsed.primaryMasterKey).toBe('cHJpbWFyeUtleQ==');
      expect(parsed.hmacMasterKey).toBe('aG1hY0tleQ==');
    });

    it('should throw for invalid masterkey file data', () => {
      const invalidJson = new TextEncoder().encode('{}').buffer as ArrayBuffer;
      expect(() => service.parseMasterkeyFile(invalidJson))
        .toThrowError('Invalid masterkey.cryptomator: missing required fields');
    });

    it('should throw for non-JSON data', () => {
      const garbage = new TextEncoder().encode('not json at all').buffer as ArrayBuffer;
      expect(() => service.parseMasterkeyFile(garbage)).toThrow();
    });
  });

  describe('parseVaultConfig', () => {
    it('should parse a JWT vault config', () => {
      const payload: VaultConfig = {
        format: 8,
        shorteningThreshold: 220,
        jti: 'test-uuid',
        cipherCombo: 'SIV_GCM',
      };

      // Create a minimal JWT (header.payload.signature)
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const payloadB64 = btoa(JSON.stringify(payload))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const jwt = `${header}.${payloadB64}.fakesignature`;

      const bytes = new TextEncoder().encode(jwt).buffer as ArrayBuffer;
      const parsed = service.parseVaultConfig(bytes);

      expect(parsed.format).toBe(8);
      expect(parsed.shorteningThreshold).toBe(220);
      expect(parsed.jti).toBe('test-uuid');
      expect(parsed.cipherCombo).toBe('SIV_GCM');
    });

    it('should throw for invalid JWT format', () => {
      const invalid = new TextEncoder().encode('notajwt').buffer as ArrayBuffer;
      expect(() => service.parseVaultConfig(invalid)).toThrow();
    });
  });

  describe('createNewVault', () => {
    it('should create vault and return all needed file data', async () => {
      const result = await service.createNewVault('testpassword');

      expect(result.masterkeyFileBytes).toBeDefined();
      expect(result.masterkeyFileBytes.byteLength).toBeGreaterThan(0);
      expect(result.vaultConfigBytes).toBeDefined();
      expect(result.vaultConfigBytes.byteLength).toBeGreaterThan(0);
      expect(result.masterkeyFile).toBeDefined();
      expect(result.vaultConfig).toBeDefined();
      expect(result.vaultConfig.format).toBe(8);
    });

    it('should leave CryptoService unlocked after creation', async () => {
      await service.createNewVault('testpassword');
      expect(cryptoService.isUnlocked).toBeTrue();
    });
  });

  describe('unlockFromBytes', () => {
    it('should unlock with correct password from serialized masterkey', async () => {
      const { masterkeyFileBytes } = await service.createNewVault('mypassword');
      cryptoService.lockVault();

      const success = await service.unlockFromBytes('mypassword', masterkeyFileBytes);
      expect(success).toBeTrue();
      expect(cryptoService.isUnlocked).toBeTrue();
    });

    it('should fail with wrong password', async () => {
      const { masterkeyFileBytes } = await service.createNewVault('mypassword');
      cryptoService.lockVault();

      const success = await service.unlockFromBytes('wrongpassword', masterkeyFileBytes);
      expect(success).toBeFalse();
      expect(cryptoService.isUnlocked).toBeFalse();
    });
  });

  describe('changePassword', () => {
    it('should produce new masterkey bytes that work with new password', async () => {
      await service.createNewVault('oldpass');
      const newBytes = await service.changePassword('newpass');

      cryptoService.lockVault();
      const success = await service.unlockFromBytes('newpass', newBytes);
      expect(success).toBeTrue();
    });
  });
});
