import { TestBed } from '@angular/core/testing';
import { PhotoService, PhotoItem } from './photo.service';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import { HeicConverterService } from '../upload/heic-converter.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import type { FileEntry } from '../crypto/crypto.models';

describe('PhotoService', () => {
  let service: PhotoService;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let vaultServiceSpy: jasmine.SpyObj<VaultService>;
  let heicSpy: jasmine.SpyObj<HeicConverterService>;
  let storageMock: jasmine.SpyObj<StorageAdapter>;

  beforeEach(() => {
    storageMock = jasmine.createSpyObj<StorageAdapter>('StorageAdapter', [
      'listFiles', 'readFile', 'writeFile', 'createFolder', 'deleteFolder', 'deleteFile',
      'connect', 'disconnect', 'isConnected', 'fileExists', 'getQuota',
    ]);

    cryptoSpy = jasmine.createSpyObj<CryptoService>('CryptoService', [
      'encryptDirectoryId', 'decryptFilename', 'decryptFile',
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
    it('should list and decrypt photo filenames', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ALBUMHASH');

      const entries: FileEntry[] = [
        { encryptedName: 'enc1.c9r', path: '', size: 5000, lastModified: new Date(), isDirectory: false },
        { encryptedName: 'enc2.c9r', path: '', size: 3000, lastModified: new Date(), isDirectory: false },
      ];
      storageMock.listFiles.and.resolveTo(entries);

      cryptoSpy.decryptFilename.and.callFake(async (name: string) => {
        if (name === 'enc1.c9r') return 'photo1.jpg';
        return 'photo2.png';
      });

      const photos = await service.listPhotos('album-dir-id');

      expect(photos.length).toBe(2);
      expect(photos[0].name).toBe('photo1.jpg');
      expect(photos[0].encryptedName).toBe('enc1.c9r');
      expect(photos[0].storagePath).toBe('d/AB/ALBUMHASH/enc1.c9r');
      expect(photos[0].size).toBe(5000);
      expect(photos[1].name).toBe('photo2.png');
    });

    it('should skip directories', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/HASH');
      storageMock.listFiles.and.resolveTo([
        { encryptedName: 'subdir.c9r', path: '', size: 0, lastModified: new Date(), isDirectory: true },
      ]);

      const photos = await service.listPhotos('dir-id');
      expect(photos.length).toBe(0);
    });

    it('should skip non-.c9r files', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/HASH');
      storageMock.listFiles.and.resolveTo([
        { encryptedName: 'somefile.txt', path: '', size: 100, lastModified: new Date(), isDirectory: false },
      ]);

      const photos = await service.listPhotos('dir-id');
      expect(photos.length).toBe(0);
    });

    it('should skip non-image files after decryption', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/HASH');
      storageMock.listFiles.and.resolveTo([
        { encryptedName: 'enc.c9r', path: '', size: 100, lastModified: new Date(), isDirectory: false },
      ]);
      cryptoSpy.decryptFilename.and.resolveTo('document.pdf');

      const photos = await service.listPhotos('dir-id');
      expect(photos.length).toBe(0);
    });

    it('should skip files that fail to decrypt', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/HASH');
      storageMock.listFiles.and.resolveTo([
        { encryptedName: 'broken.c9r', path: '', size: 100, lastModified: new Date(), isDirectory: false },
      ]);
      cryptoSpy.decryptFilename.and.rejectWith(new Error('decrypt failed'));

      const photos = await service.listPhotos('dir-id');
      expect(photos.length).toBe(0);
    });
  });

  describe('decryptThumbnail', () => {
    it('should read and decrypt thumbnail from _intimapic/thumbs/', async () => {
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

      const fakeJpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer as ArrayBuffer;
      storageMock.readFile.and.resolveTo(new ArrayBuffer(100));
      cryptoSpy.decryptFile.and.resolveTo(fakeJpeg);

      const url = await service.decryptThumbnail(photo, 'album-dir-id', 'grid');

      expect(storageMock.readFile).toHaveBeenCalledWith('_intimapic/thumbs/album-dir-id/abc123.grid', undefined);
      expect(cryptoSpy.decryptFile).toHaveBeenCalled();
      expect(url).toMatch(/^blob:/);
    });

    it('should use _root as directory for root photos', async () => {
      const photo: PhotoItem = {
        encryptedName: 'xyz.c9r',
        name: 'photo.jpg',
        storagePath: 'd/AB/HASH/xyz.c9r',
        thumbnailUrl: null,
        previewUrl: null,
        fullResUrl: null,
        loading: false,
        size: 1000,
      };

      storageMock.readFile.and.resolveTo(new ArrayBuffer(50));
      cryptoSpy.decryptFile.and.resolveTo(new ArrayBuffer(10));

      await service.decryptThumbnail(photo, '', 'grid');

      expect(storageMock.readFile).toHaveBeenCalledWith('_intimapic/thumbs/_root/xyz.grid', undefined);
    });

    it('should return cached URL on second call', async () => {
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

      storageMock.readFile.and.resolveTo(new ArrayBuffer(50));
      cryptoSpy.decryptFile.and.resolveTo(new ArrayBuffer(10));

      const url1 = await service.decryptThumbnail(photo, 'dir-id', 'grid');
      const url2 = await service.decryptThumbnail(photo, 'dir-id', 'grid');

      expect(url1).toBe(url2);
      // Should only have read file once
      expect(storageMock.readFile).toHaveBeenCalledTimes(1);
    });

    it('should fall back to decrypting original when thumbnail not found', async () => {
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

      // First readFile (thumbnail) throws, second (original) succeeds
      let callCount = 0;
      storageMock.readFile.and.callFake(async () => {
        callCount++;
        if (callCount === 1) throw new Error('not found');
        return new ArrayBuffer(50);
      });
      cryptoSpy.decryptFile.and.resolveTo(new ArrayBuffer(10));

      const url = await service.decryptThumbnail(photo, 'dir-id', 'grid');
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

      storageMock.readFile.and.resolveTo(new ArrayBuffer(50));
      cryptoSpy.decryptFile.and.resolveTo(new ArrayBuffer(10));

      await service.decryptThumbnail(photo, 'dir-id', 'grid');
      service.clearCache();

      // After clearing, should fetch again
      await service.decryptThumbnail(photo, 'dir-id', 'grid');
      expect(storageMock.readFile).toHaveBeenCalledTimes(2);
    });
  });
});
