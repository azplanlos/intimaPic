import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import type { StorageProviderType } from '../../core/crypto/crypto.models';

@Component({
  selector: 'app-provider-select',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, MatIconModule],
  template: `
    <div class="provider-container">
      <h2>Speicher wählen</h2>
      <p class="description">Wo sollen deine verschlüsselten Fotos gespeichert werden?</p>

      <div class="provider-grid">
        <mat-card class="provider-card" (click)="selectProvider('onedrive')"
                  [class.selected]="selectedProvider === 'onedrive'">
          <mat-card-content>
            <mat-icon>cloud</mat-icon>
            <h3>OneDrive</h3>
            <p>Microsoft Cloud-Speicher</p>
          </mat-card-content>
        </mat-card>

        <mat-card class="provider-card" (click)="selectProvider('s3')"
                  [class.selected]="selectedProvider === 's3'">
          <mat-card-content>
            <mat-icon>dns</mat-icon>
            <h3>AWS S3</h3>
            <p>Amazon Cloud Storage</p>
          </mat-card-content>
        </mat-card>

        <mat-card class="provider-card" (click)="selectProvider('icloud')"
                  [class.selected]="selectedProvider === 'icloud'">
          <mat-card-content>
            <mat-icon>apple</mat-icon>
            <h3>iCloud Drive</h3>
            <p>Nur auf Apple-Geräten</p>
          </mat-card-content>
        </mat-card>
      </div>

      <div class="actions">
        <button mat-button (click)="goBack()">Zurück</button>
        <button mat-raised-button color="primary"
                [disabled]="!selectedProvider"
                (click)="proceed()">
          Weiter
        </button>
      </div>
    </div>
  `,
  styles: [`
    .provider-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
      max-width: 600px;
      margin: 0 auto;
    }

    h2 {
      font-weight: 400;
      margin-bottom: 0.5rem;
    }

    .description {
      opacity: 0.7;
      margin-bottom: 2rem;
    }

    .provider-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 1rem;
      width: 100%;
      margin-bottom: 2rem;
    }

    .provider-card {
      cursor: pointer;
      text-align: center;
      transition: transform 0.15s, box-shadow 0.15s;
    }

    .provider-card:hover {
      transform: translateY(-2px);
    }

    .provider-card.selected {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: 2px;
    }

    .provider-card mat-icon {
      font-size: 40px;
      width: 40px;
      height: 40px;
      margin-bottom: 0.5rem;
      color: var(--mat-sys-primary);
    }

    .provider-card h3 {
      margin: 0.5rem 0 0.25rem;
      font-weight: 500;
    }

    .provider-card p {
      font-size: 0.85rem;
      opacity: 0.6;
      margin: 0;
    }

    .actions {
      display: flex;
      gap: 1rem;
      justify-content: flex-end;
      width: 100%;
    }
  `]
})
export class ProviderSelectComponent {
  private readonly router = inject(Router);

  selectedProvider: StorageProviderType | null = null;

  selectProvider(provider: StorageProviderType): void {
    this.selectedProvider = provider;
  }

  proceed(): void {
    if (this.selectedProvider) {
      // Store the selected provider in session and navigate to provider config
      sessionStorage.setItem('intimapic_selected_provider', this.selectedProvider);
      this.router.navigate(['/setup/provider-config']);
    }
  }

  goBack(): void {
    this.router.navigate(['/setup/welcome']);
  }
}
