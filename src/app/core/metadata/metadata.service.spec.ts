import { TestBed } from '@angular/core/testing';
import { MetadataService } from './metadata.service';
import { MetadataStore } from './metadata-store';
import { ExifExtractor } from './exif-extractor';
import { CryptoService } from '../crypto/crypto.service';
import { VaultService } from '../vault/vault.service';
import type { StorageAdapter } from '../storage/storage-adapter.interface';
import { MetadataRecord, VaultMetadataPayload } from './metadata.models';

describe('MetadataService', () => {
  let service: MetadataService;
  let storeMock: jasmine.SpyObj<MetadataStore>;
  let exifMock: jasmine.SpyObj<ExifExtractor>;
  let cryptoMock: jasmine.SpyObj<CryptoService>;
  let vaultServiceMock: jasmine.SpyObj<VaultService>;
  let storageMock: jasmine.SpyObj<StorageAdapter>;

  function makeRecord(photoId: string, updatedAt: number, overrides: Partial<MetadataRecord> = {}): MetadataRecord {
    return {
      photoId,
      captureDate: null,
      cameraMake: null,
      cameraModel: null,
      rating: null,
      isFavorite: false,
      updatedAt,
      ...overrides,
    };
  }

  beforeEach(() => {
    storageMock = jasmine.createSpyObj<StorageAdapter>('StorageAdapter', [
      'listFiles', 'readFile', 'writeFile', 'createFolder', 'deleteFolder',
      'deleteFile', 'connect', 'disconnect', 'isConnected', 'fileExists', 'getQuota',
    ]);

    storeMock = jasmine.createSpyObj<MetadataStore>('MetadataStore', [
      'open', 'get', 'getAll', 'getAllByCaptureDate', 'getBatch',
      'put', 'putBatch', 'delete', 'clear',
    ]);

    exifMock = jasmine.createSpyObj<ExifExtractor>('ExifExtractor', ['extract']);
    cryptoMock = jasmine.createSpyObj<CryptoService>('CryptoService', ['encryptFile', 'decryptFile']);
    vaultServiceMock = jasmine.createSpyObj<VaultService>('VaultService', ['getStorage']);
    vaultServiceMock.getStorage.and.returnValue(storageMock);

    TestBed.configureTestingModule({
      providers: [
        MetadataService,
        { provide: MetadataStore, useValue: storeMock },
        { provide: ExifExtractor, useValue: exifMock },
        { provide: CryptoService, useValue: cryptoMock },
        { provide: VaultService, useValue: vaultServiceMock },
      ],
    });

    service = TestBed.inject(MetadataService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('initialize', () => {
    it('should open store and populate cache from local records when remote does not exist', async () => {
      const localRecords = [makeRecord('photo1', 100), makeRecord('photo2', 200)];
      storeMock.open.and.resolveTo();
      storeMock.getAll.and.resolveTo(localRecords);
      storageMock.fileExists.and.resolveTo(false);
      storeMock.putBatch.and.resolveTo();

      await service.initialize();

      expect(storeMock.open).toHaveBeenCalled();
      expect(storeMock.getAll).toHaveBeenCalled();
      expect(storageMock.fileExists).toHaveBeenCalledWith('_intimapic/metadata.enc');
      expect(storeMock.putBatch).toHaveBeenCalledWith(localRecords);
    });

    it('should merge local and remote records using last-write-wins', async () => {
      const localRecords = [
        makeRecord('photo1', 100, { rating: 3 }),
        makeRecord('photo2', 200),
      ];
      const remoteRecords = [
        makeRecord('photo1', 150, { rating: 5 }),
        makeRecord('photo3', 300),
      ];
      const payload: VaultMetadataPayload = { version: 1, records: remoteRecords };
      const jsonBytes = new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer;

      storeMock.open.and.resolveTo();
      storeMock.getAll.and.resolveTo(localRecords);
      storageMock.fileExists.and.resolveTo(true);
      storageMock.readFile.and.resolveTo(new ArrayBuffer(10));
      cryptoMock.decryptFile.and.resolveTo(jsonBytes);
      storeMock.putBatch.and.resolveTo();

      await service.initialize();

      const putBatchArg = storeMock.putBatch.calls.mostRecent().args[0];
      expect(putBatchArg.length).toBe(3);

      const photo1 = putBatchArg.find((r: MetadataRecord) => r.photoId === 'photo1');
      expect(photo1?.rating).toBe(5); // remote wins (updatedAt 150 > 100)
      expect(photo1?.updatedAt).toBe(150);

      const photo2 = putBatchArg.find((r: MetadataRecord) => r.photoId === 'photo2');
      expect(photo2?.updatedAt).toBe(200); // only in local

      const photo3 = putBatchArg.find((r: MetadataRecord) => r.photoId === 'photo3');
      expect(photo3?.updatedAt).toBe(300); // only in remote
    });

    it('should handle corrupt remote metadata gracefully (treat as empty)', async () => {
      const localRecords = [makeRecord('photo1', 100)];
      const corruptBytes = new TextEncoder().encode('not valid json').buffer as ArrayBuffer;

      storeMock.open.and.resolveTo();
      storeMock.getAll.and.resolveTo(localRecords);
      storageMock.fileExists.and.resolveTo(true);
      storageMock.readFile.and.resolveTo(new ArrayBuffer(10));
      cryptoMock.decryptFile.and.resolveTo(corruptBytes);
      storeMock.putBatch.and.resolveTo();

      await service.initialize();

      // Should still succeed with local data only
      expect(storeMock.putBatch).toHaveBeenCalledWith(localRecords);
    });

    it('should handle decryption failure gracefully', async () => {
      const localRecords = [makeRecord('photo1', 100)];

      storeMock.open.and.resolveTo();
      storeMock.getAll.and.resolveTo(localRecords);
      storageMock.fileExists.and.resolveTo(true);
      storageMock.readFile.and.resolveTo(new ArrayBuffer(10));
      cryptoMock.decryptFile.and.rejectWith(new Error('Decryption failed'));
      storeMock.putBatch.and.resolveTo();

      await service.initialize();

      expect(storeMock.putBatch).toHaveBeenCalledWith(localRecords);
    });
  });

  describe('teardown', () => {
    it('should flush to cloud, clear cache and store', async () => {
      // Initialize first to populate state
      storeMock.open.and.resolveTo();
      storeMock.getAll.and.resolveTo([makeRecord('photo1', 100)]);
      storageMock.fileExists.and.resolveTo(false);
      storeMock.putBatch.and.resolveTo();
      await service.initialize();

      // Setup for teardown
      storeMock.getAll.and.resolveTo([makeRecord('photo1', 100)]);
      cryptoMock.encryptFile.and.resolveTo(new ArrayBuffer(20));
      storageMock.writeFile.and.resolveTo();
      storeMock.clear.and.resolveTo();

      await service.teardown();

      expect(cryptoMock.encryptFile).toHaveBeenCalled();
      expect(storageMock.writeFile).toHaveBeenCalledWith('_intimapic/metadata.enc', jasmine.any(ArrayBuffer));
      expect(storeMock.clear).toHaveBeenCalled();
    });

    it('should handle flush failure gracefully and still clear store', async () => {
      storeMock.open.and.resolveTo();
      storeMock.getAll.and.resolveTo([makeRecord('photo1', 100)]);
      storageMock.fileExists.and.resolveTo(false);
      storeMock.putBatch.and.resolveTo();
      await service.initialize();

      storeMock.getAll.and.rejectWith(new Error('DB error'));
      storeMock.clear.and.resolveTo();

      await service.teardown();

      expect(storeMock.clear).toHaveBeenCalled();
    });
  });

  /**
   * Property 6: Favorite Toggle Inverts State
   *
   * For any photo with a current isFavorite value of V, calling toggleFavorite
   * SHALL produce a new isFavorite value of !V and persist it to MetadataStore.
   *
   * **Validates: Requirements 4.2**
   */
  describe('Property 6: Favorite Toggle Inverts State', () => {
    async function initializeServiceWith(records: MetadataRecord[]): Promise<void> {
      storeMock.open.and.resolveTo();
      storeMock.getAll.and.resolveTo(records);
      storageMock.fileExists.and.resolveTo(false);
      storeMock.putBatch.and.resolveTo();
      storeMock.put.and.resolveTo();
      await service.initialize();
    }

    it('should toggle isFavorite from false to true', async () => {
      const record = makeRecord('photo1', 100, { isFavorite: false });
      await initializeServiceWith([record]);

      const result = await service.toggleFavorite('photo1');

      expect(result).toBe(true);
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.isFavorite).toBe(true);
      expect(putArg.photoId).toBe('photo1');
    });

    it('should toggle isFavorite from true to false', async () => {
      const record = makeRecord('photo1', 100, { isFavorite: true });
      await initializeServiceWith([record]);

      const result = await service.toggleFavorite('photo1');

      expect(result).toBe(false);
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.isFavorite).toBe(false);
      expect(putArg.photoId).toBe('photo1');
    });

    it('should toggle twice and return to original state (false → true → false)', async () => {
      const record = makeRecord('photo1', 100, { isFavorite: false });
      await initializeServiceWith([record]);

      const first = await service.toggleFavorite('photo1');
      expect(first).toBe(true);

      const second = await service.toggleFavorite('photo1');
      expect(second).toBe(false);
    });

    it('should toggle twice and return to original state (true → false → true)', async () => {
      const record = makeRecord('photo1', 100, { isFavorite: true });
      await initializeServiceWith([record]);

      const first = await service.toggleFavorite('photo1');
      expect(first).toBe(false);

      const second = await service.toggleFavorite('photo1');
      expect(second).toBe(true);
    });

    it('should create record with isFavorite=true for photo with no existing metadata', async () => {
      await initializeServiceWith([]);

      const result = await service.toggleFavorite('new-photo');

      expect(result).toBe(true);
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.photoId).toBe('new-photo');
      expect(putArg.isFavorite).toBe(true);
      expect(putArg.captureDate).toBeNull();
      expect(putArg.cameraMake).toBeNull();
      expect(putArg.cameraModel).toBeNull();
      expect(putArg.rating).toBeNull();
    });

    it('should call store.put with the updated record on each toggle', async () => {
      const record = makeRecord('photo1', 100, { isFavorite: false });
      await initializeServiceWith([record]);

      await service.toggleFavorite('photo1');

      expect(storeMock.put).toHaveBeenCalledTimes(1);
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.isFavorite).toBe(true);
      expect(putArg.updatedAt).toBeGreaterThan(100);
    });

    it('should invert state for diverse initial isFavorite values', async () => {
      // Simulates property-based testing with multiple inputs
      const testCases: boolean[] = [false, true, false, true, true, false];

      for (let i = 0; i < testCases.length; i++) {
        const initial = testCases[i];
        const id = `photo-${i}`;
        const records = [makeRecord(id, 100, { isFavorite: initial })];

        // Re-initialize with each test case
        storeMock.open.and.resolveTo();
        storeMock.getAll.and.resolveTo(records);
        storageMock.fileExists.and.resolveTo(false);
        storeMock.putBatch.and.resolveTo();
        storeMock.put.and.resolveTo();
        await service.initialize();

        const result = await service.toggleFavorite(id);
        expect(result).toBe(!initial, `Expected !${initial} for ${id}`);
      }
    });

    it('should preserve other metadata fields when toggling favorite', async () => {
      const record = makeRecord('photo1', 100, {
        isFavorite: false,
        rating: 4,
        captureDate: '2024-01-01T00:00:00.000Z',
        cameraMake: 'Canon',
        cameraModel: 'EOS R5',
      });
      await initializeServiceWith([record]);

      await service.toggleFavorite('photo1');

      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.isFavorite).toBe(true);
      expect(putArg.rating).toBe(4);
      expect(putArg.captureDate).toBe('2024-01-01T00:00:00.000Z');
      expect(putArg.cameraMake).toBe('Canon');
      expect(putArg.cameraModel).toBe('EOS R5');
    });
  });

  /**
   * Property 7: Star Rating Set/Clear Logic
   *
   * For any photo with current rating R and a user tap on star value S: if R equals S,
   * the resulting rating SHALL be null; otherwise the resulting rating SHALL be S.
   * The result SHALL be persisted to MetadataStore.
   *
   * **Validates: Requirements 5.2, 5.3**
   */
  describe('Property 7: Star Rating Set/Clear Logic', () => {
    async function initializeServiceWith(records: MetadataRecord[]): Promise<void> {
      storeMock.open.and.resolveTo();
      storeMock.getAll.and.resolveTo(records);
      storageMock.fileExists.and.resolveTo(false);
      storeMock.putBatch.and.resolveTo();
      storeMock.put.and.resolveTo();
      await service.initialize();
    }

    it('should set rating to 3 on unrated photo', async () => {
      const record = makeRecord('photo1', 100, { rating: null });
      await initializeServiceWith([record]);

      const result = await service.setRating('photo1', 3);

      expect(result).toBe(3);
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.rating).toBe(3);
      expect(putArg.photoId).toBe('photo1');
    });

    it('should clear rating when tapping same star (3 → null)', async () => {
      const record = makeRecord('photo1', 100, { rating: 3 });
      await initializeServiceWith([record]);

      const result = await service.setRating('photo1', 3);

      expect(result).toBeNull();
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.rating).toBeNull();
    });

    it('should change rating when tapping different star (3 → 5)', async () => {
      const record = makeRecord('photo1', 100, { rating: 3 });
      await initializeServiceWith([record]);

      const result = await service.setRating('photo1', 5);

      expect(result).toBe(5);
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.rating).toBe(5);
    });

    it('should create record with given rating for photo with no metadata', async () => {
      await initializeServiceWith([]);

      const result = await service.setRating('new-photo', 4);

      expect(result).toBe(4);
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.photoId).toBe('new-photo');
      expect(putArg.rating).toBe(4);
      expect(putArg.isFavorite).toBe(false);
      expect(putArg.captureDate).toBeNull();
    });

    it('should test same-star-clears behavior for all stars 1–5', async () => {
      for (let star = 1; star <= 5; star++) {
        const id = `photo-star-${star}`;
        const records = [makeRecord(id, 100, { rating: star })];

        storeMock.open.and.resolveTo();
        storeMock.getAll.and.resolveTo(records);
        storageMock.fileExists.and.resolveTo(false);
        storeMock.putBatch.and.resolveTo();
        storeMock.put.and.resolveTo();
        await service.initialize();

        const result = await service.setRating(id, star);
        expect(result).toBeNull(`Expected null when tapping star ${star} on photo with rating ${star}`);
      }
    });

    it('should test setting different star for all stars 1–5', async () => {
      for (let currentRating = 1; currentRating <= 5; currentRating++) {
        for (let tapStar = 1; tapStar <= 5; tapStar++) {
          if (tapStar === currentRating) continue;

          const id = `photo-${currentRating}-${tapStar}`;
          const records = [makeRecord(id, 100, { rating: currentRating })];

          storeMock.open.and.resolveTo();
          storeMock.getAll.and.resolveTo(records);
          storageMock.fileExists.and.resolveTo(false);
          storeMock.putBatch.and.resolveTo();
          storeMock.put.and.resolveTo();
          await service.initialize();

          const result = await service.setRating(id, tapStar);
          expect(result).toBe(tapStar, `Expected ${tapStar} when tapping star ${tapStar} on photo with rating ${currentRating}`);
        }
      }
    });

    it('should call store.put with the updated record', async () => {
      const record = makeRecord('photo1', 100, { rating: null });
      await initializeServiceWith([record]);

      await service.setRating('photo1', 4);

      expect(storeMock.put).toHaveBeenCalledTimes(1);
      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.rating).toBe(4);
      expect(putArg.updatedAt).toBeGreaterThan(100);
    });

    it('should preserve other metadata fields when setting rating', async () => {
      const record = makeRecord('photo1', 100, {
        rating: null,
        isFavorite: true,
        captureDate: '2023-12-25T00:00:00.000Z',
        cameraMake: 'Sony',
        cameraModel: 'A7III',
      });
      await initializeServiceWith([record]);

      await service.setRating('photo1', 5);

      const putArg = storeMock.put.calls.mostRecent().args[0];
      expect(putArg.rating).toBe(5);
      expect(putArg.isFavorite).toBe(true);
      expect(putArg.captureDate).toBe('2023-12-25T00:00:00.000Z');
      expect(putArg.cameraMake).toBe('Sony');
      expect(putArg.cameraModel).toBe('A7III');
    });

    it('should handle sequential rating changes correctly', async () => {
      const record = makeRecord('photo1', 100, { rating: null });
      await initializeServiceWith([record]);

      // Set to 3
      const r1 = await service.setRating('photo1', 3);
      expect(r1).toBe(3);

      // Change to 5
      const r2 = await service.setRating('photo1', 5);
      expect(r2).toBe(5);

      // Clear by tapping 5 again
      const r3 = await service.setRating('photo1', 5);
      expect(r3).toBeNull();

      // Set to 1
      const r4 = await service.setRating('photo1', 1);
      expect(r4).toBe(1);
    });
  });

  describe('mergeRecords', () => {
    it('should keep all records from both sets with unique photoIds', () => {
      const local = [makeRecord('a', 100)];
      const remote = [makeRecord('b', 200)];

      const result = service.mergeRecords(local, remote);

      expect(result.length).toBe(2);
      expect(result.find(r => r.photoId === 'a')).toBeTruthy();
      expect(result.find(r => r.photoId === 'b')).toBeTruthy();
    });

    it('should pick remote record when it has higher updatedAt', () => {
      const local = [makeRecord('x', 100, { rating: 2 })];
      const remote = [makeRecord('x', 200, { rating: 5 })];

      const result = service.mergeRecords(local, remote);

      expect(result.length).toBe(1);
      expect(result[0].rating).toBe(5);
      expect(result[0].updatedAt).toBe(200);
    });

    it('should keep local record when it has higher updatedAt', () => {
      const local = [makeRecord('x', 300, { rating: 3 })];
      const remote = [makeRecord('x', 100, { rating: 1 })];

      const result = service.mergeRecords(local, remote);

      expect(result.length).toBe(1);
      expect(result[0].rating).toBe(3);
      expect(result[0].updatedAt).toBe(300);
    });

    it('should handle empty local set', () => {
      const remote = [makeRecord('a', 100), makeRecord('b', 200)];
      const result = service.mergeRecords([], remote);
      expect(result.length).toBe(2);
    });

    it('should handle empty remote set', () => {
      const local = [makeRecord('a', 100), makeRecord('b', 200)];
      const result = service.mergeRecords(local, []);
      expect(result.length).toBe(2);
    });

    it('should handle both empty sets', () => {
      const result = service.mergeRecords([], []);
      expect(result.length).toBe(0);
    });
  });

  /**
   * Property 5: Last-Write-Wins Merge Correctness
   *
   * For any two sets of MetadataRecords (local and remote) where records may share
   * photoIds with differing updatedAt timestamps, the mergeRecords function SHALL
   * produce a set where each photoId maps to the record with the highest updatedAt
   * value from either set, and records with unique photoIds are all preserved.
   *
   * **Validates: Requirements 3.4**
   */
  describe('Property 5: Last-Write-Wins Merge Correctness', () => {

    // ─── Generators ────────────────────────────────────────────────

    /** Generate a pseudo-random integer in [min, max] using a simple seeded approach. */
    function seededRand(seed: number): () => number {
      let s = seed;
      return () => {
        s = (s * 1664525 + 1013904223) & 0x7fffffff;
        return s;
      };
    }

    /** Generate a diverse set of records with given photoId pool and timestamp range. */
    function generateRecords(
      count: number,
      photoIdPool: string[],
      timestampBase: number,
      rand: () => number,
      overridesPool: Array<Partial<MetadataRecord>> = []
    ): MetadataRecord[] {
      const records: MetadataRecord[] = [];
      for (let i = 0; i < count; i++) {
        const photoId = photoIdPool[rand() % photoIdPool.length];
        const updatedAt = timestampBase + (rand() % 100000);
        const overrides = overridesPool.length > 0
          ? overridesPool[rand() % overridesPool.length]
          : {};
        records.push(makeRecord(photoId, updatedAt, {
          rating: (rand() % 6 === 0) ? null : ((rand() % 5) + 1),
          isFavorite: rand() % 2 === 0,
          captureDate: rand() % 3 === 0 ? null : `2024-0${(rand() % 9) + 1}-15T10:00:00.000Z`,
          cameraMake: rand() % 2 === 0 ? 'Canon' : 'Sony',
          cameraModel: rand() % 2 === 0 ? 'R5' : 'A7IV',
          ...overrides,
        }));
      }
      return records;
    }

    /** De-duplicate input records by photoId (keeping last occurrence) to simulate what a real set would look like. */
    function deduplicateByPhotoId(records: MetadataRecord[]): MetadataRecord[] {
      const map = new Map<string, MetadataRecord>();
      for (const r of records) {
        map.set(r.photoId, r);
      }
      return Array.from(map.values());
    }

    // ─── Property: Union of unique photoIds is preserved ───────────

    it('should contain exactly the union of unique photoIds from both input sets', () => {
      const photoIds = Array.from({ length: 20 }, (_, i) => `photo_${i}`);
      const rand = seededRand(42);

      // Generate sets with overlapping photoIds
      const localRaw = generateRecords(15, photoIds.slice(0, 12), 1000, rand);
      const remoteRaw = generateRecords(15, photoIds.slice(8, 20), 2000, rand);

      const local = deduplicateByPhotoId(localRaw);
      const remote = deduplicateByPhotoId(remoteRaw);

      const result = service.mergeRecords(local, remote);

      // Compute expected union of photoIds
      const expectedIds = new Set([
        ...local.map(r => r.photoId),
        ...remote.map(r => r.photoId),
      ]);

      const resultIds = new Set(result.map(r => r.photoId));
      expect(resultIds.size).toBe(expectedIds.size);
      expectedIds.forEach(id => {
        expect(resultIds.has(id))
          .withContext(`Expected photoId "${id}" to be in merged output`)
          .toBeTrue();
      });
    });

    // ─── Property: For shared photoIds, highest updatedAt wins ─────

    it('should keep the record with the highest updatedAt for shared photoIds', () => {
      const sharedIds = Array.from({ length: 12 }, (_, i) => `shared_${i}`);
      const rand = seededRand(123);

      const local = sharedIds.map(id =>
        makeRecord(id, 1000 + (rand() % 5000), {
          rating: ((rand() % 5) + 1),
          isFavorite: rand() % 2 === 0,
        })
      );

      const remote = sharedIds.map(id =>
        makeRecord(id, 1000 + (rand() % 5000), {
          rating: ((rand() % 5) + 1),
          isFavorite: rand() % 2 === 0,
        })
      );

      const result = service.mergeRecords(local, remote);

      expect(result.length).toBe(sharedIds.length);

      for (const id of sharedIds) {
        const localRec = local.find(r => r.photoId === id)!;
        const remoteRec = remote.find(r => r.photoId === id)!;
        const merged = result.find(r => r.photoId === id)!;

        const expectedWinner = remoteRec.updatedAt > localRec.updatedAt
          ? remoteRec
          : localRec; // local wins on equal

        expect(merged.updatedAt).toBe(expectedWinner.updatedAt);
        expect(merged.rating).toBe(expectedWinner.rating);
        expect(merged.isFavorite).toBe(expectedWinner.isFavorite);
      }
    });

    // ─── Property: Unique photoIds preserved as-is ─────────────────

    it('should preserve records with unique photoIds unchanged', () => {
      const localOnlyIds = ['localOnly_a', 'localOnly_b', 'localOnly_c', 'localOnly_d', 'localOnly_e'];
      const remoteOnlyIds = ['remoteOnly_x', 'remoteOnly_y', 'remoteOnly_z', 'remoteOnly_w', 'remoteOnly_v'];
      const sharedIds = ['shared_1', 'shared_2', 'shared_3'];

      const rand = seededRand(777);

      const local = [
        ...localOnlyIds.map(id => makeRecord(id, 1000 + (rand() % 1000), { rating: (rand() % 5) + 1 })),
        ...sharedIds.map(id => makeRecord(id, 500, { rating: 2 })),
      ];

      const remote = [
        ...remoteOnlyIds.map(id => makeRecord(id, 2000 + (rand() % 1000), { rating: (rand() % 5) + 1 })),
        ...sharedIds.map(id => makeRecord(id, 1000, { rating: 4 })),
      ];

      const result = service.mergeRecords(local, remote);

      // Local-only records should be exactly as input
      for (const id of localOnlyIds) {
        const original = local.find(r => r.photoId === id)!;
        const merged = result.find(r => r.photoId === id)!;
        expect(merged).toEqual(original);
      }

      // Remote-only records should be exactly as input
      for (const id of remoteOnlyIds) {
        const original = remote.find(r => r.photoId === id)!;
        const merged = result.find(r => r.photoId === id)!;
        expect(merged).toEqual(original);
      }
    });

    // ─── Property: Large diverse set (10+ records) ─────────────────

    it('should correctly merge large sets with many duplicates and varying timestamps', () => {
      const rand = seededRand(9999);
      const allIds = Array.from({ length: 25 }, (_, i) => `bulk_photo_${i}`);

      // Local has 18 records covering first 15 photoIds
      const localRaw = generateRecords(18, allIds.slice(0, 15), 1000, rand);
      const local = deduplicateByPhotoId(localRaw);

      // Remote has 18 records covering last 15 photoIds (overlap on ids 10–14)
      const remoteRaw = generateRecords(18, allIds.slice(10, 25), 3000, rand);
      const remote = deduplicateByPhotoId(remoteRaw);

      const result = service.mergeRecords(local, remote);

      // Property 1: Union of all photoIds
      const expectedIds = new Set([
        ...local.map(r => r.photoId),
        ...remote.map(r => r.photoId),
      ]);
      expect(result.length).toBe(expectedIds.size);

      // Property 2: For each shared photoId, highest updatedAt wins
      for (const rec of result) {
        const localRec = local.find(r => r.photoId === rec.photoId);
        const remoteRec = remote.find(r => r.photoId === rec.photoId);

        if (localRec && remoteRec) {
          // Shared — highest updatedAt should win
          const expectedTimestamp = Math.max(localRec.updatedAt, remoteRec.updatedAt);
          expect(rec.updatedAt).toBe(expectedTimestamp);

          // Verify the entire record matches the winner
          const winner = remoteRec.updatedAt > localRec.updatedAt ? remoteRec : localRec;
          expect(rec).toEqual(winner);
        } else if (localRec) {
          expect(rec).toEqual(localRec);
        } else if (remoteRec) {
          expect(rec).toEqual(remoteRec);
        }
      }
    });

    // ─── Property: Equal updatedAt — local wins (not strictly greater) ─

    it('should keep local record when updatedAt is equal (remote only overrides if strictly greater)', () => {
      const ids = Array.from({ length: 10 }, (_, i) => `tie_photo_${i}`);
      const sameTimestamp = 5000;

      const local = ids.map(id =>
        makeRecord(id, sameTimestamp, { rating: 1, isFavorite: false, cameraMake: 'LocalCam' })
      );
      const remote = ids.map(id =>
        makeRecord(id, sameTimestamp, { rating: 5, isFavorite: true, cameraMake: 'RemoteCam' })
      );

      const result = service.mergeRecords(local, remote);

      expect(result.length).toBe(ids.length);
      for (const rec of result) {
        // Local should win because remote.updatedAt is NOT strictly greater
        expect(rec.rating).toBe(1);
        expect(rec.isFavorite).toBeFalse();
        expect(rec.cameraMake).toBe('LocalCam');
      }
    });

    // ─── Property: No records are lost or duplicated ────────────────

    it('should produce no duplicate photoIds in the output', () => {
      const rand = seededRand(2025);
      const photoIds = Array.from({ length: 10 }, (_, i) => `dup_check_${i}`);

      // Generate multiple records per photoId in both sets
      const localRaw: MetadataRecord[] = [];
      const remoteRaw: MetadataRecord[] = [];
      for (const id of photoIds) {
        localRaw.push(makeRecord(id, 1000 + (rand() % 5000), { rating: (rand() % 5) + 1 }));
        localRaw.push(makeRecord(id, 1000 + (rand() % 5000), { rating: (rand() % 5) + 1 }));
        remoteRaw.push(makeRecord(id, 1000 + (rand() % 5000), { rating: (rand() % 5) + 1 }));
      }

      // Deduplicate inputs (as the function expects sets without internal duplicates,
      // but we test that the output is always clean)
      const local = deduplicateByPhotoId(localRaw);
      const remote = deduplicateByPhotoId(remoteRaw);

      const result = service.mergeRecords(local, remote);

      const outputIds = result.map(r => r.photoId);
      const uniqueOutputIds = new Set(outputIds);
      expect(outputIds.length).toBe(uniqueOutputIds.size);
    });

    // ─── Property: Diverse field combinations don't affect merge logic ─

    it('should correctly merge records with diverse field combinations', () => {
      const local: MetadataRecord[] = [
        makeRecord('diverse_1', 100, { captureDate: null, rating: null, isFavorite: false }),
        makeRecord('diverse_2', 500, { captureDate: '2024-06-01T00:00:00.000Z', rating: 5, isFavorite: true }),
        makeRecord('diverse_3', 300, { cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro' }),
        makeRecord('diverse_4', 1000, { rating: 1, cameraMake: null }),
      ];

      const remote: MetadataRecord[] = [
        makeRecord('diverse_1', 200, { captureDate: '2020-01-01T00:00:00.000Z', rating: 3, isFavorite: true }),
        makeRecord('diverse_2', 400, { captureDate: null, rating: 1, isFavorite: false }),
        makeRecord('diverse_3', 600, { cameraMake: 'Samsung', cameraModel: 'Galaxy S24' }),
        makeRecord('diverse_5', 900, { rating: 4 }),
      ];

      const result = service.mergeRecords(local, remote);

      // diverse_1: remote wins (200 > 100)
      const d1 = result.find(r => r.photoId === 'diverse_1')!;
      expect(d1.updatedAt).toBe(200);
      expect(d1.rating).toBe(3);
      expect(d1.isFavorite).toBeTrue();

      // diverse_2: local wins (500 > 400)
      const d2 = result.find(r => r.photoId === 'diverse_2')!;
      expect(d2.updatedAt).toBe(500);
      expect(d2.rating).toBe(5);

      // diverse_3: remote wins (600 > 300)
      const d3 = result.find(r => r.photoId === 'diverse_3')!;
      expect(d3.updatedAt).toBe(600);
      expect(d3.cameraMake).toBe('Samsung');

      // diverse_4: only in local, preserved
      const d4 = result.find(r => r.photoId === 'diverse_4')!;
      expect(d4.updatedAt).toBe(1000);

      // diverse_5: only in remote, preserved
      const d5 = result.find(r => r.photoId === 'diverse_5')!;
      expect(d5.updatedAt).toBe(900);

      expect(result.length).toBe(5);
    });
  });
});
