/**
 * App Shell caching for the Custom ServiceWorker.
 * Replaces Angular's NGSW for static asset caching.
 *
 * Strategy:
 * - Navigation requests → Network-first, fallback to cached index.html
 * - Hashed assets (JS/CSS with content hash) → Cache-first (immutable)
 * - Other static assets (images, fonts) → Stale-while-revalidate
 * - API/data requests → Passthrough (handled by message channel, not fetch)
 */

const APP_SHELL_CACHE = 'intimapic-app-shell-v1';
const STATIC_ASSETS_CACHE = 'intimapic-static-assets-v1';

/** Files to precache on install (app shell essentials) */
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
];

/**
 * Patterns for hashed assets (immutable, cache forever).
 * Angular CLI output uses content hashes in filenames.
 */
function isHashedAsset(url: URL): boolean {
  const path = url.pathname;
  // Angular CLI produces files like main-XXXXXXXX.js, styles-XXXXXXXX.css
  return /\.[a-f0-9]{8,}\.(js|css)$/.test(path);
}

/**
 * Patterns for static assets (images, fonts, icons).
 */
function isStaticAsset(url: URL): boolean {
  const path = url.pathname;
  return /\.(png|jpg|jpeg|gif|svg|webp|avif|ico|woff|woff2|ttf|otf)$/i.test(path);
}

/**
 * Whether a request is a navigation (page load).
 */
function isNavigation(request: Request): boolean {
  return request.mode === 'navigate';
}

/**
 * Whether this request should be handled by the app shell cache.
 * Data requests (Graph API, S3, Lambda) go through the message channel instead.
 */
function shouldHandleFetch(event: FetchEvent): boolean {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return false;

  // Skip API-like paths (shouldn't exist for a static PWA, but just in case)
  if (url.pathname.startsWith('/api/')) return false;

  return true;
}

// ─── Lifecycle Handlers ────────────────────────────────────────────────────────

export async function handleInstall(_event: ExtendableEvent): Promise<void> {
  const cache = await caches.open(APP_SHELL_CACHE);

  // Precache essential app shell files
  for (const url of PRECACHE_URLS) {
    try {
      await cache.add(url);
    } catch {
      // Non-critical: if precache fails, we'll fetch on demand
      console.warn(`[SW] Failed to precache: ${url}`);
    }
  }
}

export async function handleActivate(_event: ExtendableEvent): Promise<void> {
  // Delete old cache versions
  const cacheNames = await caches.keys();
  const validCaches = [APP_SHELL_CACHE, STATIC_ASSETS_CACHE];

  await Promise.all(
    cacheNames
      .filter(name => name.startsWith('intimapic-') && !validCaches.includes(name))
      .map(name => caches.delete(name))
  );
}

/**
 * Handle fetch events for app shell / static assets.
 * Returns null if the request should not be handled (passthrough).
 */
export function handleFetch(event: FetchEvent): Promise<Response> | null {
  if (!shouldHandleFetch(event)) return null;

  const url = new URL(event.request.url);

  // Navigation requests: Network-first with index.html fallback
  if (isNavigation(event.request)) {
    return handleNavigation(event.request);
  }

  // Hashed assets: Cache-first (immutable)
  if (isHashedAsset(url)) {
    return handleHashedAsset(event.request);
  }

  // Static assets: Stale-while-revalidate
  if (isStaticAsset(url)) {
    return handleStaticAsset(event.request);
  }

  // Other same-origin requests (e.g., unhashed JS): Network-first
  return handleNetworkFirst(event.request);
}

// ─── Fetch Strategies ──────────────────────────────────────────────────────────

async function handleNavigation(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_SHELL_CACHE);
      cache.put('/index.html', response.clone());
      return response;
    }
  } catch {
    // Network failed – try cache
  }

  const cached = await caches.match('/index.html');
  if (cached) return cached;

  return new Response('Offline – App nicht gecacht.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

async function handleHashedAsset(request: Request): Promise<Response> {
  // Cache-first: hashed assets are immutable
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(APP_SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function handleStaticAsset(request: Request): Promise<Response> {
  // Stale-while-revalidate
  const cached = await caches.match(request);

  const fetchPromise = fetch(request).then(async response => {
    if (response.ok) {
      const cache = await caches.open(STATIC_ASSETS_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  if (cached) {
    // Return stale, update in background
    fetchPromise; // fire and forget
    return cached;
  }

  // No cache: must wait for network
  const response = await fetchPromise;
  if (response) return response;

  return new Response('', { status: 504 });
}

async function handleNetworkFirst(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 504 });
  }
}
