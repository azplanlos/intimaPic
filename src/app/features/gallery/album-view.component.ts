import {
  Component, inject, signal, computed, OnInit, OnDestroy,
  ElementRef, AfterViewInit, ViewChildren, QueryList
} from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { PhotoService, type PhotoItem } from '../../core/album/photo.service';
import { ToolbarService } from '../../shared/toolbar.service';
import { MetadataService } from '../../core/metadata/metadata.service';
import { SortControlComponent } from '../../shared/sort-control/sort-control.component';
import { getSortPreference, setSortPreference, sortByFilename, sortByCaptureDate, sortByRating } from '../../core/metadata/sort-utils';
import type { MetadataRecord, SortCriterion } from '../../core/metadata/metadata.models';
import { AlbumPickerDialogComponent, type AlbumPickerDialogData, type AlbumPickerDialogResult } from './album-picker-dialog.component';
import PhotoSwipe from 'photoswipe';

@Component({
  selector: 'app-album-view',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    SortControlComponent,
  ],
  template: `
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
      <div class="sort-toolbar">
        <app-sort-control
          [activeCriterion]="sortCriterion()"
          (criterionChanged)="onSortCriterionChanged($event)">
        </app-sort-control>
      </div>
      <div class="photo-grid">
        @for (photo of sortedPhotos(); track photo.encryptedName; let i = $index) {
          <div class="photo-item">
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
            <div class="rating-bar">
              <mat-icon class="rating-heart">{{ (metadata().get(photo.encryptedName)?.isFavorite) ? 'favorite' : 'favorite_border' }}</mat-icon>
              @for (star of [1,2,3,4,5]; track star) {
                <mat-icon class="rating-star">{{ (metadata().get(photo.encryptedName)?.rating ?? 0) >= star ? 'star' : 'star_border' }}</mat-icon>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [`
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

    .sort-toolbar {
      display: flex;
      justify-content: flex-end;
      padding: 4px 8px;
    }

    .photo-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 4px;
      padding: 2px;
    }

    .photo-item {
      display: flex;
      flex-direction: column;
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

    .rating-bar {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 1px;
      padding: 2px 0;
      background: transparent;
      opacity: 0.45;
    }

    .photo-item:hover .rating-bar {
      opacity: 0.9;
    }

    .rating-bar .rating-heart,
    .rating-bar .rating-star {
      font-size: 14px;
      width: 14px;
      height: 14px;
      line-height: 14px;
    }

    .rating-bar .rating-heart {
      color: #E91E63;
    }

    .rating-bar .rating-star {
      color: #FFD700;
    }
  `]
})
export class AlbumViewComponent implements OnInit, OnDestroy, AfterViewInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly photoService = inject(PhotoService);
  private readonly toolbar = inject(ToolbarService);
  private readonly metadataService = inject(MetadataService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  @ViewChildren('photoCell') photoCells!: QueryList<ElementRef>;

  photos = signal<PhotoItem[]>([]);
  loading = signal(true);
  albumName = signal('');
  albumId = signal('');
  sortCriterion = signal<SortCriterion>('filename');
  metadata = signal<Map<string, MetadataRecord>>(new Map());

  readonly sortedPhotos = computed(() => {
    const photoList = [...this.photos()];
    const meta = this.metadata();
    switch (this.sortCriterion()) {
      case 'captureDate': return photoList.sort((a, b) => sortByCaptureDate(a, b, meta));
      case 'rating': return photoList.sort((a, b) => sortByRating(a, b, meta));
      default: return photoList.sort(sortByFilename);
    }
  });

  private observer: IntersectionObserver | null = null;
  private lightbox: PhotoSwipe | null = null;
  /** Set to true when the lightbox is closing to prevent late refreshSlideContent calls. */
  private lightboxClosing = false;
  /** Reference to the info overlay element in the lightbox. */
  private infoOverlayEl: HTMLElement | null = null;

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
      const name = params['name'] || 'Album';
      this.albumName.set(name);
      this.toolbar.set({
        title: name,
        backAction: () => this.goBack(),
        actions: [
          { icon: 'add_photo_alternate', label: 'Fotos hochladen', callback: () => this.goUpload() }
        ],
      });
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
    this.toolbar.reset();
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

      // Initialize sort criterion from persisted preference
      this.sortCriterion.set(getSortPreference(this.albumId()));

      // Load metadata for the album photos
      const photoIds = items.map(p => p.encryptedName);
      const meta = this.metadataService.getMetadataBatch(photoIds);
      this.metadata.set(meta);

      // Queue background EXIF extraction for photos without metadata
      const photosWithoutMetadata = items
        .filter(p => !meta.has(p.encryptedName))
        .map(p => ({ encryptedName: p.encryptedName, storagePath: p.storagePath }));
      if (photosWithoutMetadata.length > 0) {
        this.metadataService.queueBackgroundExtraction(photosWithoutMetadata);
      }
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
      const photo = this.sortedPhotos()[index];
      if (photo && !photo.thumbnailUrl && !photo.loading) {
        this.observer!.observe(cell.nativeElement);
      }
    });
  }

  private async decryptThumbnailAt(index: number): Promise<void> {
    const currentPhotos = this.sortedPhotos();
    const photo = currentPhotos[index];
    if (!photo || photo.thumbnailUrl || photo.loading) return;

    this.updatePhotoById(photo.encryptedName, { loading: true });

    try {
      // Load the small grid thumbnail
      const url = await this.photoService.decryptThumbnail(photo, this.albumId(), 'grid');
      this.updatePhotoById(photo.encryptedName, { thumbnailUrl: url, loading: false });
    } catch (err) {
      console.error(`Failed to decrypt thumbnail for ${photo.name}:`, err);
      this.updatePhotoById(photo.encryptedName, { loading: false });
    }
  }

  /** Update a photo by its encryptedName (index-independent). */
  private updatePhotoById(encryptedName: string, update: Partial<PhotoItem>): void {
    this.photos.update(photos => {
      const idx = photos.findIndex(p => p.encryptedName === encryptedName);
      if (idx === -1) return photos;
      const copy = [...photos];
      copy[idx] = { ...copy[idx], ...update };
      return copy;
    });
  }

  async openLightbox(startIndex: number): Promise<void> {
    const photos = this.sortedPhotos();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Resolve real dimensions for thumbnails that are already loaded.
    // This prevents aspect ratio distortion before the high-res preview arrives.
    const dimensionPromises = photos.map(async (photo) => {
      const src = photo.previewUrl || photo.thumbnailUrl || '';
      if (src) {
        try {
          return await this.getImageDimensions(src);
        } catch {
          return { width: 1, height: 1 };
        }
      }
      return { width: 1, height: 1 };
    });
    const dimensions = await Promise.all(dimensionPromises);

    const dataSource = photos.map((photo, i) => {
      const src = photo.previewUrl || photo.thumbnailUrl || '';
      // Scale the thumbnail dimensions up to fill the viewport (preserving aspect ratio).
      // This makes PhotoSwipe display the low-res thumbnail at full screen size immediately,
      // so there's no jump when the high-res preview replaces it.
      let { width, height } = dimensions[i];
      if (width > 0 && height > 0) {
        const scale = Math.min(viewportW / width, viewportH / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      return {
        src,
        width,
        height,
        msrc: photo.thumbnailUrl || src,
      };
    });

    const options = {
      index: startIndex,
      dataSource,
      bgOpacity: 1,
      showHideAnimationType: 'fade' as const,
      preload: [1, 1] as [number, number], // Reduced preload to save memory on mobile
    };

    this.lightbox = new PhotoSwipe(options);
    this.lightboxClosing = false;

    // On slide change, cancel stale fetches, upgrade current + neighbors, and update rating display
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

      // Update rating control display for the new slide
      const ratingEl = document.querySelector('.pswp__rating-control') as HTMLElement | null;
      if (ratingEl) {
        this.updateRatingControlDisplay(ratingEl, idx, photos);
      }

      // Update info overlay if visible
      if (this.infoOverlayEl && !this.infoOverlayEl.classList.contains('pswp__info-overlay--hidden')) {
        this.updateInfoOverlayContent(photos);
      }
    });

    // On close, abort all in-flight decryptions immediately
    this.lightbox.on('close', () => {
      this.lightboxClosing = true;
      this.abortAllSlides();
    });

    // On destroy, release the lightbox reference
    this.lightbox.on('destroy', () => {
      this.lightbox = null;
      // Remove info overlay from DOM
      if (this.infoOverlayEl) {
        this.infoOverlayEl.remove();
        this.infoOverlayEl = null;
      }
    });

    // Register download button and rating controls
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

      // Register rating control (heart + stars) at the bottom of the lightbox
      (this.lightbox as any).ui.registerElement({
        name: 'rating-control',
        appendTo: 'wrapper',
        order: 7,
        isButton: false,
        html: this.buildRatingControlHtml(),
        onInit: (el: HTMLElement, pswp: PhotoSwipe) => {
          this.setupRatingControlListeners(el, pswp, photos);
          this.updateRatingControlDisplay(el, pswp.currIndex, photos);
        },
      });

      // Register info button in the top bar
      (this.lightbox as any).ui.registerElement({
        name: 'info-button',
        order: 7,
        isButton: true,
        html: '<svg aria-hidden="true" class="pswp__icn" viewBox="0 0 24 24" width="24" height="24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" fill="currentColor"/></svg>',
        onClick: () => {
          this.toggleInfoOverlay(photos);
        },
      });

      // Register delete button in the top bar
      (this.lightbox as any).ui.registerElement({
        name: 'delete-button',
        order: 9,
        isButton: true,
        html: '<svg aria-hidden="true" class="pswp__icn" viewBox="0 0 24 24" width="24" height="24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>',
        onClick: (_event: Event, _el: HTMLElement, pswp: PhotoSwipe) => {
          const currentPhoto = photos[pswp.currIndex];
          if (currentPhoto) {
            this.confirmAndDeletePhoto(currentPhoto, pswp);
          }
        },
      });

      // Register move button in the top bar
      (this.lightbox as any).ui.registerElement({
        name: 'move-button',
        order: 10,
        isButton: true,
        html: '<svg aria-hidden="true" class="pswp__icn" viewBox="0 0 24 24" width="24" height="24"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12l-4-4h3V10h2v4h3l-4 4z" fill="currentColor"/></svg>',
        onClick: (_event: Event, _el: HTMLElement, pswp: PhotoSwipe) => {
          const currentPhoto = photos[pswp.currIndex];
          if (currentPhoto) {
            this.openMoveDialog(currentPhoto, pswp);
          }
        },
      });
    });

    this.lightbox.init();

    // Create info overlay element directly in the DOM
    this.infoOverlayEl = document.createElement('div');
    this.infoOverlayEl.className = 'pswp__info-overlay pswp__info-overlay--hidden';
    document.body.appendChild(this.infoOverlayEl);

    // Upgrade the initial slide
    this.upgradeSlide(startIndex, photos);
  }

  /**
   * Decrypt preview for a slide and hot-swap it into PhotoSwipe.
   * Uses AbortController so the request can be cancelled if the user
   * navigates away from this slide before decryption completes.
   *
   * Only calls refreshSlideContent for the current slide to avoid
   * disrupting PhotoSwipe's gesture/animation state on mobile.
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

      this.updatePhotoById(photo.encryptedName, { previewUrl: url });

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

      // Only refresh the current slide to avoid interrupting swipe gestures.
      // Neighbor slides will pick up their new src on next navigation.
      if (this.lightbox.currIndex === index) {
        this.lightbox.refreshSlideContent(index);
      }
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
   * Cleans up the Image object after use to prevent memory leaks on mobile.
   */
  private getImageDimensions(src: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        // Release the image reference — critical for mobile memory management
        img.onload = null;
        img.onerror = null;
        img.src = '';
        resolve({ width, height });
      };
      img.onerror = () => {
        img.onload = null;
        img.onerror = null;
        img.src = '';
        resolve({ width: 1920, height: 1080 }); // Fallback
      };
      img.src = src;
    });
  }

  // ─── Lightbox Rating Control Helpers ────────────────────────────

  /** Build the HTML for the lightbox rating control (heart + 5 stars). */
  private buildRatingControlHtml(): string {
    const heartSvg = `<svg class="pswp__rating-heart" viewBox="0 0 24 24" width="28" height="28">
      <path class="heart-filled" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="currentColor"/>
      <path class="heart-outline" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z" fill="currentColor"/>
    </svg>`;

    let starsSvg = '';
    for (let i = 1; i <= 5; i++) {
      starsSvg += `<button class="pswp__rating-star" data-star="${i}" aria-label="Rate ${i} stars">
        <svg viewBox="0 0 24 24" width="24" height="24">
          <path class="star-filled" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="currentColor"/>
          <path class="star-outline" d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z" fill="currentColor"/>
        </svg>
      </button>`;
    }

    return `<div class="pswp__rating-inner">
      <button class="pswp__rating-heart-btn" aria-label="Toggle favorite">${heartSvg}</button>
      <span class="pswp__rating-stars">${starsSvg}</span>
    </div>`;
  }

  /** Attach click listeners to the rating control buttons. */
  private setupRatingControlListeners(el: HTMLElement, _pswp: PhotoSwipe, photos: PhotoItem[]): void {
    const heartBtn = el.querySelector('.pswp__rating-heart-btn');
    if (heartBtn) {
      heartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.lightbox || this.lightboxClosing) return;
        const currentPhoto = photos[this.lightbox.currIndex];
        if (currentPhoto) {
          this.metadataService.toggleFavorite(currentPhoto.encryptedName).then(() => {
            this.refreshMetadata();
            this.updateRatingControlDisplay(el, this.lightbox!.currIndex, photos);
          });
        }
      });
    }

    const starBtns = el.querySelectorAll('.pswp__rating-star');
    starBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.lightbox || this.lightboxClosing) return;
        const star = parseInt((btn as HTMLElement).dataset['star'] || '0', 10);
        const currentPhoto = photos[this.lightbox.currIndex];
        if (currentPhoto && star >= 1 && star <= 5) {
          this.metadataService.setRating(currentPhoto.encryptedName, star).then(() => {
            this.refreshMetadata();
            this.updateRatingControlDisplay(el, this.lightbox!.currIndex, photos);
          });
        }
      });
    });
  }

  /** Update the rating control icons to reflect the current photo's metadata. */
  private updateRatingControlDisplay(el: HTMLElement, index: number, photos: PhotoItem[]): void {
    const photo = photos[index];
    if (!photo) return;

    const meta = this.metadataService.getMetadata(photo.encryptedName);
    const isFav = meta?.isFavorite ?? false;
    const rating = meta?.rating ?? 0;

    // Update heart icon
    const heartFilled = el.querySelector('.heart-filled') as SVGElement | null;
    const heartOutline = el.querySelector('.heart-outline') as SVGElement | null;
    if (heartFilled && heartOutline) {
      heartFilled.style.display = isFav ? 'block' : 'none';
      heartOutline.style.display = isFav ? 'none' : 'block';
    }

    // Update heart button aria-label
    const heartBtn = el.querySelector('.pswp__rating-heart-btn') as HTMLElement | null;
    if (heartBtn) {
      heartBtn.setAttribute('aria-label', isFav ? 'Remove from favorites' : 'Add to favorites');
    }

    // Update star icons
    const starBtns = el.querySelectorAll('.pswp__rating-star');
    starBtns.forEach((btn) => {
      const star = parseInt((btn as HTMLElement).dataset['star'] || '0', 10);
      const filled = btn.querySelector('.star-filled') as SVGElement | null;
      const outline = btn.querySelector('.star-outline') as SVGElement | null;
      if (filled && outline) {
        filled.style.display = star <= rating ? 'block' : 'none';
        outline.style.display = star <= rating ? 'none' : 'block';
      }
    });
  }

  onSortCriterionChanged(criterion: SortCriterion): void {
    this.sortCriterion.set(criterion);
    setSortPreference(this.albumId(), criterion);
  }

  async onFavoriteToggled(photoId: string): Promise<void> {
    await this.metadataService.toggleFavorite(photoId);
    this.refreshMetadata();
  }

  async onRatingChanged(event: { photoId: string; value: number }): Promise<void> {
    await this.metadataService.setRating(event.photoId, event.value);
    this.refreshMetadata();
  }

  private refreshMetadata(): void {
    const photoIds = this.photos().map(p => p.encryptedName);
    const meta = this.metadataService.getMetadataBatch(photoIds);
    this.metadata.set(meta);
  }

  goBack(): void {
    this.router.navigate(['/gallery']);
  }

  goUpload(): void {
    this.router.navigate(['/upload'], {
      queryParams: { albumId: this.albumId(), albumName: this.albumName() }
    });
  }

  // ─── Delete & Move ──────────────────────────────────────────────

  /**
   * Show a confirmation prompt and delete the current photo.
   * Closes lightbox if this was the last photo, otherwise navigates to the next one.
   */
  private async confirmAndDeletePhoto(photo: PhotoItem, pswp: PhotoSwipe): Promise<void> {
    const confirmed = window.confirm(`„${photo.name}" unwiderruflich löschen?`);
    if (!confirmed) return;

    try {
      // Delete from storage
      await this.photoService.deletePhoto(photo, this.albumId());

      // Remove metadata
      await this.metadataService.deleteMetadata(photo.encryptedName);

      // Remove from local list
      this.photos.update(photos => photos.filter(p => p.encryptedName !== photo.encryptedName));
      this.refreshMetadata();

      this.snackBar.open('Foto gelöscht', undefined, { duration: 2500 });

      // Handle lightbox navigation after deletion
      const remaining = this.sortedPhotos();
      if (remaining.length === 0) {
        pswp.close();
      } else {
        // Rebuild dataSource and refresh
        const newIndex = Math.min(pswp.currIndex, remaining.length - 1);
        pswp.close();
        // Re-open lightbox on next photo after a small delay for DOM update
        setTimeout(() => this.openLightbox(newIndex), 150);
      }
    } catch (err) {
      console.error('Failed to delete photo:', err);
      this.snackBar.open('Fehler beim Löschen', undefined, { duration: 3000 });
    }
  }

  /**
   * Open the album picker dialog and move the current photo to the selected album.
   */
  private openMoveDialog(photo: PhotoItem, pswp: PhotoSwipe): void {
    const dialogRef = this.dialog.open(AlbumPickerDialogComponent, {
      data: {
        excludeDirectoryId: this.albumId(),
        title: 'Foto verschieben nach…',
      } satisfies AlbumPickerDialogData,
      width: '340px',
    });

    dialogRef.afterClosed().subscribe(async (result: AlbumPickerDialogResult | undefined) => {
      if (!result) return;

      try {
        // Move the photo to the target album
        await this.photoService.movePhoto(photo, this.albumId(), result.album.directoryId);

        // Remove metadata from current album context (it stays in the store but the photo is gone from this view)
        this.photos.update(photos => photos.filter(p => p.encryptedName !== photo.encryptedName));
        this.refreshMetadata();

        this.snackBar.open(`Verschoben nach „${result.album.name}"`, undefined, { duration: 3000 });

        // Handle lightbox after move
        const remaining = this.sortedPhotos();
        if (remaining.length === 0) {
          pswp.close();
        } else {
          const newIndex = Math.min(pswp.currIndex, remaining.length - 1);
          pswp.close();
          setTimeout(() => this.openLightbox(newIndex), 150);
        }
      } catch (err) {
        console.error('Failed to move photo:', err);
        this.snackBar.open('Fehler beim Verschieben', undefined, { duration: 3000 });
      }
    });
  }

  // ─── Info Overlay ──────────────────────────────────────────────

  private toggleInfoOverlay(photos: PhotoItem[]): void {
    if (!this.infoOverlayEl || !this.lightbox) return;

    const isHidden = this.infoOverlayEl.classList.contains('pswp__info-overlay--hidden');
    if (isHidden) {
      this.updateInfoOverlayContent(photos);
      this.infoOverlayEl.classList.remove('pswp__info-overlay--hidden');
    } else {
      this.infoOverlayEl.classList.add('pswp__info-overlay--hidden');
    }
  }

  private updateInfoOverlayContent(photos: PhotoItem[]): void {
    if (!this.infoOverlayEl || !this.lightbox) return;

    const photo = photos[this.lightbox.currIndex];
    if (!photo) return;

    const meta = this.metadataService.getMetadata(photo.encryptedName);

    let html = `<div class="pswp__info-header">${photo.name}</div>`;
    html += '<dl class="pswp__info-list">';

    if (meta?.captureDate) {
      const date = new Date(meta.captureDate);
      html += `<dt>Aufnahme</dt><dd>${date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })} · ${date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</dd>`;
    }

    if (meta?.cameraMake || meta?.cameraModel) {
      const camera = [meta.cameraMake, meta.cameraModel].filter(Boolean).join(' ');
      html += `<dt>Kamera</dt><dd>${camera}</dd>`;
    }

    if (meta?.rating) {
      html += `<dt>Bewertung</dt><dd>${'★'.repeat(meta.rating)}${'☆'.repeat(5 - meta.rating)}</dd>`;
    }

    if (photo.size) {
      const sizeMB = (photo.size / (1024 * 1024)).toFixed(1);
      html += `<dt>Größe</dt><dd>${sizeMB} MB</dd>`;
    }

    html += '</dl>';
    this.infoOverlayEl.innerHTML = html;
  }
}
