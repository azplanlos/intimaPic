import { Component, inject, signal, OnInit, OnDestroy, computed } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatCardModule } from '@angular/material/card';
import { ImportScanService, type UnsortedPhoto } from '../../core/album/import-scan.service';
import { AlbumService, type Album } from '../../core/album/album.service';
import { PhotoService } from '../../core/album/photo.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { VaultService } from '../../core/vault/vault.service';
import { ThumbnailSyncService } from '../../core/upload/thumbnail-sync.service';
import { HeicConverterService } from '../../core/upload/heic-converter.service';
import { ToolbarService } from '../../shared/toolbar.service';
import { getMimeType } from '../../core/image-types';

@Component({
  selector: 'app-import-wizard',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatProgressBarModule,
    MatFormFieldModule,
    MatInputModule,
    MatListModule,
    MatCardModule,
  ],
  template: `
    <div class="wizard-container">
      @if (loading()) {
        <div class="loading">
          <mat-spinner diameter="40"></mat-spinner>
          <p>Unsortierte Fotos werden geladen...</p>
        </div>
      } @else if (allDone()) {
        <div class="done-state">
          <mat-icon class="done-icon">check_circle</mat-icon>
          <h2>Alle Fotos einsortiert!</h2>
          <p>{{ processedCount() }} Fotos wurden in Alben verschoben.</p>
          <button mat-raised-button color="primary" (click)="finish()">
            <mat-icon>photo_library</mat-icon>
            Zur Galerie
          </button>
        </div>
      } @else if (currentPhoto()) {
        <!-- Progress indicator -->
        <div class="progress-header">
          <span class="progress-text">
            Foto {{ processedCount() + 1 }} von {{ totalPhotos() }}
          </span>
          <mat-progress-bar
            mode="determinate"
            [value]="progressPercent()">
          </mat-progress-bar>
        </div>

        <!-- Current photo preview -->
        <div class="photo-preview">
          @if (previewUrl()) {
            <img [src]="previewUrl()" [alt]="currentPhoto()!.name" class="preview-image">
          } @else if (previewError()) {
            <div class="preview-placeholder preview-error">
              <mat-icon>broken_image</mat-icon>
              <p>{{ previewError() }}</p>
            </div>
          } @else {
            <div class="preview-placeholder">
              <mat-spinner diameter="32"></mat-spinner>
              <p>Vorschau wird geladen...</p>
            </div>
          }
          <p class="filename">{{ currentPhoto()!.name }}</p>
          @if (!currentPhoto()!.isEncrypted) {
            <span class="unencrypted-badge">
              <mat-icon>lock_open</mat-icon> Unverschlüsselt
            </span>
          }
        </div>

        <!-- Album selection -->
        <div class="album-selection">
          <h3>In welches Album verschieben?</h3>

          @if (albums().length > 0) {
            <mat-selection-list [multiple]="false" class="album-list">
              @for (album of albums(); track album.directoryId) {
                <mat-list-option
                  [value]="album.directoryId"
                  (click)="selectAlbum(album)"
                  [selected]="selectedAlbum()?.directoryId === album.directoryId">
                  <mat-icon matListItemIcon>folder</mat-icon>
                  <span matListItemTitle>{{ album.name }}</span>
                </mat-list-option>
              }
            </mat-selection-list>
          }

          <!-- Create new album inline -->
          @if (showNewAlbumForm()) {
            <div class="new-album-form">
              <mat-form-field appearance="outline" class="full-width">
                <mat-label>Neues Album</mat-label>
                <input matInput
                       [(ngModel)]="newAlbumName"
                       (keyup.enter)="createAndAssign()"
                       placeholder="z.B. Urlaub 2024">
              </mat-form-field>
              <div class="form-actions">
                <button mat-button (click)="showNewAlbumForm.set(false)">Abbrechen</button>
                <button mat-raised-button color="primary"
                        [disabled]="!newAlbumName || processing()"
                        (click)="createAndAssign()">
                  Erstellen & Zuweisen
                </button>
              </div>
            </div>
          } @else {
            <button mat-stroked-button (click)="showNewAlbumForm.set(true)" class="new-album-btn">
              <mat-icon>create_new_folder</mat-icon>
              Neues Album erstellen
            </button>
          }

          <!-- Action buttons -->
          <div class="actions">
            <button mat-button
                    (click)="skipPhoto()"
                    [disabled]="processing()">
              Überspringen
            </button>
            <button mat-raised-button
                    color="primary"
                    (click)="assignToSelected()"
                    [disabled]="!selectedAlbum() || processing()">
              @if (processing()) {
                <mat-spinner diameter="18"></mat-spinner>
              } @else {
                <ng-container>
                  <mat-icon>drive_file_move</mat-icon>
                  Verschieben
                </ng-container>
              }
            </button>
          </div>
        </div>
      } @else {
        <!-- No unsorted photos -->
        <div class="empty-state">
          <mat-icon class="empty-icon">check_circle</mat-icon>
          <p>Keine unsortierten Fotos vorhanden.</p>
          <button mat-raised-button color="primary" (click)="finish()">
            Zur Galerie
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .wizard-container {
      display: flex;
      flex-direction: column;
      padding: 1rem;
      max-width: 600px;
      margin: 0 auto;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    .loading, .done-state, .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem 1rem;
      gap: 1rem;
      text-align: center;
      flex: 1;
    }

    .done-icon, .empty-icon {
      font-size: 64px;
      width: 64px;
      height: 64px;
      color: var(--mat-sys-primary);
    }

    .progress-header {
      flex-shrink: 0;
      margin-bottom: 0.5rem;
    }
    .progress-text {
      display: block;
      font-size: 0.85rem;
      opacity: 0.7;
      margin-bottom: 0.5rem;
    }

    .photo-preview {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      margin-bottom: 0.75rem;
    }

    .preview-image {
      max-width: 100%;
      max-height: 100%;
      min-height: 0;
      border-radius: 12px;
      object-fit: contain;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }

    .preview-placeholder {
      width: 100%;
      flex: 1;
      min-height: 80px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      background: color-mix(in srgb, var(--mat-sys-surface-variant) 30%, transparent);
      border-radius: 12px;
    }

    .preview-error mat-icon {
      font-size: 48px;
      width: 48px;
      height: 48px;
      opacity: 0.5;
    }

    .filename {
      margin-top: 0.25rem;
      font-size: 0.85rem;
      opacity: 0.7;
      word-break: break-all;
      flex-shrink: 0;
    }

    .unencrypted-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      margin-top: 0.25rem;
      padding: 0.2rem 0.6rem;
      font-size: 0.75rem;
      border-radius: 12px;
      background: color-mix(in srgb, var(--mat-sys-tertiary) 15%, transparent);
      color: var(--mat-sys-tertiary);
    }
    .unencrypted-badge mat-icon {
      font-size: 14px;
      width: 14px;
      height: 14px;
    }

    .album-selection h3 {
      font-weight: 400;
      margin: 0 0 0.5rem;
    }

    .album-selection {
      flex-shrink: 0;
    }

    .album-list {
      max-height: 200px;
      overflow-y: auto;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--mat-sys-outline) 30%, transparent);
      margin-bottom: 1rem;
    }

    .new-album-btn {
      width: 100%;
      margin-bottom: 1rem;
    }

    .new-album-form {
      padding: 1rem;
      border-radius: 12px;
      background: color-mix(in srgb, var(--mat-sys-surface-variant) 20%, transparent);
      margin-bottom: 1rem;
    }
    .full-width { width: 100%; }
    .form-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }

    .actions {
      display: flex;
      gap: 0.75rem;
      justify-content: flex-end;
      margin-top: 1rem;
    }

    .actions button mat-icon {
      vertical-align: middle;
      margin-right: 0.25rem;
    }
  `]
})
export class ImportWizardComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly toolbar = inject(ToolbarService);
  private readonly importScanService = inject(ImportScanService);
  private readonly albumService = inject(AlbumService);
  private readonly photoService = inject(PhotoService);
  private readonly crypto = inject(CryptoService);
  private readonly vaultService = inject(VaultService);
  private readonly thumbnailSync = inject(ThumbnailSyncService);
  private readonly heicConverter = inject(HeicConverterService);

  readonly albums = this.albumService.albums;
  readonly loading = signal(true);
  readonly processing = signal(false);
  readonly currentIndex = signal(0);
  readonly previewUrl = signal<string | null>(null);
  readonly previewError = signal<string | null>(null);
  readonly selectedAlbum = signal<Album | null>(null);
  readonly showNewAlbumForm = signal(false);
  readonly processedCount = signal(0);
  newAlbumName = '';

  private unsortedPhotos = signal<UnsortedPhoto[]>([]);

  readonly totalPhotos = signal(0);
  readonly currentPhoto = computed(() => {
    const idx = this.currentIndex();
    const photos = this.unsortedPhotos();
    return idx < photos.length ? photos[idx] : null;
  });
  readonly allDone = computed(() =>
    !this.loading() && this.processedCount() > 0 && !this.currentPhoto()
  );
  readonly progressPercent = computed(() => {
    const total = this.totalPhotos();
    if (total === 0) return 0;
    return Math.round((this.processedCount() / total) * 100);
  });

  async ngOnInit(): Promise<void> {
    this.toolbar.set({
      title: 'Fotos einsortieren',
      backAction: () => this.skipAll(),
      actions: [{ icon: 'close', label: 'Schließen', callback: () => this.skipAll() }],
    });

    try {
      // Load albums for selection
      await this.albumService.loadAlbums();

      // Get the unsorted photos (already scanned before navigation)
      this.unsortedPhotos.set(this.importScanService.unsortedPhotos());
      this.totalPhotos.set(this.unsortedPhotos().length);

      if (this.unsortedPhotos().length > 0) {
        await this.loadPreview();
      }
    } catch (err) {
      console.error('[ImportWizard] Init error:', err);
    } finally {
      this.loading.set(false);
    }
  }

  ngOnDestroy(): void {
    this.toolbar.reset();
  }

  /**
   * Load a preview of the current photo.
   * For encrypted files: decrypt first. For unencrypted: display directly.
   * HEIC/HEIF files are converted to JPEG for browser display.
   */
  private async loadPreview(): Promise<void> {
    const photo = this.currentPhoto();
    if (!photo) return;

    this.previewUrl.set(null);
    this.previewError.set(null);

    try {
      const storage = this.vaultService.getStorage();
      const rawData = await storage.readFile(photo.storagePath);

      let imageData: ArrayBuffer;
      if (photo.isEncrypted) {
        imageData = await this.crypto.decryptFile(rawData);
      } else {
        // Unencrypted photo — use directly
        imageData = rawData;
      }

      const mimeType = getMimeType(photo.name);
      const blob = new Blob([imageData], { type: mimeType });

      // Convert HEIC/HEIF to JPEG for browsers without native support
      let displayBlob: Blob;
      if (this.heicConverter.isHeic(photo.name)) {
        try {
          displayBlob = await this.heicConverter.convertToJpeg(blob);
        } catch (heicErr) {
          console.warn('[ImportWizard] HEIC conversion failed, trying raw display:', heicErr);
          // Fallback: attempt to display the raw HEIC blob (works on Safari/iOS)
          displayBlob = blob;
        }
      } else {
        displayBlob = blob;
      }

      const url = URL.createObjectURL(displayBlob);
      this.previewUrl.set(url);
    } catch (err) {
      console.warn('[ImportWizard] Failed to load preview:', err);
      this.previewError.set('Vorschau konnte nicht geladen werden');
    }
  }

  selectAlbum(album: Album): void {
    this.selectedAlbum.set(album);
  }

  /**
   * Move the current photo to the selected album.
   */
  async assignToSelected(): Promise<void> {
    const album = this.selectedAlbum();
    const photo = this.currentPhoto();
    if (!album || !photo) return;

    this.processing.set(true);
    try {
      await this.importScanService.moveToAlbum(photo, album.directoryId);
      this.processedCount.update(c => c + 1);
      this.advanceToNext();
    } catch (err) {
      console.error('[ImportWizard] Move failed:', err);
    } finally {
      this.processing.set(false);
    }
  }

  /**
   * Create a new album and immediately assign the current photo to it.
   */
  async createAndAssign(): Promise<void> {
    if (!this.newAlbumName.trim()) return;

    this.processing.set(true);
    try {
      const album = await this.albumService.createAlbum(this.newAlbumName.trim());
      this.newAlbumName = '';
      this.showNewAlbumForm.set(false);

      const photo = this.currentPhoto();
      if (photo) {
        await this.importScanService.moveToAlbum(photo, album.directoryId);
        this.processedCount.update(c => c + 1);
        this.advanceToNext();
      }
    } catch (err) {
      console.error('[ImportWizard] Create & assign failed:', err);
    } finally {
      this.processing.set(false);
    }
  }

  /**
   * Skip the current photo (leave in root).
   */
  skipPhoto(): void {
    // Revoke old preview URL
    const url = this.previewUrl();
    if (url) URL.revokeObjectURL(url);

    this.selectedAlbum.set(null);
    this.showNewAlbumForm.set(false);
    this.previewError.set(null);

    // Photo stays in array, so advance past it
    this.currentIndex.update(i => i + 1);

    // Load next preview
    if (this.currentPhoto()) {
      this.loadPreview();
    }
  }

  /**
   * Skip all remaining photos and go to gallery.
   */
  skipAll(): void {
    this.finish();
  }

  /**
   * All done – run thumbnail sync and navigate to gallery.
   */
  async finish(): Promise<void> {
    // Revoke any active preview URL
    const url = this.previewUrl();
    if (url) URL.revokeObjectURL(url);

    // Trigger thumbnail sync for newly moved photos (runs in background)
    this.thumbnailSync.syncAll();

    this.router.navigate(['/gallery']);
  }

  private advanceToNext(): void {
    // Revoke old preview URL
    const url = this.previewUrl();
    if (url) URL.revokeObjectURL(url);

    this.selectedAlbum.set(null);
    this.showNewAlbumForm.set(false);
    this.previewError.set(null);

    // Re-read the (now smaller) array from the service signal.
    // The moved photo was already removed, so index 0 is the next photo.
    this.unsortedPhotos.set(this.importScanService.unsortedPhotos());
    this.currentIndex.set(0);

    // Update totalPhotos to stay consistent: processed + remaining
    this.totalPhotos.set(this.processedCount() + this.unsortedPhotos().length);

    // Load next preview
    if (this.currentPhoto()) {
      this.loadPreview();
    }
  }
}
