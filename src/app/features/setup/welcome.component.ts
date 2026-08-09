import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { VaultService } from '../../core/vault/vault.service';

@Component({
  selector: 'app-welcome',
  standalone: true,
  imports: [MatButtonModule, MatIconModule],
  template: `
    <div class="welcome-container">
      <div class="welcome-hero">
        <img src="assets/app-logo.png" alt="IntimaPic Logo" class="hero-logo">
        <p class="subtitle">Deine Fotos. Ende-zu-Ende verschlüsselt.</p>
      </div>

      <div class="welcome-actions">
        <button mat-raised-button color="primary" (click)="createNew()">
          <mat-icon>add_circle</mat-icon>
          Neuen Tresor erstellen
        </button>

        <button mat-stroked-button (click)="connectExisting()">
          <mat-icon>login</mat-icon>
          Bestehenden Tresor verbinden
        </button>
      </div>

      <p class="footer-note">
        Dein Verschlüsselungsschlüssel verlässt niemals dieses Gerät.
      </p>
    </div>
  `,
  styles: [`
    .welcome-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
      text-align: center;
    }

    .welcome-hero {
      margin-bottom: 3rem;
    }

    .hero-logo {
      width: 180px;
      height: 180px;
      margin-bottom: 1.5rem;
      border-radius: 24px;
    }

    h1 {
      font-size: 2.5rem;
      font-weight: 300;
      margin: 0 0 0.5rem 0;
    }

    .subtitle {
      font-size: 1.1rem;
      opacity: 0.7;
      margin: 0;
    }

    .welcome-actions {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      width: 100%;
      max-width: 320px;
    }

    .welcome-actions button {
      height: 48px;
      font-size: 1rem;
    }

    .footer-note {
      margin-top: 3rem;
      font-size: 0.85rem;
      opacity: 0.5;
      max-width: 300px;
    }
  `]
})
export class WelcomeComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly vaultService = inject(VaultService);

  ngOnInit(): void {
    // If vault already exists, redirect to unlock
    if (this.vaultService.status() === 'locked') {
      this.router.navigate(['/setup/unlock']);
    }
  }

  createNew(): void {
    sessionStorage.setItem('intimapic_setup_mode', 'create');
    this.router.navigate(['/setup/provider']);
  }

  connectExisting(): void {
    sessionStorage.setItem('intimapic_setup_mode', 'connect');
    this.router.navigate(['/setup/provider']);
  }
}
