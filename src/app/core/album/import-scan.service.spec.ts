import { TestBed } from '@angular/core/testing';
import { ImportScanService, UnsortedPhoto } from './import-scan.service';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import type { FileEntry } from '../crypto/crypto.models';

describe('ImportScanService', () => {
  let service: ImportScanService;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let vaultServiceSpy: jasmine.SpyObj<VaultService>;
  let storageMock: jasmine.SpyObj<StorageAdapter>;

  beforeEach(() => {
    storageMock = jasmine.createSpyObj<StorageAdapter>('StorageAdapter', [
      'listFiles', 'readFile', 'writeFile', 'createFolder', 'deleteFolder', 'deleteFile',
      'connect', 'disconnect', 'isConnected', 'fileExists', 'getQuota',
    ]);

    cryptoSpy = jasmine.createSpyObj<CryptoService>('CryptoService', [
      'encryptDirectoryId', 'encryptFilename', 'decryptFilename', 'encryptFile',
    ]);

    vaultServiceSpy = jasmine.createSpyObj<VaultService>('VaultService', ['getStorage']);
    vaultServiceSpy.getStorage.and.returnValue(storageMock);

    TestBed.configureTestingModule({
      providers: [
        ImportScanService,
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: VaultService, useValue: vaultServiceSpy },
      ],
    });

    service = TestBed.inject(ImportScanService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('scanRoot', () => {
    it('should find encrypted .c9r photo files in root', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOTHASH');

      // Cryptomator root entries
      const rootEntries: FileEntry[] = [
        { encryptedName: 'photo1.c9r', path: '', size: 5000, lastModified: new Date(), isDirectory: false },
        { encryptedName: 'album.c9r', path: '', size: 0, lastModified: new Date(), isDirectory: true },
      ];
      storageMock.listFiles.and.callFake(async (path: string) => {
        if (path === 'd/AB/ROOTHASH') return rootEntries;
        return [];
      });

      cryptoSpy.decryptFilename.and.resolveTo('vacation.jpg');

      const found = await service.scanRoot();
      expect(found).toBeTrue();
      expect(service.unsortedPhotos().length).toBe(1);
      expect(service.unsortedPhotos()[0].name).toBe('vacation.jpg');
      expect(service.unsortedPhotos()[0].isEncrypted).toBeTrue();
    });

    it('should find unencrypted image files in storage root', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOTHASH');

      storageMock.listFiles.and.callFake(async (path: string) => {
        if (path === 'd/AB/ROOTHASH') return [];
        if (path === '') return [
          { encryptedName: 'direct-photo.jpg', path: '', size: 2000, lastModified: new Date(), isDirectory: false },
          { encryptedName: 'document.pdf', path: '', size: 1000, lastModified: new Date(), isDirectory: false },
        ];
        return [];
      });

      const found = await service.scanRoot();
      expect(found).toBeTrue();

      const photos = service.unsortedPhotos();
      expect(photos.length).toBe(1);
      expect(photos[0].name).toBe('direct-photo.jpg');
      expect(photos[0].isEncrypted).toBeFalse();
    });

    it('should return false when no unsorted photos found', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      storageMock.listFiles.and.resolveTo([]);

      const found = await service.scanRoot();
      expect(found).toBeFalse();
      expect(service.unsortedPhotos().length).toBe(0);
    });

    it('should not scan while already scanning', async () => {
      cryptoSpy.encryptDirectoryId.and.callFake(async () => {
        // Simulate slow operation
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'd/AB/ROOT';
      });
      storageMock.listFiles.and.resolveTo([]);

      // Start two scans simultaneously
      const scan1 = service.scanRoot();
      const scan2 = service.scanRoot();

      const [result1, result2] = await Promise.all([scan1, scan2]);
      // Second scan should return false immediately (already scanning)
      expect(result2).toBeFalse();
    });

    it('should set scanning signal during scan', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      storageMock.listFiles.and.callFake(async () => {
        expect(service.scanning()).toBeTrue();
        return [];
      });

      await service.scanRoot();
      expect(service.scanning()).toBeFalse();
    });

    it('should skip non-image .c9r files', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      storageMock.listFiles.and.callFake(async (path: string) => {
        if (path === 'd/AB/ROOT') return [
          { encryptedName: 'file.c9r', path: '', size: 100, lastModified: new Date(), isDirectory: false },
        ];
        return [];
      });
      cryptoSpy.decryptFilename.and.resolveTo('document.txt');

      const found = await service.scanRoot();
      expect(found).toBeFalse();
    });

    it('should recognize various image extensions', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      const imageFiles: FileEntry[] = [
        { encryptedName: 'photo.JPG', path: '', size: 100, lastModified: new Date(), isDirectory: false },
        { encryptedName: 'image.HEIC', path: '', size: 100, lastModified: new Date(), isDirectory: false },
        { encryptedName: 'pic.webp', path: '', size: 100, lastModified: new Date(), isDirectory: false },
        { encryptedName: 'anim.gif', path: '', size: 100, lastModified: new Date(), isDirectory: false },
        { encryptedName: 'shot.png', path: '', size: 100, lastModified: new Date(), isDirectory: false },
      ];
      storageMock.listFiles.and.callFake(async (path: string) => {
        if (path === '') return imageFiles;
        return [];
      });

      const found = await service.scanRoot();
      expect(found).toBeTrue();
      expect(service.unsortedPhotos().length).toBe(5);
    });
  });

  describe('moveToAlbum (encrypted)', () => {
    it('should move encrypted file to target album', async () => {
      const photo: UnsortedPhoto = {
        encryptedName: 'old-enc.c9r',
        name: 'photo.jpg',
        storagePath: 'd/AB/ROOT/old-enc.c9r',
        size: 1000,
        isEncrypted: true,
      };

      storageMock.readFile.and.resolveTo(new ArrayBuffer(100));
      storageMock.fileExists.and.resolveTo(false);
      cryptoSpy.encryptFilename.and.resolveTo('new-enc.c9r');
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/CD/ALBUMHASH');
      storageMock.createFolder.and.resolveTo();
      storageMock.writeFile.and.resolveTo();
      storageMock.deleteFile.and.resolveTo();

      // Pre-populate unsortedPhotos
      (service as any)._unsortedPhotos.set([photo]);

      await service.moveToAlbum(photo, 'target-album-id');

      expect(storageMock.readFile).toHaveBeenCalledWith('d/AB/ROOT/old-enc.c9r');
      expect(storageMock.writeFile).toHaveBeenCalledWith('d/CD/ALBUMHASH/new-enc.c9r', jasmine.any(ArrayBuffer));
      expect(storageMock.deleteFile).toHaveBeenCalledWith('d/AB/ROOT/old-enc.c9r');
      expect(service.unsortedPhotos().length).toBe(0);
    });
  });

  describe('moveToAlbum (unencrypted)', () => {
    it('should encrypt and move unencrypted file to target album', async () => {
      const photo: UnsortedPhoto = {
        encryptedName: '',
        name: 'direct-upload.jpg',
        storagePath: 'direct-upload.jpg',
        size: 2000,
        isEncrypted: false,
      };

      storageMock.readFile.and.resolveTo(new ArrayBuffer(200));
      storageMock.fileExists.and.resolveTo(false);
      cryptoSpy.encryptFile.and.resolveTo(new ArrayBuffer(300));
      cryptoSpy.encryptFilename.and.resolveTo('encrypted.c9r');
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/EF/TARGETDIR');
      storageMock.createFolder.and.resolveTo();
      storageMock.writeFile.and.resolveTo();
      storageMock.deleteFile.and.resolveTo();

      (service as any)._unsortedPhotos.set([photo]);

      await service.moveToAlbum(photo, 'album-uuid');

      expect(cryptoSpy.encryptFile).toHaveBeenCalled();
      expect(storageMock.writeFile).toHaveBeenCalledWith('d/EF/TARGETDIR/encrypted.c9r', jasmine.any(ArrayBuffer));
      expect(storageMock.deleteFile).toHaveBeenCalledWith('direct-upload.jpg');
      expect(service.unsortedPhotos().length).toBe(0);
    });
  });

  describe('hasUnsortedPhotos', () => {
    it('should return false when empty', () => {
      expect(service.hasUnsortedPhotos()).toBeFalse();
    });

    it('should return true when photos are set', () => {
      (service as any)._unsortedPhotos.set([{
        encryptedName: 'x.c9r',
        name: 'test.jpg',
        storagePath: 'd/AB/ROOT/x.c9r',
        size: 100,
        isEncrypted: true,
      }]);
      expect(service.hasUnsortedPhotos()).toBeTrue();
    });
  });

  describe('clear', () => {
    it('should clear unsorted photos', () => {
      (service as any)._unsortedPhotos.set([{
        encryptedName: 'x.c9r',
        name: 'test.jpg',
        storagePath: 'd/AB/ROOT/x.c9r',
        size: 100,
        isEncrypted: true,
      }]);

      service.clear();
      expect(service.unsortedPhotos().length).toBe(0);
    });
  });
});
