import { TestBed } from '@angular/core/testing';
import { AlbumService, Album } from './album.service';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import type { FileEntry } from '../crypto/crypto.models';

describe('AlbumService', () => {
  let service: AlbumService;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let vaultServiceSpy: jasmine.SpyObj<VaultService>;
  let storageMock: jasmine.SpyObj<StorageAdapter>;

  beforeEach(() => {
    storageMock = jasmine.createSpyObj<StorageAdapter>('StorageAdapter', [
      'listFiles', 'readFile', 'writeFile', 'createFolder', 'deleteFolder', 'deleteFile',
      'connect', 'disconnect', 'isConnected', 'fileExists', 'getQuota',
    ]);

    cryptoSpy = jasmine.createSpyObj<CryptoService>('CryptoService', [
      'encryptDirectoryId', 'encryptFilename', 'decryptFilename',
    ]);

    vaultServiceSpy = jasmine.createSpyObj<VaultService>('VaultService', ['getStorage']);
    vaultServiceSpy.getStorage.and.returnValue(storageMock);

    TestBed.configureTestingModule({
      providers: [
        AlbumService,
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: VaultService, useValue: vaultServiceSpy },
      ],
    });

    service = TestBed.inject(AlbumService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('loadAlbums', () => {
    it('should return empty array when no entries exist', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOTPATH');
      storageMock.listFiles.and.resolveTo([]);

      const albums = await service.loadAlbums();
      expect(albums).toEqual([]);
      expect(service.albums()).toEqual([]);
    });

    it('should load albums from .c9r directories with dir.c9r', async () => {
      cryptoSpy.encryptDirectoryId.and.callFake(async (id: string) => {
        if (id === '') return 'd/AB/ROOTPATH';
        return 'd/CD/ALBUMPATH';
      });

      const entries: FileEntry[] = [
        { encryptedName: 'encrypted-album.c9r', path: '', size: 0, lastModified: new Date(), isDirectory: true },
        { encryptedName: 'photo.c9r', path: '', size: 1000, lastModified: new Date(), isDirectory: false },
      ];
      storageMock.listFiles.and.resolveTo(entries);

      storageMock.readFile.and.resolveTo(
        new TextEncoder().encode('uuid-album-123').buffer as ArrayBuffer
      );

      cryptoSpy.decryptFilename.and.resolveTo('Mein Album');

      const albums = await service.loadAlbums();

      expect(albums.length).toBe(1);
      expect(albums[0].name).toBe('Mein Album');
      expect(albums[0].directoryId).toBe('uuid-album-123');
      expect(albums[0].storagePath).toBe('d/CD/ALBUMPATH');
      expect(albums[0].encryptedName).toBe('encrypted-album.c9r');
    });

    it('should skip entries that cannot be decrypted', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      storageMock.listFiles.and.resolveTo([
        { encryptedName: 'corrupt.c9r', path: '', size: 0, lastModified: new Date(), isDirectory: true },
      ]);
      storageMock.readFile.and.resolveTo(new TextEncoder().encode('dir-id').buffer as ArrayBuffer);
      cryptoSpy.decryptFilename.and.rejectWith(new Error('decryption failed'));

      const albums = await service.loadAlbums();
      expect(albums.length).toBe(0);
    });

    it('should skip non-.c9r directories', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      storageMock.listFiles.and.resolveTo([
        { encryptedName: 'somefolder', path: '', size: 0, lastModified: new Date(), isDirectory: true },
      ]);

      const albums = await service.loadAlbums();
      expect(albums.length).toBe(0);
    });

    it('should update the albums signal', async () => {
      cryptoSpy.encryptDirectoryId.and.callFake(async (id: string) => {
        return id === '' ? 'd/AB/ROOT' : 'd/CD/ALBUM';
      });
      storageMock.listFiles.and.resolveTo([
        { encryptedName: 'enc.c9r', path: '', size: 0, lastModified: new Date(), isDirectory: true },
      ]);
      storageMock.readFile.and.resolveTo(new TextEncoder().encode('dir-123').buffer as ArrayBuffer);
      cryptoSpy.decryptFilename.and.resolveTo('Album 1');

      await service.loadAlbums();
      expect(service.albums().length).toBe(1);
      expect(service.albums()[0].name).toBe('Album 1');
    });
  });

  describe('createAlbum', () => {
    it('should create album folder structure', async () => {
      cryptoSpy.encryptDirectoryId.and.callFake(async (id: string) => {
        if (id === '') return 'd/AB/ROOT';
        return 'd/EF/NEWHASH';
      });
      cryptoSpy.encryptFilename.and.resolveTo('encrypted-name.c9r');
      storageMock.createFolder.and.resolveTo();
      storageMock.writeFile.and.resolveTo();

      const album = await service.createAlbum('Urlaub 2024');

      expect(album.name).toBe('Urlaub 2024');
      expect(album.directoryId).toBeTruthy();
      expect(album.storagePath).toBe('d/EF/NEWHASH');
      expect(album.encryptedName).toBe('encrypted-name.c9r');

      // Should have created .c9r folder in root
      expect(storageMock.createFolder).toHaveBeenCalledWith('d/AB/ROOT/encrypted-name.c9r');
      // Should have written dir.c9r
      expect(storageMock.writeFile).toHaveBeenCalled();
    });

    it('should add the album to the signal', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      cryptoSpy.encryptFilename.and.resolveTo('enc.c9r');
      storageMock.createFolder.and.resolveTo();
      storageMock.writeFile.and.resolveTo();

      expect(service.albums().length).toBe(0);
      await service.createAlbum('Test');
      expect(service.albums().length).toBe(1);
      expect(service.albums()[0].name).toBe('Test');
    });

    it('should write the directory ID into dir.c9r', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      cryptoSpy.encryptFilename.and.resolveTo('enc.c9r');
      storageMock.createFolder.and.resolveTo();
      storageMock.writeFile.and.resolveTo();

      const album = await service.createAlbum('Test');

      const writeCall = storageMock.writeFile.calls.first();
      expect(writeCall.args[0]).toBe('d/AB/ROOT/enc.c9r/dir.c9r');

      const writtenData = new TextDecoder().decode(writeCall.args[1]);
      expect(writtenData).toBe(album.directoryId);
    });
  });

  describe('deleteAlbum', () => {
    it('should delete album content directory and .c9r folder', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      storageMock.deleteFolder.and.resolveTo();

      const album: Album = {
        name: 'Delete Me',
        directoryId: 'dir-to-delete',
        storagePath: 'd/CD/ALBUMHASH',
        encryptedName: 'encrypted.c9r',
      };

      await service.deleteAlbum(album);

      expect(storageMock.deleteFolder).toHaveBeenCalledWith('d/CD/ALBUMHASH');
      expect(storageMock.deleteFolder).toHaveBeenCalledWith('d/AB/ROOT/encrypted.c9r');
    });

    it('should remove album from signal', async () => {
      cryptoSpy.encryptDirectoryId.and.callFake(async (id: string) => {
        return id === '' ? 'd/AB/ROOT' : 'd/CD/ALBUM';
      });
      cryptoSpy.encryptFilename.and.resolveTo('enc.c9r');
      storageMock.createFolder.and.resolveTo();
      storageMock.writeFile.and.resolveTo();
      storageMock.deleteFolder.and.resolveTo();

      const album = await service.createAlbum('To Remove');
      expect(service.albums().length).toBe(1);

      await service.deleteAlbum(album);
      expect(service.albums().length).toBe(0);
    });

    it('should not throw when content directory is already deleted', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      storageMock.deleteFolder.and.callFake(async (path: string) => {
        if (path === 'd/CD/ALBUMHASH') throw new Error('not found');
      });

      const album: Album = {
        name: 'Test',
        directoryId: 'test',
        storagePath: 'd/CD/ALBUMHASH',
        encryptedName: 'enc.c9r',
      };

      await expectAsync(service.deleteAlbum(album)).toBeResolved();
    });
  });

  describe('getRootDirectoryId', () => {
    it('should return empty string for root', () => {
      expect(service.getRootDirectoryId()).toBe('');
    });
  });
});
