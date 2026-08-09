import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatListModule } from '@angular/material/list';
import { UploadService, type UploadProgress } from '../../core/upload/upload.service';
import { ToolbarService } from '../../shared/toolbar.service';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatListModule,
  ],
  template: `
    <div class="upload-container">
      <!-- Drop Zone -->
      <div class="drop-zone"
           [class.dragging]="isDragging()"
           (dragover)="onDragOver($event)"
           (dragleave)="onDragLeave($event)"
           (drop)="onDrop($event)"
           (click)="fileInput.click()">
        <mat-icon class="upload-icon">cloud_upload</mat-icon>
        <p class="drop-text">Fotos hierher ziehen oder tippen zum Auswählen</p>
        <p class="drop-hint">JPEG, PNG, HEIC, WebP</p>
        <input #fileInput type="file"
               accept="image/jpeg,image/png,image/heic,image/webp"
               multiple
               hidden
               (change)="onFilesSelected($event)">
      </div>

      <!-- Upload Progress List -->
      @if (uploads().length > 0) {
        <div class="upload-list">
          <div class="list-header">
            <h3>Uploads ({{ uploads().length }})</h3>
            @if (hasDone()) {
              <button mat-button (click)="clearCompleted()">Fertige entfernen</button>
            }
          </div>

          @for (upload of uploads(); track upload.id) {
            <div class="upload-item" [class.error]="upload.step === 'error'">
              <div class="upload-info">
                <mat-icon class="status-icon">{{ getStepIcon(upload.step) }}</mat-icon>
                <div class="upload-details">
                  <span class="file-name">{{ upload.fileName }}</span>
                  <span class="step-label">{{ getStepLabel(upload.step) }}</span>
                </div>
              </div>
              @if (upload.step !== 'done' && upload.step !== 'error') {
                <mat-progress-bar mode="determinate"
                                  [value]="upload.progress">
                </mat-progress-bar>
              }
              @if (upload.error) {
                <span class="error-text">{{ upload.error }}</span>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .upload-container {
      padding: 1.5rem;
      max-width: 600px;
      margin: 0 auto;
    }

    .drop-zone {
      border: 2px dashed var(--mat-sys-outline);
      border-radius: 16px;
      padding: 3rem 2rem;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s, background-color 0.2s;
    }

    .drop-zone:hover,
    .drop-zone.dragging {
      border-color: var(--mat-sys-primary);
      background: color-mix(in srgb, var(--mat-sys-primary) 5%, transparent);
    }

    .upload-icon {
      font-size: 56px;
      width: 56px;
      height: 56px;
      color: var(--mat-sys-primary);
      opacity: 0.7;
    }

    .drop-text {
      font-size: 1.1rem;
      margin: 1rem 0 0.25rem;
    }

    .drop-hint {
      font-size: 0.85rem;
      opacity: 0.5;
    }

    .upload-list {
      margin-top: 2rem;
    }

    .list-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }

    .list-header h3 {
      font-weight: 400;
      margin: 0;
    }

    .upload-item {
      padding: 0.75rem;
      border-radius: 8px;
      margin-bottom: 0.5rem;
      background: color-mix(in srgb, var(--mat-sys-surface-variant) 30%, transparent);
    }

    .upload-item.error {
      background: color-mix(in srgb, var(--mat-sys-error) 8%, transparent);
    }

    .upload-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }

    .status-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }

    .upload-details {
      display: flex;
      flex-direction: column;
    }

    .file-name {
      font-size: 0.9rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }

    .step-label {
      font-size: 0.8rem;
      opacity: 0.6;
    }

    .error-text {
      font-size: 0.8rem;
      color: var(--mat-sys-error);
      display: block;
      margin-top: 0.25rem;
    }
  `]
})
export class UploadComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly uploadService = inject(UploadService);
  private readonly toolbar = inject(ToolbarService);

  uploads = this.uploadService.activeUploads;
  isDragging = signal(false);
  albumId = signal('');
  albumName = signal('');

  ngOnInit(): void {
    this.route.queryParams.subscribe(params => {
      this.albumId.set(params['albumId'] || '');
      this.albumName.set(params['albumName'] || '');
      this.toolbar.set({
        title: params['albumName'] || 'Fotos hochladen',
        backAction: () => this.goBack(),
      });
    });
  }

  ngOnDestroy(): void {
    this.toolbar.reset();
  }

  hasDone(): boolean {
    return this.uploads().some(u => u.step === 'done');
  }

  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.uploadFiles(Array.from(input.files));
      input.value = ''; // Reset so same file can be selected again
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const imageFiles = Array.from(files).filter(f =>
        f.type.startsWith('image/')
      );
      if (imageFiles.length > 0) {
        this.uploadFiles(imageFiles);
      }
    }
  }

  async clearCompleted(): Promise<void> {
    // Remove done items from the active uploads display
    // The queue service handles IndexedDB cleanup
  }

  goBack(): void {
    this.router.navigate(['/gallery']);
  }

  getStepIcon(step: UploadProgress['step']): string {
    switch (step) {
      case 'queued': return 'hourglass_empty';
      case 'thumbnail': return 'image';
      case 'encrypting': return 'lock';
      case 'uploading': return 'cloud_upload';
      case 'done': return 'check_circle';
      case 'error': return 'error';
    }
  }

  getStepLabel(step: UploadProgress['step']): string {
    switch (step) {
      case 'queued': return 'In Warteschlange...';
      case 'thumbnail': return 'Thumbnail erzeugen...';
      case 'encrypting': return 'Verschlüsseln...';
      case 'uploading': return 'Hochladen...';
      case 'done': return 'Fertig';
      case 'error': return 'Fehler';
    }
  }

  private uploadFiles(files: File[]): void {
    this.uploadService.addFiles(files, this.albumId());
  }
}
