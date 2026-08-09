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
  selector: 'app-connect-vault',
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
    <div class="connect-container">
      <mat-icon class="hero-icon">login</mat-icon>
      <h2>Bestehenden Tresor verbinden</h2>
      <p class="description">
        Die Verbindung zum Cloud-Speicher wird hergestellt und geprüft,
        ob ein Tresor vorhanden ist.
      </p>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Tresorname</mat-label>
        <input matInput
               [(ngModel)]="vaultName"
               name="vaultName"
               placeholder="z. B. Privat, Arbeit ...">
        <mat-icon matPrefix>shield</mat-icon>
      </mat-form-field>

      @if (error()) {
        <div class="error-box">
          <mat-icon>error_outline</mat-icon>
          <p>{{ error() }}</p>
        </div>
      }

      @if (success()) {
        <div class="success-box">
          <mat-icon>check_circle</mat-icon>
          <p>Tresor gefunden! Du kannst ihn jetzt mit deinem Passwort entsperren.</p>
        </div>
      }

      <div class="actions">
        <button mat-button (click)="goBack()" [disabled]="loading()">
          Zurück
        </button>

        @if (success()) {
          <button mat-raised-button color="primary" (click)="goToUnlock()">
            Zum Entsperren
          </button>
        } @else {
          <button mat-raised-button color="primary"
                  [disabled]="loading()"
                  (click)="connectVault()">
            @if (loading()) {
              <mat-spinner diameter="20"></mat-spinner>
            } @else {
              Verbinden
            }
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    .connect-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
      max-width: 400px;
      margin: 0 auto;
    }

    .hero-icon {
      font-size: 56px;
      width: 56px;
      height: 56px;
      color: var(--mat-sys-primary);
      margin-bottom: 1rem;
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

    .error-box {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      border-radius: 8px;
      background: color-mix(in srgb, var(--mat-sys-error) 10%, transparent);
      width: 100%;
      margin-bottom: 1.5rem;
    }

    .error-box mat-icon {
      color: var(--mat-sys-error);
      flex-shrink: 0;
    }

    .error-box p {
      margin: 0;
      color: var(--mat-sys-error);
      font-size: 0.875rem;
    }

    .success-box {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      border-radius: 8px;
      background: color-mix(in srgb, var(--mat-sys-primary) 10%, transparent);
      width: 100%;
      margin-bottom: 1.5rem;
    }

    .success-box mat-icon {
      color: var(--mat-sys-primary);
      flex-shrink: 0;
    }

    .success-box p {
      margin: 0;
      font-size: 0.875rem;
    }

    .actions {
      display: flex;
      gap: 1rem;
      justify-content: flex-end;
      width: 100%;
      margin-top: 1rem;
    }

    .full-width {
      width: 100%;
      margin-bottom: 1rem;
    }
  `]
})
export class ConnectVaultComponent {
  private readonly router = inject(Router);
  private readonly vaultService = inject(VaultService);

  loading = signal(false);
  error = signal<string | null>(null);
  success = signal(false);
  vaultName = '';

  constructor() {
    // Suggest vault name from root path folder name
    this.vaultName = this.deriveVaultName();
  }

  async connectVault(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.success.set(false);

    const provider = sessionStorage.getItem('intimapic_selected_provider') as StorageProviderType | null;
    if (!provider) {
      this.error.set('Kein Speicheranbieter ausgewählt. Bitte gehe zurück und wähle einen Anbieter.');
      this.loading.set(false);
      return;
    }

    const settings = this.buildSettings(provider);
    const result = await this.vaultService.connectExistingVault(settings, this.vaultName.trim() || undefined);

    this.loading.set(false);

    if (result) {
      this.success.set(true);
      // Clean up session storage
      sessionStorage.removeItem('intimapic_selected_provider');
      sessionStorage.removeItem('intimapic_provider_config');
      sessionStorage.removeItem('intimapic_provider_root_path');
      sessionStorage.removeItem('intimapic_setup_mode');
    } else {
      this.error.set(
        this.vaultService.error() || 'Verbindung zum bestehenden Tresor fehlgeschlagen.'
      );
    }
  }

  goToUnlock(): void {
    this.router.navigate(['/setup/unlock']);
  }

  goBack(): void {
    this.router.navigate(['/setup/provider-config']);
  }

  private deriveVaultName(): string {
    const rootPath = sessionStorage.getItem('intimapic_provider_root_path') || '';
    const segments = rootPath.split('/').filter(s => s.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : '';
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
