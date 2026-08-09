import { TestBed } from '@angular/core/testing';
import { ExifExtractor } from './exif-extractor';

/**
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 *
 * Property 1: EXIF Extraction Fidelity
 * For any valid image file containing EXIF data, the ExifExtractor SHALL return
 * a captureDate equal to the DateTimeOriginal field if present, otherwise the
 * DateTimeDigitized field if present, otherwise null. The cameraMake and cameraModel
 * fields SHALL equal the EXIF Make and Model fields respectively (or null if absent).
 */
describe('ExifExtractor', () => {
  let service: ExifExtractor;
  let parseExifSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ExifExtractor);
    // Spy on the internal parseExif method to mock exifr behavior
    parseExifSpy = spyOn(service as any, 'parseExif');
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('Property 1: EXIF Extraction Fidelity', () => {
    const dummyBuffer = new ArrayBuffer(100);

    it('should use DateTimeOriginal as captureDate when present', async () => {
      const originalDate = new Date('2023-06-15T14:30:00.000Z');
      const digitizedDate = new Date('2023-06-15T15:00:00.000Z');

      parseExifSpy.and.resolveTo({
        DateTimeOriginal: originalDate,
        DateTimeDigitized: digitizedDate,
        Make: 'Canon',
        Model: 'EOS R5',
      });

      const result = await service.extract(dummyBuffer);

      expect(result.captureDate).toBe(originalDate.toISOString());
    });

    it('should use DateTimeDigitized as captureDate when DateTimeOriginal is absent', async () => {
      const digitizedDate = new Date('2023-08-20T10:00:00.000Z');

      parseExifSpy.and.resolveTo({
        DateTimeDigitized: digitizedDate,
        Make: 'Nikon',
        Model: 'Z6',
      });

      const result = await service.extract(dummyBuffer);

      expect(result.captureDate).toBe(digitizedDate.toISOString());
    });

    it('should return null captureDate when both date fields are absent', async () => {
      parseExifSpy.and.resolveTo({
        Make: 'Sony',
        Model: 'A7III',
      });

      const result = await service.extract(dummyBuffer);

      expect(result.captureDate).toBeNull();
    });

    it('should map Make and Model to cameraMake and cameraModel', async () => {
      parseExifSpy.and.resolveTo({
        DateTimeOriginal: new Date('2024-01-01T00:00:00.000Z'),
        Make: 'Fujifilm',
        Model: 'X-T5',
      });

      const result = await service.extract(dummyBuffer);

      expect(result.cameraMake).toBe('Fujifilm');
      expect(result.cameraModel).toBe('X-T5');
    });

    it('should return null cameraMake and cameraModel when Make and Model are absent', async () => {
      parseExifSpy.and.resolveTo({
        DateTimeOriginal: new Date('2024-01-01T00:00:00.000Z'),
      });

      const result = await service.extract(dummyBuffer);

      expect(result.cameraMake).toBeNull();
      expect(result.cameraModel).toBeNull();
    });

    it('should return all null fields when exifr throws an error', async () => {
      parseExifSpy.and.rejectWith(new Error('Corrupted image data'));

      const result = await service.extract(dummyBuffer);

      expect(result.captureDate).toBeNull();
      expect(result.cameraMake).toBeNull();
      expect(result.cameraModel).toBeNull();
    });

    it('should return all null fields when exifr returns null', async () => {
      parseExifSpy.and.resolveTo(null);

      const result = await service.extract(dummyBuffer);

      expect(result.captureDate).toBeNull();
      expect(result.cameraMake).toBeNull();
      expect(result.cameraModel).toBeNull();
    });
  });
});
