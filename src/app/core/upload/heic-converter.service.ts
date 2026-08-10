import { Injectable } from '@angular/core';
import heic2any from 'heic2any';

/**
 * Service to convert HEIC/HEIF images to JPEG for browsers that don't
 * natively support HEIC (e.g. Chromium-based browsers, Firefox).
 *
 * Uses heic2any under the hood. Checks native browser support first
 * and skips conversion if the browser can handle HEIC directly (Safari).
 */
@Injectable({ providedIn: 'root' })
export class HeicConverterService {
  /** Cached result of native HEIC support check */
  private nativeSupport: boolean | null = null;

  /**
   * Returns true if the given filename or MIME type indicates HEIC/HEIF.
   */
  isHeic(nameOrMime: string): boolean {
    const lower = nameOrMime.toLowerCase();
    return (
      lower.endsWith('.heic') ||
      lower.endsWith('.heif') ||
      lower === 'image/heic' ||
      lower === 'image/heif'
    );
  }

  /**
   * Convert a HEIC blob to JPEG. If the browser natively supports HEIC,
   * returns the original blob unchanged.
   *
   * @param blob - The HEIC image blob
   * @param quality - JPEG quality (0-1), defaults to 0.92
   * @returns A JPEG blob (or the original if native support detected)
   */
  async convertToJpeg(blob: Blob, quality = 0.92): Promise<Blob> {
    if (await this.hasNativeHeicSupport()) {
      return blob;
    }

    const result = await heic2any({
      blob,
      toType: 'image/jpeg',
      quality,
    });

    // heic2any returns Blob | Blob[] depending on multi-image HEIC files
    return Array.isArray(result) ? result[0] : result;
  }

  /**
   * Always convert HEIC to JPEG, bypassing the native support check.
   * Use this when the result must be displayable in an <img> tag on all browsers,
   * e.g. for preview thumbnails where a broken image is unacceptable.
   *
   * @param blob - The HEIC image blob
   * @param quality - JPEG quality (0-1), defaults to 0.92
   * @returns A JPEG blob
   */
  async forceConvertToJpeg(blob: Blob, quality = 0.92): Promise<Blob> {
    const result = await heic2any({
      blob,
      toType: 'image/jpeg',
      quality,
    });

    return Array.isArray(result) ? result[0] : result;
  }

  /**
   * Ensure a blob is browser-displayable: if it's HEIC and the browser
   * doesn't support it natively, convert to JPEG. Otherwise return as-is.
   *
   * @param blob - The image blob
   * @param fileName - Original filename (used to detect HEIC)
   * @param quality - JPEG quality for conversion
   */
  async ensureDisplayable(blob: Blob, fileName: string, quality = 0.92): Promise<Blob> {
    if (!this.isHeic(fileName) && !this.isHeic(blob.type)) {
      return blob;
    }
    return this.convertToJpeg(blob, quality);
  }

  /**
   * Check whether the browser natively supports HEIC via createImageBitmap.
   * Result is cached after first call.
   */
  private async hasNativeHeicSupport(): Promise<boolean> {
    if (this.nativeSupport !== null) {
      return this.nativeSupport;
    }

    try {
      // Minimal valid HEIC file header (ftyp box with 'heic' brand)
      // This is a tiny probe – if createImageBitmap resolves, browser supports HEIC.
      const heicProbe = new Uint8Array([
        0x00, 0x00, 0x00, 0x1c, // box size: 28 bytes
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
        0x68, 0x65, 0x69, 0x63, // major brand: 'heic'
        0x00, 0x00, 0x00, 0x00, // minor version
        0x68, 0x65, 0x69, 0x63, // compatible brand: 'heic'
        0x68, 0x65, 0x76, 0x63, // compatible brand: 'hevc'
        0x6d, 0x69, 0x66, 0x31, // compatible brand: 'mif1'
      ]);
      const probeBlob = new Blob([heicProbe], { type: 'image/heic' });
      const bmp = await createImageBitmap(probeBlob);
      bmp.close();
      this.nativeSupport = true;
    } catch {
      this.nativeSupport = false;
    }

    return this.nativeSupport;
  }
}
