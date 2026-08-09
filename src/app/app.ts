import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';
import { VaultService } from './core/vault/vault.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  private readonly vaultService = inject(VaultService);
  private readonly router = inject(Router);

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && this.vaultService.isUnlocked()) {
      this.lockAndRedirect();
    }
  };

  private readonly onPageHide = (): void => {
    if (this.vaultService.isUnlocked()) {
      this.lockAndRedirect();
    }
  };

  async ngOnInit(): Promise<void> {
    await this.vaultService.initialize();

    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
  }

  private lockAndRedirect(): void {
    this.vaultService.lockVault().then(() => {
      this.router.navigate(['/setup/unlock']);
    });
  }
}
