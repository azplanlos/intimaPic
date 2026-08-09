import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { VaultService } from '../../core/vault/vault.service';
import { VaultRegistryService } from '../../core/vault/vault-registry.service';
import { BiometricAuthService } from '../../core/biometric/biometric-auth.service';
import { ImportScanService } from '../../core/album/import-scan.service';
import { ThumbnailSyncService } from '../../core/upload/thumbnail-sync.service';

@Component({
  selector: 'app-unlock-vault',
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
    <div class="unlock-container">
      <div class="unlock-hero">
        <img src="assets/app-logo.png" alt="IntimaPic Logo" class="hero-logo">
        <h2>Tresor entsperren</h2>
        @if (registry.activeVault(); as vault) {
          <p class="vault-name">{{ vault.name }}</p>
        }
        <p class="description">
          @if (biometricAvailable()) {
            Verwende Biometrie oder gib dein Passwort ein.
          } @else {
            Gib dein Passwort ein, um auf deine Fotos zuzugreifen.
          }
        </p>
      </div>

      @if (biometricAvailable()) {
        <div class="biometric-section">
          <button mat-raised-button color="primary"
                  class="biometric-btn"
                  [disabled]="loading()"
                  (click)="unlockWithBiometric()">
            @if (loading() && biometricLoading()) {
              <mat-spinner diameter="20"></mat-spinner>
            } @else {
              <ng-container>
                <mat-icon>fingerprint</mat-icon>
                Mit Biometrie entsperren
              </ng-container>
            }
          </button>

          <div class="divider">
            <span>oder</span>
          </div>
        </div>
      }

      <form (ngSubmit)="unlock()" class="form">
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Passwort</mat-label>
          <input matInput
                 [type]="hidePassword() ? 'password' : 'text'"
                 [(ngModel)]="password"
                 name="password"
                 required
                 autocomplete="current-password"
                 (keyup.enter)="unlock()">
          <button mat-icon-button matSuffix type="button"
                  (click)="hidePassword.set(!hidePassword())">
            <mat-icon>{{ hidePassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
          </button>
        </mat-form-field>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }

        <button mat-raised-button type="submit"
                [disabled]="loading() || !password"
                class="full-width unlock-btn"
                [color]="biometricAvailable() ? undefined : 'primary'">
          @if (loading() && !biometricLoading()) {
            <mat-spinner diameter="20"></mat-spinner>
          } @else {
            Entsperren
          }
        </button>
      </form>

      <button mat-button class="reset-link" (click)="resetVault()">
        Tresor zurücksetzen
      </button>

      <button mat-button class="add-vault-link" (click)="addVault()">
        <mat-icon>add</mat-icon>
        Neuen Tresor hinzufügen
      </button>

      @if (registry.hasMultipleVaults()) {
        <button mat-button class="switch-link" (click)="switchVault()">
          <mat-icon>swap_horiz</mat-icon>
          Anderen Tresor wählen
        </button>
      }
    </div>
  `,
  styles: [`
    .unlock-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      min-height: 100dvh;
      padding: 1rem 2rem;
      box-sizing: border-box;
      overflow-y: auto;
    }

    .unlock-hero {
      text-align: center;
      margin-bottom: 1.5rem;
    }

    .hero-logo {
      width: 80px;
      height: 80px;
      margin-bottom: 0.75rem;
      border-radius: 16px;
    }

    h2 {
      font-weight: 400;
      margin: 0 0 0.25rem 0;
      font-size: 1.4rem;
    }

    .description {
      opacity: 0.7;
      margin: 0;
      font-size: 0.9rem;
    }

    .biometric-section {
      width: 100%;
      max-width: 320px;
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-bottom: 0.25rem;
    }

    .biometric-btn {
      width: 100%;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .divider {
      display: flex;
      align-items: center;
      width: 100%;
      margin: 0.75rem 0;
      gap: 1rem;
    }

    .divider::before,
    .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--mat-sys-outline-variant);
    }

    .divider span {
      font-size: 0.8rem;
      opacity: 0.6;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .form {
      width: 100%;
      max-width: 320px;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .full-width {
      width: 100%;
    }

    .unlock-btn {
      height: 44px;
      margin-top: 0.25rem;
    }

    .error {
      color: var(--mat-sys-error);
      font-size: 0.875rem;
      margin: 0;
      text-align: center;
    }

    .reset-link {
      margin-top: 1.5rem;
      opacity: 0.6;
    }

    .add-vault-link {
      margin-top: 0.25rem;
      opacity: 0.7;
    }

    .switch-link {
      margin-top: 0.25rem;
      opacity: 0.7;
    }

    .vault-name {
      font-size: 0.9rem;
      opacity: 0.8;
      margin: 0.25rem 0 0.5rem 0;
      font-weight: 500;
    }
  `]
})
export class UnlockVaultComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly vaultService = inject(VaultService);
  protected readonly registry = inject(VaultRegistryService);
  private readonly biometricAuth = inject(BiometricAuthService);
  private readonly importScanService = inject(ImportScanService);
  private readonly thumbnailSync = inject(ThumbnailSyncService);

  password = '';
  hidePassword = signal(true);
  loading = signal(false);
  biometricLoading = signal(false);
  biometricAvailable = signal(false);
  error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const available = await this.vaultService.isBiometricAvailable();
    this.biometricAvailable.set(available);
  }

  async unlockWithBiometric(): Promise<void> {
    this.loading.set(true);
    this.biometricLoading.set(true);
    this.error.set(null);

    const success = await this.vaultService.unlockWithBiometric();

    if (success) {
      await this.postUnlock();
    } else {
      this.loading.set(false);
      this.biometricLoading.set(false);
      this.error.set(this.vaultService.error() || 'Biometrische Authentifizierung fehlgeschlagen.');
    }
  }

  async unlock(): Promise<void> {
    if (!this.password) return;

    this.loading.set(true);
    this.biometricLoading.set(false);
    this.error.set(null);

    const success = await this.vaultService.unlockVault(this.password);

    if (success) {
      await this.postUnlock();
    } else {
      this.loading.set(false);
      this.error.set(this.vaultService.error() || 'Entsperren fehlgeschlagen.');
    }
  }

  async resetVault(): Promise<void> {
    if (confirm('Tresor wirklich zurücksetzen? Deine lokalen Einstellungen werden gelöscht. Die verschlüsselten Daten bleiben in der Cloud erhalten.')) {
      await this.vaultService.reset();
      if (this.registry.hasVaults()) {
        this.router.navigate(['/setup/vault-select']);
      } else {
        this.router.navigate(['/setup/welcome']);
      }
    }
  }

  switchVault(): void {
    this.router.navigate(['/setup/vault-select']);
  }

  addVault(): void {
    sessionStorage.setItem('intimapic_adding_new_vault', 'true');
    this.router.navigate(['/setup/welcome']);
  }

  private async postUnlock(): Promise<void> {
    // Scan root for unsorted photos (from iOS Shortcuts/Cryptomator import)
    const hasUnsorted = await this.importScanService.scanRoot();

    this.loading.set(false);
    this.biometricLoading.set(false);

    if (hasUnsorted) {
      // Don't start thumbnail sync now — the import wizard will trigger it
      // after the user has finished sorting. Running it in parallel causes
      // OneDrive throttle contention (409 conflicts / blocked requests).
      this.router.navigate(['/import-wizard']);
    } else {
      // No unsorted photos — safe to start thumbnail sync in background
      this.thumbnailSync.syncAll();
      this.router.navigate(['/gallery']);
    }
  }
}
