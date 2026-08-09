import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { VaultService } from '../core/vault/vault.service';
import { ToolbarService } from './toolbar.service';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [
    RouterOutlet,
    MatToolbarModule,
    MatIconModule,
    MatButtonModule,
    MatMenuModule,
  ],
  template: `
    <mat-toolbar class="app-toolbar">
      @if (toolbar.title()) {
        <button mat-icon-button (click)="toolbar.backAction()?.()">
          <mat-icon>arrow_back</mat-icon>
        </button>
        <span class="toolbar-title">{{ toolbar.title() }}</span>
      } @else {
        <img src="assets/app-icon-small.png" alt="IntimaPic" class="toolbar-logo">
        <span class="toolbar-title">IntimaPic</span>
      }
      <span class="spacer"></span>
      @for (action of toolbar.actions(); track action.icon) {
        <button mat-icon-button (click)="action.callback()" [attr.aria-label]="action.label">
          <mat-icon>{{ action.icon }}</mat-icon>
        </button>
      }
      <button mat-icon-button [matMenuTriggerFor]="appMenu" aria-label="Menü">
        <mat-icon>more_vert</mat-icon>
      </button>
      <mat-menu #appMenu="matMenu">
        <button mat-menu-item (click)="openBiometricSettings()">
          <mat-icon>fingerprint</mat-icon>
          <span>Biometrie verwalten</span>
        </button>
        <button mat-menu-item (click)="lock()">
          <mat-icon>lock</mat-icon>
          <span>Tresor sperren</span>
        </button>
      </mat-menu>
    </mat-toolbar>

    <div class="shell-content">
      <router-outlet></router-outlet>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    .app-toolbar {
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .toolbar-logo {
      width: 32px;
      height: 32px;
      border-radius: 6px;
    }

    .toolbar-title {
      margin-left: 0.5rem;
      font-weight: 400;
    }

    .spacer {
      flex: 1;
    }

    .shell-content {
      flex: 1;
      overflow-y: auto;
    }
  `]
})
export class AppShellComponent {
  protected readonly toolbar = inject(ToolbarService);
  private readonly router = inject(Router);
  private readonly vaultService = inject(VaultService);

  async lock(): Promise<void> {
    await this.vaultService.lockVault();
    this.router.navigate(['/setup/unlock']);
  }

  openBiometricSettings(): void {
    this.router.navigate(['/settings/biometric']);
  }
}
