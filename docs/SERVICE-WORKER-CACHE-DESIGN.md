# IntimaPic – ServiceWorker Cache & Offline-Architektur

## Zusammenfassung

Dieses Dokument beschreibt die Architektur eines Custom ServiceWorkers, der als **zentrale Daten-Middleware** zwischen der Angular-PWA und den Cloud-Storage-Providern agiert. Ziel ist es, die App responsiver zu machen, Netzwerkrequests zu reduzieren und vollständige Offline-Fähigkeit zu ermöglichen.

---

## Inhaltsverzeichnis

1. [Design-Entscheidungen](#1-design-entscheidungen)
2. [Architektur-Überblick](#2-architektur-überblick)
3. [ServiceWorker-Verantwortlichkeiten](#3-serviceworker-verantwortlichkeiten)
4. [Messaging-API (Page ↔ SW)](#4-messaging-api-page--sw)
5. [Cache-Strategie](#5-cache-strategie)
6. [Key-Management & Offline-Unlock](#6-key-management--offline-unlock)
7. [Sync-Strategie](#7-sync-strategie)
8. [Storage-Provider im SW](#8-storage-provider-im-sw)
9. [Migration vom bestehenden Code](#9-migration-vom-bestehenden-code)
10. [Sicherheitsbetrachtung](#10-sicherheitsbetrachtung)
11. [Limitierungen & Sonderfälle](#11-limitierungen--sonderfälle)
12. [Offene Punkte](#12-offene-punkte)

---

## 1. Design-Entscheidungen

| # | Entscheidung | Begründung |
|---|-------------|------------|
| D1 | **Nur verschlüsselter Cache** – kein Klartext-Cache-Layer | Sicherheit: Kein entschlüsselter Content wird persistiert. Decrypt-Performance (~5ms/Thumbnail via Web Crypto) ist vernachlässigbar gegenüber Netzwerk-Latenz. |
| D2 | **Keys werden beim Unlock an den SW übergeben** und beim Lock gelöscht | SW benötigt Keys zum Entschlüsseln von Directory Listings und Dateinamen. Keys leben nur im SW-Memory (nicht persistiert). |
| D3 | **Offline-Unlock via lokal gespeicherter `masterkey.cryptomator`** | Die Masterkey-Datei wird verschlüsselt im Cache gehalten. Beim Offline-Unlock wird die scrypt-Ableitung + AES Key Unwrap lokal durchgeführt – identisch zum Online-Fall. |
| D4 | **Sync nur für aktiv besuchte Ordner** | Kein proaktives Pre-Fetching aller Alben-Inhalte. Album-Liste wird komplett synchronisiert, aber Foto-Inhalte nur für aktuell geöffnete Alben. |
| D5 | **Kein Thumbnail-Preloading** | Das bestehende Paging (Intersection Observer + Lazy Loading) bleibt erhalten. Der SW cached Thumbnails nur wenn sie von der Page angefragt werden. |
| D6 | **iCloud Drive bleibt im Main Thread** | File System Access API ist im SW-Kontext nicht verfügbar. iCloud-Adapter kommuniziert über einen Main-Thread-Proxy. |
| D7 | **Custom SW ersetzt Angular NGSW** | Ein einzelner Custom SW übernimmt sowohl App-Shell-Caching als auch Daten-Caching. Vermeidet Konflikte zwischen zwei SWs im gleichen Scope. |
| D8 | **IndexedDB (Dexie) als persistenter Cache-Store** | Bewährte Technologie, bereits im Projekt. Keine historischen iOS-Limits. Strukturierte Queries möglich. |

---

## 2. Architektur-Überblick

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Angular PWA (Main Thread)                       │
│                                                                     │
│  ┌───────────┐  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │  Gallery  │  │ CryptoService│  │    SwClientService           │  │
│  │  UI       │  │ (nur für     │  │    (MessageChannel API)      │  │
│  │           │  │  Decrypt)    │  │                              │  │
│  └─────┬─────┘  └──────┬───────┘  └──────────────┬──────────────┘  │
│        │                │                         │                 │
│        │                │◄── decrypted blobs ─────┤                 │
│        │                │                         │                 │
└────────┼────────────────┼─────────────────────────┼─────────────────┘
         │                │         postMessage     │
         │                │                         │
═════════╪════════════════╪═════════════════════════╪═══════════════════
         │                                          │
┌────────┼──────────────────────────────────────────┼─────────────────┐
│        │            Custom ServiceWorker           │                 │
│        │                                          │                 │
│  ┌─────▼──────────────────────────────────────────▼──────────────┐  │
│  │                       SW Controller                            │  │
│  │                                                               │  │
│  │  ┌───────────────┐  ┌───────────────┐  ┌──────────────────┐  │  │
│  │  │ StorageAdapter│  │ CacheManager  │  │  CryptoModule    │  │  │
│  │  │ (OneDrive, S3)│  │ (IndexedDB)   │  │  (Filename Dec., │  │  │
│  │  │               │  │               │  │   Dir-ID Enc.)   │  │  │
│  │  └───────┬───────┘  └───────┬───────┘  └────────┬─────────┘  │  │
│  └──────────┼──────────────────┼───────────────────┼─────────────┘  │
│             │                  │                   │                 │
└─────────────┼──────────────────┼───────────────────┼─────────────────┘
              │                  │                   │
       ┌──────▼──────┐   ┌──────▼──────┐     Keys im Memory
       │  Cloud APIs │   │  IndexedDB  │     (nicht persistiert)
       │  (Network)  │   │  (Cache DB) │
       └─────────────┘   └────────────┘
```

### Datenfluss: Thumbnail laden

```
1. Page: SwClientService.getThumbnail(encryptedName, directoryId, 'grid')
       │
       ▼ postMessage via MessageChannel
2. SW:  CacheManager.get('thumb:grid:' + encryptedName)
       │
       ├─ HIT:  Verschlüsselter Blob aus IndexedDB
       │        → postMessage zurück an Page
       │
       └─ MISS: StorageAdapter.readFile(thumbPath)
                → CacheManager.put(key, encryptedBlob)
                → postMessage zurück an Page
       │
       ▼
3. Page: CryptoService.decryptFile(encryptedBlob)
       │
       ▼
4. Page: new Blob([decrypted]) → URL.createObjectURL() → <img>
```

---

## 3. ServiceWorker-Verantwortlichkeiten

### Was der SW macht:
- **Netzwerk-Zugriff**: Alle Cloud-API-Aufrufe (OneDrive Graph API, S3 Pre-Signed URLs)
- **Verschlüsselter Cache**: Speichert verschlüsselte Blobs in IndexedDB
- **Directory Listings**: Lädt und cached Album-/Foto-Listings
- **Dateinamen-Entschlüsselung**: Entschlüsselt `.c9r`-Dateinamen für Listings (benötigt Keys)
- **Directory-ID-Verschlüsselung**: Berechnet Storage-Pfade (`d/XX/YYYY...`)
- **Auth-Token-Verwaltung**: Hält OAuth-Tokens für Cloud-Provider
- **App-Shell-Caching**: Statische Assets (JS, CSS, HTML) – ersetzt NGSW

### Was der SW NICHT macht:
- **Datei-Entschlüsselung** (Content): Bleibt im Main Thread (`CryptoService`)
- **UI-Rendering**: Keine DOM-Interaktion
- **Klartext-Caching**: Keine entschlüsselten Daten werden persistiert
- **Proaktives Pre-Fetching**: Kein Hintergrund-Download von nicht angeforderten Thumbnails

### Was im Main Thread bleibt:
- **File-Content-Decryption** (AES-GCM Chunk-Decryption)
- **Blob-URL-Erzeugung** und Anzeige
- **HEIC-Konvertierung** (benötigt OffscreenCanvas im Main Thread oder Worker)
- **iCloud Drive Adapter** (File System Access API)
- **MSAL Token-Refresh** (benötigt ggf. DOM für Popup-Fallback)
- **Upload-Pipeline** (Encryption + Thumbnail-Generierung)

---

## 4. Messaging-API (Page ↔ SW)

### 4.1 Transport: MessageChannel

Jede Anfrage verwendet einen dedizierten `MessageChannel` für Request/Response-Korrelation:

```typescript
// SwClientService (Main Thread)
async function sendCommand<T>(command: SwCommand): Promise<T> {
  const { port1, port2 } = new MessageChannel();
  
  return new Promise((resolve, reject) => {
    port1.onmessage = (event: MessageEvent<SwResponse>) => {
      if (event.data.type === 'ERROR') {
        reject(new SwError(event.data.code, event.data.message));
      } else if (event.data.type === 'NEED_KEYS') {
        // Re-transfer keys and retry (SW was terminated)
        this.reTransferKeys().then(() => this.sendCommand(command))
          .then(resolve).catch(reject);
      } else {
        resolve(event.data as T);
      }
      port1.close();
    };
    
    navigator.serviceWorker.controller!.postMessage(command, [port2]);
  });
}
```

### 4.2 Commands (Page → SW)

```typescript
// ─── Lifecycle ──────────────────────────────────────────────────────

interface InitKeysCommand {
  type: 'INIT_KEYS';
  encryptionKey: ArrayBuffer;
  macKey: ArrayBuffer;
  vaultId: string;
}

interface LockCommand {
  type: 'LOCK';
}

interface SetAuthTokenCommand {
  type: 'SET_AUTH_TOKEN';
  provider: 'onedrive' | 's3';
  token: string;
  refreshToken?: string;
  expiresAt: number;
}

// ─── Album/Directory Operations ─────────────────────────────────────

interface ListAlbumsCommand {
  type: 'LIST_ALBUMS';
  forceRefresh?: boolean;
}

interface ListPhotosCommand {
  type: 'LIST_PHOTOS';
  directoryId: string;
  forceRefresh?: boolean;
}

// ─── File Operations ────────────────────────────────────────────────

interface GetThumbnailCommand {
  type: 'GET_THUMBNAIL';
  encryptedName: string;
  directoryId: string;
  size: 'grid' | 'preview';
}

interface GetOriginalCommand {
  type: 'GET_ORIGINAL';
  storagePath: string;
}

interface WriteFileCommand {
  type: 'WRITE_FILE';
  path: string;
  data: ArrayBuffer;
}

interface DeleteFileCommand {
  type: 'DELETE_FILE';
  path: string;
}

// ─── Cache Management ───────────────────────────────────────────────

interface InvalidateCacheCommand {
  type: 'INVALIDATE_CACHE';
  scope: 'all' | 'directory';
  directoryId?: string;
}

interface GetCacheStatsCommand {
  type: 'GET_CACHE_STATS';
}

// ─── Storage Info ───────────────────────────────────────────────────

interface GetQuotaCommand {
  type: 'GET_QUOTA';
}

interface CheckConnectivityCommand {
  type: 'CHECK_CONNECTIVITY';
}
```

### 4.3 Responses (SW → Page)

```typescript
// ─── Success Responses ──────────────────────────────────────────────

interface AlbumsListResponse {
  type: 'ALBUMS_LIST';
  albums: CachedAlbum[];
  fromCache: boolean;
}

interface PhotosListResponse {
  type: 'PHOTOS_LIST';
  directoryId: string;
  photos: CachedPhotoEntry[];
  fromCache: boolean;
}

interface FileDataResponse {
  type: 'FILE_DATA';
  data: ArrayBuffer;       // Verschlüsselte Daten
  fromCache: boolean;
}

interface CacheStatsResponse {
  type: 'CACHE_STATS';
  totalEntries: number;
  totalSizeBytes: number;
  quotaUsedPercent: number;
  oldestEntry: number;     // Timestamp
}

// ─── Control Responses ──────────────────────────────────────────────

interface NeedKeysResponse {
  type: 'NEED_KEYS';
}

interface NeedTokenResponse {
  type: 'NEED_TOKEN';
  provider: 'onedrive' | 's3';
}

interface ErrorResponse {
  type: 'ERROR';
  code: SwErrorCode;
  message: string;
}

type SwErrorCode =
  | 'KEYS_NOT_SET'
  | 'TOKEN_EXPIRED'
  | 'NETWORK_ERROR'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'FILE_NOT_FOUND'
  | 'DECRYPT_FAILED'
  | 'PROVIDER_ERROR'
  | 'CACHE_ERROR'
  | 'OFFLINE';
```

### 4.4 Push-Nachrichten (SW → Page, unaufgefordert)

Für Statusupdates, die nicht auf einen Request antworten:

```typescript
interface DirectoryUpdatedPush {
  type: 'DIRECTORY_UPDATED';
  directoryId: string;
  addedCount: number;
  removedCount: number;
}

interface ConnectivityChangedPush {
  type: 'CONNECTIVITY_CHANGED';
  online: boolean;
}

interface CacheEvictionPush {
  type: 'CACHE_EVICTION';
  evictedCount: number;
  reason: 'quota' | 'lock' | 'manual';
}
```

---

## 5. Cache-Strategie

### 5.1 Cache-Architektur

Alles wird **verschlüsselt** gespeichert. Der Cache enthält:

| Store | Inhalt | Persistenz | Eviction |
|-------|--------|-----------|----------|
| `app_shell` | JS, CSS, HTML, Manifest | Permanent | Bei App-Update |
| `vault_meta` | `masterkey.cryptomator`, `vault.cryptomator` | Permanent (pro Vault) | Bei Vault-Löschung |
| `directory_listings` | Verschlüsselte Ordner-Einträge (raw JSON der FileEntry[]) | Persistent, TTL 5 min | LRU, nur besuchte Ordner |
| `thumbnails_grid` | Verschlüsselte Grid-Thumbnails (~60KB) | Persistent | LRU bei Quota >80% |
| `thumbnails_preview` | Verschlüsselte Preview-Thumbnails (~250KB) | Persistent | LRU max 500 Einträge |
| `originals` | Verschlüsselte Originale (nur on-demand, z.B. Download) | Nicht gecacht | — |

### 5.2 IndexedDB-Schema (Dexie)

```typescript
// sw-cache-db.ts (im ServiceWorker)

interface CachedBlob {
  /** Composite key: 'grid:{encryptedName}' oder 'preview:{encryptedName}' */
  key: string;
  /** Vault ID – zur Isolation bei Multi-Vault */
  vaultId: string;
  /** Verschlüsselte Daten */
  data: ArrayBuffer;
  /** Zeitpunkt der Speicherung (für LRU) */
  cachedAt: number;
  /** Letzer Zugriff (für LRU-Eviction) */
  lastAccess: number;
  /** Größe in Bytes (für Quota-Tracking) */
  size: number;
}

interface CachedDirectoryListing {
  /** Key: vaultId + ':' + directoryId */
  key: string;
  vaultId: string;
  directoryId: string;
  /** Raw FileEntry[] als JSON – noch verschlüsselte Namen */
  entries: FileEntry[];
  /** Zeitpunkt des letzten Syncs */
  syncedAt: number;
  /** ETag oder Hash für Change-Detection */
  etag?: string;
}

interface CachedVaultMeta {
  /** Key: vaultId */
  vaultId: string;
  /** masterkey.cryptomator Inhalt (bleibt verschlüsselt – enthält wrapped keys) */
  masterkeyFile: ArrayBuffer;
  /** vault.cryptomator Inhalt (JWT) */
  vaultConfig: ArrayBuffer;
  /** Storage Provider Konfiguration */
  storageSettings: StorageSettings;
  /** Zeitpunkt der letzten Aktualisierung */
  updatedAt: number;
}

// Dexie Schema:
this.version(1).stores({
  thumbnails: 'key, vaultId, lastAccess, size',
  directories: 'key, vaultId, syncedAt',
  vaultMeta: 'vaultId',
});
```

### 5.3 Cache-Ablauf (Read Path)

```
GET_THUMBNAIL Request
    │
    ▼
┌─ IndexedDB Lookup (key = 'grid:' + encryptedName) ─┐
│                                                      │
├─ HIT: lastAccess aktualisieren                       │
│       → verschlüsselten Blob zurückgeben             │
│                                                      │
└─ MISS: ─────────────────────────────────────────────┐│
         │                                            ││
         ▼                                            ││
    Online? ──── Nein ──► ERROR { code: 'OFFLINE' }   ││
         │                                            ││
         Ja                                           ││
         │                                            ││
         ▼                                            ││
    StorageAdapter.readFile(thumbPath)                 ││
         │                                            ││
         ▼                                            ││
    IndexedDB.put({ key, data, cachedAt, size })      ││
         │                                            ││
         ▼                                            ││
    → verschlüsselten Blob zurückgeben                ││
                                                      ││
└─────────────────────────────────────────────────────┘│
```

### 5.4 Cache-Eviction

```typescript
async function evictIfNeeded(vaultId: string): Promise<void> {
  const stats = await navigator.storage.estimate();
  const usedPercent = ((stats.usage ?? 0) / (stats.quota ?? 1)) * 100;
  
  if (usedPercent > 80) {
    // Phase 1: Preview-Thumbnails evicten (größer, weniger kritisch)
    await evictOldest('thumbnails', vaultId, 'preview:', 100);
  }
  
  if (usedPercent > 90) {
    // Phase 2: Grid-Thumbnails evicten (älteste zuerst)
    await evictOldest('thumbnails', vaultId, 'grid:', 200);
  }
  
  if (usedPercent > 95) {
    // Phase 3: Directory Listings evicten (außer aktuell geöffneter)
    await evictOldDirectories(vaultId, keepDirectoryIds);
  }
}

async function evictOldest(
  store: string, vaultId: string, prefix: string, count: number
): Promise<void> {
  // Älteste nach lastAccess, limitiert auf count
  const oldest = await db.table(store)
    .where('vaultId').equals(vaultId)
    .filter(entry => entry.key.startsWith(prefix))
    .sortBy('lastAccess');
  
  const toDelete = oldest.slice(0, count).map(e => e.key);
  await db.table(store).bulkDelete(toDelete);
}
```

---

## 6. Key-Management & Offline-Unlock

### 6.1 Key-Lifecycle

```
┌──────────────────────────────────────────────────────────┐
│                    Key-Lifecycle                           │
│                                                          │
│  ┌─────────┐     INIT_KEYS      ┌─────────────────┐     │
│  │ Locked  │ ──────────────────► │ Keys im Memory  │     │
│  │(no keys)│                     │ (SW Scope)      │     │
│  └────┬────┘                     └────────┬────────┘     │
│       │                                   │              │
│       │◄──── LOCK ────────────────────────┤              │
│       │      (zeroize + delete)           │              │
│       │                                   │              │
│       │◄──── SW Termination ──────────────┤              │
│       │      (GC räumt Scope)             │              │
│       │                                   │              │
│       │      NEED_KEYS ──────────────────►│              │
│       │      (Page sendet erneut)         │              │
│       │                                   │              │
└───────┼───────────────────────────────────┼──────────────┘
```

### 6.2 Key-Übergabe beim Unlock

```typescript
// Main Thread: VaultService.unlockVault()
async unlockVault(password: string): Promise<boolean> {
  // 1. Online ODER Offline: masterkey.cryptomator laden
  let masterkeyData: ArrayBuffer;
  
  if (navigator.onLine) {
    // Vom Cloud-Storage laden (über SW)
    masterkeyData = await this.swClient.getFile('masterkey.cryptomator');
    // SW cached die Datei automatisch in vault_meta
  } else {
    // Aus dem SW-Cache laden
    masterkeyData = await this.swClient.getCachedVaultMeta();
  }
  
  // 2. Passwort prüfen + Keys ableiten (lokal, kein Netzwerk nötig)
  const success = await this.cryptoService.unlockVault(password, masterkeyData);
  if (!success) return false;
  
  // 3. Keys an SW übergeben
  const keys = this.cryptoService.getMasterKeys();
  await this.swClient.sendCommand({
    type: 'INIT_KEYS',
    encryptionKey: keys.encryptionKey,
    macKey: keys.macKey,
    vaultId: this.registry.activeVaultId(),
  });
  
  // 4. Auth-Token übergeben (nur wenn online)
  if (navigator.onLine) {
    await this.transferAuthToken();
  }
  
  return true;
}
```

### 6.3 Offline-Unlock

Der Offline-Unlock ist möglich, weil:

1. **`masterkey.cryptomator` wird lokal gecacht** (im `vault_meta` Store)
2. **scrypt + AES Key Unwrap** brauchen kein Netzwerk (reine CPU-Operationen)
3. **Das Passwort wird deterministisch geprüft**: AES Key Unwrap (RFC 3394) schlägt bei falschem Passwort garantiert fehl

```
Offline-Unlock Flow:
━━━━━━━━━━━━━━━━━━━

1. User gibt Passwort ein
2. Page: SwClientService.getCachedVaultMeta(vaultId)
   → SW: IndexedDB vault_meta lookup → masterkey.cryptomator (encrypted wrapped keys)
3. Page: CryptoService.unlockVault(password, masterkeyData)
   → scrypt(password, salt) → KEK
   → AES Key Unwrap(KEK, wrappedEncKey) → encryptionKey
   → AES Key Unwrap(KEK, wrappedMacKey) → macKey
   → Erfolg? → Keys sind verfügbar
4. Page: INIT_KEYS an SW → SW hat Keys
5. Album-Liste + Thumbnails aus IndexedDB-Cache → UI sofort nutzbar
```

### 6.4 Wann wird `masterkey.cryptomator` gecacht?

- **Beim ersten erfolgreichen Online-Unlock**: SW speichert die Datei automatisch
- **Bei jedem Online-Unlock**: SW aktualisiert den Cache (falls Passwort geändert wurde)
- **Beim Vault-Lock**: Cache bleibt (enthält nur wrapped keys, sind ohne Passwort wertlos)
- **Bei Vault-Löschung**: Cache wird entfernt

### 6.5 Key-Zeroization beim Lock

```typescript
// Im ServiceWorker:
function handleLock(): void {
  if (masterKeys) {
    // Keys im Memory überschreiben
    new Uint8Array(masterKeys.encryptionKey).fill(0);
    new Uint8Array(masterKeys.macKey).fill(0);
    masterKeys = null;
  }
  currentVaultId = null;
  
  // Auth-Tokens löschen
  authTokens.clear();
  
  // Kein Cache-Löschen nötig! Alles ist verschlüsselt.
}
```

**Wichtig**: Der verschlüsselte Cache bleibt bei Lock erhalten. Da alle Daten mit dem Cryptomator-Format verschlüsselt sind, ist ein Zugriff ohne Passwort nicht möglich.

---

## 7. Sync-Strategie

### 7.1 Grundprinzip: "Sync on Visit"

```
┌──────────────────────────────────────────────────────────────┐
│                     Sync-Strategie                            │
│                                                              │
│  ┌────────────────────────────────────┐                      │
│  │ Album-Liste (Root Directory)       │ ← Sync bei jedem    │
│  │ • Wird bei Vault-Unlock geladen    │   Unlock + manuell  │
│  │ • TTL: 5 Minuten                   │                      │
│  └────────────────────────────────────┘                      │
│                                                              │
│  ┌────────────────────────────────────┐                      │
│  │ Album-Inhalt (Foto-Listing)        │ ← Sync nur wenn     │
│  │ • Wird geladen wenn User Album     │   User Album öffnet │
│  │   öffnet                           │                      │
│  │ • TTL: 5 Minuten                   │                      │
│  │ • Stale-While-Revalidate           │                      │
│  └────────────────────────────────────┘                      │
│                                                              │
│  ┌────────────────────────────────────┐                      │
│  │ Thumbnails                         │ ← Geladen wenn Page  │
│  │ • On-Demand (Paging bleibt)        │   sie anfordert      │
│  │ • Kein Pre-Fetching                │                      │
│  │ • Persistent im Cache              │                      │
│  └────────────────────────────────────┘                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 Album-Liste Sync

```typescript
// Im ServiceWorker:
async function handleListAlbums(
  command: ListAlbumsCommand, 
  port: MessagePort
): Promise<void> {
  const cacheKey = `${currentVaultId}:_albums`;
  const cached = await db.directories.get(cacheKey);
  
  const TTL = 5 * 60 * 1000; // 5 Minuten
  const isStale = !cached || (Date.now() - cached.syncedAt > TTL);
  
  // Stale-While-Revalidate: Sofort aus Cache antworten, dann aktualisieren
  if (cached && !command.forceRefresh) {
    port.postMessage({
      type: 'ALBUMS_LIST',
      albums: await decryptAlbumList(cached.entries),
      fromCache: true,
    });
  }
  
  if (isStale || command.forceRefresh) {
    if (!navigator.onLine) {
      if (!cached) {
        port.postMessage({ type: 'ERROR', code: 'OFFLINE', message: 'Keine Verbindung und kein Cache vorhanden.' });
      }
      return;
    }
    
    // Frisch vom Storage laden
    const rootPath = await encryptDirectoryId('');
    const entries = await storageAdapter.listFiles(rootPath);
    
    // Cache aktualisieren
    await db.directories.put({
      key: cacheKey,
      vaultId: currentVaultId,
      directoryId: '_albums',
      entries,
      syncedAt: Date.now(),
    });
    
    // Neue Daten an Page senden (wenn sich etwas geändert hat)
    const albums = await decryptAlbumList(entries);
    port.postMessage({
      type: 'ALBUMS_LIST',
      albums,
      fromCache: false,
    });
  }
}
```

### 7.3 Foto-Listing Sync (nur bei Besuch)

```typescript
async function handleListPhotos(
  command: ListPhotosCommand,
  port: MessagePort
): Promise<void> {
  const cacheKey = `${currentVaultId}:${command.directoryId}`;
  const cached = await db.directories.get(cacheKey);
  
  const TTL = 5 * 60 * 1000;
  const isStale = !cached || (Date.now() - cached.syncedAt > TTL);
  
  // Sofort aus Cache antworten (für Instant-UX)
  if (cached && !command.forceRefresh) {
    const photos = await decryptPhotoList(cached.entries, command.directoryId);
    port.postMessage({
      type: 'PHOTOS_LIST',
      directoryId: command.directoryId,
      photos,
      fromCache: true,
    });
  }
  
  // Im Hintergrund aktualisieren wenn stale
  if (isStale || command.forceRefresh) {
    if (!navigator.onLine) {
      if (!cached) {
        port.postMessage({ type: 'ERROR', code: 'OFFLINE', message: 'Ordner nicht im Cache.' });
      }
      return;
    }
    
    const dirPath = await encryptDirectoryId(command.directoryId);
    const entries = await storageAdapter.listFiles(dirPath);
    
    await db.directories.put({
      key: cacheKey,
      vaultId: currentVaultId,
      directoryId: command.directoryId,
      entries,
      syncedAt: Date.now(),
    });
    
    // Nur updaten wenn sich tatsächlich etwas geändert hat
    if (!cached || hasChanges(cached.entries, entries)) {
      const photos = await decryptPhotoList(entries, command.directoryId);
      port.postMessage({
        type: 'PHOTOS_LIST',
        directoryId: command.directoryId,
        photos,
        fromCache: false,
      });
    }
  }
}
```

### 7.4 Stale-While-Revalidate Pattern

```
User öffnet Album
       │
       ▼
  Cache vorhanden? ────── Nein ──► Lade von Netzwerk ──► Zeige an
       │
       Ja
       │
       ▼
  Zeige sofort aus Cache (UX: instant!)
       │
       ▼
  Stale? (> 5 min) ────── Nein ──► Fertig
       │
       Ja
       │
       ▼
  Lade im Hintergrund von Netzwerk
       │
       ▼
  Änderungen? ────── Nein ──► Fertig
       │
       Ja
       │
       ▼
  Push DIRECTORY_UPDATED an Page
       │
       ▼
  Page aktualisiert UI (neue/entfernte Fotos)
```

---

## 8. Storage-Provider im SW

### 8.1 Adapter-Interface (SW-Version)

Die Storage-Adapter werden in den SW verschoben. Das Interface bleibt gleich, aber die Implementierung wird für den SW-Kontext angepasst:

```typescript
// sw/storage/storage-adapter.interface.ts

interface SwStorageAdapter {
  readonly providerName: string;
  
  connect(token: string, config: ProviderConfig): void;
  disconnect(): void;
  isConnected(): boolean;
  
  listFiles(path: string): Promise<FileEntry[]>;
  readFile(path: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  getQuota(): Promise<StorageQuota>;
}
```

### 8.2 Auth-Token-Handling

```
┌─────────────────────────────────────────────────────────┐
│                 Token-Flow                                │
│                                                         │
│  Page ──SET_AUTH_TOKEN──► SW (hält Token im Memory)     │
│                                                         │
│  SW: Token abgelaufen?                                  │
│       │                                                 │
│       ▼                                                 │
│  SW ──NEED_TOKEN──► Page                                │
│                       │                                 │
│                       ▼                                 │
│  Page: MSAL.acquireTokenSilent()                        │
│       (oder Popup-Fallback im Main Thread)              │
│                       │                                 │
│                       ▼                                 │
│  Page ──SET_AUTH_TOKEN──► SW (neuer Token)              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 8.3 iCloud Drive Sonderfall

Da die File System Access API im SW nicht verfügbar ist, fungiert der Main Thread als Proxy:

```typescript
// Nur für iCloud Drive:
// SW sendet "ICLOUD_REQUEST" → Page führt FS Access API aus → Antwort an SW

interface ICloudProxyRequest {
  type: 'ICLOUD_REQUEST';
  operation: 'listFiles' | 'readFile' | 'writeFile' | 'deleteFile';
  path: string;
  data?: ArrayBuffer;
}

interface ICloudProxyResponse {
  type: 'ICLOUD_RESPONSE';
  requestId: string;
  result?: any;
  error?: string;
}
```

Der SW-Code erkennt den Provider-Typ und leitet iCloud-Anfragen an den Main Thread weiter, statt sie selbst auszuführen.

---

## 9. Migration vom bestehenden Code

### 9.1 Betroffene Services

| Bestehender Service | Änderung |
|-------------------|----------|
| `PhotoService` | Ruft SW via `SwClientService` statt direkt `StorageAdapter` auf. `decryptFile()` bleibt lokal. LRU-Cache wird zu In-Memory-only (kein IndexedDB im Main Thread mehr). |
| `AlbumService` | Delegiert `listFiles` an SW. Erhält bereits entschlüsselte Album-Namen vom SW. |
| `VaultService` | Unlock-Flow erweitert: nach Key-Derivation → `INIT_KEYS` an SW. Lock: `LOCK` an SW. |
| `ThumbnailSyncService` | Bleibt im Main Thread (benötigt OffscreenCanvas). Nutzt aber SW für Storage-Zugriff. |
| `StorageAdapterFactory` | Wird im Main Thread entfernt (außer für iCloud). Adapters leben im SW. |
| `OneDriveAdapter` | Verschoben in den SW. `RequestThrottle` bleibt. |
| `S3Adapter` | Verschoben in den SW. |
| `app.config.ts` | NGSW-Registration → Custom SW Registration. |
| `ngsw-config.json` | Entfällt. App-Shell-Caching wird im Custom SW implementiert. |

### 9.2 Neue Services

| Neuer Service | Verantwortung |
|---------------|---------------|
| `SwClientService` | Messaging-API zum SW. Request/Response-Handling. Key-Re-Transfer. |
| `SwRegistrationService` | SW-Registrierung, Update-Handling, Lifecycle. |
| `sw/controller.ts` | Haupt-Entry-Point des SW. Message-Router. |
| `sw/cache-manager.ts` | IndexedDB-Zugriff für verschlüsselten Cache. LRU-Eviction. |
| `sw/crypto-module.ts` | AES-SIV (Dateinamen) + Directory-ID-Encryption. Nur das, was der SW für Listings braucht. |
| `sw/app-shell-cache.ts` | Ersetzt NGSW: Precache App-Shell, Versioned Assets. |

### 9.3 Dateistruktur (vorgeschlagen)

```
src/
├── app/
│   ├── core/
│   │   ├── sw-client/
│   │   │   ├── sw-client.service.ts      ← Messaging-API
│   │   │   ├── sw-registration.service.ts
│   │   │   ├── sw-client.models.ts       ← Command/Response Types
│   │   │   └── index.ts
│   │   ├── crypto/                        ← Bleibt (für File Decryption)
│   │   ├── storage/                       ← Nur noch iCloud-Adapter
│   │   ├── album/                         ← Nutzt SwClientService
│   │   └── ...
│   └── ...
│
├── service-worker/
│   ├── sw.ts                              ← Entry Point
│   ├── controller.ts                      ← Message Router
│   ├── cache/
│   │   ├── cache-manager.ts              ← IndexedDB CRUD + Eviction
│   │   ├── cache-db.ts                   ← Dexie Schema
│   │   └── app-shell-cache.ts            ← Static Asset Caching
│   ├── storage/
│   │   ├── storage-adapter.interface.ts
│   │   ├── onedrive-adapter.ts
│   │   ├── s3-adapter.ts
│   │   └── storage-factory.ts
│   ├── crypto/
│   │   ├── filename-crypto.ts            ← AES-SIV für Dateinamen
│   │   ├── directory-id-crypto.ts        ← Dir-ID → Storage Path
│   │   └── crypto.models.ts
│   └── models/
│       ├── commands.ts
│       └── responses.ts
│
└── ...
```

---

## 10. Sicherheitsbetrachtung

### 10.1 Threat Model

| Angriff | Risiko | Mitigation |
|---------|--------|-----------|
| XSS liest Keys aus Main Thread | Unverändert (wie bisher) | CSP, Input Sanitization |
| XSS sendet `INIT_KEYS` mit falschen Keys | Niedrig – kann eigenen Vault nicht unterschieben | SW akzeptiert `INIT_KEYS` nur einmal pro Session |
| XSS sendet Commands an SW | Kann verschlüsselte Daten abrufen, aber nicht entschlüsseln | SW gibt nur verschlüsselte Blobs zurück |
| Cold-Boot / Memory Dump | Gleich wie bisher | Keys nur im Memory, zeroized bei Lock |
| Zugriff auf IndexedDB (z.B. über DevTools) | Nur verschlüsselte Daten sichtbar | Kein Klartext im Cache |
| SW Termination → Keys verloren | Kein Sicherheitsrisiko | Lazy Re-Transfer löst es funktional |

### 10.2 Sicherheits-Invarianten

1. **Kein Klartext wird jemals persistiert** (weder in IndexedDB noch in Cache API)
2. **Keys existieren nur im flüchtigen Memory** (Main Thread + SW Scope)
3. **SW akzeptiert `INIT_KEYS` nur einmal** (kein Überschreiben durch XSS)
4. **SW gibt Keys niemals heraus** (kein `GET_KEYS`-Command)
5. **Bei Lock werden Keys sofort zeroized** (in beiden Kontexten)
6. **masterkey.cryptomator im Cache ist sicher** (enthält nur AES-Key-Wrapped Keys, nutzlos ohne Passwort + scrypt)

### 10.3 Key-Validierung im SW

```typescript
// ServiceWorker: Nur einmal Keys akzeptieren pro Session
let masterKeys: MasterKeys | null = null;
let keysSetByClient: string | null = null; // Client-ID

function handleInitKeys(event: ExtendableMessageEvent, command: InitKeysCommand): void {
  const clientId = (event.source as WindowClient)?.id;
  
  if (masterKeys !== null) {
    // Keys bereits gesetzt – nur vom gleichen Client erlauben (Re-Transfer nach SW-Restart)
    if (clientId !== keysSetByClient) {
      event.ports[0].postMessage({ 
        type: 'ERROR', 
        code: 'KEYS_ALREADY_SET',
        message: 'Keys wurden bereits von einem anderen Client gesetzt.' 
      });
      return;
    }
  }
  
  masterKeys = {
    encryptionKey: command.encryptionKey,
    macKey: command.macKey,
  };
  keysSetByClient = clientId;
  currentVaultId = command.vaultId;
  
  event.ports[0].postMessage({ type: 'ACK' });
}
```

---

## 11. Limitierungen & Sonderfälle

### 11.1 iCloud Drive

- **File System Access API nicht im SW verfügbar**
- Lösung: Main-Thread-Proxy (siehe Abschnitt 8.3)
- Performance-Implikation: Jeder iCloud-Zugriff hat einen zusätzlichen postMessage-Roundtrip
- Da iCloud Drive lokal ist (keine Netzwerk-Latenz), ist dies akzeptabel

### 11.2 SW Termination & Restart

- Browser kann den SW nach ~30s Inaktivität terminieren
- **Keys gehen verloren** → `NEED_KEYS`-Response an Page → Re-Transfer
- **IndexedDB-Cache bleibt** → kein Datenverlust
- **Auth-Tokens gehen verloren** → `NEED_TOKEN`-Response → Page refresht Token

### 11.3 Multi-Tab-Szenarien

- Nur ein SW pro Origin, geteilt zwischen allen Tabs
- `INIT_KEYS` vom ersten Tab, das den Vault unlocked
- Weitere Tabs senden ebenfalls `INIT_KEYS` (SW ignoriert wenn bereits gesetzt mit gleichen Keys)
- `LOCK` von einem Tab → alle Tabs erhalten `CONNECTIVITY_CHANGED` Push (oder eigenes `VAULT_LOCKED` Event)

### 11.4 App-Updates (SW Update Lifecycle)

```typescript
// sw.ts
self.addEventListener('install', (event) => {
  // Neuer SW installiert – sofort aktivieren
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Alte App-Shell-Caches löschen
      clearOldAppShellCaches(),
      // Claim alle Clients sofort
      self.clients.claim(),
    ])
  );
});
```

- Daten-Cache (`thumbnails`, `directories`) wird **nicht** bei Updates gelöscht
- Nur `app_shell`-Cache wird bei neuer Version ersetzt
- Page erkennt neuen SW und zeigt "Update verfügbar"-Banner

### 11.5 `navigator.storage.persist()`

```typescript
// Bei App-Installation / erstem Unlock:
async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage?.persist) {
    return navigator.storage.persist();
    // Safari (Home Screen PWA): auto-approved
    // Chrome: auto-approved bei hohem Engagement
  }
  return false;
}
```

---

## 12. Offene Punkte

| # | Frage | Status | Notizen |
|---|-------|--------|---------|
| 1 | Soll der SW auch für **Uploads** zuständig sein (Background Upload)? | Offen | Könnte mit Background Fetch API implementiert werden. Upload-Pipeline braucht aber OffscreenCanvas für Thumbnails → evtl. Hybrid. |
| 2 | **Conflict Resolution**: Was passiert wenn ein Foto in der Cloud gelöscht wurde, aber noch im Cache ist? | Offen | Vorschlag: Bei Stale-Revalidate fehlende Einträge aus Cache entfernen. |
| 3 | **Multi-Vault**: Wie interagiert der Cache bei Vault-Wechsel? | Design vorhanden | Jeder Cache-Eintrag hat `vaultId`. Bei Lock werden nur Keys gelöscht, Cache bleibt isoliert. |
| 4 | **Cache-Migration**: Wie werden bestehende Nutzer migriert (LRU-Cache → SW-Cache)? | Offen | Vermutlich Clean Start: alter In-Memory-Cache hat keine Persistenz, also kein Datenverlust. |
| 5 | **Build-Setup**: Wie wird der SW gebündelt (separate Webpack/esbuild Config)? | Offen | Angular CLI Custom Builder oder separate esbuild-Konfiguration für `src/service-worker/`. |
| 6 | **Testing**: Wie werden SW-Commands in Unit Tests getestet? | Offen | Vorschlag: SW-Logik als reine Funktionen testen, Message-Routing separat. |
| 7 | **Rate Limiting**: Soll der SW das bestehende OneDrive-Throttling (4 concurrent) beibehalten? | Ja | `RequestThrottle` wird 1:1 in den SW übernommen. |

---

## Anhang A: Speicher-Abschätzung

| Vault-Größe | Encrypted Cache (Grid + Preview) | Directory Listings | Vault Meta | **Total** |
|-------------|----------------------------------|-------------------|------------|-----------|
| 1.000 Fotos | ~310 MB | ~50 KB | ~5 KB | **~310 MB** |
| 5.000 Fotos | ~1.55 GB | ~250 KB | ~5 KB | **~1.55 GB** |
| 10.000 Fotos | ~3.1 GB | ~500 KB | ~5 KB | **~3.1 GB** |
| 50.000 Fotos | ~15.5 GB | ~2.5 MB | ~5 KB | **~15.5 GB** |

Typische Browser-Quota: 30–120 GB (je nach Gerät). Selbst bei 50.000 Fotos unter 50% der Quota.

---

## Anhang B: Performance-Vergleich (geschätzt)

| Aktion | Heute (kein Cache) | Mit SW-Cache |
|--------|-------------------|--------------|
| Album öffnen (100 Fotos, Listing) | ~800ms (Netzwerk) | ~5ms (IndexedDB) + Background Revalidate |
| Thumbnail laden (Grid) | ~200ms (Netzwerk + Decrypt) | ~10ms (IDB) + ~5ms (Decrypt) = **~15ms** |
| Thumbnail laden (Preview) | ~400ms (Netzwerk + Decrypt) | ~15ms (IDB) + ~5ms (Decrypt) = **~20ms** |
| App neu laden nach Vault Unlock | Alles erneut laden | Alles aus Cache, **instant** |
| Offline-Nutzung | ❌ Nicht möglich | ✅ Vollständig (alle gecachten Alben) |
