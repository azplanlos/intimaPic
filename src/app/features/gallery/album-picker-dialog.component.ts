import { Component, inject, signal, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AlbumService, type Album } from '../../core/album/album.service';

export interface AlbumPickerDialogData {
  /** The directory ID of the current album (to exclude from the list) */
  excludeDirectoryId: string;
  /** Title shown at the top of the dialog */
  title?: string;
}

export interface AlbumPickerDialogResult {
  /** The selected target album */
  album: Album;
}

@Component({
  selector: 'app-album-picker-dialog',
  standalone: true,
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatListModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ title }}</h2>

    <mat-dialog-content>
      @if (loading()) {
        <div class="loading">
          <mat-spinner diameter="32"></mat-spinner>
          <p>Alben werden geladen...</p>
        </div>
      } @else if (albums().length === 0) {
        <div class="empty">
          <mat-icon>photo_album</mat-icon>
          <p>Keine anderen Alben vorhanden.</p>
        </div>
      } @else {
        <mat-selection-list [multiple]="false">
          @for (album of albums(); track album.directoryId) {
            <mat-list-option [value]="album" (click)="onAlbumClicked(album)">
              <mat-icon matListItemIcon>photo_album</mat-icon>
              <span matListItemTitle>{{ album.name }}</span>
            </mat-list-option>
          }
        </mat-selection-list>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Abbrechen</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 280px;
      max-height: 60vh;
    }

    .loading, .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      gap: 0.75rem;
    }

    .empty mat-icon {
      font-size: 48px;
      width: 48px;
      height: 48px;
      opacity: 0.5;
    }
  `]
})
export class AlbumPickerDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<AlbumPickerDialogComponent, AlbumPickerDialogResult>);
  private readonly data: AlbumPickerDialogData = inject(MAT_DIALOG_DATA);
  private readonly albumService = inject(AlbumService);

  readonly title: string;
  readonly loading = signal(true);
  readonly albums = signal<Album[]>([]);

  constructor() {
    this.title = this.data.title ?? 'Foto verschieben nach…';
  }

  async ngOnInit(): Promise<void> {
    try {
      const allAlbums = await this.albumService.loadAlbums();
      // Exclude the current album from the list
      const filtered = allAlbums.filter(a => a.directoryId !== this.data.excludeDirectoryId);
      this.albums.set(filtered);
    } catch (err) {
      console.error('Failed to load albums:', err);
    } finally {
      this.loading.set(false);
    }
  }

  onAlbumClicked(album: Album): void {
    this.dialogRef.close({ album });
  }

  onCancel(): void {
    this.dialogRef.close(undefined);
  }
}
