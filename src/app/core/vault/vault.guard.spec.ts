import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { vaultUnlockedGuard } from './vault.guard';
import { VaultService, VaultStatus } from './vault.service';
import { VaultRegistryService } from './vault-registry.service';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';

describe('vaultUnlockedGuard', () => {
  let router: Router;

  const mockRoute = {} as ActivatedRouteSnapshot;
  const mockState = {} as RouterStateSnapshot;

  function setup(options: {
    isUnlocked: boolean;
    status: VaultStatus;
    hasMultipleVaults: boolean;
  }) {
    const isUnlockedSignal = signal(options.isUnlocked);
    const statusSignal = signal<VaultStatus>(options.status);
    const hasMultipleVaultsSignal = signal(options.hasMultipleVaults);

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: VaultService,
          useValue: {
            isUnlocked: isUnlockedSignal,
            status: statusSignal,
          },
        },
        {
          provide: VaultRegistryService,
          useValue: {
            hasMultipleVaults: hasMultipleVaultsSignal,
          },
        },
      ],
    });

    router = TestBed.inject(Router);
  }

  it('should allow access when vault is unlocked', () => {
    setup({ isUnlocked: true, status: 'unlocked', hasMultipleVaults: false });

    const result = TestBed.runInInjectionContext(() =>
      vaultUnlockedGuard(mockRoute, mockState)
    );

    expect(result).toBeTrue();
  });

  it('should redirect to /setup/unlock when locked with single vault', () => {
    setup({ isUnlocked: false, status: 'locked', hasMultipleVaults: false });

    const result = TestBed.runInInjectionContext(() =>
      vaultUnlockedGuard(mockRoute, mockState)
    ) as UrlTree;

    expect(result.toString()).toBe('/setup/unlock');
  });

  it('should redirect to /setup/vault-select when locked with multiple vaults', () => {
    setup({ isUnlocked: false, status: 'locked', hasMultipleVaults: true });

    const result = TestBed.runInInjectionContext(() =>
      vaultUnlockedGuard(mockRoute, mockState)
    ) as UrlTree;

    expect(result.toString()).toBe('/setup/vault-select');
  });

  it('should redirect to /setup/welcome when status is none', () => {
    setup({ isUnlocked: false, status: 'none', hasMultipleVaults: false });

    const result = TestBed.runInInjectionContext(() =>
      vaultUnlockedGuard(mockRoute, mockState)
    ) as UrlTree;

    expect(result.toString()).toBe('/setup/welcome');
  });
});
