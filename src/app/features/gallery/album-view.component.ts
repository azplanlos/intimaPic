import {
  Component, inject, signal, OnInit, OnDestroy,
  ElementRef, AfterViewInit, ViewChildren, QueryList
} from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { PhotoService, type PhotoItem } from '../../core/album/photo.service';
import PhotoSwipe from 'photoswipe';

@Component({
  selector: 'app-album-view',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatToolbarModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <mat-toolbar color="primary">
      <button mat-icon-button (click)="goBack()">
        <mat-icon>arrow_back</mat-icon>
      </button>
      <span class="toolbar-title">{{ albumName() }}</span>
      <span class="spacer"></span>
      <button mat-icon-button (click)="goUpload()">
        <mat-icon>add_photo_alternate</mat-icon>
      </button>
    </mat-toolbar>

    @if (loading()) {
      <div class="loading">
        <mat-spinner diameter="40"></mat-spinner>
        <p>Fotos laden...</p>
      </div>
    } @else if (photos().length === 0) {
      <div class="empty">
        <mat-icon class="empty-icon">photo_library</mat-icon>
        <p>Noch keine Fotos in diesem Album.</p>
        <button mat-raised-button color="primary" (click)="goUpload()">
          <mat-icon>add_photo_alternate</mat-icon>
          Fotos hochladen
        </button>
      </div>
    } @else {
      <div class="photo-grid">
        @for (photo of photos(); track photo.encryptedName; let i = $index) {
          <div class="photo-cell"
               #photoCell
               [attr.data-index]="i"
               (click)="openLightbox(i)">
            @if (photo.thumbnailUrl) {
              <img [src]="photo.thumbnailUrl" [alt]="photo.name">
            } @else {
              <div class="placeholder">
                @if (photo.loading) {
                  <mat-spinner diameter="24"></mat-spinner>
                } @else {
                  <mat-icon>image</mat-icon>
                }
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .toolbar-title { margin-left: 0.5rem; font-weight: 400; }
    .spacer { flex: 1; }

    .loading, .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem;
      gap: 1rem;
      min-height: calc(100vh - 64px);
    }
    .empty-icon { font-size: 56px; width: 56px; height: 56px; opacity: 0.5; }

    .photo-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 2px;
      padding: 2px;
    }

    .photo-cell {
      position: relative;
      aspect-ratio: 1;
      overflow: hidden;
      cursor: pointer;
      background: color-mix(in srgb, var(--mat-sys-surface-variant) 30%, transparent);
    }

    .photo-cell img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.15s;
    }

    .photo-cell:active img {
      transform: scale(0.95);
    }

    .placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.4;
    }
  `]
})
export class AlbumViewComponent implements OnInit, OnDestroy, AfterViewInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly photoService = inject(PhotoService);

  @ViewChildren('photoCell') photoCells!: QueryList<ElementRef>;

  photos = signal<PhotoItem[]>([]);
  loading = signal(true);
  albumName = signal('');
  albumId = signal('');

  private observer: IntersectionObserver | null = null;
  private lightbox: PhotoSwipe | null = null;
  /** Set to true when the lightbox is closing to prevent late refreshSlideContent calls. */
  private lightboxClosing = false;

  /**
   * AbortControllers for in-flight preview decryptions.
   * Key = slide index. On slide change, stale controllers (slides no longer
   * within current ± 1) are aborted to free up throttle slots and sockets.
   */
  private slideAbortControllers = new Map<number, AbortController>();

  ngOnInit(): void {
    this.route.params.subscribe(params => {
      this.albumId.set(params['id'] || '');
    });
    this.route.queryParams.subscribe(params => {
      this.albumName.set(params['name'] || 'Album');
    });
  }

  async ngAfterViewInit(): Promise<void> {
    await this.loadPhotos();
    this.setupIntersectionObserver();

    // Re-observe when the list changes
    this.photoCells.changes.subscribe(() => {
      this.observeNewCells();
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.lightboxClosing = true;
    this.abortAllSlides();
    this.lightbox?.destroy();
    this.lightbox = null;
    // Clear full-res cache on leaving album (saves memory)
    // Thumbnail cache stays for quick back-navigation
    this.photoService.clearFullResCache();
  }

  private async loadPhotos(): Promise<void> {
    try {
      const items = await this.photoService.listPhotos(this.albumId());
      this.photos.set(items);
    } catch (err) {
      console.error('Failed to list photos:', err);
    } finally {
      this.loading.set(false);
    }
  }

  private setupIntersectionObserver(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = Number((entry.target as HTMLElement).dataset['index']);
            this.decryptThumbnailAt(index);
            this.observer?.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '200px' }
    );

    this.observeNewCells();
  }

  private observeNewCells(): void {
    if (!this.observer) return;
    this.photoCells.forEach(cell => {
      const index = Number(cell.nativeElement.dataset['index']);
      const photo = this.photos()[index];
      if (photo && !photo.thumbnailUrl && !photo.loading) {
        this.observer!.observe(cell.nativeElement);
      }
    });
  }

  private async decryptThumbnailAt(index: number): Promise<void> {
    const currentPhotos = this.photos();
    const photo = currentPhotos[index];
    if (!photo || photo.thumbnailUrl || photo.loading) return;

    this.updatePhoto(index, { loading: true });

    try {
      // Load the small grid thumbnail
      const url = await this.photoService.decryptThumbnail(photo, this.albumId(), 'grid');
      this.updatePhoto(index, { thumbnailUrl: url, loading: false });
    } catch (err) {
      console.error(`Failed to decrypt thumbnail for ${photo.name}:`, err);
      this.updatePhoto(index, { loading: false });
    }
  }

  private updatePhoto(index: number, update: Partial<PhotoItem>): void {
    this.photos.update(photos => {
      const copy = [...photos];
      copy[index] = { ...copy[index], ...update };
      return copy;
    });
  }

  async openLightbox(startIndex: number): Promise<void> {
    const photos = this.photos();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Build data source: use thumbnail as src, but scale dimensions to fill viewport
    const dataSource = await Promise.all(
      photos.map(async (photo) => {
        const src = photo.previewUrl || photo.thumbnailUrl || '';
        if (!src) return { src: '', width: viewportW, height: viewportH, msrc: '' };

        const dims = await this.getImageDimensions(src);
        // Scale up to viewport-filling dimensions (preserving aspect ratio)
        const scale = Math.max(viewportW / dims.width, viewportH / dims.height);
        const displayW = Math.round(dims.width * scale);
        const displayH = Math.round(dims.height * scale);

        return {
          src,
          width: displayW,
          height: displayH,
          msrc: src,
        };
      })
    );

    const options = {
      index: startIndex,
      dataSource,
      bgOpacity: 1,
      showHideAnimationType: 'fade' as const,
      preload: [1, 2] as [number, number],
    };

    this.lightbox = new PhotoSwipe(options);
    this.lightboxClosing = false;

    // On slide change, cancel stale fetches and upgrade current + neighbors
    this.lightbox.on('change', () => {
      if (!this.lightbox || this.lightboxClosing) return;
      const idx = this.lightbox.currIndex;

      // Abort any in-flight requests for slides no longer relevant (outside idx ± 1)
      for (const [slideIdx, controller] of this.slideAbortControllers) {
        if (slideIdx < idx - 1 || slideIdx > idx + 1) {
          controller.abort();
          this.slideAbortControllers.delete(slideIdx);
        }
      }

      this.upgradeSlide(idx, photos);
      if (idx > 0) this.upgradeSlide(idx - 1, photos);
      if (idx < photos.length - 1) this.upgradeSlide(idx + 1, photos);
    });

    // On close, abort all in-flight decryptions immediately
    this.lightbox.on('close', () => {
      this.lightboxClosing = true;
      this.abortAllSlides();
    });

    // Register download button
    this.lightbox.on('uiRegister', () => {
      (this.lightbox as any).ui.registerElement({
        name: 'download-button',
        order: 8,
        isButton: true,
        html: '<svg aria-hidden="true" class="pswp__icn" viewBox="0 0 24 24" width="24" height="24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>',
        onClick: (_event: Event, _el: HTMLElement, pswp: PhotoSwipe) => {
          const currentPhoto = photos[pswp.currIndex];
          if (currentPhoto) {
            this.photoService.downloadOriginal(currentPhoto);
          }
        },
      });
    });

    this.lightbox.init();

    // Upgrade the initial slide
    this.upgradeSlide(startIndex, photos);
  }

  /**
   * Decrypt full-res for a slide and hot-swap it into PhotoSwipe.
   * Uses AbortController so the request can be cancelled if the user
   * navigates away from this slide before decryption completes.
   */
  private async upgradeSlide(index: number, photos: PhotoItem[]): Promise<void> {
    const photo = photos[index];
    if (!photo || photo.previewUrl) return;

    // If there's already an in-flight request for this slide, don't start another
    if (this.slideAbortControllers.has(index)) return;

    const controller = new AbortController();
    this.slideAbortControllers.set(index, controller);

    try {
      const url = await this.photoService.decryptPreview(photo, this.albumId(), controller.signal);

      // Clean up controller now that we're done
      this.slideAbortControllers.delete(index);

      // Don't update if lightbox is closing or was destroyed
      if (this.lightboxClosing || !this.lightbox) return;

      this.updatePhoto(index, { previewUrl: url });

      const dims = await this.getImageDimensions(url);

      if (!this.lightbox || this.lightboxClosing) return;

      // Update the dataSource entry with the new high-res image
      const ds = (this.lightbox.options as any).dataSource;
      if (ds && ds[index]) {
        ds[index].src = url;
        ds[index].width = dims.width;
        ds[index].height = dims.height;
        ds[index].msrc = url;
      }

      // Tell PhotoSwipe to reload this slide
      this.lightbox.refreshSlideContent(index);
    } catch (err) {
      this.slideAbortControllers.delete(index);
      // Silently ignore aborted requests (user navigated away)
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error(`Failed to upgrade slide ${index}:`, err);
    }
  }

  /**
   * Abort all in-flight slide decryptions.
   */
  private abortAllSlides(): void {
    for (const controller of this.slideAbortControllers.values()) {
      controller.abort();
    }
    this.slideAbortControllers.clear();
  }

  /**
   * Get actual dimensions of an image from its blob URL.
   */
  private getImageDimensions(src: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 1920, height: 1080 }); // Fallback
      img.src = src;
    });
  }

  goBack(): void {
    this.router.navigate(['/gallery']);
  }

  goUpload(): void {
    this.router.navigate(['/upload'], {
      queryParams: { albumId: this.albumId(), albumName: this.albumName() }
    });
  }
}
