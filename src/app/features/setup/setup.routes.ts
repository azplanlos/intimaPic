import { Routes } from '@angular/router';

export const SETUP_ROUTES: Routes = [
  {
    path: '',
    redirectTo: 'welcome',
    pathMatch: 'full',
  },
  {
    path: 'welcome',
    loadComponent: () => import('./welcome.component').then(m => m.WelcomeComponent),
  },
  {
    path: 'create',
    loadComponent: () => import('./create-vault.component').then(m => m.CreateVaultComponent),
  },
  {
    path: 'connect',
    loadComponent: () => import('./connect-vault.component').then(m => m.ConnectVaultComponent),
  },
  {
    path: 'unlock',
    loadComponent: () => import('./unlock-vault.component').then(m => m.UnlockVaultComponent),
  },
  {
    path: 'provider',
    loadComponent: () => import('./provider-select.component').then(m => m.ProviderSelectComponent),
  },
  {
    path: 'provider-config',
    loadComponent: () => import('./provider-config.component').then(m => m.ProviderConfigComponent),
  },
];
