import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import type { StorageProviderType } from '../../core/crypto/crypto.models';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-provider-config',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
  ],
  template: `
    <div class="config-container">
      <h2>{{ providerLabel() }} konfigurieren</h2>

      @switch (provider()) {
        @case ('onedrive') {
          @if (hasAzureDefaults) {
            <p class="description">
              Die Azure-Konfiguration ist vorkonfiguriert. Du kannst die Werte bei Bedarf überschreiben.
            </p>
          } @else {
            <p class="description">
              Erstelle eine App-Registrierung im
              <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps" target="_blank">Azure Portal</a>
              und trage die Application (client) ID ein.
            </p>
          }

          <form class="form" (ngSubmit)="proceed()">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Application (Client) ID</mat-label>
              <input matInput
                     [(ngModel)]="oneDriveClientId"
                     name="clientId"
                     required
                     placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
              @if (hasAzureDefaults) {
                <mat-hint>Vorkonfiguriert – bei Bedarf überschreiben</mat-hint>
              } @else {
                <mat-hint>UUID aus der Azure App-Registrierung</mat-hint>
              }
            </mat-form-field>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Tenant ID (optional)</mat-label>
              <input matInput
                     [(ngModel)]="oneDriveTenantId"
                     name="tenantId"
                     placeholder="common">
              <mat-hint>"common" für persönliche Konten, oder Tenant-UUID</mat-hint>
            </mat-form-field>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Root-Pfad in OneDrive</mat-label>
              <input matInput
                     [(ngModel)]="rootPath"
                     name="rootPath"
                     placeholder="/Apps/IntimaPic">
            </mat-form-field>

            <div class="actions">
              <button mat-button type="button" (click)="goBack()">Zurück</button>
              <button mat-raised-button color="primary" type="submit"
                      [disabled]="!oneDriveClientId">
                Weiter
              </button>
            </div>
          </form>

          @if (!hasAzureDefaults) {
            <div class="help-box">
              <mat-icon>info</mat-icon>
              <div>
                <strong>Azure App-Registrierung Kurzanleitung:</strong>
                <ol>
                  <li>Azure Portal → App-Registrierungen → Neue Registrierung</li>
                  <li>Name: "IntimaPic", Kontotyp: Persönliche MS-Konten</li>
                  <li>Redirect URI: Typ "SPA", Wert: <code>{{ redirectUri }}</code></li>
                  <li>Die Application (client) ID kopieren und hier einfügen</li>
                </ol>
              </div>
            </div>
          }
        }

        @case ('s3') {
          <p class="description">
            Konfiguriere den S3-Bucket und den Lambda-API-Endpunkt für Pre-Signed URLs.
          </p>

          <form class="form" (ngSubmit)="proceed()">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>API Endpoint (Lambda)</mat-label>
              <input matInput
                     [(ngModel)]="s3ApiEndpoint"
                     name="apiEndpoint"
                     required
                     placeholder="https://xxx.execute-api.eu-central-1.amazonaws.com/prod">
            </mat-form-field>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Bucket Name</mat-label>
              <input matInput
                     [(ngModel)]="s3BucketName"
                     name="bucketName"
                     required
                     placeholder="my-intimapic-bucket">
            </mat-form-field>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Region</mat-label>
              <input matInput
                     [(ngModel)]="s3Region"
                     name="region"
                     required
                     placeholder="eu-central-1">
            </mat-form-field>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Root-Pfad (Prefix)</mat-label>
              <input matInput
                     [(ngModel)]="rootPath"
                     name="rootPath"
                     placeholder="intimapic/">
            </mat-form-field>

            <div class="actions">
              <button mat-button type="button" (click)="goBack()">Zurück</button>
              <button mat-raised-button color="primary" type="submit"
                      [disabled]="!s3ApiEndpoint || !s3BucketName || !s3Region">
                Weiter
              </button>
            </div>
          </form>
        }

        @case ('icloud') {
          <p class="description">
            iCloud Drive wird über den lokalen Dateisystem-Zugriff verbunden.
            Du wirst im nächsten Schritt aufgefordert, den iCloud Drive Ordner auszuwählen.
          </p>

          <form class="form" (ngSubmit)="proceed()">
            <div class="actions">
              <button mat-button type="button" (click)="goBack()">Zurück</button>
              <button mat-raised-button color="primary" type="submit">
                Weiter
              </button>
            </div>
          </form>
        }
      }
    </div>
  `,
  styles: [`
    .config-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
      max-width: 500px;
      margin: 0 auto;
    }

    h2 {
      font-weight: 400;
      margin-bottom: 0.5rem;
    }

    .description {
      opacity: 0.7;
      margin-bottom: 1.5rem;
      text-align: center;
    }

    .description a {
      color: var(--mat-sys-primary);
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

    .actions {
      display: flex;
      gap: 1rem;
      justify-content: flex-end;
      margin-top: 1rem;
    }

    .help-box {
      display: flex;
      gap: 0.75rem;
      margin-top: 2rem;
      padding: 1rem;
      border-radius: 8px;
      background: color-mix(in srgb, var(--mat-sys-primary) 8%, transparent);
      font-size: 0.85rem;
      width: 100%;
    }

    .help-box mat-icon {
      color: var(--mat-sys-primary);
      flex-shrink: 0;
    }

    .help-box ol {
      margin: 0.5rem 0 0;
      padding-left: 1.2rem;
    }

    .help-box li {
      margin-bottom: 0.3rem;
    }

    .help-box code {
      background: rgba(0,0,0,0.06);
      padding: 0.1rem 0.3rem;
      border-radius: 3px;
      font-size: 0.8rem;
      word-break: break-all;
    }
  `]
})
export class ProviderConfigComponent implements OnInit {
  private readonly router = inject(Router);

  provider = signal<StorageProviderType>('onedrive');

  // Whether environment provides Azure defaults
  readonly hasAzureDefaults = !!environment.azure.defaultClientId;

  // OneDrive fields – pre-filled from environment if available
  oneDriveClientId = environment.azure.defaultClientId || '';
  oneDriveTenantId = environment.azure.defaultTenantId || 'common';
  rootPath = '/Apps/IntimaPic';

  // S3 fields
  s3ApiEndpoint = '';
  s3BucketName = '';
  s3Region = 'eu-central-1';

  redirectUri = document.baseURI.replace(/\/$/, '') + '/auth-redirect';

  ngOnInit(): void {
    const stored = sessionStorage.getItem('intimapic_selected_provider') as StorageProviderType | null;
    if (stored) {
      this.provider.set(stored);
    }

    // Set default root paths based on provider
    if (stored === 's3') {
      this.rootPath = 'intimapic/';
    } else if (stored === 'icloud') {
      this.rootPath = '';
    }
  }

  providerLabel(): string {
    switch (this.provider()) {
      case 'onedrive': return 'OneDrive';
      case 's3': return 'AWS S3';
      case 'icloud': return 'iCloud Drive';
    }
  }

  proceed(): void {
    // Store the configuration in sessionStorage for the create-vault step
    const config = this.buildConfig();
    sessionStorage.setItem('intimapic_provider_config', JSON.stringify(config));
    sessionStorage.setItem('intimapic_provider_root_path', this.rootPath);
    this.router.navigate(['/setup/create']);
  }

  goBack(): void {
    this.router.navigate(['/setup/provider']);
  }

  private buildConfig(): Record<string, string> {
    switch (this.provider()) {
      case 'onedrive':
        return {
          clientId: this.oneDriveClientId,
          tenantId: this.oneDriveTenantId || 'common',
        };
      case 's3':
        return {
          apiEndpoint: this.s3ApiEndpoint,
          bucketName: this.s3BucketName,
          region: this.s3Region,
        };
      case 'icloud':
        return {};
    }
  }
}
