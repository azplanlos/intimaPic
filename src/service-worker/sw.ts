/**
 * IntimaPic Custom ServiceWorker – Entry Point
 *
 * This ServiceWorker replaces Angular's NGSW and acts as a central
 * data middleware between the Angular PWA and cloud storage providers.
 *
 * Responsibilities:
 * - App Shell caching (static assets)
 * - Encrypted data caching (thumbnails, directory listings)
 * - Storage provider network access (OneDrive, S3)
 * - Filename decryption for directory listings
 * - Key management (held in memory, never persisted)
 */

/// <reference lib="webworker" />

import { handleMessage } from './controller';
import { handleInstall, handleActivate, handleFetch } from './cache/app-shell-cache';
import type { SwCommand } from './models/commands';

declare const self: ServiceWorkerGlobalScope;

// ─── Lifecycle Events ──────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  // Skip waiting to activate immediately
  event.waitUntil(
    handleInstall(event).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    handleActivate(event).then(() => self.clients.claim())
  );
});

// ─── Fetch Event (App Shell Caching) ───────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  // Only handle navigation and static asset requests for app shell
  // Data requests go through the message channel, not fetch
  const response = handleFetch(event);
  if (response) {
    event.respondWith(response);
  }
});

// ─── Message Event (Main Thread Communication) ─────────────────────────────────

self.addEventListener('message', (event) => {
  const command = event.data as SwCommand;
  if (!command || !command.type) return;

  // The response port is the transferred MessagePort
  const replyPort = event.ports[0];
  if (!replyPort) {
    // No port = push-style message (e.g., iCloud proxy response)
    // Still route it through the controller
    const dummyPort = { postMessage: () => {} } as unknown as MessagePort;
    event.waitUntil(handleMessage(event, command, dummyPort));
    return;
  }

  event.waitUntil(handleMessage(event, command, replyPort));
});

// ─── Online/Offline Detection ──────────────────────────────────────────────────

self.addEventListener('online', async () => {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'CONNECTIVITY_CHANGED', online: true });
  }
});

self.addEventListener('offline', async () => {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'CONNECTIVITY_CHANGED', online: false });
  }
});
