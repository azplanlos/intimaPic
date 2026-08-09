import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatMenuModule } from '@angular/material/menu';
import { VaultRegistryService } from '../../core/vault/vault-registry.service';
import type { VaultInfo } from '../../core/vault/vault-registry.models';

@Component({
  selector: 'app-vault-select',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatMenuModule,
  ],
  template: `
    <div class="vault-select-container">
      <div class="header">
        <img src="assets/app-logo.png" alt="IntimaPic Logo" class="hero-logo">
        <h2>Tresor auswählen</h2>
        <p class="description">Wähle einen Tresor zum Entsperren.</p>
      </div>

      <div class="vault-list">
        @for (vault of registry.vaults(); track vault.id) {
          <mat-card class="vault-card" (click)="selectVault(vault)" tabindex="0"
                    (keyup.enter)="selectVault(vault)"
                    [attr.aria-label]="'Tresor ' + vault.name + ' öffnen'">
            <mat-card-content class="vault-card-content">
              <mat-icon class="provider-icon">{{ getProviderIcon(vault) }}</mat-icon>
              <div class="vault-info">
                <span class="vault-name">{{ vault.name }}</span>
                <span class="vault-provider">{{ getProviderLabel(vault) }}</span>
              </div>
              <button mat-icon-button class="vault-menu-btn"
                      [matMenuTriggerFor]="vaultMenu"
                      (click)="$event.stopPropagation()"
                      aria-label="Tresor-Optionen">
                <mat-icon>more_vert</mat-icon>
              </button>
              <mat-menu #vaultMenu="matMenu">
                <button mat-menu-item (click)="renameVault(vault)">
                  <mat-icon>edit</mat-icon>
                  <span>Umbenennen</span>
                </button>
                <button mat-menu-item (click)="removeVault(vault)">
                  <mat-icon>delete</mat-icon>
                  <span>Tresor entfernen</span>
                </button>
              </mat-menu>
            </mat-card-content>
          </mat-card>
        }
      </div>

      <button mat-stroked-button class="add-vault-btn" (click)="addVault()">
        <mat-icon>add</mat-icon>
        Neuen Tresor hinzufügen
      </button>
    </div>
  `,
  styles: [`
    .vault-select-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      min-height: 100dvh;
      padding: 2rem;
      box-sizing: border-box;
    }

    .header {
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
      margin: 0 0 0.5rem 0;
    }

    .description {
      opacity: 0.7;
      margin: 0;
    }

    .vault-list {
      width: 100%;
      max-width: 400px;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }

    .vault-card {
      cursor: pointer;
      transition: box-shadow 0.2s ease, transform 0.1s ease;
    }

    .vault-card:hover {
      box-shadow: var(--mat-sys-level2);
      transform: translateY(-1px);
    }

    .vault-card:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: 2px;
    }

    .vault-card-content {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.5rem 0;
    }

    .provider-icon {
      color: var(--mat-sys-primary);
      font-size: 28px;
      width: 28px;
      height: 28px;
    }

    .vault-info {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }

    .vault-name {
      font-weight: 500;
      font-size: 1rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .vault-provider {
      font-size: 0.8rem;
      opacity: 0.6;
    }

    .vault-menu-btn {
      flex-shrink: 0;
    }

    .add-vault-btn {
      max-width: 400px;
      width: 100%;
      height: 48px;
    }
  `]
})
export class VaultSelectComponent {
  protected readonly registry = inject(VaultRegistryService);
  private readonly router = inject(Router);

  selectVault(vault: VaultInfo): void {
    this.registry.setActiveVault(vault.id);
    this.router.navigate(['/setup/unlock']);
  }

  addVault(): void {
    sessionStorage.setItem('intimapic_adding_new_vault', 'true');
    this.router.navigate(['/setup/welcome']);
  }

  removeVault(vault: VaultInfo): void {
    const confirmMsg = `Tresor "${vault.name}" wirklich entfernen? Die verschlüsselten Daten bleiben in der Cloud erhalten.`;
    if (confirm(confirmMsg)) {
      this.registry.removeVault(vault.id);

      // If no vaults left, go to welcome
      if (!this.registry.hasVaults()) {
        this.router.navigate(['/setup/welcome']);
      }
    }
  }

  renameVault(vault: VaultInfo): void {
    const newName = prompt('Neuer Tresorname:', vault.name);
    if (newName && newName.trim() && newName.trim() !== vault.name) {
      this.registry.renameVault(vault.id, newName.trim());
    }
  }

  getProviderIcon(vault: VaultInfo): string {
    switch (vault.storageSettings.provider) {
      case 'onedrive': return 'cloud';
      case 's3': return 'dns';
      case 'icloud': return 'smartphone';
      default: return 'folder';
    }
  }

  getProviderLabel(vault: VaultInfo): string {
    switch (vault.storageSettings.provider) {
      case 'onedrive': return 'OneDrive';
      case 's3': return 'S3-kompatibel';
      case 'icloud': return 'iCloud Drive';
      default: return 'Unbekannt';
    }
  }
}
