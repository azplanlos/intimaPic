import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatListModule } from '@angular/material/list';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatMenuModule } from '@angular/material/menu';
import { MatFabButton } from '@angular/material/button';
import { VaultService } from '../../core/vault/vault.service';
import { AlbumService, type Album } from '../../core/album/album.service';

@Component({
  selector: 'app-gallery',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatToolbarModule,
    MatListModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatMenuModule,
  ],
  template: `
    <mat-toolbar color="primary">
      <mat-icon>photo_library</mat-icon>
      <span class="toolbar-title">IntimaPic</span>
      <span class="spacer"></span>
      <button mat-icon-button [matMenuTriggerFor]="settingsMenu" aria-label="Menü">
        <mat-icon>more_vert</mat-icon>
      </button>
      <mat-menu #settingsMenu="matMenu">
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

    <div class="gallery-container">
      @if (loading()) {
        <div class="loading">
          <mat-spinner diameter="40"></mat-spinner>
          <p>Alben laden...</p>
        </div>
      } @else {
        <div class="section-header">
          <h2>Alben</h2>
        </div>

        @if (albums().length === 0) {
          <div class="empty-state">
            <mat-icon class="empty-icon">photo_album</mat-icon>
            <p>Noch keine Alben vorhanden.</p>
            <p class="hint">Erstelle ein Album um Fotos hochzuladen.</p>
          </div>
        } @else {
          <div class="album-grid">
            @for (album of albums(); track album.directoryId) {
              <div class="album-card" (click)="openAlbum(album)">
                <mat-icon class="album-icon">folder</mat-icon>
                <span class="album-name">{{ album.name }}</span>
              </div>
            }
          </div>
        }

        <!-- Create Album Section -->
        <div class="create-section">
          @if (showCreateForm()) {
            <div class="create-form">
              <mat-form-field appearance="outline" class="full-width">
                <mat-label>Albumname</mat-label>
                <input matInput
                       [(ngModel)]="newAlbumName"
                       (keyup.enter)="createAlbum()"
                       placeholder="z.B. Urlaub 2024">
              </mat-form-field>
              <div class="form-actions">
                <button mat-button (click)="showCreateForm.set(false)">Abbrechen</button>
                <button mat-raised-button color="primary"
                        [disabled]="!newAlbumName || creating()"
                        (click)="createAlbum()">
                  @if (creating()) {
                    <mat-spinner diameter="18"></mat-spinner>
                  } @else {
                    Erstellen
                  }
                </button>
              </div>
            </div>
          } @else {
            <button mat-raised-button color="primary" (click)="showCreateForm.set(true)">
              <mat-icon>create_new_folder</mat-icon>
              Neues Album
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .toolbar-title {
      margin-left: 0.5rem;
      font-weight: 400;
    }
    .spacer { flex: 1; }

    .gallery-container {
      padding: 1.5rem;
      max-width: 700px;
      margin: 0 auto;
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem;
      gap: 1rem;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .section-header h2 { font-weight: 400; margin: 0; }

    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      opacity: 0.7;
    }
    .empty-icon {
      font-size: 56px;
      width: 56px;
      height: 56px;
      margin-bottom: 1rem;
    }
    .hint { font-size: 0.85rem; opacity: 0.6; }

    .album-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .album-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 1.5rem 1rem;
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.15s;
      background: color-mix(in srgb, var(--mat-sys-surface-variant) 30%, transparent);
    }
    .album-card:hover {
      background: color-mix(in srgb, var(--mat-sys-surface-variant) 60%, transparent);
    }
    .album-icon {
      font-size: 40px;
      width: 40px;
      height: 40px;
      color: var(--mat-sys-primary);
      margin-bottom: 0.5rem;
    }
    .album-name {
      font-size: 0.9rem;
      text-align: center;
      word-break: break-word;
    }

    .create-section {
      margin-top: 1.5rem;
    }
    .create-form {
      padding: 1rem;
      border-radius: 12px;
      background: color-mix(in srgb, var(--mat-sys-surface-variant) 20%, transparent);
    }
    .full-width { width: 100%; }
    .form-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }
  `]
})
export class GalleryPlaceholderComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly vaultService = inject(VaultService);
  private readonly albumService = inject(AlbumService);

  albums = this.albumService.albums;
  loading = signal(true);
  creating = signal(false);
  showCreateForm = signal(false);
  newAlbumName = '';

  async ngOnInit(): Promise<void> {
    try {
      await this.albumService.loadAlbums();
    } catch (err) {
      console.error('Failed to load albums:', err);
    } finally {
      this.loading.set(false);
    }
  }

  async createAlbum(): Promise<void> {
    if (!this.newAlbumName.trim()) return;

    this.creating.set(true);
    try {
      await this.albumService.createAlbum(this.newAlbumName.trim());
      this.newAlbumName = '';
      this.showCreateForm.set(false);
    } catch (err) {
      console.error('Failed to create album:', err);
    } finally {
      this.creating.set(false);
    }
  }

  openAlbum(album: Album): void {
    this.router.navigate(['/album', album.directoryId], {
      queryParams: { name: album.name }
    });
  }

  async lock(): Promise<void> {
    await this.vaultService.lockVault();
    this.router.navigate(['/setup/unlock']);
  }

  openBiometricSettings(): void {
    this.router.navigate(['/settings/biometric']);
  }
}
