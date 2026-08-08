/**
 * Cryptomator-compatible masterkey.cryptomator file format.
 * Stores wrapped master keys and scrypt KDF parameters.
 */
export interface MasterkeyFile {
  version: number;
  scryptSalt: string;       // Base64-encoded scrypt salt
  scryptCostParam: number;  // scrypt N (cost parameter), typically 32768
  scryptBlockSize: number;  // scrypt r (block size), typically 8
  primaryMasterKey: string; // Base64-encoded AES Key Wrap of encryption master key
  hmacMasterKey: string;    // Base64-encoded AES Key Wrap of MAC master key
  versionMac: string;       // Base64-encoded HMAC-SHA256 of version (as 4-byte big-endian)
}

/**
 * Cryptomator vault.cryptomator JWT payload.
 */
export interface VaultConfig {
  format: number;           // Vault format version (8)
  shorteningThreshold: number; // Max ciphertext name length before shortening (220)
  jti: string;              // Unique vault identifier (UUID)
  cipherCombo: 'SIV_GCM';  // Cipher mode: AES-SIV for names, AES-GCM for content
}

/**
 * Decrypted master keys held in memory.
 */
export interface MasterKeys {
  encryptionKey: ArrayBuffer; // 256-bit encryption master key
  macKey: ArrayBuffer;        // 256-bit MAC master key
}

/**
 * Encrypted file header (68 bytes).
 */
export interface FileHeader {
  nonce: Uint8Array;       // 12 bytes
  contentKey: Uint8Array;  // 32 bytes (decrypted from header payload)
}

/**
 * Result of encrypting a file.
 */
export interface EncryptedFile {
  /** The encrypted filename (Base64url-encoded) with .c9r suffix */
  encryptedName: string;
  /** The encrypted file data: [68-byte header][32KiB+ chunks] */
  data: ArrayBuffer;
}

/**
 * A file/folder entry as stored in cloud storage.
 */
export interface FileEntry {
  /** Encrypted name (as stored, e.g. "xyz.c9r") */
  encryptedName: string;
  /** Decrypted original name (populated after decryption) */
  decryptedName?: string;
  /** Full path in storage */
  path: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  lastModified: Date;
  /** Whether this entry is a directory */
  isDirectory: boolean;
}

/**
 * Represents a folder with its children.
 */
export interface FolderStructure {
  /** Full encrypted path */
  path: string;
  /** Decrypted folder name */
  decryptedName: string;
  /** Directory ID (UUID for non-root, empty string for root) */
  directoryId: string;
  /** Child entries (files and subfolders) */
  children: FileEntry[];
  /** When this structure was last synced from storage */
  lastSynced: Date;
}

/**
 * Cloud storage provider types.
 */
export type StorageProviderType = 'onedrive' | 's3' | 'icloud';

/**
 * User's storage configuration.
 */
export interface StorageSettings {
  provider: StorageProviderType;
  /** Provider-specific configuration */
  config: OneDriveConfig | S3Config | ICloudConfig;
  /** Root path within the provider where the vault is stored */
  rootPath: string;
}

export interface OneDriveConfig {
  clientId: string;
  tenantId?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface S3Config {
  bucketName: string;
  region: string;
  apiEndpoint: string;
  identityPoolId?: string;
}

export interface ICloudConfig {
  directoryHandleId?: string;
}

/**
 * Pending upload entry stored in IndexedDB.
 */
export interface PendingUpload {
  id: string;
  file: Blob;
  originalName: string;
  targetPath: string;
  status: 'pending' | 'encrypting' | 'uploading' | 'done' | 'error';
  errorMessage?: string;
  createdAt: Date;
}
