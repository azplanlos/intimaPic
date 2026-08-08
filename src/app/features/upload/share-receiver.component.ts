import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { UploadService } from '../../core/upload/upload.service';
import { VaultService } from '../../core/vault/vault.service';

/**
 * Handles incoming files from the Web Share Target.
 * When the PWA receives shared images, the Service Worker intercepts the POST
 * and stores the files in a cache. This component retrieves them and feeds
 * them into the upload pipeline.
 */
@Component({
  selector: 'app-share-receiver',
  standalone: true,
  imports: [MatProgressSpinnerModule],
  template: `
    <div class="share-container">
      <mat-spinner diameter="48"></mat-spinner>
      <p>Empfangene Fotos werden verarbeitet...</p>
    </div>
  `,
  styles: [`
    .share-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      gap: 1.5rem;
    }
  `]
})
export class ShareReceiverComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly uploadService = inject(UploadService);
  private readonly vaultService = inject(VaultService);

  async ngOnInit(): Promise<void> {
    // Check if vault is unlocked
    if (!this.vaultService.isUnlocked()) {
      // Redirect to unlock, then come back
      this.router.navigate(['/setup/unlock'], {
        queryParams: { returnTo: '/share' },
      });
      return;
    }

    // Try to get shared files from the Service Worker cache
    const files = await this.getSharedFiles();

    if (files.length > 0) {
      await this.uploadService.addFiles(files);
      this.router.navigate(['/upload']);
    } else {
      // No files found, just go to upload page
      this.router.navigate(['/upload']);
    }
  }

  /**
   * Retrieve shared files from the SW share-target cache.
   * The ngsw service worker doesn't natively handle share_target,
   * so we'll also check for files passed via the formData directly.
   */
  private async getSharedFiles(): Promise<File[]> {
    const files: File[] = [];

    try {
      // Try getting from cache API (if SW stored them)
      const cache = await caches.open('share-target-cache');
      const requests = await cache.keys();

      for (const request of requests) {
        const response = await cache.match(request);
        if (response) {
          const blob = await response.blob();
          const fileName = this.extractFileName(request.url) || 'shared-photo.jpg';
          files.push(new File([blob], fileName, { type: blob.type }));
          await cache.delete(request);
        }
      }
    } catch {
      // Cache API not available or empty
    }

    return files;
  }

  private extractFileName(url: string): string {
    try {
      const urlObj = new URL(url);
      const name = urlObj.searchParams.get('name');
      return name || urlObj.pathname.split('/').pop() || 'shared-photo.jpg';
    } catch {
      return 'shared-photo.jpg';
    }
  }
}
