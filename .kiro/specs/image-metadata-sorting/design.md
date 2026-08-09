# Design Document: Image Metadata Sorting

## Overview

This design adds EXIF metadata extraction during photo import, user-applied ratings/favorites, and configurable sort controls to the IntimaPic gallery. Metadata is stored locally in IndexedDB via Dexie.js for fast typed access and synced to an encrypted vault-level file for cross-device availability.

## Architecture

### New Services & Components

```
src/app/core/metadata/
├── metadata.service.ts         # Central orchestrator for metadata CRUD + sync
├── metadata-store.ts           # Dexie.js database + MetadataStore service
├── exif-extractor.ts           # EXIF parsing using exifr library
└── metadata.models.ts          # Interfaces and types

src/app/shared/
├── rating/
│   ├── rating.component.ts     # Heart toggle + star rating (standalone)
│   └── rating.component.spec.ts
└── sort-control/
    ├── sort-control.component.ts  # Sort button + menu (standalone)
    └── sort-control.component.spec.ts
```

### Dependency Graph

```
AlbumViewComponent
  ├── SortControlComponent (toolbar button)
  ├── RatingComponent (per photo in grid + lightbox)
  └── MetadataService
        ├── MetadataStore (Dexie.js → IndexedDB)
        ├── ExifExtractor (exifr)
        ├── CryptoService (encrypt/decrypt vault metadata file)
        └── VaultService → StorageAdapter (read/write _intimapic/metadata.enc)
```

## Data Models

### MetadataRecord

```typescript
export interface MetadataRecord {
  /** Encrypted filename (primary key, same as PhotoItem.encryptedName) */
  photoId: string;
  /** EXIF DateTimeOriginal or DateTimeDigitized, null if unavailable */
  captureDate: string | null; // ISO 8601 string for IndexedDB compatibility
  /** EXIF Make field */
  cameraMake: string | null;
  /** EXIF Model field */
  cameraModel: string | null;
  /** User rating 1–5, null if unrated */
  rating: number | null;
  /** User favorite flag */
  isFavorite: boolean;
  /** Last modification timestamp (ms since epoch) for sync merge */
  updatedAt: number;
}
```

### SortCriterion

```typescript
export type SortCriterion = 'filename' | 'captureDate' | 'rating';
```

### VaultMetadataPayload (serialized to `_intimapic/metadata.enc`)

```typescript
export interface VaultMetadataPayload {
  version: 1;
  records: MetadataRecord[];
}
```

## Component Design

### MetadataStore (Dexie.js Database)

The metadata store uses [Dexie.js](https://dexie.org/) — a lightweight (~16KB gzipped) typed wrapper around IndexedDB that provides promise-based APIs, automatic index management, and built-in transaction support.

```typescript
import Dexie, { type Table } from 'dexie';

export class MetadataDatabase extends Dexie {
  photos!: Table<MetadataRecord, string>;

  constructor() {
    super('intimapic_metadata');
    this.version(1).stores({
      photos: 'photoId, captureDate, rating, isFavorite, updatedAt'
    });
  }
}
```

This gives us:
- **Typed table access** — `db.photos` is fully typed as `Table<MetadataRecord, string>`
- **Automatic index management** — indexes on `captureDate`, `rating`, `isFavorite`, and `updatedAt` are declared inline
- **Transaction support built-in** — `db.transaction('rw', db.photos, async () => { ... })`
- **Query builders** — `where()`, `orderBy()`, `filter()`, `bulkPut()`, `bulkGet()`
- **Promise-based API** — no manual `IDBRequest` handling

The `MetadataStore` service wraps the database instance and provides the application-level API:

```typescript
@Injectable({ providedIn: 'root' })
export class MetadataStore {
  private db = new MetadataDatabase();
  private inMemoryFallback: Map<string, MetadataRecord> | null = null;

  /** Open the database (Dexie opens lazily; this verifies availability). */
  async open(): Promise<void> {
    try {
      await this.db.open();
    } catch {
      // IndexedDB unavailable (e.g., private browsing in some browsers)
      this.inMemoryFallback = new Map();
      console.warn('IndexedDB unavailable — using in-memory fallback for this session.');
    }
  }

  /** Get a single record by photoId. */
  async get(photoId: string): Promise<MetadataRecord | undefined> {
    if (this.inMemoryFallback) return this.inMemoryFallback.get(photoId);
    return this.db.photos.get(photoId);
  }

  /** Get all records. */
  async getAll(): Promise<MetadataRecord[]> {
    if (this.inMemoryFallback) return Array.from(this.inMemoryFallback.values());
    return this.db.photos.toArray();
  }

  /** Get records ordered by captureDate descending (newest first). */
  async getAllByCaptureDate(): Promise<MetadataRecord[]> {
    if (this.inMemoryFallback) {
      return Array.from(this.inMemoryFallback.values())
        .sort((a, b) => (b.captureDate ?? '').localeCompare(a.captureDate ?? ''));
    }
    return this.db.photos.orderBy('captureDate').reverse().toArray();
  }

  /** Get records for a list of photoIds (batch read). */
  async getBatch(photoIds: string[]): Promise<Map<string, MetadataRecord>> {
    if (this.inMemoryFallback) {
      const result = new Map<string, MetadataRecord>();
      for (const id of photoIds) {
        const record = this.inMemoryFallback.get(id);
        if (record) result.set(id, record);
      }
      return result;
    }
    const records = await this.db.photos.bulkGet(photoIds);
    const result = new Map<string, MetadataRecord>();
    for (const record of records) {
      if (record) result.set(record.photoId, record);
    }
    return result;
  }

  /** Put (create or update) a record. */
  async put(record: MetadataRecord): Promise<void> {
    if (this.inMemoryFallback) {
      this.inMemoryFallback.set(record.photoId, record);
      return;
    }
    await this.db.photos.put(record);
  }

  /** Put multiple records in a single transaction. */
  async putBatch(records: MetadataRecord[]): Promise<void> {
    if (this.inMemoryFallback) {
      for (const record of records) {
        this.inMemoryFallback.set(record.photoId, record);
      }
      return;
    }
    await this.db.photos.bulkPut(records);
  }

  /** Delete a record. */
  async delete(photoId: string): Promise<void> {
    if (this.inMemoryFallback) {
      this.inMemoryFallback.delete(photoId);
      return;
    }
    await this.db.photos.delete(photoId);
  }

  /** Clear all records (used on vault lock). */
  async clear(): Promise<void> {
    if (this.inMemoryFallback) {
      this.inMemoryFallback.clear();
      return;
    }
    await this.db.photos.clear();
  }
}
```

If IndexedDB is unavailable (private browsing in some browsers), the store falls back to an in-memory `Map<string, MetadataRecord>` for the session.

### ExifExtractor

```typescript
@Injectable({ providedIn: 'root' })
export class ExifExtractor {
  /**
   * Extract metadata from raw image bytes.
   * Returns partial MetadataRecord fields (captureDate, cameraMake, cameraModel).
   */
  async extract(imageData: ArrayBuffer): Promise<Partial<MetadataRecord>>;
}
```

Implementation uses the `exifr` library (lightweight, tree-shakeable, ~15KB gzipped). Only parses the EXIF IFD0 and ExifIFD segments (no GPS, no thumbnails) for minimal overhead:

```typescript
import exifr from 'exifr';

async extract(imageData: ArrayBuffer): Promise<Partial<MetadataRecord>> {
  try {
    const exif = await exifr.parse(imageData, {
      pick: ['DateTimeOriginal', 'DateTimeDigitized', 'Make', 'Model'],
      translateValues: false,
    });

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
```

### MetadataService

The central orchestrator. Responsibilities:
1. EXIF extraction during import
2. Rating/favorite CRUD
3. FlushTimer management (debounced 30s sync to cloud)
4. Cloud sync on vault open (merge with last-write-wins)

```typescript
@Injectable({ providedIn: 'root' })
export class MetadataService {
  private readonly store = inject(MetadataStore);
  private readonly exifExtractor = inject(ExifExtractor);
  private readonly cryptoService = inject(CryptoService);
  private readonly vaultService = inject(VaultService);

  /** In-memory cache for fast reads (populated on vault open) */
  private cache = new Map<string, MetadataRecord>();

  /** Flush timer handle */
  private flushTimerHandle: ReturnType<typeof setTimeout> | null = null;

  /** Whether a flush is currently in progress */
  private flushing = false;

  /** Whether there are pending changes since last flush */
  private dirty = false;

  private readonly FLUSH_DELAY_MS = 30_000;
  private readonly METADATA_PATH = '_intimapic/metadata.enc';

  // ─── Lifecycle ─────────────────────────────────────────────────

  /** Called when vault is opened. Loads local + remote metadata and merges. */
  async initialize(): Promise<void>;

  /** Called when vault is locked. Flush pending, clear cache. */
  async teardown(): Promise<void>;

  // ─── EXIF Extraction ───────────────────────────────────────────

  /** Extract EXIF and create a metadata record for a newly imported photo. */
  async extractAndStore(photoId: string, imageData: ArrayBuffer): Promise<MetadataRecord>;

  /** Queue background EXIF extraction for photos without metadata. */
  queueBackgroundExtraction(photoIds: string[]): void;

  // ─── Read ──────────────────────────────────────────────────────

  /** Get metadata for a single photo (from cache). */
  getMetadata(photoId: string): MetadataRecord | undefined;

  /** Get metadata for a batch of photos (from cache). */
  getMetadataBatch(photoIds: string[]): Map<string, MetadataRecord>;

  // ─── Rating & Favorites ────────────────────────────────────────

  /** Toggle isFavorite for a photo. Returns new value. */
  async toggleFavorite(photoId: string): Promise<boolean>;

  /** Set rating (1–5) or clear (null if same star tapped). */
  async setRating(photoId: string, value: number): Promise<number | null>;

  // ─── Flush & Sync ─────────────────────────────────────────────

  /** Reset the flush timer (called on every metadata change). */
  private resetFlushTimer(): void;

  /** Flush metadata to cloud (serialize → encrypt → write). */
  private async flush(): Promise<void>;

  /** Merge remote records with local using last-write-wins. */
  private mergeRecords(local: MetadataRecord[], remote: MetadataRecord[]): MetadataRecord[];
}
```

### FlushTimer Logic

```typescript
private resetFlushTimer(): void {
  if (this.flushTimerHandle !== null) {
    clearTimeout(this.flushTimerHandle);
  }
  this.dirty = true;
  this.flushTimerHandle = setTimeout(() => this.flush(), this.FLUSH_DELAY_MS);
}
```

On `visibilitychange` → `hidden`:
```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && this.dirty) {
    this.flush(); // immediate flush, no timer
  }
});
```

### Merge Strategy (Last-Write-Wins)

```typescript
mergeRecords(local: MetadataRecord[], remote: MetadataRecord[]): MetadataRecord[] {
  const merged = new Map<string, MetadataRecord>();

  // Start with all local records
  for (const record of local) {
    merged.set(record.photoId, record);
  }

  // Override with remote records that have a newer updatedAt
  for (const record of remote) {
    const existing = merged.get(record.photoId);
    if (!existing || record.updatedAt > existing.updatedAt) {
      merged.set(record.photoId, record);
    }
  }

  return Array.from(merged.values());
}
```

### Flush Pipeline

```typescript
private async flush(): Promise<void> {
  if (this.flushing) return;
  this.flushing = true;
  this.dirty = false;
  this.flushTimerHandle = null;

  try {
    const records = await this.store.getAll(); // Dexie's toArray() under the hood
    const payload: VaultMetadataPayload = { version: 1, records };
    const json = JSON.stringify(payload);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(json).buffer as ArrayBuffer;

    // Encrypt using Cryptomator file format (AES-256-GCM chunks)
    const encrypted = await this.cryptoService.encryptFile(plaintext);

    // Write to vault
    const storage = this.vaultService.getStorage();
    await storage.writeFile(this.METADATA_PATH, encrypted);
  } catch (err) {
    console.error('Metadata flush failed:', err);
    // Mark dirty again so next timer or visibility change retries
    this.dirty = true;
  } finally {
    this.flushing = false;
  }
}
```

## Sort Logic

### Sort Comparators

```typescript
export function sortByFilename(a: PhotoItem, b: PhotoItem): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortByCaptureDate(
  a: PhotoItem, b: PhotoItem,
  metadata: Map<string, MetadataRecord>
): number {
  const dateA = metadata.get(a.encryptedName)?.captureDate ?? null;
  const dateB = metadata.get(b.encryptedName)?.captureDate ?? null;

  // Nulls at the end
  if (dateA === null && dateB === null) return 0;
  if (dateA === null) return 1;
  if (dateB === null) return -1;

  // Descending (newest first)
  return dateB.localeCompare(dateA);
}

export function sortByRating(
  a: PhotoItem, b: PhotoItem,
  metadata: Map<string, MetadataRecord>
): number {
  const metaA = metadata.get(a.encryptedName);
  const metaB = metadata.get(b.encryptedName);
  const ratingA = metaA?.rating ?? null;
  const ratingB = metaB?.rating ?? null;
  const favA = metaA?.isFavorite ?? false;
  const favB = metaB?.isFavorite ?? false;

  // Unrated at the end
  if (ratingA === null && ratingB === null) {
    // Among unrated, favorites first
    if (favA !== favB) return favA ? -1 : 1;
    return 0;
  }
  if (ratingA === null) return 1;
  if (ratingB === null) return -1;

  // Descending rating
  if (ratingA !== ratingB) return ratingB - ratingA;

  // Same rating: favorites first
  if (favA !== favB) return favA ? -1 : 1;
  return 0;
}
```

### Sort Preference Persistence

Sort preferences are stored in `localStorage` per album:

```typescript
private readonly SORT_PREF_KEY_PREFIX = 'intimapic_sort_';

getSortPreference(albumId: string): SortCriterion {
  const stored = localStorage.getItem(`${this.SORT_PREF_KEY_PREFIX}${albumId}`);
  if (stored === 'captureDate' || stored === 'rating') return stored;
  return 'filename'; // default
}

setSortPreference(albumId: string, criterion: SortCriterion): void {
  localStorage.setItem(`${this.SORT_PREF_KEY_PREFIX}${albumId}`, criterion);
}
```

## Component Integration

### RatingComponent

A standalone Angular component used in both the photo grid overlay and the PhotoSwipe lightbox.

```typescript
@Component({
  selector: 'app-rating',
  standalone: true,
  imports: [MatIconModule, MatButtonModule],
  template: `
    <button mat-icon-button (click)="onHeartClick($event)" [attr.aria-label]="isFavorite() ? 'Remove from favorites' : 'Add to favorites'">
      <mat-icon>{{ isFavorite() ? 'favorite' : 'favorite_border' }}</mat-icon>
    </button>
    <span class="stars" role="group" aria-label="Rating">
      @for (star of [1,2,3,4,5]; track star) {
        <button mat-icon-button
                (click)="onStarClick($event, star)"
                [attr.aria-label]="'Rate ' + star + ' stars'">
          <mat-icon>{{ (rating() ?? 0) >= star ? 'star' : 'star_border' }}</mat-icon>
        </button>
      }
    </span>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RatingComponent {
  readonly photoId = input.required<string>();
  readonly isFavorite = input<boolean>(false);
  readonly rating = input<number | null>(null);

  readonly favoriteToggled = output<string>(); // emits photoId
  readonly ratingChanged = output<{ photoId: string; value: number }>();
}
```

### SortControlComponent

```typescript
@Component({
  selector: 'app-sort-control',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatMenuModule],
  template: `
    <button mat-button [matMenuTriggerFor]="sortMenu">
      <mat-icon>sort</mat-icon>
      {{ sortLabel() }}
    </button>
    <mat-menu #sortMenu="matMenu">
      <button mat-menu-item (click)="select('filename')">
        <mat-icon>{{ activeCriterion() === 'filename' ? 'check' : '' }}</mat-icon>
        Dateiname
      </button>
      <button mat-menu-item (click)="select('captureDate')">
        <mat-icon>{{ activeCriterion() === 'captureDate' ? 'check' : '' }}</mat-icon>
        Aufnahmedatum
      </button>
      <button mat-menu-item (click)="select('rating')">
        <mat-icon>{{ activeCriterion() === 'rating' ? 'check' : '' }}</mat-icon>
        Bewertung
      </button>
    </mat-menu>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SortControlComponent {
  readonly activeCriterion = input<SortCriterion>('filename');
  readonly criterionChanged = output<SortCriterion>();

  sortLabel = computed(() => {
    switch (this.activeCriterion()) {
      case 'captureDate': return 'Aufnahmedatum';
      case 'rating': return 'Bewertung';
      default: return 'Dateiname';
    }
  });

  select(criterion: SortCriterion): void {
    this.criterionChanged.emit(criterion);
  }
}
```

### AlbumViewComponent Integration

The AlbumViewComponent gains:
1. A `SortControlComponent` in the toolbar (via ToolbarService actions)
2. A `sortedPhotos` computed signal derived from `photos` + current sort criterion + metadata
3. Rating display per photo cell (small heart/star icons)

```typescript
// New signals in AlbumViewComponent
private readonly metadataService = inject(MetadataService);
readonly sortCriterion = signal<SortCriterion>('filename');
readonly metadata = signal<Map<string, MetadataRecord>>(new Map());

readonly sortedPhotos = computed(() => {
  const photos = [...this.photos()];
  const meta = this.metadata();
  switch (this.sortCriterion()) {
    case 'captureDate': return photos.sort((a, b) => sortByCaptureDate(a, b, meta));
    case 'rating': return photos.sort((a, b) => sortByRating(a, b, meta));
    default: return photos.sort(sortByFilename);
  }
});
```

## Sequence Diagrams

### Photo Import with EXIF Extraction

```
ImportScanService         MetadataService        ExifExtractor        MetadataStore
      │                        │                      │                     │
      │── moveToAlbum(photo) ──│                      │                     │
      │                        │── extract(imageData)─│                     │
      │                        │◄── {captureDate,     │                     │
      │                        │     make, model} ────│                     │
      │                        │                      │                     │
      │                        │── put(record) ───────────────────────────►│
      │                        │── resetFlushTimer() ─│                     │
      │                        │                      │                     │
      │◄── done ───────────────│                      │                     │
```

### Vault Open – Metadata Sync

```
VaultService          MetadataService         StorageAdapter        CryptoService       MetadataStore
    │                       │                       │                     │                   │
    │── initialize() ──────►│                       │                     │                   │
    │                       │── readFile(metadata.enc)──────────────────►│                   │
    │                       │◄── encrypted bytes ───│                     │                   │
    │                       │── decryptFile(bytes) ──────────────────────►│                   │
    │                       │◄── JSON plaintext ────│                     │                   │
    │                       │                       │                     │                   │
    │                       │── getAll() ────────────────────────────────────────────────────►│
    │                       │◄── local records ─────────────────────────────────────────────│
    │                       │                       │                     │                   │
    │                       │── mergeRecords(local, remote) ──────────────│                   │
    │                       │── putBatch(merged) ───────────────────────────────────────────►│
    │                       │── populate cache ─────│                     │                   │
    │◄── ready ─────────────│                       │                     │                   │
```

### Rating Change → Flush

```
User          RatingComponent      MetadataService        MetadataStore      StorageAdapter
  │                  │                    │                      │                   │
  │── tap star(3) ──►│                    │                      │                   │
  │                  │── setRating(id,3)─►│                      │                   │
  │                  │                    │── put(record) ──────►│                   │
  │                  │                    │── resetFlushTimer()   │                   │
  │                  │◄── new rating ─────│                      │                   │
  │                  │                    │                      │                   │
  │                  │       ... 30s pass ...                     │                   │
  │                  │                    │                      │                   │
  │                  │                    │── flush() ────────────│                   │
  │                  │                    │   serialize + encrypt │                   │
  │                  │                    │── writeFile(enc) ─────────────────────────►│
  │                  │                    │◄── done ─────────────────────────────────│
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| EXIF parsing fails (corrupted image) | Set captureDate/cameraMake/cameraModel to null; continue normally |
| IndexedDB unavailable | Dexie's `open()` rejects; fall back to in-memory Map; log warning; user experience unaffected for session |
| VaultMetadataFile missing on sync | Treat remote as empty; local data is authoritative |
| VaultMetadataFile decryption fails | Log error; continue with local data only |
| Flush write fails (network error) | Log error; mark dirty; retry on next timer or visibility change |
| VaultMetadataFile corrupt JSON | Log error; treat remote as empty; local data wins |

## Dependencies

### New NPM Packages

- `exifr` (^7.1.3) — lightweight EXIF parser, tree-shakeable, supports JPEG/HEIC/TIFF. ~15KB gzipped.
- `dexie` (^4.0.11) — typed IndexedDB wrapper with promise-based API, query builders, and automatic index management. ~16KB gzipped.

### Existing Dependencies Used

- `@angular/material` — MatIcon, MatButton, MatMenu for sort control and rating
- `@angular/cdk` — Accessibility primitives

## Performance Considerations

1. **EXIF extraction is async and non-blocking** — queued as microtasks during import, not blocking UI
2. **In-memory cache** — MetadataService.cache provides O(1) reads; IndexedDB is only hit on initialization
3. **Batch IndexedDB operations** — `putBatch` uses Dexie's `bulkPut()` for efficient multi-record writes in a single transaction
4. **Indexed queries** — Dexie's `orderBy('captureDate').reverse().toArray()` leverages IndexedDB indexes for pre-sorted reads without in-memory sorting
5. **Flush debouncing** — avoids write amplification; at most one cloud write per 30s burst
6. **Minimal EXIF parsing** — only reads IFD0 + ExifIFD (4 fields), skips thumbnails/GPS/MakerNote

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: EXIF Extraction Fidelity

*For any* valid image file containing EXIF data, the ExifExtractor SHALL return a captureDate equal to the DateTimeOriginal field if present, otherwise the DateTimeDigitized field if present, otherwise null. The cameraMake and cameraModel fields SHALL equal the EXIF Make and Model fields respectively (or null if absent).

**Validates: Requirements 1.1, 1.2, 1.3, 1.4**

### Property 2: Metadata Write Round-Trip

*For any* MetadataRecord, writing it to MetadataStore and immediately reading it back by photoId SHALL produce a record equal to the original.

**Validates: Requirements 2.2**

### Property 3: Flush Timer Debounce

*For any* sequence of N metadata changes occurring within a 30-second window, the MetadataService SHALL produce exactly one flush event, occurring 30 seconds after the last change in the sequence.

**Validates: Requirements 3.1, 4.4, 5.5**

### Property 4: Metadata Sync Round-Trip

*For any* set of MetadataRecords, serializing them to the VaultMetadataPayload JSON format, encrypting with CryptoService.encryptFile, then decrypting with CryptoService.decryptFile and deserializing SHALL produce a set of records equal to the original.

**Validates: Requirements 3.2**

### Property 5: Last-Write-Wins Merge Correctness

*For any* two sets of MetadataRecords (local and remote) where records may share photoIds with differing updatedAt timestamps, the mergeRecords function SHALL produce a set where each photoId maps to the record with the highest updatedAt value from either set, and records with unique photoIds are all preserved.

**Validates: Requirements 3.4**

### Property 6: Favorite Toggle Inverts State

*For any* photo with a current isFavorite value of V, calling toggleFavorite SHALL produce a new isFavorite value of !V and persist it to MetadataStore.

**Validates: Requirements 4.2**

### Property 7: Star Rating Set/Clear Logic

*For any* photo with current rating R and a user tap on star value S: if R equals S, the resulting rating SHALL be null; otherwise the resulting rating SHALL be S. The result SHALL be persisted to MetadataStore.

**Validates: Requirements 5.2, 5.3**

### Property 8: Filename Sort Correctness

*For any* list of PhotoItems, applying sortByFilename SHALL produce a list where for all adjacent pairs (a, b), a.name.localeCompare(b.name) <= 0 (ascending alphabetical order with natural numeric sorting).

**Validates: Requirements 6.3**

### Property 9: Capture Date Sort Correctness

*For any* list of PhotoItems with associated metadata, applying sortByCaptureDate SHALL produce a list where: (1) all items with non-null captureDate appear before items with null captureDate, and (2) among items with non-null captureDate, each item's captureDate is >= the next item's captureDate (descending chronological order).

**Validates: Requirements 6.4**

### Property 10: Rating Sort Correctness

*For any* list of PhotoItems with associated metadata, applying sortByRating SHALL produce a list where: (1) all items with non-null rating appear before items with null rating, (2) among items with non-null rating, each item's rating is >= the next item's rating, and (3) among items with equal rating, favorites appear before non-favorites.

**Validates: Requirements 6.5**

### Property 11: Sort Preference Persistence Round-Trip

*For any* albumId and SortCriterion value, calling setSortPreference then getSortPreference with the same albumId SHALL return the same SortCriterion value.

**Validates: Requirements 6.6**
