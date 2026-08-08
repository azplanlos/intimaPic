import { Routes } from '@angular/router';
import { vaultUnlockedGuard } from './core/vault/vault.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'gallery',
    pathMatch: 'full',
  },
  {
    path: 'setup',
    loadChildren: () => import('./features/setup/setup.routes').then(m => m.SETUP_ROUTES),
  },
  {
    path: 'gallery',
    canActivate: [vaultUnlockedGuard],
    loadComponent: () =>
      import('./features/gallery/gallery-placeholder.component').then(m => m.GalleryPlaceholderComponent),
  },
  {
    path: 'album/:id',
    canActivate: [vaultUnlockedGuard],
    loadComponent: () =>
      import('./features/gallery/album-view.component').then(m => m.AlbumViewComponent),
  },
  {
    path: 'import-wizard',
    canActivate: [vaultUnlockedGuard],
    loadComponent: () =>
      import('./features/import-wizard/import-wizard.component').then(m => m.ImportWizardComponent),
  },
  {
    path: 'upload',
    canActivate: [vaultUnlockedGuard],
    loadComponent: () =>
      import('./features/upload/upload.component').then(m => m.UploadComponent),
  },
  {
    path: 'settings/biometric',
    canActivate: [vaultUnlockedGuard],
    loadComponent: () =>
      import('./features/settings/biometric-settings.component').then(m => m.BiometricSettingsComponent),
  },
  {
    path: 'share',
    loadComponent: () =>
      import('./features/upload/share-receiver.component').then(m => m.ShareReceiverComponent),
  },
  {
    // MSAL v5 redirect bridge – popup is redirected here after Microsoft login.
    // Must NOT have any guards that would interfere with the auth response.
    path: 'auth-redirect',
    loadComponent: () =>
      import('./features/auth-redirect/auth-redirect.component').then(m => m.AuthRedirectComponent),
  },
  {
    path: '**',
    redirectTo: 'gallery',
  },
];
