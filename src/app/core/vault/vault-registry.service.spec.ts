import { TestBed } from '@angular/core/testing';
import { VaultRegistryService } from './vault-registry.service';
import type { StorageSettings } from '../crypto/crypto.models';

describe('VaultRegistryService', () => {
  let service: VaultRegistryService;

  const mockSettings: StorageSettings = {
    provider: 'onedrive',
    config: { clientId: 'test-client-id' },
    rootPath: '/Apps/IntimaPic',
  };

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(VaultRegistryService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('initialize', () => {
    it('should load vaults from localStorage', () => {
      const vaults = [{
        id: 'vault-1',
        name: 'Test Vault',
        storageSettings: mockSettings,
        createdAt: '2024-01-01T00:00:00.000Z',
      }];
      localStorage.setItem('intimapic_vault_registry', JSON.stringify(vaults));
      localStorage.setItem('intimapic_active_vault_id', 'vault-1');

      service.initialize();

      expect(service.vaults().length).toBe(1);
      expect(service.vaults()[0].name).toBe('Test Vault');
      expect(service.activeVaultId()).toBe('vault-1');
    });

    it('should auto-select single vault on initialize', () => {
      const vaults = [{
        id: 'only-vault',
        name: 'Single',
        storageSettings: mockSettings,
        createdAt: '2024-01-01T00:00:00.000Z',
      }];
      localStorage.setItem('intimapic_vault_registry', JSON.stringify(vaults));

      service.initialize();

      expect(service.activeVaultId()).toBe('only-vault');
    });

    it('should handle corrupted localStorage gracefully', () => {
      localStorage.setItem('intimapic_vault_registry', 'not-valid-json');

      service.initialize();

      expect(service.vaults().length).toBe(0);
    });

    it('should start with empty state when no localStorage data', () => {
      service.initialize();

      expect(service.vaults().length).toBe(0);
      expect(service.activeVaultId()).toBeNull();
      expect(service.hasVaults()).toBeFalse();
    });
  });

  describe('addVault', () => {
    it('should add a vault and persist to localStorage', () => {
      service.initialize();
      const vault = service.addVault('Mein Tresor', mockSettings);

      expect(vault.id).toBeTruthy();
      expect(vault.name).toBe('Mein Tresor');
      expect(vault.storageSettings).toBe(mockSettings);
      expect(service.vaults().length).toBe(1);

      const stored = JSON.parse(localStorage.getItem('intimapic_vault_registry')!);
      expect(stored.length).toBe(1);
    });

    it('should set new vault as active', () => {
      service.initialize();
      const vault = service.addVault('New Vault', mockSettings);

      expect(service.activeVaultId()).toBe(vault.id);
    });

    it('should support multiple vaults', () => {
      service.initialize();
      service.addVault('Vault 1', mockSettings);
      service.addVault('Vault 2', mockSettings);

      expect(service.vaults().length).toBe(2);
      expect(service.hasMultipleVaults()).toBeTrue();
    });
  });

  describe('removeVault', () => {
    it('should remove vault and update localStorage', () => {
      service.initialize();
      const vault = service.addVault('To Remove', mockSettings);

      service.removeVault(vault.id);

      expect(service.vaults().length).toBe(0);
      expect(service.hasVaults()).toBeFalse();
    });

    it('should update active vault when removing the active one', () => {
      service.initialize();
      const vault1 = service.addVault('First', mockSettings);
      const vault2 = service.addVault('Second', mockSettings);

      service.removeVault(vault2.id);

      expect(service.activeVaultId()).toBe(vault1.id);
    });

    it('should set active to null when removing the only vault', () => {
      service.initialize();
      const vault = service.addVault('Only', mockSettings);

      service.removeVault(vault.id);

      expect(service.activeVaultId()).toBeNull();
    });
  });

  describe('renameVault', () => {
    it('should update vault name and persist', () => {
      service.initialize();
      const vault = service.addVault('Old Name', mockSettings);

      service.renameVault(vault.id, 'New Name');

      expect(service.vaults()[0].name).toBe('New Name');
      const stored = JSON.parse(localStorage.getItem('intimapic_vault_registry')!);
      expect(stored[0].name).toBe('New Name');
    });
  });

  describe('setActiveVault', () => {
    it('should set the active vault', () => {
      service.initialize();
      const vault1 = service.addVault('V1', mockSettings);
      service.addVault('V2', mockSettings);

      service.setActiveVault(vault1.id);
      expect(service.activeVaultId()).toBe(vault1.id);
    });

    it('should throw for non-existent vault ID', () => {
      service.initialize();
      expect(() => service.setActiveVault('nonexistent')).toThrow();
    });
  });

  describe('activeVault computed', () => {
    it('should return the active vault info', () => {
      service.initialize();
      const vault = service.addVault('Active', mockSettings);

      expect(service.activeVault()).toBeTruthy();
      expect(service.activeVault()!.name).toBe('Active');
      expect(service.activeVault()!.id).toBe(vault.id);
    });

    it('should return null when no active vault', () => {
      service.initialize();
      expect(service.activeVault()).toBeNull();
    });
  });

  describe('getVault', () => {
    it('should find vault by ID', () => {
      service.initialize();
      const vault = service.addVault('Find Me', mockSettings);

      expect(service.getVault(vault.id)).toBeDefined();
      expect(service.getVault(vault.id)!.name).toBe('Find Me');
    });

    it('should return undefined for unknown ID', () => {
      service.initialize();
      expect(service.getVault('unknown')).toBeUndefined();
    });
  });

  describe('clearAll', () => {
    it('should remove all vaults and clear localStorage', () => {
      service.initialize();
      service.addVault('V1', mockSettings);
      service.addVault('V2', mockSettings);

      service.clearAll();

      expect(service.vaults().length).toBe(0);
      expect(service.activeVaultId()).toBeNull();
      expect(localStorage.getItem('intimapic_vault_registry')).toBeNull();
      expect(localStorage.getItem('intimapic_active_vault_id')).toBeNull();
    });
  });

  describe('migrateFromLegacy', () => {
    it('should migrate legacy single-vault keys to registry', () => {
      localStorage.setItem('intimapic_vault_exists', 'true');
      localStorage.setItem('intimapic_storage_settings', JSON.stringify(mockSettings));

      service.initialize();
      const migrated = service.migrateFromLegacy();

      expect(migrated).toBeTruthy();
      expect(migrated!.name).toBe('Mein Tresor');
      expect(service.vaults().length).toBe(1);

      expect(localStorage.getItem('intimapic_vault_exists')).toBeNull();
      expect(localStorage.getItem('intimapic_storage_settings')).toBeNull();
    });

    it('should return null when no legacy data exists', () => {
      service.initialize();
      const result = service.migrateFromLegacy();
      expect(result).toBeNull();
    });
  });
});
