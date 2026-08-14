import { TestBed } from '@angular/core/testing';
import { AlbumService, Album } from './album.service';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import { SwClientService, SwError } from '../sw-client/sw-client.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import type { FileEntry } from '../crypto/crypto.models';
import type { CachedAlbum } from '../../../service-worker/models/responses';

describe('AlbumService', () => {
  let service: AlbumService;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;
  let vaultServiceSpy: jasmine.SpyObj<VaultService>;
  let swClientSpy: jasmine.SpyObj<SwClientService>;
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

    swClientSpy = jasmine.createSpyObj<SwClientService>('SwClientService', [
      'listAlbums', 'createFolder', 'writeFile', 'deleteFolder', 'invalidateCache',
    ]);

    TestBed.configureTestingModule({
      providers: [
        AlbumService,
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: VaultService, useValue: vaultServiceSpy },
        { provide: SwClientService, useValue: swClientSpy },
      ],
    });

    service = TestBed.inject(AlbumService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('loadAlbums', () => {
    it('should return albums from SwClientService', async () => {
      const cachedAlbums: CachedAlbum[] = [
        { name: 'Mein Album', directoryId: 'uuid-album-123', storagePath: 'd/CD/ALBUMPATH', encryptedName: 'encrypted-album.c9r' },
      ];
      swClientSpy.listAlbums.and.resolveTo({ albums: cachedAlbums, fromCache: false });

      const albums = await service.loadAlbums();

      expect(albums.length).toBe(1);
      expect(albums[0].name).toBe('Mein Album');
      expect(albums[0].directoryId).toBe('uuid-album-123');
      expect(albums[0].storagePath).toBe('d/CD/ALBUMPATH');
      expect(albums[0].encryptedName).toBe('encrypted-album.c9r');
    });

    it('should return empty array when no albums exist', async () => {
      swClientSpy.listAlbums.and.resolveTo({ albums: [], fromCache: false });

      const albums = await service.loadAlbums();
      expect(albums).toEqual([]);
      expect(service.albums()).toEqual([]);
    });

    it('should update the albums signal', async () => {
      const cachedAlbums: CachedAlbum[] = [
        { name: 'Album 1', directoryId: 'dir-1', storagePath: 'd/AB/PATH1', encryptedName: 'enc1.c9r' },
        { name: 'Album 2', directoryId: 'dir-2', storagePath: 'd/CD/PATH2', encryptedName: 'enc2.c9r' },
      ];
      swClientSpy.listAlbums.and.resolveTo({ albums: cachedAlbums, fromCache: true });

      await service.loadAlbums();
      expect(service.albums().length).toBe(2);
      expect(service.albums()[0].name).toBe('Album 1');
      expect(service.albums()[1].name).toBe('Album 2');
    });

    it('should fall back to direct storage when SW is not ready', async () => {
      // SW not ready → SwError
      swClientSpy.listAlbums.and.rejectWith(new SwError('SW_NOT_READY', 'ServiceWorker is not active.'));

      // Fallback uses VaultService.getStorage()
      cryptoSpy.encryptDirectoryId.and.callFake(async (id: string) => {
        if (id === '') return 'd/AB/ROOTPATH';
        return 'd/CD/ALBUMPATH';
      });

      const entries: FileEntry[] = [
        { encryptedName: 'encrypted-album.c9r', path: '', size: 0, lastModified: new Date(), isDirectory: true },
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
    });

    it('should fall back to direct storage on TOKEN_EXPIRED', async () => {
      swClientSpy.listAlbums.and.rejectWith(new SwError('TOKEN_EXPIRED', 'No token'));

      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      storageMock.listFiles.and.resolveTo([]);

      const albums = await service.loadAlbums();
      expect(albums).toEqual([]);
    });

    it('should pass forceRefresh to SW', async () => {
      swClientSpy.listAlbums.and.resolveTo({ albums: [], fromCache: false });

      await service.loadAlbums(true);

      expect(swClientSpy.listAlbums).toHaveBeenCalledWith(true);
    });
  });

  describe('createAlbum', () => {
    it('should create album folder structure via SwClientService', async () => {
      cryptoSpy.encryptDirectoryId.and.callFake(async (id: string) => {
        if (id === '') return 'd/AB/ROOT';
        return 'd/EF/NEWHASH';
      });
      cryptoSpy.encryptFilename.and.resolveTo('encrypted-name.c9r');
      swClientSpy.createFolder.and.resolveTo();
      swClientSpy.writeFile.and.resolveTo();
      swClientSpy.invalidateCache.and.resolveTo();

      const album = await service.createAlbum('Urlaub 2024');

      expect(album.name).toBe('Urlaub 2024');
      expect(album.directoryId).toBeTruthy();
      expect(album.storagePath).toBe('d/EF/NEWHASH');
      expect(album.encryptedName).toBe('encrypted-name.c9r');

      // Should have created .c9r folder in root
      expect(swClientSpy.createFolder).toHaveBeenCalledWith('d/AB/ROOT/encrypted-name.c9r');
      // Should have written dir.c9r
      expect(swClientSpy.writeFile).toHaveBeenCalled();
    });

    it('should add the album to the signal', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      cryptoSpy.encryptFilename.and.resolveTo('enc.c9r');
      swClientSpy.createFolder.and.resolveTo();
      swClientSpy.writeFile.and.resolveTo();
      swClientSpy.invalidateCache.and.resolveTo();

      expect(service.albums().length).toBe(0);
      await service.createAlbum('Test');
      expect(service.albums().length).toBe(1);
      expect(service.albums()[0].name).toBe('Test');
    });

    it('should write the directory ID into dir.c9r', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      cryptoSpy.encryptFilename.and.resolveTo('enc.c9r');
      swClientSpy.createFolder.and.resolveTo();
      swClientSpy.writeFile.and.resolveTo();
      swClientSpy.invalidateCache.and.resolveTo();

      const album = await service.createAlbum('Test');

      const writeCall = swClientSpy.writeFile.calls.first();
      expect(writeCall.args[0]).toBe('d/AB/ROOT/enc.c9r/dir.c9r');

      const writtenData = new TextDecoder().decode(writeCall.args[1]);
      expect(writtenData).toBe(album.directoryId);
    });

    it('should invalidate directory cache after creation', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      cryptoSpy.encryptFilename.and.resolveTo('enc.c9r');
      swClientSpy.createFolder.and.resolveTo();
      swClientSpy.writeFile.and.resolveTo();
      swClientSpy.invalidateCache.and.resolveTo();

      await service.createAlbum('Test');

      expect(swClientSpy.invalidateCache).toHaveBeenCalledWith('directory', '_albums');
    });
  });

  describe('deleteAlbum', () => {
    it('should delete album content directory and .c9r folder via SwClientService', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      swClientSpy.deleteFolder.and.resolveTo();
      swClientSpy.invalidateCache.and.resolveTo();

      const album: Album = {
        name: 'Delete Me',
        directoryId: 'dir-to-delete',
        storagePath: 'd/CD/ALBUMHASH',
        encryptedName: 'encrypted.c9r',
      };

      await service.deleteAlbum(album);

      expect(swClientSpy.deleteFolder).toHaveBeenCalledWith('d/CD/ALBUMHASH');
      expect(swClientSpy.deleteFolder).toHaveBeenCalledWith('d/AB/ROOT/encrypted.c9r');
    });

    it('should remove album from signal', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      cryptoSpy.encryptFilename.and.resolveTo('enc.c9r');
      swClientSpy.createFolder.and.resolveTo();
      swClientSpy.writeFile.and.resolveTo();
      swClientSpy.deleteFolder.and.resolveTo();
      swClientSpy.invalidateCache.and.resolveTo();

      const album = await service.createAlbum('To Remove');
      expect(service.albums().length).toBe(1);

      await service.deleteAlbum(album);
      expect(service.albums().length).toBe(0);
    });

    it('should not throw when content directory is already deleted', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      swClientSpy.deleteFolder.and.callFake(async (path: string) => {
        if (path === 'd/CD/ALBUMHASH') throw new Error('not found');
      });
      swClientSpy.invalidateCache.and.resolveTo();

      const album: Album = {
        name: 'Test',
        directoryId: 'test',
        storagePath: 'd/CD/ALBUMHASH',
        encryptedName: 'enc.c9r',
      };

      await expectAsync(service.deleteAlbum(album)).toBeResolved();
    });

    it('should invalidate caches after deletion', async () => {
      cryptoSpy.encryptDirectoryId.and.resolveTo('d/AB/ROOT');
      swClientSpy.deleteFolder.and.resolveTo();
      swClientSpy.invalidateCache.and.resolveTo();

      const album: Album = {
        name: 'Test',
        directoryId: 'my-dir-id',
        storagePath: 'd/CD/HASH',
        encryptedName: 'enc.c9r',
      };

      await service.deleteAlbum(album);

      expect(swClientSpy.invalidateCache).toHaveBeenCalledWith('directory', '_albums');
      expect(swClientSpy.invalidateCache).toHaveBeenCalledWith('directory', 'my-dir-id');
    });
  });

  describe('getRootDirectoryId', () => {
    it('should return empty string for root', () => {
      expect(service.getRootDirectoryId()).toBe('');
    });
  });
});
