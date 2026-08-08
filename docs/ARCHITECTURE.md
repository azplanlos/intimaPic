# IntimaPic – Architecture & Design

## 1. System-Überblick

```
┌─────────────────────────────────────────────────────────┐
│                   Angular PWA (Client)                   │
│                                                         │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │  Gallery   │  │   Upload   │  │   Crypto Engine  │  │
│  │  Module    │  │   Module   │  │  (Cryptomator)   │  │
│  └─────┬──────┘  └─────┬──────┘  └────────┬─────────┘  │
│        │                │                  │            │
│  ┌─────┴────────────────┴──────────────────┴─────────┐  │
│  │            Storage Adapter Layer                   │  │
│  └───────┬──────────────┬──────────────┬─────────────┘  │
└──────────┼──────────────┼──────────────┼────────────────┘
           │              │              │
    ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼─────────┐
    │  OneDrive   │ │   AWS S3   │ │ iCloud Drive  │
    │ (Graph API) │ │ (Lambda)   │ │ (FS Access)   │
    └─────────────┘ └────────────┘ └───────────────┘
```

---

## 2. Verschlüsselungsformat: Cryptomator Vault Format 8

IntimaPic verwendet das **Cryptomator Vault Format 8** – ein offenes, dokumentiertes und weit verbreitetes Verschlüsselungsformat. Dies garantiert:

- **Zukunftssicherheit**: Falls IntimaPic eingestellt wird, können Nutzer ihre Fotos mit der offiziellen Cryptomator-App (Windows, Mac, Linux, iOS, Android) entschlüsseln.
- **Hohe Sicherheit**: scrypt KDF, AES-SIV für Dateinamen, AES-GCM für Dateiinhalte.
- **Deterministische Passwort-Prüfung**: AES Key Unwrap (RFC 3394) schlägt bei falschem Passwort garantiert fehl.

### 2.1 Schlüssel-Hierarchie

```
User-Passwort
     │
     ▼ scrypt (N=32768, r=8, p=1, salt=32 bytes)
     │
KEK (Key-Encryption Key, 256 bit)
     │
     ├──▶ AES Key Unwrap → Encryption Master Key (256 bit)
     └──▶ AES Key Unwrap → MAC Master Key (256 bit)
```

### 2.2 Vault-Dateien

```
vault-root/
├── masterkey.cryptomator      ← JSON: wrapped Keys + scrypt-Params
├── vault.cryptomator          ← JWT: Vault-Metadaten (Format, UUID, Cipher)
└── d/                         ← Verschlüsselte Verzeichnisstruktur
    ├── AB/
    │   └── CDEFGHIJKLMNOPQRSTUVWXYZ234567/
    │       ├── filename1.c9r  ← Verschlüsselte Datei
    │       └── filename2.c9r/
    │           └── dir.c9r    ← Directory ID (= Unterordner)
    └── ...
```

**masterkey.cryptomator:**
```json
{
  "version": 999,
  "scryptSalt": "<base64>",
  "scryptCostParam": 32768,
  "scryptBlockSize": 8,
  "primaryMasterKey": "<base64 AES-Key-Wrapped>",
  "hmacMasterKey": "<base64 AES-Key-Wrapped>",
  "versionMac": "<base64 HMAC-SHA256>"
}
```

### 2.3 Dateinamen-Verschlüsselung

- Algorithmus: **AES-SIV** (RFC 5297)
- Associated Data: Directory ID des Eltern-Ordners
- Encoding: Base64url + `.c9r` Extension
- Deterministic: Gleicher Name + gleicher Ordner = gleicher Ciphertext

```
ciphertextName = base64url(AES-SIV(filename, parentDirId, encKey, macKey)) + ".c9r"
```

### 2.4 Datei-Inhalts-Verschlüsselung

Jede Datei besteht aus:
1. **Header (68 Bytes)**: Nonce (12B) + AES-GCM(Payload, encMasterKey) + Tag (16B)
   - Payload: 8 Bytes 0xFF + 32 Bytes per-file Content Key
2. **Chunks (je max 32KiB + 28 Bytes)**:
   - Nonce (12B) + AES-GCM(Chunk, contentKey, AAD) + Tag (16B)
   - AAD = Chunk-Nummer (8B big-endian) + Header-Nonce (12B)

```
File = [Header 68B][Chunk₀][Chunk₁]...[Chunkₙ]
Chunk = [Nonce 12B][AES-GCM Ciphertext ≤32KiB][Tag 16B]
```

### 2.5 Verzeichnisstruktur

Cryptomator flattened alle Verzeichnisse:
1. Jedes Verzeichnis hat eine UUID als Directory ID
2. Die Directory ID wird AES-SIV verschlüsselt
3. SHA-1 Hash → Base32 → ergibt den Pfad unter `d/`

```
dirPath = "d/" + base32(sha1(aesSiv(dirId)))[0:2] + "/" + base32(sha1(aesSiv(dirId)))[2:]
```

---

## 3. Storage Adapter Layer

### 3.1 Interface

```typescript
interface StorageAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  listFiles(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  getQuota(): Promise<StorageQuota>;
}
```

### 3.2 Provider-Implementierungen

| Provider | Auth | Upload | Besonderheiten |
|----------|------|--------|----------------|
| OneDrive | OAuth 2.0 PKCE (MSAL.js) | Simple ≤4MB, Resumable >4MB | App-Folder `/Apps/IntimaPic` |
| AWS S3 | Lambda Pre-Signed URLs | Direkt zu S3 | Kein AWS SDK im Client |
| iCloud Drive | File System Access API | Lokal schreiben | Nur Apple-Geräte |

---

## 4. Multi-Device Key Transfer

```
Gerät A (hat Keys)                   Gerät B (neu)
      │                                    │
      ├── Generiert Pairing-Code ─────────►│
      │   (6-stellig + QR-Code)            │
      │                                    │
      │◄── ECDH Public Key ───────────────┤
      │                                    │
      ├── Encrypted Master Keys ──────────►│
      │   (ECDH + AES-GCM)                │
      │                                    │
      │   User gibt Passwort ein ─────────►│
      │   Unwrap + Verify → Ready          │
```

Transfer-Kanal: Lambda WebSocket Relay (Zero-Knowledge).

---

## 5. Upload-Pipeline

```
Foto auswählen (File Picker / Drag & Drop / Share Sheet)
  │
  ▼
Thumbnail generieren (OffscreenCanvas, max 300x300, JPEG 80%)
  │
  ├──▶ Thumbnail verschlüsseln (Cryptomator File Format)
  │    └── Upload nach d/<thumbs-dir-hash>/<encrypted-name>.c9r
  │
  ▼
Foto verschlüsseln (Header + 32KiB GCM Chunks)
  │
  ▼
Dateiname verschlüsseln (AES-SIV + Base64url + .c9r)
  │
  ▼
Upload zum Storage Provider
  │
  ▼
Lokalen Cache aktualisieren (IndexedDB)
```

---

## 6. Angular Module-Struktur

```
src/app/
├── core/
│   ├── crypto/           # CryptoService, AES-SIV, AES Key Wrap, VaultConfigService
│   ├── storage/          # StorageAdapter + Implementierungen + Factory
│   ├── vault/            # VaultService (State), Guard
│   └── upload/           # ThumbnailService, UploadService, UploadQueueService
│
├── features/
│   ├── gallery/          # Foto-Galerie (Browse, View)
│   ├── upload/           # Upload-Flow (Share Target, Manual)
│   ├── setup/            # Ersteinrichtung (Provider, Passwort, Config)
│   ├── pairing/          # Multi-Device Key Transfer
│   └── settings/         # Einstellungen
│
├── shared/               # Gemeinsame Komponenten
└── app.routes.ts
```

---

## 7. Technologie-Entscheidungen

| Bereich | Entscheidung | Begründung |
|---------|-------------|------------|
| Framework | Angular 18+ | Vorgabe, starke PWA-Unterstützung |
| UI | Angular Material | Konsistentes Design, Mobile-ready |
| State | Angular Signals | Leichtgewichtig |
| Crypto Format | **Cryptomator Vault Format 8** | Open Standard, zukunftssicher, hohe Sicherheit |
| Crypto API | Web Crypto + custom AES-SIV | Nativ performant, AES-SIV als Polyfill |
| Storage SDK | Graph Client / Lambda / FS Access | Offizielle APIs |
| Backend | AWS Lambda + Serverless | Nur bei Bedarf |
| Key Transfer | Lambda WebSocket | Zuverlässig cross-platform |

---

## 8. Sicherheitsüberlegungen

- **Kein Server kennt die Master Keys** – nur verschlüsselte Daten werden übertragen.
- **scrypt (N=32768)** verhindert Brute-Force auf das Passwort (>100ms pro Versuch).
- **AES Key Unwrap (RFC 3394)** bietet deterministische Passwort-Verifikation – kein "vielleicht korrekt".
- **Per-file Content Keys** – Jede Datei hat einen eigenen AES-GCM Key.
- **Chunk-Authentifizierung** – AAD verhindert Chunk-Reordering und Cross-File-Attacks.
- **AES-SIV für Dateinamen** – Deterministisch, aber sicher gegen Manipulation (authenticated).
- **CSP-Header** verhindern XSS/Injection.
- **OAuth PKCE** – Kein Client Secret nötig.

---

## 9. Kompatibilität mit Cryptomator

IntimaPic-Vaults sind **direkt mit Cryptomator** kompatibel:

- Die offizielle Cryptomator Desktop-App (Windows/Mac/Linux) kann den Vault öffnen.
- Die Cryptomator iOS/Android-Apps können den Vault öffnen.
- Cyberduck und Mountain Duck unterstützen das Format ebenfalls.
- Der Vault ist ein normaler Ordner in der Cloud – keine proprietäre Infrastruktur.

Falls IntimaPic eingestellt wird, haben Nutzer **mehrere Wege**, auf ihre Fotos zuzugreifen.
