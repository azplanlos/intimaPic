export type { StorageAdapter, StorageQuota } from './storage-adapter.interface';
export { StorageAdapterFactory } from './storage-adapter.factory';
export { ICloudDriveAdapter } from './icloud-drive-adapter.service';

// NOTE: OneDriveAdapter and S3Adapter are still exported for use by
// StorageAdapterFactory during vault creation/connection verification.
// For regular operations, all storage access goes through the ServiceWorker.
export { OneDriveAdapter } from './onedrive-adapter.service';
export { S3Adapter } from './s3-adapter.service';
