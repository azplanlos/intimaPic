# Implementation Plan: Image Metadata Sorting

## Overview

Add EXIF metadata extraction, user-applied ratings/favorites, and configurable sort controls to the IntimaPic gallery. Implementation proceeds bottom-up: data models → storage layer → extraction → orchestrator service → UI components → integration into existing views.

## Tasks

- [x] 1. Install dependency and create data models
  - [x] 1.1 Install exifr and dexie npm packages
    - Run `npm install exifr dexie` to add the EXIF parsing library and the typed IndexedDB wrapper
    - Verify both appear in package.json dependencies
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1_

  - [x] 1.2 Create metadata data models
    - Create `src/app/core/metadata/metadata.models.ts`
    - Define `MetadataRecord` interface with fields: photoId, captureDate, cameraMake, cameraModel, rating, isFavorite, updatedAt
    - Define `SortCriterion` type union: 'filename' | 'captureDate' | 'rating'
    - Define `VaultMetadataPayload` interface with version and records fields
    - _Requirements: 2.1, 6.2_

- [x] 2. Implement MetadataStore (Dexie.js wrapper)
  - [x] 2.1 Create MetadataStore service using Dexie.js
    - Create `src/app/core/metadata/metadata-store.ts`
    - Define `MetadataDatabase extends Dexie` class with a `photos` table typed as `Table<MetadataRecord, string>`
    - Declare schema: `this.version(1).stores({ photos: 'photoId, captureDate, rating, isFavorite, updatedAt' })`
    - Implement `@Injectable({ providedIn: 'root' })` MetadataStore service wrapping the Dexie database instance
    - Implement methods: `open()` (verify DB availability), `get()` (via `db.photos.get()`), `getAll()` (via `db.photos.toArray()`), `getAllByCaptureDate()` (via `db.photos.orderBy('captureDate').reverse().toArray()`), `getBatch()` (via `db.photos.bulkGet()`), `put()` (via `db.photos.put()`), `putBatch()` (via `db.photos.bulkPut()`), `delete()`, `clear()`
    - Implement in-memory Map fallback when Dexie's `open()` rejects (IndexedDB unavailable)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 2.2 Write property test for MetadataStore round-trip
    - **Property 2: Metadata Write Round-Trip**
    - Test that writing a MetadataRecord and reading it back by photoId produces an equal record
    - **Validates: Requirements 2.2**

- [x] 3. Implement ExifExtractor service
  - [x] 3.1 Create ExifExtractor service
    - Create `src/app/core/metadata/exif-extractor.ts`
    - Implement `@Injectable({ providedIn: 'root' })` service
    - Use `exifr` library to parse EXIF data from ArrayBuffer
    - Configure exifr to only pick `DateTimeOriginal`, `DateTimeDigitized`, `Make`, `Model`
    - Return `Partial<MetadataRecord>` with captureDate (ISO 8601), cameraMake, cameraModel
    - Handle extraction failures gracefully by returning null fields
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 3.2 Write property test for EXIF extraction fidelity
    - **Property 1: EXIF Extraction Fidelity**
    - Test that DateTimeOriginal takes priority over DateTimeDigitized, both absent yields null, and Make/Model map correctly
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

- [x] 4. Implement MetadataService (orchestrator)
  - [x] 4.1 Create MetadataService core with lifecycle and cache
    - Create `src/app/core/metadata/metadata.service.ts`
    - Implement `@Injectable({ providedIn: 'root' })` service
    - Inject MetadataStore, ExifExtractor, CryptoService, VaultService
    - Implement in-memory cache (`Map<string, MetadataRecord>`)
    - Implement `initialize()`: load local records, download + decrypt remote metadata file, merge with last-write-wins, populate cache
    - Implement `teardown()`: flush pending changes, clear cache and store
    - Handle missing/corrupt VaultMetadataFile gracefully (treat remote as empty)
    - _Requirements: 2.3, 3.4, 3.5, 3.6_

  - [x] 4.2 Implement flush timer and sync logic
    - Implement `resetFlushTimer()` with 30-second debounce
    - Implement `flush()`: serialize records → encrypt via CryptoService → write to `_intimapic/metadata.enc`
    - Add `visibilitychange` listener to flush immediately when page becomes hidden
    - Handle flush failures by marking dirty for retry
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 4.3 Implement EXIF extraction and rating/favorite CRUD methods
    - Implement `extractAndStore(photoId, imageData)`: extract EXIF → create MetadataRecord → persist → update cache → reset flush timer
    - Implement `queueBackgroundExtraction(photoIds)`: queue photos without metadata for async extraction
    - Implement `getMetadata(photoId)` and `getMetadataBatch(photoIds)` reading from cache
    - Implement `toggleFavorite(photoId)`: toggle isFavorite, persist, reset flush timer
    - Implement `setRating(photoId, value)`: set rating or clear if same value tapped, persist, reset flush timer
    - _Requirements: 1.1, 1.5, 4.2, 4.4, 5.2, 5.3, 5.5_

  - [x] 4.4 Write property tests for MetadataService
    - **Property 5: Last-Write-Wins Merge Correctness**
    - Test that mergeRecords keeps the record with highest updatedAt for shared photoIds and preserves all unique photoIds
    - **Validates: Requirements 3.4**

  - [x] 4.5 Write property tests for favorite toggle and rating logic
    - **Property 6: Favorite Toggle Inverts State**
    - Test that toggleFavorite produces !V for any current value V
    - **Property 7: Star Rating Set/Clear Logic**
    - Test that tapping same star clears rating (null), tapping different star sets it
    - **Validates: Requirements 4.2, 5.2, 5.3**

- [x] 5. Checkpoint - Ensure core services compile and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement sort comparator functions
  - [x] 6.1 Create sort utility functions
    - Create sort comparator functions (can be in `metadata.models.ts` or a separate `sort-utils.ts` file in the metadata folder)
    - Implement `sortByFilename`: ascending alphabetical with natural numeric sorting via `localeCompare`
    - Implement `sortByCaptureDate`: descending date order, nulls at end
    - Implement `sortByRating`: descending rating, nulls at end, favorites first among equal ratings
    - Implement `getSortPreference(albumId)` and `setSortPreference(albumId, criterion)` using localStorage
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 6.2 Write property tests for sort correctness
    - **Property 8: Filename Sort Correctness**
    - Test ascending alphabetical ordering with natural numeric sorting
    - **Property 9: Capture Date Sort Correctness**
    - Test descending date order with nulls at end
    - **Property 10: Rating Sort Correctness**
    - Test descending rating, nulls at end, favorites first among equal
    - **Property 11: Sort Preference Persistence Round-Trip**
    - Test that setSortPreference then getSortPreference returns same value
    - **Validates: Requirements 6.3, 6.4, 6.5, 6.6**

- [x] 7. Implement UI components
  - [x] 7.1 Create RatingComponent
    - Create `src/app/shared/rating/rating.component.ts`
    - Standalone component with Angular Material icons and buttons
    - Heart icon button toggling between `favorite` and `favorite_border` icons
    - Five star buttons toggling between `star` and `star_border` icons
    - Input signals: `photoId` (required), `isFavorite`, `rating`
    - Output signals: `favoriteToggled`, `ratingChanged`
    - Use `ChangeDetectionStrategy.OnPush`
    - Add proper ARIA labels for accessibility
    - _Requirements: 4.1, 4.3, 5.1, 5.4_

  - [x] 7.2 Create SortControlComponent
    - Create `src/app/shared/sort-control/sort-control.component.ts`
    - Standalone component with MatButton, MatIcon, MatMenu
    - Sort button showing current criterion label (Dateiname / Aufnahmedatum / Bewertung)
    - Menu with three options and checkmark for active selection
    - Input signal: `activeCriterion`
    - Output signal: `criterionChanged`
    - Use `ChangeDetectionStrategy.OnPush`
    - _Requirements: 6.1, 6.2_

  - [x] 7.3 Write unit tests for RatingComponent and SortControlComponent
    - Test heart toggle emits correct event
    - Test star click emits correct rating value
    - Test sort menu emits selected criterion
    - _Requirements: 4.1, 5.1, 6.1_

- [x] 8. Integrate into AlbumViewComponent
  - [x] 8.1 Add sort control and metadata loading to AlbumViewComponent
    - Add `MetadataService` injection
    - Add `sortCriterion` signal initialized from `getSortPreference(albumId)`
    - Add `metadata` signal populated from MetadataService cache
    - Create `sortedPhotos` computed signal applying the correct comparator based on criterion
    - Add `SortControlComponent` to toolbar via ToolbarService
    - Persist sort criterion on change via `setSortPreference`
    - Use `sortedPhotos` in template instead of raw photos list
    - Load metadata for album photos on album open (call `getMetadataBatch`)
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 2.3_

  - [x] 8.2 Add RatingComponent to photo grid cells
    - Display small rating overlay (heart + stars) on each photo cell
    - Wire `favoriteToggled` and `ratingChanged` events to MetadataService methods
    - Update metadata signal after changes to reflect new sort order
    - _Requirements: 4.1, 5.1_

- [x] 9. Integrate into ImportScanService
  - [x] 9.1 Add EXIF extraction on photo import
    - Modify ImportScanService to call `MetadataService.extractAndStore(photoId, imageData)` during photo import
    - Ensure extraction happens after encryption but uses the original decrypted image data
    - Handle extraction errors gracefully (photo import continues even if EXIF fails)
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 10. Integrate RatingComponent into PhotoSwipe lightbox
  - [x] 10.1 Add rating controls to lightbox view
    - Add RatingComponent to the PhotoSwipe lightbox overlay
    - Pass current photo's metadata (isFavorite, rating) as inputs
    - Wire events to MetadataService methods
    - Ensure changes in lightbox reflect immediately in grid when returning
    - _Requirements: 4.3, 5.4_

- [x] 11. Background metadata extraction
  - [x] 11.1 Add background extraction for existing photos
    - On album open, identify photos listed by PhotoService that have no MetadataRecord in MetadataStore
    - Call `MetadataService.queueBackgroundExtraction(photoIds)` for those photos
    - Implement queue processing: extract EXIF for each photo sequentially (or in small batches) to avoid blocking UI
    - Decrypt photo data via CryptoService before extracting EXIF
    - _Requirements: 1.5_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The sort comparators and MetadataService merge logic are pure functions and well-suited for property testing

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "6.1"] },
    { "id": 3, "tasks": ["4.1", "7.1", "7.2"] },
    { "id": 4, "tasks": ["4.2", "4.3", "6.2", "7.3"] },
    { "id": 5, "tasks": ["4.4", "4.5"] },
    { "id": 6, "tasks": ["8.1", "9.1"] },
    { "id": 7, "tasks": ["8.2", "10.1", "11.1"] }
  ]
}
```
