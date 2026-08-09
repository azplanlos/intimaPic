import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { VaultService } from './vault.service';
import { VaultRegistryService } from './vault-registry.service';

/**
 * Guard that redirects to setup/unlock if the vault is not unlocked.
 * When multiple vaults are registered, redirects to the vault selection page.
 */
export const vaultUnlockedGuard: CanActivateFn = () => {
  const vaultService = inject(VaultService);
  const registry = inject(VaultRegistryService);
  const router = inject(Router);

  if (vaultService.isUnlocked()) {
    return true;
  }

  if (vaultService.status() === 'locked') {
    // Multiple vaults → let user choose which one to unlock
    if (registry.hasMultipleVaults()) {
      return router.createUrlTree(['/setup/vault-select']);
    }
    return router.createUrlTree(['/setup/unlock']);
  }

  return router.createUrlTree(['/setup/welcome']);
};
