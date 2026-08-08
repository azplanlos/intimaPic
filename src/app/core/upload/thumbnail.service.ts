import { Injectable } from '@angular/core';

export type ThumbnailSize = 'grid' | 'preview';

export interface ThumbnailResult {
  /** Thumbnail as JPEG Blob */
  blob: Blob;
  /** Thumbnail as ArrayBuffer (ready for encryption) */
  data: ArrayBuffer;
  /** Thumbnail width */
  width: number;
  /** Thumbnail height */
  height: number;
}

export interface MultiThumbnailResult {
  /** Small grid thumbnail (~300px max) */
  grid: ThumbnailResult;
  /** FullHD preview (1920px max) */
  preview: ThumbnailResult;
  /** Original image dimensions */
  originalWidth: number;
  originalHeight: number;
}

/** Max dimension configs per thumbnail size */
const SIZE_CONFIG: Record<ThumbnailSize, { maxDimension: number; quality: number }> = {
  grid: { maxDimension: 300, quality: 0.75 },
  preview: { maxDimension: 1920, quality: 0.85 },
};

/**
 * Service to generate thumbnails from image files using OffscreenCanvas.
 * Produces two JPEG variants:
 * - grid: small thumbnail for gallery grid (~300px max side)
 * - preview: FullHD for lightbox/fullscreen view (1920px max side)
 */
@Injectable({ providedIn: 'root' })
export class ThumbnailService {

  /**
   * Generate both thumbnail sizes from an image file.
   */
  async generateAll(file: File | Blob): Promise<MultiThumbnailResult> {
    const imageBitmap = await createImageBitmap(file);
    const origW = imageBitmap.width;
    const origH = imageBitmap.height;

    const [grid, preview] = await Promise.all([
      this.renderThumbnail(imageBitmap, 'grid'),
      this.renderThumbnail(imageBitmap, 'preview'),
    ]);

    imageBitmap.close();

    return { grid, preview, originalWidth: origW, originalHeight: origH };
  }

  /**
   * Generate a single thumbnail size.
   */
  async generate(file: File | Blob, size: ThumbnailSize = 'grid'): Promise<ThumbnailResult> {
    const imageBitmap = await createImageBitmap(file);
    const result = await this.renderThumbnail(imageBitmap, size);
    imageBitmap.close();
    return result;
  }

  /**
   * Legacy helper: generate grid thumbnail as ArrayBuffer.
   */
  async generateAsArrayBuffer(file: File | Blob): Promise<ArrayBuffer> {
    const { data } = await this.generate(file, 'grid');
    return data;
  }

  private async renderThumbnail(
    source: ImageBitmap,
    size: ThumbnailSize
  ): Promise<ThumbnailResult> {
    const config = SIZE_CONFIG[size];
    const { width, height } = this.fitDimensions(
      source.width,
      source.height,
      config.maxDimension
    );

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create canvas context');

    ctx.drawImage(source, 0, 0, width, height);

    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: config.quality,
    });

    const data = await blob.arrayBuffer();
    return { blob, data, width, height };
  }

  private fitDimensions(
    origWidth: number,
    origHeight: number,
    maxDimension: number
  ): { width: number; height: number } {
    if (origWidth <= maxDimension && origHeight <= maxDimension) {
      return { width: origWidth, height: origHeight };
    }

    const ratio = Math.min(maxDimension / origWidth, maxDimension / origHeight);
    return {
      width: Math.round(origWidth * ratio),
      height: Math.round(origHeight * ratio),
    };
  }
}
