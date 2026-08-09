# Requirements Document

## Introduction

Image Metadata Sorting adds EXIF extraction, user-applied ratings, and sort controls to IntimaPic. During import, the system extracts capture date and camera information from photos. Users can apply favorites (heart toggle) and 1–5 star ratings. The gallery sort button allows ordering photos by filename, capture date, or rating. Metadata is stored locally in IndexedDB for fast reads and periodically synced to an encrypted vault-level metadata file in the cloud for multi-device access.

## Glossary

- **MetadataService**: The Angular service responsible for extracting, persisting, reading, and syncing photo metadata.
- **MetadataStore**: The IndexedDB object store that holds per-photo metadata records locally.
- **VaultMetadataFile**: A single AES-256-GCM encrypted JSON file stored at `_intimapic/metadata.enc` in the cloud vault, containing all photo metadata for cross-device sync.
- **PhotoItem**: The data model representing a single photo in a gallery view, extended with metadata fields.
- **RatingComponent**: The UI component providing the heart toggle and 1–5 star rating controls.
- **SortControl**: The UI element in the gallery toolbar that lets users choose the photo sort order.
- **ImportScanService**: The existing service that scans the vault root for unsorted photos during import.
- **AlbumViewComponent**: The existing gallery component that displays the photo grid for an album.
- **CaptureDate**: The date and time a photo was originally taken, extracted from EXIF DateTimeOriginal or DateTimeDigitized tags.
- **FlushTimer**: A debounced 30-second timer that triggers persistence of in-memory metadata changes to IndexedDB and cloud sync.

## Requirements

### Requirement 1: EXIF Metadata Extraction

**User Story:** As a user, I want my photos' capture dates and camera info to be automatically extracted during import, so that I can sort and browse by when photos were taken.

#### Acceptance Criteria

1. WHEN ImportScanService processes a photo file, THE MetadataService SHALL extract the EXIF DateTimeOriginal field and store it as the CaptureDate for that photo.
2. IF the EXIF DateTimeOriginal field is absent, THEN THE MetadataService SHALL attempt extraction from the EXIF DateTimeDigitized field.
3. IF both EXIF date fields are absent, THEN THE MetadataService SHALL set the CaptureDate to null for that photo.
4. WHEN ImportScanService processes a photo file, THE MetadataService SHALL extract the EXIF Make and Model fields and store them as camera information.
5. WHEN a photo is listed by PhotoService and has no metadata record in MetadataStore, THE MetadataService SHALL queue the photo for background EXIF extraction.

### Requirement 2: Local Metadata Persistence

**User Story:** As a user, I want my photo metadata stored locally for instant access, so that sorting and rating work quickly without network requests.

#### Acceptance Criteria

1. THE MetadataStore SHALL persist photo metadata records in IndexedDB with fields: photoId (encrypted filename), captureDate, cameraMake, cameraModel, rating, and isFavorite.
2. WHEN a metadata record is created or updated, THE MetadataService SHALL write the change to MetadataStore within the current execution frame.
3. WHEN the AlbumViewComponent requests photo metadata, THE MetadataService SHALL read from MetadataStore without network calls.
4. IF IndexedDB is unavailable, THEN THE MetadataService SHALL fall back to in-memory storage for the current session and log a warning.

### Requirement 3: Cloud Metadata Sync

**User Story:** As a user, I want my metadata available on all my devices, so that ratings and favorites carry over when I switch devices.

#### Acceptance Criteria

1. WHEN metadata changes occur, THE MetadataService SHALL start a debounced FlushTimer of 30 seconds after the last change.
2. WHEN the FlushTimer expires, THE MetadataService SHALL serialize all metadata records to JSON, encrypt the result using AES-256-GCM via CryptoService, and write the VaultMetadataFile to `_intimapic/metadata.enc`.
3. WHEN the application visibility changes to hidden, THE MetadataService SHALL immediately flush pending metadata changes to the VaultMetadataFile regardless of the FlushTimer state.
4. WHEN a vault is opened on a device, THE MetadataService SHALL download and decrypt the VaultMetadataFile, then merge remote records with local MetadataStore records using a last-write-wins strategy based on a per-record timestamp.
5. IF the VaultMetadataFile does not exist in the cloud vault, THEN THE MetadataService SHALL treat the remote metadata set as empty and proceed with local data only.
6. IF the VaultMetadataFile download or decryption fails, THEN THE MetadataService SHALL log the error and continue operating with local MetadataStore data.

### Requirement 4: Favorite Toggle

**User Story:** As a user, I want to mark photos as favorites with a single tap, so that I can quickly find my best photos.

#### Acceptance Criteria

1. THE RatingComponent SHALL display a heart icon for each photo that toggles between filled (favorite) and outlined (not favorite) states.
2. WHEN the user taps the heart icon, THE MetadataService SHALL toggle the isFavorite field for that photo and persist the change to MetadataStore.
3. THE RatingComponent SHALL render the heart icon in the photo lightbox view (PhotoSwipe fullscreen).
4. WHEN the isFavorite field changes, THE MetadataService SHALL reset the FlushTimer to 30 seconds from the current time.

### Requirement 5: Star Rating

**User Story:** As a user, I want to rate photos on a 1–5 scale, so that I can sort by quality and find my best shots.

#### Acceptance Criteria

1. THE RatingComponent SHALL display five star icons that allow selecting a rating from 1 to 5 for each photo.
2. WHEN the user taps a star, THE MetadataService SHALL set the rating field for that photo to the selected value (1–5) and persist the change to MetadataStore.
3. WHEN the user taps the currently selected star rating, THE MetadataService SHALL clear the rating to null (unrated) and persist the change.
4. THE RatingComponent SHALL render the star rating controls in the photo lightbox view (PhotoSwipe fullscreen).
5. WHEN the rating field changes, THE MetadataService SHALL reset the FlushTimer to 30 seconds from the current time.

### Requirement 6: Gallery Sort Control

**User Story:** As a user, I want to sort photos in the gallery by different criteria, so that I can browse them in the order that is most useful to me.

#### Acceptance Criteria

1. THE SortControl SHALL appear as a button in the AlbumViewComponent toolbar with the current sort criterion label.
2. WHEN the user taps the SortControl, THE SortControl SHALL display a menu with options: "Filename", "Capture Date", and "Rating".
3. WHEN the user selects "Filename", THE AlbumViewComponent SHALL sort photos alphabetically by their decrypted filename in ascending order.
4. WHEN the user selects "Capture Date", THE AlbumViewComponent SHALL sort photos by CaptureDate in descending order (newest first), placing photos with null CaptureDate at the end.
5. WHEN the user selects "Rating", THE AlbumViewComponent SHALL sort photos by rating in descending order (highest first), placing unrated photos at the end, then by isFavorite (favorites first among equal ratings).
6. THE AlbumViewComponent SHALL persist the selected sort criterion locally so that the same sort order applies on subsequent visits to the same album.
7. THE AlbumViewComponent SHALL default to "Filename" sort order when no persisted sort preference exists for an album.
