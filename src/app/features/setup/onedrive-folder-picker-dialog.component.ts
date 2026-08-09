import { Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  OneDriveFolderPickerService,
  OneDriveFolderEntry,
} from '../../core/storage/onedrive-folder-picker.service';

export interface FolderPickerDialogResult {
  /** The selected or newly created folder path */
  path: string;
  /** Whether a vault was detected in this folder */
  hasVault: boolean;
}

@Component({
  selector: 'app-onedrive-folder-picker-dialog',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatListModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <h2 mat-dialog-title>OneDrive-Ordner wählen</h2>

    <mat-dialog-content>
      @if (loading()) {
        <div class="loading">
          <mat-spinner diameter="32"></mat-spinner>
          <p>Ordner werden geladen...</p>
        </div>
      } @else if (error()) {
        <div class="error-box">
          <mat-icon>error_outline</mat-icon>
          <p>{{ error() }}</p>
        </div>
      } @else {
        <!-- Breadcrumb navigation -->
        <div class="breadcrumb">
          <button mat-button class="breadcrumb-item"
                  [disabled]="currentPath() === '/'"
                  (click)="navigateTo('/')">
            <mat-icon>home</mat-icon>
            OneDrive
          </button>
          @for (crumb of breadcrumbs(); track crumb.path) {
            <mat-icon class="breadcrumb-separator">chevron_right</mat-icon>
            <button mat-button class="breadcrumb-item" (click)="navigateTo(crumb.path)">
              {{ crumb.name }}
            </button>
          }
        </div>

        <!-- Folder list -->
        @if (folders().length === 0 && !creatingFolder()) {
          <div class="empty-state">
            <mat-icon>folder_open</mat-icon>
            <p>Keine Unterordner vorhanden</p>
          </div>
        } @else {
          <div class="folder-list">
            @for (folder of folders(); track folder.path) {
              <div class="folder-item"
                   [class.selectable]="isSelectable(folder)"
                   [class.selected]="selectedFolder()?.path === folder.path"
                   (click)="onFolderClick(folder)">
                <mat-icon class="folder-icon"
                          [class.vault-icon]="folder.hasVault"
                          [class.empty-icon]="folder.justCreated">
                  {{ folder.hasVault ? 'enhanced_encryption' : folder.justCreated ? 'create_new_folder' : 'folder' }}
                </mat-icon>
                <div class="folder-info">
                  <span class="folder-name">{{ folder.name }}</span>
                  @if (folder.hasVault) {
                    <span class="folder-hint vault-hint">Tresor vorhanden</span>
                  } @else if (folder.justCreated) {
                    <span class="folder-hint new-hint">Neuer leerer Ordner</span>
                  }
                </div>
                @if (!isSelectable(folder)) {
                  <mat-icon class="navigate-icon">chevron_right</mat-icon>
                }
              </div>
            }
          </div>
        }

        <!-- New folder creation -->
        @if (creatingFolder()) {
          <div class="new-folder-row">
            <mat-form-field appearance="outline" class="new-folder-input">
              <mat-label>Neuer Ordnername</mat-label>
              <input matInput
                     [(ngModel)]="newFolderName"
                     (keyup.enter)="confirmNewFolder()"
                     (keyup.escape)="cancelNewFolder()"
                     autofocus>
            </mat-form-field>
            <button mat-icon-button color="primary" (click)="confirmNewFolder()"
                    [disabled]="!newFolderName.trim()">
              <mat-icon>check</mat-icon>
            </button>
            <button mat-icon-button (click)="cancelNewFolder()">
              <mat-icon>close</mat-icon>
            </button>
          </div>
        }

        @if (selectionHint()) {
          <p class="selection-hint">{{ selectionHint() }}</p>
        }
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="startNewFolder()" [disabled]="loading() || creatingFolder()">
        <mat-icon>create_new_folder</mat-icon>
        Neuer Ordner
      </button>
      <div class="spacer"></div>
      <button mat-button mat-dialog-close>Abbrechen</button>
      <button mat-raised-button color="primary"
              [disabled]="!canConfirm()"
              (click)="confirm()">
        @if (selectedFolder()?.hasVault) {
          Tresor verbinden
        } @else {
          Ordner auswählen
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-height: 300px;
      max-height: 400px;
      min-width: 380px;
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      gap: 1rem;
    }

    .loading p {
      opacity: 0.7;
    }

    .error-box {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem;
      border-radius: 8px;
      background: color-mix(in srgb, var(--mat-sys-error) 10%, transparent);
    }

    .error-box mat-icon {
      color: var(--mat-sys-error);
    }

    .error-box p {
      margin: 0;
      color: var(--mat-sys-error);
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
      padding: 0.25rem 0;
      border-bottom: 1px solid color-mix(in srgb, var(--mat-sys-on-surface) 12%, transparent);
    }

    .breadcrumb-item {
      min-width: auto;
      padding: 0 8px;
      font-size: 0.85rem;
    }

    .breadcrumb-separator {
      font-size: 18px;
      width: 18px;
      height: 18px;
      opacity: 0.5;
    }

    .folder-list {
      max-height: 250px;
      overflow-y: auto;
    }

    .folder-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      cursor: pointer;
      transition: background 150ms;
    }

    .folder-item:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 6%, transparent);
    }

    .folder-item.selected {
      background: color-mix(in srgb, var(--mat-sys-primary) 12%, transparent);
    }

    .folder-item.selectable {
      border-left: 3px solid var(--mat-sys-primary);
    }

    .folder-icon {
      color: color-mix(in srgb, var(--mat-sys-on-surface) 60%, transparent);
    }

    .folder-icon.vault-icon {
      color: var(--mat-sys-primary);
    }

    .folder-icon.empty-icon {
      color: var(--mat-sys-tertiary, var(--mat-sys-primary));
    }

    .folder-info {
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    .folder-name {
      font-size: 0.9rem;
    }

    .folder-hint {
      font-size: 0.75rem;
      margin-top: 2px;
    }

    .vault-hint {
      color: var(--mat-sys-primary);
    }

    .new-hint {
      color: var(--mat-sys-tertiary, var(--mat-sys-primary));
    }

    .navigate-icon {
      opacity: 0.4;
      font-size: 20px;
      width: 20px;
      height: 20px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 150px;
      opacity: 0.5;
    }

    .empty-state mat-icon {
      font-size: 48px;
      width: 48px;
      height: 48px;
      margin-bottom: 0.5rem;
    }

    .new-folder-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0;
    }

    .new-folder-input {
      flex: 1;
    }

    .selection-hint {
      font-size: 0.8rem;
      opacity: 0.6;
      text-align: center;
      margin: 0.5rem 0 0;
    }

    mat-dialog-actions {
      display: flex;
      gap: 0.5rem;
    }

    .spacer {
      flex: 1;
    }
  `],
})
export class OneDriveFolderPickerDialogComponent {
  private readonly dialogRef = inject(MatDialogRef<OneDriveFolderPickerDialogComponent, FolderPickerDialogResult>);
  private readonly folderPicker = inject(OneDriveFolderPickerService);

  /** Tracks paths of folders created in this session */
  private readonly createdPaths = new Set<string>();

  // State
  loading = signal(false);
  error = signal<string | null>(null);
  currentPath = signal('/');
  folders = signal<OneDriveFolderEntry[]>([]);
  selectedFolder = signal<OneDriveFolderEntry | null>(null);
  creatingFolder = signal(false);
  newFolderName = '';

  // Computed
  breadcrumbs = computed(() => {
    const path = this.currentPath();
    if (path === '/') return [];
    const parts = path.split('/').filter(p => p);
    return parts.map((name, i) => ({
      name,
      path: '/' + parts.slice(0, i + 1).join('/'),
    }));
  });

  canConfirm = computed(() => {
    const selected = this.selectedFolder();
    if (!selected) return false;
    return this.isSelectable(selected);
  });

  selectionHint = computed(() => {
    const selected = this.selectedFolder();
    if (!selected) return 'Wähle einen Ordner mit Tresor oder erstelle einen neuen leeren Ordner.';
    if (this.isSelectable(selected)) return '';
    return 'Dieser Ordner enthält keinen Tresor. Navigiere hinein oder erstelle einen neuen Ordner.';
  });

  constructor() {
    this.loadFolders('/');
  }

  /**
   * A folder is selectable (confirmable) only if it contains a vault
   * or was just created as an empty folder in this session.
   */
  isSelectable(folder: OneDriveFolderEntry): boolean {
    return folder.hasVault || folder.justCreated;
  }

  async loadFolders(path: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.selectedFolder.set(null);

    try {
      const folders = await this.folderPicker.listFolders(path);

      // Check for vault existence in each folder (parallel, best-effort)
      const enriched = await Promise.all(
        folders.map(async (folder) => {
          let hasVault = false;
          try {
            hasVault = await this.folderPicker.checkVaultExists(folder.path);
          } catch {
            // ignore
          }
          return {
            ...folder,
            hasVault,
            justCreated: this.createdPaths.has(folder.path),
          };
        })
      );

      this.folders.set(enriched);
      this.currentPath.set(path);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Fehler beim Laden der Ordner.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Click on a folder: if it's selectable, select it.
   * If it's not selectable (regular folder), navigate into it.
   */
  onFolderClick(folder: OneDriveFolderEntry): void {
    if (this.isSelectable(folder)) {
      // Toggle selection
      if (this.selectedFolder()?.path === folder.path) {
        this.selectedFolder.set(null);
      } else {
        this.selectedFolder.set(folder);
      }
    } else {
      // Navigate into the folder to show its subfolders
      this.loadFolders(folder.path);
    }
  }

  navigateTo(path: string): void {
    this.loadFolders(path);
  }

  startNewFolder(): void {
    this.creatingFolder.set(true);
    this.newFolderName = '';
  }

  cancelNewFolder(): void {
    this.creatingFolder.set(false);
    this.newFolderName = '';
  }

  async confirmNewFolder(): Promise<void> {
    const name = this.newFolderName.trim();
    if (!name) return;

    this.loading.set(true);
    try {
      const newPath = await this.folderPicker.createFolder(this.currentPath(), name);
      this.createdPaths.add(newPath);
      this.creatingFolder.set(false);
      this.newFolderName = '';

      // Reload current folder and auto-select the new folder
      await this.loadFolders(this.currentPath());
      const created = this.folders().find(f => f.path === newPath);
      if (created) {
        this.selectedFolder.set(created);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Ordner konnte nicht erstellt werden.');
      this.loading.set(false);
    }
  }

  confirm(): void {
    const selected = this.selectedFolder();
    if (selected && this.isSelectable(selected)) {
      this.dialogRef.close({ path: selected.path, hasVault: selected.hasVault });
    }
  }
}
