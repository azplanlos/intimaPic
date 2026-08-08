import { Injectable, signal, computed } from '@angular/core';
import type { PendingUpload } from '../crypto/crypto.models';

const DB_NAME = 'intimapic_uploads';
const STORE_NAME = 'pending';
const DB_VERSION = 1;

/**
 * Manages a persistent upload queue backed by IndexedDB.
 * Tracks pending uploads and their status across page reloads.
 */
@Injectable({ providedIn: 'root' })
export class UploadQueueService {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private readonly _queue = signal<PendingUpload[]>([]);
  readonly queue = this._queue.asReadonly();
  readonly pendingCount = computed(() =>
    this._queue().filter(u => u.status !== 'done').length
  );
  readonly hasErrors = computed(() =>
    this._queue().some(u => u.status === 'error')
  );

  /**
   * Get or open the IndexedDB database (lazy init).
   */
  private async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (!this.dbPromise) {
      this.dbPromise = this.openDB().then(db => {
        this.db = db;
        return db;
      });
    }
    return this.dbPromise;
  }

  /**
   * Initialize the IndexedDB database and load existing entries.
   */
  async initialize(): Promise<void> {
    await this.getDB();
    await this.loadAll();
  }

  /**
   * Add a file to the upload queue.
   */
  async enqueue(file: File, targetPath: string): Promise<PendingUpload> {
    const entry: PendingUpload = {
      id: crypto.randomUUID(),
      file,
      originalName: file.name,
      targetPath,
      status: 'pending',
      createdAt: new Date(),
    };

    await this.put(entry);
    this._queue.update(q => [...q, entry]);
    return entry;
  }

  /**
   * Update the status of a queued upload.
   */
  async updateStatus(
    id: string,
    status: PendingUpload['status'],
    errorMessage?: string
  ): Promise<void> {
    const queue = this._queue();
    const index = queue.findIndex(u => u.id === id);
    if (index === -1) return;

    const updated: PendingUpload = {
      ...queue[index],
      status,
      errorMessage,
    };

    await this.put(updated);
    this._queue.update(q => {
      const copy = [...q];
      copy[index] = updated;
      return copy;
    });
  }

  /**
   * Remove a completed or failed upload from the queue.
   */
  async remove(id: string): Promise<void> {
    await this.delete(id);
    this._queue.update(q => q.filter(u => u.id !== id));
  }

  /**
   * Clear all completed uploads.
   */
  async clearCompleted(): Promise<void> {
    const completed = this._queue().filter(u => u.status === 'done');
    for (const entry of completed) {
      await this.delete(entry.id);
    }
    this._queue.update(q => q.filter(u => u.status !== 'done'));
  }

  /**
   * Get all pending (not done/error) items for retry/processing.
   */
  getPending(): PendingUpload[] {
    return this._queue().filter(
      u => u.status === 'pending' || u.status === 'error'
    );
  }

  // ─── IndexedDB Operations ─────────────────────────────────────────

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async loadAll(): Promise<void> {
    const db = await this.getDB();

    const entries = await new Promise<PendingUpload[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    this._queue.set(entries);
  }

  private async put(entry: PendingUpload): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async delete(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}
