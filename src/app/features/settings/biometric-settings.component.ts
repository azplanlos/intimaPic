import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { BiometricAuthService } from '../../core/biometric/biometric-auth.service';
import type { BiometricCredential } from '../../core/biometric/biometric.models';

@Component({
  selector: 'app-biometric-settings',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
    MatDialogModule,
  ],
  template: `
    <div class="settings-container">
      <div class="header">
        <button mat-icon-button (click)="goBack()" aria-label="Zurück">
          <mat-icon>arrow_back</mat-icon>
        </button>
        <h2>Biometrische Geräte</h2>
      </div>

      <p class="description">
        Verwalte Geräte, die per FaceID, Windows Hello oder Touch ID den Tresor entsperren können.
      </p>

      @if (!platformAvailable()) {
        <div class="notice">
          <mat-icon>info</mat-icon>
          <p>Biometrische Authentifizierung ist auf diesem Gerät nicht verfügbar.</p>
        </div>
      }

      @if (loading()) {
        <div class="loading">
          <mat-spinner diameter="32"></mat-spinner>
        </div>
      } @else {
        @if (credentials().length > 0) {
          <mat-list class="credential-list">
            @for (cred of credentials(); track cred.id) {
              <mat-list-item class="credential-item">
                <mat-icon matListItemIcon>devices</mat-icon>
                <div matListItemTitle>{{ cred.deviceName }}</div>
                <div matListItemLine class="credential-meta">
                  Hinzugefügt: {{ formatDate(cred.createdAt) }}
                  @if (cred.lastUsedAt) {
                    · Zuletzt: {{ formatDate(cred.lastUsedAt) }}
                  }
                </div>
                <button mat-icon-button matListItemMeta
                        (click)="removeCredential(cred)"
                        aria-label="Gerät entfernen">
                  <mat-icon>delete</mat-icon>
                </button>
              </mat-list-item>
            }
          </mat-list>
        } @else {
          <div class="empty-state">
            <mat-icon class="empty-icon">fingerprint</mat-icon>
            <p>Noch keine biometrischen Geräte registriert.</p>
          </div>
        }

        @if (platformAvailable()) {
          <div class="add-section">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Gerätename</mat-label>
              <input matInput
                     [(ngModel)]="newDeviceName"
                     name="deviceName"
                     placeholder="z.B. MacBook Pro, iPhone 15">
              <mat-hint>Ein Name, damit du das Gerät wiedererkennst</mat-hint>
            </mat-form-field>

            <button mat-raised-button color="primary"
                    class="full-width add-btn"
                    [disabled]="registering() || !newDeviceName.trim()"
                    (click)="registerDevice()">
              @if (registering()) {
                <mat-spinner diameter="20"></mat-spinner>
              } @else {
                <ng-container>
                  <mat-icon>add</mat-icon>
                  Dieses Gerät hinzufügen
                </ng-container>
              }
            </button>
          </div>
        }

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }

        @if (success()) {
          <p class="success">{{ success() }}</p>
        }
      }
    </div>
  `,
  styles: [`
    .settings-container {
      max-width: 500px;
      margin: 0 auto;
      padding: 1.5rem;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .header h2 {
      font-weight: 400;
      margin: 0;
    }

    .description {
      opacity: 0.7;
      margin-bottom: 1.5rem;
    }

    .notice {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      border-radius: 8px;
      background: var(--mat-sys-surface-variant);
      margin-bottom: 1.5rem;
    }

    .notice mat-icon {
      color: var(--mat-sys-primary);
      flex-shrink: 0;
    }

    .notice p {
      margin: 0;
    }

    .loading {
      display: flex;
      justify-content: center;
      padding: 2rem;
    }

    .credential-list {
      margin-bottom: 1.5rem;
    }

    .credential-item {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    .credential-meta {
      font-size: 0.75rem;
      opacity: 0.6;
    }

    .empty-state {
      text-align: center;
      padding: 2rem;
      opacity: 0.6;
    }

    .empty-icon {
      font-size: 48px;
      width: 48px;
      height: 48px;
      margin-bottom: 0.5rem;
    }

    .add-section {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 1rem;
    }

    .full-width {
      width: 100%;
    }

    .add-btn {
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .error {
      color: var(--mat-sys-error);
      font-size: 0.875rem;
      margin-top: 0.75rem;
      text-align: center;
    }

    .success {
      color: var(--mat-sys-primary);
      font-size: 0.875rem;
      margin-top: 0.75rem;
      text-align: center;
    }
  `]
})
export class BiometricSettingsComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly biometricAuth = inject(BiometricAuthService);

  credentials = signal<BiometricCredential[]>([]);
  loading = signal(true);
  registering = signal(false);
  platformAvailable = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  newDeviceName = '';

  async ngOnInit(): Promise<void> {
    const available = await this.biometricAuth.isAvailable();
    this.platformAvailable.set(available);
    await this.loadCredentials();
  }

  async loadCredentials(): Promise<void> {
    this.loading.set(true);
    const creds = await this.biometricAuth.getRegisteredCredentials();
    this.credentials.set(creds);
    this.loading.set(false);
  }

  async registerDevice(): Promise<void> {
    const name = this.newDeviceName.trim();
    if (!name) return;

    this.registering.set(true);
    this.error.set(null);
    this.success.set(null);

    try {
      const credential = await this.biometricAuth.registerCredential(name);

      if (credential) {
        this.success.set(`"${name}" wurde erfolgreich hinzugefügt.`);
        this.newDeviceName = '';
        await this.loadCredentials();
      } else {
        this.error.set('Registrierung wurde abgebrochen.');
      }
    } catch (err) {
      this.error.set(
        err instanceof Error ? err.message : 'Registrierung fehlgeschlagen.'
      );
    } finally {
      this.registering.set(false);
    }
  }

  async removeCredential(cred: BiometricCredential): Promise<void> {
    if (!confirm(`"${cred.deviceName}" wirklich entfernen? Du kannst dieses Gerät dann nicht mehr per Biometrie entsperren.`)) {
      return;
    }

    await this.biometricAuth.removeCredential(cred.id);
    this.success.set(`"${cred.deviceName}" wurde entfernt.`);
    await this.loadCredentials();
  }

  formatDate(isoString: string): string {
    return new Date(isoString).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }

  goBack(): void {
    this.router.navigate(['/gallery']);
  }
}
