import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { VaultService } from '../../core/vault/vault.service';
import type { StorageProviderType, StorageSettings } from '../../core/crypto/crypto.models';

@Component({
  selector: 'app-create-vault',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <div class="create-container">
      <h2>Tresor erstellen</h2>
      <p class="description">
        Wähle ein sicheres Passwort zum Schutz deines Verschlüsselungsschlüssels.
      </p>

      @if (vaultAlreadyExists()) {
        <div class="warning-box">
          <mat-icon>warning</mat-icon>
          <div>
            <p class="warning-title">Ein Tresor existiert bereits an diesem Speicherort!</p>
            <p class="warning-text">
              Das Erstellen eines neuen Tresors würde den bestehenden überschreiben
              und alle darin enthaltenen Daten unwiderruflich zerstören.
            </p>
            <p class="warning-text">
              Wenn du diesen Tresor auf einem anderen Gerät nutzen möchtest,
              verwende stattdessen die Option „Bestehenden Tresor verbinden".
            </p>
          </div>
        </div>

        <div class="actions">
          <button mat-button (click)="goBack()">Zurück</button>
          <button mat-raised-button color="primary" (click)="switchToConnect()">
            <mat-icon>login</mat-icon>
            Bestehenden Tresor verbinden
          </button>
        </div>
      } @else {
        <form (ngSubmit)="createVault()" class="form">
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Passwort</mat-label>
            <input matInput
                   [type]="hidePassword() ? 'password' : 'text'"
                   [(ngModel)]="password"
                   name="password"
                   required
                   minlength="8"
                   autocomplete="new-password">
            <button mat-icon-button matSuffix type="button"
                    (click)="hidePassword.set(!hidePassword())">
              <mat-icon>{{ hidePassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
            </button>
            <mat-hint>Mindestens 8 Zeichen</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Passwort bestätigen</mat-label>
            <input matInput
                   [type]="hidePassword() ? 'password' : 'text'"
                   [(ngModel)]="confirmPassword"
                   name="confirmPassword"
                   required
                   autocomplete="new-password">
          </mat-form-field>

          @if (error()) {
            <p class="error">{{ error() }}</p>
          }

          <div class="actions">
            <button mat-button type="button" (click)="goBack()" [disabled]="loading()">
              Zurück
            </button>
            <button mat-raised-button color="primary" type="submit"
                    [disabled]="loading() || !isValid()">
              @if (loading()) {
                <mat-spinner diameter="20"></mat-spinner>
              } @else {
                Tresor erstellen
              }
            </button>
          </div>
        </form>
      }

      @if (checking()) {
        <div class="checking-overlay">
          <mat-spinner diameter="32"></mat-spinner>
          <p>Prüfe Speicherort...</p>
        </div>
      }
    </div>
  `,
  styles: [`
    .create-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
      max-width: 400px;
      margin: 0 auto;
      position: relative;
    }

    h2 {
      font-weight: 400;
      margin-bottom: 0.5rem;
    }

    .description {
      opacity: 0.7;
      margin-bottom: 2rem;
      text-align: center;
    }

    .form {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .full-width {
      width: 100%;
    }

    .error {
      color: var(--mat-sys-error);
      font-size: 0.875rem;
      margin: 0;
    }

    .actions {
      display: flex;
      gap: 1rem;
      justify-content: flex-end;
      width: 100%;
      margin-top: 1rem;
    }

    .warning-box {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1.25rem;
      border-radius: 8px;
      background: color-mix(in srgb, var(--mat-sys-error) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--mat-sys-error) 30%, transparent);
      width: 100%;
      margin-bottom: 1.5rem;
    }

    .warning-box mat-icon {
      color: var(--mat-sys-error);
      flex-shrink: 0;
      margin-top: 2px;
    }

    .warning-title {
      margin: 0 0 0.5rem 0;
      font-weight: 500;
      color: var(--mat-sys-error);
    }

    .warning-text {
      margin: 0 0 0.5rem 0;
      font-size: 0.875rem;
      opacity: 0.85;
    }

    .warning-text:last-child {
      margin-bottom: 0;
    }

    .checking-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      background: color-mix(in srgb, var(--mat-sys-surface) 90%, transparent);
      border-radius: 8px;
    }

    .checking-overlay p {
      opacity: 0.7;
      font-size: 0.9rem;
    }
  `]
})
export class CreateVaultComponent {
  private readonly router = inject(Router);
  private readonly vaultService = inject(VaultService);

  password = '';
  confirmPassword = '';
  hidePassword = signal(true);
  loading = signal(false);
  checking = signal(true);
  error = signal<string | null>(null);
  vaultAlreadyExists = signal(false);

  constructor() {
    // Check if a vault already exists at the target storage location
    this.checkExistingVault();
  }

  isValid(): boolean {
    return this.password.length >= 8 && this.password === this.confirmPassword;
  }

  async createVault(): Promise<void> {
    if (!this.isValid()) {
      if (this.password !== this.confirmPassword) {
        this.error.set('Passwörter stimmen nicht überein.');
      }
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    const provider = sessionStorage.getItem('intimapic_selected_provider') as StorageProviderType | null;
    if (!provider) {
      this.error.set('Kein Speicheranbieter ausgewählt.');
      this.loading.set(false);
      return;
    }

    const settings = this.buildSettings(provider);

    // Final safety check: verify vault doesn't exist before creating
    const exists = await this.vaultService.vaultExistsAtStorage(settings);
    if (exists) {
      this.vaultAlreadyExists.set(true);
      this.loading.set(false);
      return;
    }

    const success = await this.vaultService.createVault(this.password, settings);

    this.loading.set(false);

    if (success) {
      sessionStorage.removeItem('intimapic_selected_provider');
      sessionStorage.removeItem('intimapic_provider_config');
      sessionStorage.removeItem('intimapic_provider_root_path');
      sessionStorage.removeItem('intimapic_setup_mode');
      this.router.navigate(['/gallery']);
    } else {
      this.error.set(this.vaultService.error() || 'Tresor konnte nicht erstellt werden.');
    }
  }

  switchToConnect(): void {
    sessionStorage.setItem('intimapic_setup_mode', 'connect');
    this.router.navigate(['/setup/connect']);
  }

  goBack(): void {
    this.router.navigate(['/setup/provider-config']);
  }

  private async checkExistingVault(): Promise<void> {
    const provider = sessionStorage.getItem('intimapic_selected_provider') as StorageProviderType | null;
    if (!provider) {
      this.checking.set(false);
      return;
    }

    const settings = this.buildSettings(provider);

    try {
      const exists = await this.vaultService.vaultExistsAtStorage(settings);
      this.vaultAlreadyExists.set(exists);
    } catch {
      // If check fails (e.g. network), allow the user to proceed — createVault will catch it
      this.vaultAlreadyExists.set(false);
    } finally {
      this.checking.set(false);
    }
  }

  private buildSettings(provider: StorageProviderType): StorageSettings {
    const configJson = sessionStorage.getItem('intimapic_provider_config');
    const rootPath = sessionStorage.getItem('intimapic_provider_root_path');
    const providerConfig = configJson ? JSON.parse(configJson) : {};

    switch (provider) {
      case 'onedrive':
        return {
          provider: 'onedrive',
          rootPath: rootPath || '/Apps/IntimaPic',
          config: {
            clientId: providerConfig['clientId'] || '',
            tenantId: providerConfig['tenantId'] || 'common',
          },
        };
      case 's3':
        return {
          provider: 's3',
          rootPath: rootPath || 'intimapic/',
          config: {
            bucketName: providerConfig['bucketName'] || '',
            region: providerConfig['region'] || 'eu-central-1',
            apiEndpoint: providerConfig['apiEndpoint'] || '',
          },
        };
      case 'icloud':
        return {
          provider: 'icloud',
          rootPath: rootPath || '',
          config: {},
        };
    }
  }
}
