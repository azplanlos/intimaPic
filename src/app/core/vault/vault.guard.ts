import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { VaultService } from './vault.service';

/**
 * Guard that redirects to setup/unlock if the vault is not unlocked.
 */
export const vaultUnlockedGuard: CanActivateFn = () => {
  const vaultService = inject(VaultService);
  const router = inject(Router);

  if (vaultService.isUnlocked()) {
    return true;
  }

  if (vaultService.status() === 'locked') {
    return router.createUrlTree(['/setup/unlock']);
  }

  return router.createUrlTree(['/setup/welcome']);
};
