import Dexie, { type Table } from 'dexie';
import { Injectable } from '@angular/core';
import { MetadataRecord } from './metadata.models';

export class MetadataDatabase extends Dexie {
  photos!: Table<MetadataRecord, string>;

  constructor() {
    super('intimapic_metadata');
    this.version(1).stores({
      photos: 'photoId, captureDate, rating, isFavorite, updatedAt'
    });
  }
}

@Injectable({ providedIn: 'root' })
export class MetadataStore {
  private db = new MetadataDatabase();
  private inMemoryFallback: Map<string, MetadataRecord> | null = null;

  /** Open the database (Dexie opens lazily; this verifies availability). */
  async open(): Promise<void> {
    try {
      await this.db.open();
    } catch {
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
