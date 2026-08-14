/**
 * ServiceWorker Controller – Routes incoming messages to appropriate handlers.
 *
 * Architecture:
 * - Each command type is routed to a handler function
 * - Handlers receive the command payload and a reply function
 * - The reply function sends a response back via the MessagePort
 * - Keys and tokens are held in module-level variables (SW memory)
 */

import type { SwCommand } from './models/commands';
import type { SwResponse, SwPushMessage } from './models/responses';
import type { MasterKeys } from './crypto/crypto.models';
import { CacheManager } from './cache/cache-manager';
import { FilenameCrypto } from './crypto/filename-crypto';
import { DirectoryIdCrypto } from './crypto/directory-id-crypto';
import { SwStorageFactory } from './storage/storage-factory';
import type { SwStorageAdapter } from './storage/storage-adapter.interface';

// ─── Module State (lives in SW memory, lost on termination) ────────────────────

let masterKeys: MasterKeys | null = null;
let currentVaultId: string | null = null;
let keysSetByClientId: string | null = null;

let storageAdapter: SwStorageAdapter | null = null;
const authTokens = new Map<string, { token: string; refreshToken?: string; expiresAt: number }>();

// Singleton instances
const cacheManager = new CacheManager();
const filenameCrypto = new FilenameCrypto();
const directoryIdCrypto = new DirectoryIdCrypto();
const storageFactory = new SwStorageFactory();

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Handle an incoming message from a client.
 * Routes to the appropriate handler based on command type.
 */
export async function handleMessage(
  event: ExtendableMessageEvent,
  command: SwCommand,
  replyPort: MessagePort
): Promise<void> {
  const clientId = (event.source as WindowClient | null)?.id ?? null;

  try {
    switch (command.type) {
      case 'INIT_KEYS':
        handleInitKeys(command, replyPort, clientId);
        break;

      case 'LOCK':
        handleLock(replyPort);
        break;

      case 'SET_AUTH_TOKEN':
        handleSetAuthToken(command, replyPort);
        break;

      case 'LIST_ALBUMS':
        await handleListAlbums(command, replyPort);
        break;

      case 'LIST_PHOTOS':
        await handleListPhotos(command, replyPort);
        break;

      case 'GET_THUMBNAIL':
        await handleGetThumbnail(command, replyPort);
        break;

      case 'GET_FILE':
        await handleGetFile(command, replyPort);
        break;

      case 'WRITE_FILE':
        await handleWriteFile(command, replyPort);
        break;

      case 'DELETE_FILE':
        await handleDeleteFile(command, replyPort);
        break;

      case 'FILE_EXISTS':
        await handleFileExists(command, replyPort);
        break;

      case 'CREATE_FOLDER':
        await handleCreateFolder(command, replyPort);
        break;

      case 'DELETE_FOLDER':
        await handleDeleteFolder(command, replyPort);
        break;

      case 'INVALIDATE_CACHE':
        await handleInvalidateCache(command, replyPort);
        break;

      case 'GET_CACHE_STATS':
        await handleGetCacheStats(replyPort);
        break;

      case 'GET_QUOTA':
        await handleGetQuota(replyPort);
        break;

      case 'CHECK_CONNECTIVITY':
        handleCheckConnectivity(replyPort);
        break;

      case 'GET_CACHED_VAULT_META':
        await handleGetCachedVaultMeta(command, replyPort);
        break;

      case 'ICLOUD_PROXY_RESPONSE':
        handleICloudProxyResponse(command);
        break;

      default:
        reply(replyPort, { type: 'ERROR', code: 'INVALID_COMMAND', message: `Unknown command type` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error in SW controller';
    reply(replyPort, { type: 'ERROR', code: 'PROVIDER_ERROR', message });
  }
}

/**
 * Broadcast a push message to all connected clients.
 */
export async function broadcastToClients(message: SwPushMessage): Promise<void> {
  const clients = await (self as unknown as ServiceWorkerGlobalScope).clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage(message);
  }
}

/**
 * Check if keys are currently loaded (for external use by other modules).
 */
export function hasKeys(): boolean {
  return masterKeys !== null;
}

/**
 * Get the current master keys (for use by crypto modules within the SW).
 */
export function getKeys(): MasterKeys | null {
  return masterKeys;
}

/**
 * Get the current vault ID.
 */
export function getVaultId(): string | null {
  return currentVaultId;
}

/**
 * Get the active storage adapter.
 */
export function getStorageAdapter(): SwStorageAdapter | null {
  return storageAdapter;
}

// ─── Command Handlers ──────────────────────────────────────────────────────────

function handleInitKeys(
  command: Extract<SwCommand, { type: 'INIT_KEYS' }>,
  port: MessagePort,
  clientId: string | null
): void {
  // Only accept keys once per session (prevent XSS key-swap)
  // Allow re-transfer from the same client (after SW restart)
  if (masterKeys !== null && clientId !== keysSetByClientId) {
    reply(port, { type: 'ERROR', code: 'KEYS_ALREADY_SET', message: 'Keys were already set by another client.' });
    return;
  }

  masterKeys = {
    encryptionKey: command.encryptionKey,
    macKey: command.macKey,
  };
  currentVaultId = command.vaultId;
  keysSetByClientId = clientId;

  // Initialize crypto modules with keys
  filenameCrypto.setKeys(masterKeys);
  directoryIdCrypto.setKeys(masterKeys);

  reply(port, { type: 'ACK' });
}

function handleLock(port: MessagePort): void {
  // Zeroize keys in memory
  if (masterKeys) {
    new Uint8Array(masterKeys.encryptionKey).fill(0);
    new Uint8Array(masterKeys.macKey).fill(0);
    masterKeys = null;
  }

  currentVaultId = null;
  keysSetByClientId = null;

  // Clear crypto module state
  filenameCrypto.clearKeys();
  directoryIdCrypto.clearKeys();

  // Clear auth tokens
  authTokens.clear();

  // Disconnect storage adapter
  if (storageAdapter) {
    storageAdapter.disconnect();
    storageAdapter = null;
  }

  // Note: Encrypted cache is NOT cleared (it's useless without keys)

  reply(port, { type: 'ACK' });
}

function handleSetAuthToken(
  command: Extract<SwCommand, { type: 'SET_AUTH_TOKEN' }>,
  port: MessagePort
): void {
  authTokens.set(command.provider, {
    token: command.token,
    refreshToken: command.refreshToken,
    expiresAt: command.expiresAt,
  });

  // Connect or update storage adapter
  storageAdapter = storageFactory.getOrCreateAdapter(
    command.provider,
    command.token,
    command.providerConfig
  );

  reply(port, { type: 'ACK' });
}

async function handleListAlbums(
  command: Extract<SwCommand, { type: 'LIST_ALBUMS' }>,
  port: MessagePort
): Promise<void> {
  if (!ensureKeys(port)) return;

  const TTL = 5 * 60 * 1000; // 5 minutes
  const cacheKey = `${currentVaultId}:_albums`;

  // Check cache first
  if (!command.forceRefresh) {
    const cached = await cacheManager.getDirectoryListing(cacheKey);
    if (cached && (Date.now() - cached.syncedAt < TTL)) {
      const albums = await decryptAlbumList(cached.entries);
      reply(port, { type: 'ALBUMS_LIST', albums, fromCache: true });
      return;
    }
  }

  // Need network
  if (!ensureOnline(port)) {
    // If offline, try returning stale cache
    const cached = await cacheManager.getDirectoryListing(cacheKey);
    if (cached) {
      const albums = await decryptAlbumList(cached.entries);
      reply(port, { type: 'ALBUMS_LIST', albums, fromCache: true });
      return;
    }
    reply(port, { type: 'ERROR', code: 'OFFLINE', message: 'Keine Verbindung und kein Cache vorhanden.' });
    return;
  }

  if (!ensureStorage(port)) return;

  // Fetch from network
  const rootPath = await directoryIdCrypto.encryptDirectoryId('');
  const entries = await storageAdapter!.listFiles(rootPath);

  // Update cache
  await cacheManager.putDirectoryListing({
    key: cacheKey,
    vaultId: currentVaultId!,
    directoryId: '_albums',
    entries,
    syncedAt: Date.now(),
  });

  // Also cache vault meta if available
  await cacheVaultMetaIfNeeded();

  const albums = await decryptAlbumList(entries);
  reply(port, { type: 'ALBUMS_LIST', albums, fromCache: false });
}

async function handleListPhotos(
  command: Extract<SwCommand, { type: 'LIST_PHOTOS' }>,
  port: MessagePort
): Promise<void> {
  if (!ensureKeys(port)) return;

  const TTL = 5 * 60 * 1000;
  const cacheKey = `${currentVaultId}:${command.directoryId}`;

  // Check cache first (Stale-While-Revalidate)
  const cached = await cacheManager.getDirectoryListing(cacheKey);

  if (cached && !command.forceRefresh) {
    const photos = await decryptPhotoList(cached.entries, command.directoryId);
    reply(port, { type: 'PHOTOS_LIST', directoryId: command.directoryId, photos, fromCache: true });

    // If stale, revalidate in background (don't await)
    if (Date.now() - cached.syncedAt > TTL) {
      revalidateDirectory(command.directoryId, cacheKey).catch(() => {});
    }
    return;
  }

  // No cache or forced refresh
  if (!ensureOnline(port)) {
    if (cached) {
      const photos = await decryptPhotoList(cached.entries, command.directoryId);
      reply(port, { type: 'PHOTOS_LIST', directoryId: command.directoryId, photos, fromCache: true });
      return;
    }
    reply(port, { type: 'ERROR', code: 'OFFLINE', message: 'Ordner nicht im Cache.' });
    return;
  }

  if (!ensureStorage(port)) return;

  const dirPath = await directoryIdCrypto.encryptDirectoryId(command.directoryId);
  const entries = await storageAdapter!.listFiles(dirPath);

  await cacheManager.putDirectoryListing({
    key: cacheKey,
    vaultId: currentVaultId!,
    directoryId: command.directoryId,
    entries,
    syncedAt: Date.now(),
  });

  const photos = await decryptPhotoList(entries, command.directoryId);
  reply(port, { type: 'PHOTOS_LIST', directoryId: command.directoryId, photos, fromCache: false });
}

async function handleGetThumbnail(
  command: Extract<SwCommand, { type: 'GET_THUMBNAIL' }>,
  port: MessagePort
): Promise<void> {
  const thumbCacheKey = `${command.size}:${command.encryptedName}`;

  // Check encrypted cache first
  const cached = await cacheManager.getThumbnail(thumbCacheKey, currentVaultId ?? '');
  if (cached) {
    reply(port, { type: 'FILE_DATA', data: cached, fromCache: true });
    return;
  }

  // Need to fetch from network
  if (!ensureOnline(port)) {
    reply(port, { type: 'ERROR', code: 'OFFLINE', message: 'Thumbnail nicht im Cache und offline.' });
    return;
  }

  if (!ensureStorage(port)) return;
  if (!ensureKeys(port)) return;

  // Build thumbnail path: _intimapic/thumbs/<directoryId>/<baseName>.<size>
  const thumbDirId = command.directoryId || '_root';
  const baseName = command.encryptedName.endsWith('.c9r')
    ? command.encryptedName.slice(0, -4)
    : command.encryptedName;
  const thumbPath = `_intimapic/thumbs/${thumbDirId}/${baseName}.${command.size}`;

  try {
    const encryptedData = await storageAdapter!.readFile(thumbPath);

    // Store in encrypted cache
    await cacheManager.putThumbnail(
      thumbCacheKey,
      currentVaultId ?? '',
      encryptedData,
      command.size
    );

    reply(port, { type: 'FILE_DATA', data: encryptedData, fromCache: false });
  } catch (err) {
    // Thumbnail might not exist – return error so the Page can fall back to original
    const msg = err instanceof Error ? err.message : 'Thumbnail fetch failed';
    reply(port, { type: 'ERROR', code: 'FILE_NOT_FOUND', message: msg });
  }
}

async function handleGetFile(
  command: Extract<SwCommand, { type: 'GET_FILE' }>,
  port: MessagePort
): Promise<void> {
  // For general file reads (originals, dir.c9r, etc.) – no caching for originals
  if (!ensureOnline(port)) {
    reply(port, { type: 'ERROR', code: 'OFFLINE', message: 'Nicht online und Datei nicht gecacht.' });
    return;
  }
  if (!ensureStorage(port)) return;

  try {
    const data = await storageAdapter!.readFile(command.path);
    reply(port, { type: 'FILE_DATA', data, fromCache: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'File read failed';
    reply(port, { type: 'ERROR', code: 'FILE_NOT_FOUND', message: msg });
  }
}

async function handleWriteFile(
  command: Extract<SwCommand, { type: 'WRITE_FILE' }>,
  port: MessagePort
): Promise<void> {
  if (!ensureOnline(port)) {
    reply(port, { type: 'ERROR', code: 'OFFLINE', message: 'Schreiben nicht möglich: offline.' });
    return;
  }
  if (!ensureStorage(port)) return;

  await storageAdapter!.writeFile(command.path, command.data);
  reply(port, { type: 'ACK' });
}

async function handleDeleteFile(
  command: Extract<SwCommand, { type: 'DELETE_FILE' }>,
  port: MessagePort
): Promise<void> {
  if (!ensureOnline(port)) {
    reply(port, { type: 'ERROR', code: 'OFFLINE', message: 'Löschen nicht möglich: offline.' });
    return;
  }
  if (!ensureStorage(port)) return;

  await storageAdapter!.deleteFile(command.path);
  reply(port, { type: 'ACK' });
}

async function handleFileExists(
  command: Extract<SwCommand, { type: 'FILE_EXISTS' }>,
  port: MessagePort
): Promise<void> {
  if (!ensureStorage(port)) return;

  const exists = await storageAdapter!.fileExists(command.path);
  reply(port, { type: 'FILE_EXISTS', exists });
}

async function handleCreateFolder(
  command: Extract<SwCommand, { type: 'CREATE_FOLDER' }>,
  port: MessagePort
): Promise<void> {
  if (!ensureOnline(port)) {
    reply(port, { type: 'ERROR', code: 'OFFLINE', message: 'Ordner erstellen nicht möglich: offline.' });
    return;
  }
  if (!ensureStorage(port)) return;

  await storageAdapter!.createFolder(command.path);
  reply(port, { type: 'ACK' });
}

async function handleDeleteFolder(
  command: Extract<SwCommand, { type: 'DELETE_FOLDER' }>,
  port: MessagePort
): Promise<void> {
  if (!ensureOnline(port)) {
    reply(port, { type: 'ERROR', code: 'OFFLINE', message: 'Ordner löschen nicht möglich: offline.' });
    return;
  }
  if (!ensureStorage(port)) return;

  await storageAdapter!.deleteFolder(command.path);
  reply(port, { type: 'ACK' });
}

async function handleInvalidateCache(
  command: Extract<SwCommand, { type: 'INVALIDATE_CACHE' }>,
  port: MessagePort
): Promise<void> {
  const vaultId = currentVaultId ?? '';

  switch (command.scope) {
    case 'all':
      await cacheManager.clearAllForVault(vaultId);
      break;
    case 'directory':
      if (command.directoryId) {
        await cacheManager.clearDirectoryListing(`${vaultId}:${command.directoryId}`);
      }
      break;
    case 'thumbnails':
      await cacheManager.clearThumbnailsForVault(vaultId);
      break;
  }

  reply(port, { type: 'ACK' });
}

async function handleGetCacheStats(port: MessagePort): Promise<void> {
  const stats = await cacheManager.getStats(currentVaultId ?? '');
  reply(port, {
    type: 'CACHE_STATS',
    totalEntries: stats.totalEntries,
    totalSizeBytes: stats.totalSizeBytes,
    quotaUsedPercent: stats.quotaUsedPercent,
    oldestEntry: stats.oldestEntry,
  });
}

async function handleGetQuota(port: MessagePort): Promise<void> {
  if (!ensureStorage(port)) return;

  const quota = await storageAdapter!.getQuota();
  reply(port, { type: 'QUOTA', used: quota.used, total: quota.total });
}

function handleCheckConnectivity(port: MessagePort): void {
  reply(port, { type: 'CONNECTIVITY', online: self.navigator?.onLine ?? true });
}

async function handleGetCachedVaultMeta(
  command: Extract<SwCommand, { type: 'GET_CACHED_VAULT_META' }>,
  port: MessagePort
): Promise<void> {
  const meta = await cacheManager.getVaultMeta(command.vaultId);
  if (!meta) {
    reply(port, { type: 'ERROR', code: 'NOT_CACHED', message: 'Vault-Metadaten nicht im Cache.' });
    return;
  }
  reply(port, { type: 'VAULT_META', masterkeyFile: meta.masterkeyFile, vaultConfig: meta.vaultConfig });
}

function handleICloudProxyResponse(
  command: Extract<SwCommand, { type: 'ICLOUD_PROXY_RESPONSE' }>
): void {
  // Resolve pending iCloud proxy requests (implementation in storage adapter)
  storageFactory.resolveICloudProxy(command.requestId, command.result, command.error);
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

function reply(port: MessagePort, response: SwResponse): void {
  port.postMessage(response);
}

function ensureKeys(port: MessagePort): boolean {
  if (!masterKeys) {
    reply(port, { type: 'NEED_KEYS' });
    return false;
  }
  return true;
}

function ensureOnline(port: MessagePort): boolean {
  if (!self.navigator?.onLine) {
    return false;
  }
  return true;
}

function ensureStorage(port: MessagePort): boolean {
  if (!storageAdapter) {
    reply(port, { type: 'ERROR', code: 'TOKEN_EXPIRED', message: 'Kein Storage-Adapter verbunden. Token benötigt.' });
    return false;
  }
  return true;
}

/**
 * Decrypt album entries: filters directories, reads dir.c9r, decrypts names.
 * Uses a persistent directory-ID cache to avoid redundant dir.c9r reads.
 * On first load: reads dir.c9r from network and caches the result.
 * On subsequent loads (including offline): reads from cache.
 */
async function decryptAlbumList(entries: Array<{ encryptedName: string; isDirectory: boolean; path: string; size: number; lastModified: string }>): Promise<import('./models/responses').CachedAlbum[]> {
  const albums: import('./models/responses').CachedAlbum[] = [];
  const vaultId = currentVaultId ?? '';

  // Pre-load all cached directory IDs for this vault (single IDB read)
  const cachedDirIds = await cacheManager.getAllDirectoryIds(vaultId);

  // Compute root path once (not per-iteration)
  const rootPath = await directoryIdCrypto.encryptDirectoryId('');

  for (const entry of entries) {
    if (!entry.isDirectory || !entry.encryptedName.endsWith('.c9r')) continue;

    try {
      let directoryId: string;

      // Check directory-ID cache first
      const cached = cachedDirIds.get(entry.encryptedName);
      if (cached) {
        directoryId = cached;
      } else {
        // Cache miss: read dir.c9r from storage
        const dirIdPath = `${rootPath}/${entry.encryptedName}/dir.c9r`;

        if (!storageAdapter) continue;
        const dirIdData = await storageAdapter.readFile(dirIdPath);
        directoryId = new TextDecoder().decode(dirIdData).trim();

        // Cache for future use (persistent, survives SW restarts)
        await cacheManager.putDirectoryId(vaultId, entry.encryptedName, directoryId);
      }

      const name = await filenameCrypto.decryptFilename(entry.encryptedName, '');
      const storagePath = await directoryIdCrypto.encryptDirectoryId(directoryId);

      albums.push({ name, directoryId, storagePath, encryptedName: entry.encryptedName });
    } catch {
      // Skip entries we can't decrypt
      continue;
    }
  }

  return albums;
}

/**
 * Decrypt photo entries: filters .c9r files, decrypts names, filters to images.
 */
async function decryptPhotoList(
  entries: Array<{ encryptedName: string; isDirectory: boolean; path: string; size: number; lastModified: string }>,
  directoryId: string
): Promise<import('./models/responses').CachedPhotoEntry[]> {
  const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif', '.bmp', '.tiff', '.avif'];
  const photos: import('./models/responses').CachedPhotoEntry[] = [];
  const dirPath = await directoryIdCrypto.encryptDirectoryId(directoryId);

  for (const entry of entries) {
    if (entry.isDirectory || !entry.encryptedName.endsWith('.c9r')) continue;

    try {
      const name = await filenameCrypto.decryptFilename(entry.encryptedName, directoryId);
      const ext = name.toLowerCase().slice(name.lastIndexOf('.'));

      if (IMAGE_EXTENSIONS.includes(ext)) {
        photos.push({
          encryptedName: entry.encryptedName,
          name,
          storagePath: `${dirPath}/${entry.encryptedName}`,
          size: entry.size,
          lastModified: entry.lastModified,
        });
      }
    } catch {
      continue;
    }
  }

  return photos;
}

/**
 * Background revalidation: fetch fresh directory listing and notify clients if changed.
 */
async function revalidateDirectory(directoryId: string, cacheKey: string): Promise<void> {
  if (!storageAdapter || !masterKeys) return;

  const dirPath = await directoryIdCrypto.encryptDirectoryId(directoryId);
  const entries = await storageAdapter.listFiles(dirPath);

  const existing = await cacheManager.getDirectoryListing(cacheKey);
  const existingNames = new Set(existing?.entries.map(e => e.encryptedName) ?? []);
  const newNames = new Set(entries.map(e => e.encryptedName));

  const added = entries.filter(e => !existingNames.has(e.encryptedName)).length;
  const removed = (existing?.entries ?? []).filter(e => !newNames.has(e.encryptedName)).length;

  await cacheManager.putDirectoryListing({
    key: cacheKey,
    vaultId: currentVaultId!,
    directoryId,
    entries,
    syncedAt: Date.now(),
  });

  if (added > 0 || removed > 0) {
    await broadcastToClients({
      type: 'DIRECTORY_UPDATED',
      directoryId,
      addedCount: added,
      removedCount: removed,
    });
  }
}

/**
 * Cache vault meta files (masterkey.cryptomator) for offline unlock.
 */
async function cacheVaultMetaIfNeeded(): Promise<void> {
  if (!storageAdapter || !currentVaultId) return;

  const existing = await cacheManager.getVaultMeta(currentVaultId);
  if (existing) return; // Already cached

  try {
    const masterkeyFile = await storageAdapter.readFile('masterkey.cryptomator');
    let vaultConfig: ArrayBuffer | undefined;
    try {
      vaultConfig = await storageAdapter.readFile('vault.cryptomator');
    } catch { /* optional */ }

    await cacheManager.putVaultMeta({
      vaultId: currentVaultId,
      masterkeyFile,
      vaultConfig,
      updatedAt: Date.now(),
    });
  } catch {
    // Non-critical: offline unlock just won't work until next successful cache
  }
}
