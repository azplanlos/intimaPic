import { TestBed } from '@angular/core/testing';
import { PhotoService, PhotoItem } from './photo.service';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import { HeicConverterService } from '../upload/heic-converter.service';
import { SwClientService, SwError } from '../sw-client/sw-client.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import type { CachedPhotoEntry } from '../../../service-worker/models/responses';

describe('PhotoService', () => {
  let service: PhotoService;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let swClientSpy: jasmine.SpyObj<SwClientService>;
  let vaultServiceSpy: jasmine.SpyObj<VaultService>;
  let storageMock: jasmine.SpyObj<StorageAdapter>;
  let heicSpy: jasmine.SpyObj<HeicConverterService>;

  beforeEach(() => {
    storageMock = jasmine.createSpyObj<StorageAdapter>('StorageAdapter', [
      'listFiles', 'readFile', 'writeFile', 'createFolder', 'deleteFolder', 'deleteFile',
      'connect', 'disconnect', 'isConnected', 'fileExists', 'getQuota',
    ]);

    cryptoSpy = jasmine.createSpyObj<CryptoService>('CryptoService', [
      'encryptDirectoryId', 'decryptFilename', 'decryptFile',
    ]);

    swClientSpy = jasmine.createSpyObj<SwClientService>('SwClientService', [
      'listPhotos', 'getThumbnail', 'getFile',
    ]);

    vaultServiceSpy = jasmine.createSpyObj<VaultService>('VaultService', ['getStorage']);
    vaultServiceSpy.getStorage.and.returnValue(storageMock);

    heicSpy = jasmine.createSpyObj<HeicConverterService>('HeicConverterService', ['ensureDisplayable']);
    heicSpy.ensureDisplayable.and.callFake(async (blob: Blob) => blob);

    TestBed.configureTestingModule({
      providers: [
        PhotoService,
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: VaultService, useValue: vaultServiceSpy },
        { provide: SwClientService, useValue: swClientSpy },
        { provide: HeicConverterService, useValue: heicSpy },
      ],
    });

    service = TestBed.inject(PhotoService);
  });

  afterEach(() => {
    service.clearCache();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('listPhotos', () => {
    it('should return photo items from SW response', async () => {
      const entries: CachedPhotoEntry[] = [
        { encryptedName: 'enc1.c9r', name: 'photo1.jpg', storagePath: 'd/AB/ALBUMHASH/enc1.c9r', size: 5000, lastModified: '2024-01-01T00:00:00Z' },
        { encryptedName: 'enc2.c9r', name: 'photo2.png', storagePath: 'd/AB/ALBUMHASH/enc2.c9r', size: 3000, lastModified: '2024-01-02T00:00:00Z' },
      ];
      swClientSpy.listPhotos.and.resolveTo({ photos: entries, fromCache: false });

      const photos = await service.listPhotos('album-dir-id');

      expect(photos.length).toBe(2);
      expect(photos[0].name).toBe('photo1.jpg');
      expect(photos[0].encryptedName).toBe('enc1.c9r');
      expect(photos[0].storagePath).toBe('d/AB/ALBUMHASH/enc1.c9r');
      expect(photos[0].size).toBe(5000);
      expect(photos[1].name).toBe('photo2.png');
    });

    it('should populate existing in-memory blob URLs from cache', async () => {
      // First call to populate the thumbnail cache
      const fakeEncrypted = new ArrayBuffer(100);
      const fakeDecrypted = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer as ArrayBuffer;
      swClientSpy.getThumbnail.and.resolveTo({ data: fakeEncrypted, fromCache: true });
      cryptoSpy.decryptFile.and.resolveTo(fakeDecrypted);

      const photo: PhotoItem = {
        encryptedName: 'enc1.c9r', name: 'photo1.jpg',
        storagePath: 'd/AB/HASH/enc1.c9r', thumbnailUrl: null,
        previewUrl: null, fullResUrl: null, loading: false, size: 5000,
      };
      await service.decryptThumbnail(photo, 'dir-id', 'grid');

      // Now listPhotos should include the cached URL
      swClientSpy.listPhotos.and.resolveTo({
        photos: [{ encryptedName: 'enc1.c9r', name: 'photo1.jpg', storagePath: 'd/AB/HASH/enc1.c9r', size: 5000, lastModified: '' }],
        fromCache: false,
      });

      const photos = await service.listPhotos('dir-id');
      expect(photos[0].thumbnailUrl).toMatch(/^blob:/);
    });
  });

  describe('decryptThumbnail', () => {
    it('should fetch encrypted thumbnail from SW and decrypt locally', async () => {
      const photo: PhotoItem = {
        encryptedName: 'abc123.c9r',
        name: 'photo.jpg',
        storagePath: 'd/AB/HASH/abc123.c9r',
        thumbnailUrl: null,
        previewUrl: null,
        fullResUrl: null,
        loading: false,
        size: 5000,
      };

      const fakeEncrypted = new ArrayBuffer(100);
      const fakeJpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer as ArrayBuffer;
      swClientSpy.getThumbnail.and.resolveTo({ data: fakeEncrypted, fromCache: false });
      cryptoSpy.decryptFile.and.resolveTo(fakeJpeg);

      const url = await service.decryptThumbnail(photo, 'album-dir-id', 'grid');

      expect(swClientSpy.getThumbnail).toHaveBeenCalledWith('abc123.c9r', 'album-dir-id', 'grid');
      expect(cryptoSpy.decryptFile).toHaveBeenCalledWith(fakeEncrypted);
      expect(url).toMatch(/^blob:/);
    });

    it('should return cached URL on second call without fetching again', async () => {
      const photo: PhotoItem = {
        encryptedName: 'cached.c9r',
        name: 'photo.jpg',
        storagePath: 'd/AB/HASH/cached.c9r',
        thumbnailUrl: null,
        previewUrl: null,
        fullResUrl: null,
        loading: false,
        size: 1000,
      };

      swClientSpy.getThumbnail.and.resolveTo({ data: new ArrayBuffer(50), fromCache: true });
      cryptoSpy.decryptFile.and.resolveTo(new ArrayBuffer(10));

      const url1 = await service.decryptThumbnail(photo, 'dir-id', 'grid');
      const url2 = await service.decryptThumbnail(photo, 'dir-id', 'grid');

      expect(url1).toBe(url2);
      // Should only have called SW once
      expect(swClientSpy.getThumbnail).toHaveBeenCalledTimes(1);
    });

    it('should fall back to direct storage when thumbnail not found', async () => {
      const photo: PhotoItem = {
        encryptedName: 'nothumbs.c9r',
        name: 'photo.jpg',
        storagePath: 'd/AB/HASH/nothumbs.c9r',
        thumbnailUrl: null,
        previewUrl: null,
        fullResUrl: null,
        loading: false,
        size: 1000,
      };

      // SW returns FILE_NOT_FOUND for thumbnail
      swClientSpy.getThumbnail.and.rejectWith(new SwError('FILE_NOT_FOUND', 'Thumbnail not found'));
      // Direct storage fallback: thumbnail also not found → falls back to original
      storageMock.readFile.and.callFake(async (path: string) => {
        if (path.includes('.grid')) throw new Error('not found');
        return new ArrayBuffer(50); // original file
      });
      cryptoSpy.decryptFile.and.resolveTo(new ArrayBuffer(10));

      const url = await service.decryptThumbnail(photo, 'dir-id', 'grid');
      expect(url).toMatch(/^blob:/);
      // Should have tried the direct thumbnail path first, then original
      expect(storageMock.readFile).toHaveBeenCalledWith('_intimapic/thumbs/dir-id/nothumbs.grid', undefined);
    });

    it('should re-throw AbortError without falling back', async () => {
      const photo: PhotoItem = {
        encryptedName: 'abort.c9r',
        name: 'photo.jpg',
        storagePath: 'd/AB/HASH/abort.c9r',
        thumbnailUrl: null,
        previewUrl: null,
        fullResUrl: null,
        loading: false,
        size: 1000,
      };

      swClientSpy.getThumbnail.and.rejectWith(new DOMException('Aborted', 'AbortError'));

      await expectAsync(
        service.decryptThumbnail(photo, 'dir-id', 'grid')
      ).toBeRejectedWithError('Aborted');
    });
  });

  describe('decryptOriginal', () => {
    it('should fetch encrypted original from SW and decrypt', async () => {
      const photo: PhotoItem = {
        encryptedName: 'orig.c9r',
        name: 'photo.jpg',
        storagePath: 'd/AB/HASH/orig.c9r',
        thumbnailUrl: null,
        previewUrl: null,
        fullResUrl: null,
        loading: false,
        size: 5000000,
      };

      swClientSpy.getFile.and.resolveTo(new ArrayBuffer(5000));
      cryptoSpy.decryptFile.and.resolveTo(new ArrayBuffer(4000));

      const url = await service.decryptOriginal(photo);

      expect(swClientSpy.getFile).toHaveBeenCalledWith('d/AB/HASH/orig.c9r');
      expect(cryptoSpy.decryptFile).toHaveBeenCalled();
      expect(url).toMatch(/^blob:/);
    });
  });

  describe('clearCache', () => {
    it('should clear all cached thumbnails', async () => {
      const photo: PhotoItem = {
        encryptedName: 'test.c9r',
        name: 'photo.jpg',
        storagePath: 'd/AB/HASH/test.c9r',
        thumbnailUrl: null,
        previewUrl: null,
        fullResUrl: null,
        loading: false,
        size: 1000,
      };

      swClientSpy.getThumbnail.and.resolveTo({ data: new ArrayBuffer(50), fromCache: true });
      cryptoSpy.decryptFile.and.resolveTo(new ArrayBuffer(10));

      await service.decryptThumbnail(photo, 'dir-id', 'grid');
      service.clearCache();

      // After clearing, should fetch again
      await service.decryptThumbnail(photo, 'dir-id', 'grid');
      expect(swClientSpy.getThumbnail).toHaveBeenCalledTimes(2);
    });
  });
});
