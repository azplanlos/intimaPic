import { Injectable } from '@angular/core';
import exifr from 'exifr';
import { MetadataRecord } from './metadata.models';

@Injectable({ providedIn: 'root' })
export class ExifExtractor {
  /**
   * Extract metadata from raw image bytes.
   * Returns partial MetadataRecord fields (captureDate, cameraMake, cameraModel).
   */
  async extract(imageData: ArrayBuffer): Promise<Partial<MetadataRecord>> {
    try {
      const exif = await this.parseExif(imageData);

      if (!exif) return { captureDate: null, cameraMake: null, cameraModel: null };

      const dateField = exif.DateTimeOriginal ?? exif.DateTimeDigitized ?? null;
      const captureDate = dateField instanceof Date
        ? dateField.toISOString()
        : null;

      return {
        captureDate,
        cameraMake: exif.Make ?? null,
        cameraModel: exif.Model ?? null,
      };
    } catch {
      return { captureDate: null, cameraMake: null, cameraModel: null };
    }
  }

  /** @internal Exposed for testability — calls exifr.parse */
  protected async parseExif(imageData: ArrayBuffer): Promise<any> {
    return exifr.parse(imageData, {
      pick: ['DateTimeOriginal', 'DateTimeDigitized', 'Make', 'Model'],
      translateValues: false,
    });
  }
}
