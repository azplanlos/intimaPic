# IntimaPic – Implementation Tasks

## Phase 1: Foundation (2-3 Wochen)

### 1.1 Projekt-Setup
- [ ] Angular 18 Projekt mit `ng new intimapic --style=scss --routing`
- [ ] PWA hinzufügen: `ng add @angular/pwa`
- [ ] Angular Material hinzufügen: `ng add @angular/material`
- [ ] Ordnerstruktur gemäß Architektur anlegen
- [ ] ESLint + Prettier konfigurieren
- [ ] Environment-Konfiguration (dev/prod)

### 1.2 Crypto Engine
- [ ] `CryptoService` erstellen mit Web Crypto API
- [ ] Master Key Generierung (256-bit random)
- [ ] PBKDF2 Key-Derivation (SHA-256, 100k Iterationen)
- [ ] AES-256-CBC Encrypt/Decrypt für Dateien
- [ ] AES-256-CBC Encrypt/Decrypt für Dateinamen
- [ ] IV-Generierung (16 Byte random pro Datei)
- [ ] `.gsc` Metadatei lesen/schreiben
- [ ] GoodSync-Kompatibilitäts-Tests (mit echten GoodSync-Dateien)

### 1.3 Grundlegende Datenmodelle
- [ ] `FileEntry` Interface
- [ ] `FolderStructure` Interface
- [ ] `EncryptedFile` Model (IV + Ciphertext)
- [ ] `StorageSettings` Model

---

## Phase 2: Storage & Upload (2-3 Wochen)

### 2.1 Storage Adapter Interface
- [ ] `StorageAdapter` Interface definieren
- [ ] `StorageAdapterFactory` Service (Provider-Auswahl)
- [ ] Error-Handling & Retry-Logik

### 2.2 OneDrive Adapter
- [ ] MSAL.js Integration (OAuth 2.0 PKCE)
- [ ] Microsoft Graph Client Setup
- [ ] `listFiles()` Implementation
- [ ] `readFile()` Implementation
- [ ] `writeFile()` Implementation
- [ ] `deleteFile()` / `createFolder()` / `deleteFolder()`
- [ ] Quota-Abfrage
- [ ] App-Registration in Azure Portal dokumentieren

### 2.3 S3 Adapter
- [ ] AWS Lambda für Pre-Signed URL Generierung
- [ ] Serverless Framework Config (`serverless.yml`)
- [ ] Cognito Identity Pool Setup (oder API Key)
- [ ] S3 Adapter Implementation
- [ ] CORS-Konfiguration für S3 Bucket

### 2.4 Upload Pipeline
- [ ] File Input Komponente (multiple, accept image/*)
- [ ] Drag & Drop Zone
- [ ] Thumbnail-Generierung (Canvas API, max 300x300)
- [ ] Verschlüsselungs-Pipeline (Name → Thumbnail → Datei)
- [ ] Upload-Progress Anzeige
- [ ] Pending Uploads Queue (IndexedDB)
- [ ] Background Upload mit Service Worker

---

## Phase 3: Gallery UI (2 Wochen)

### 3.1 Ordner-Navigation
- [ ] Folder-List Komponente
- [ ] Breadcrumb-Navigation
- [ ] Ordner erstellen / umbenennen / löschen
- [ ] Verschlüsselte Ordnernamen entschlüsseln & cachen

### 3.2 Foto-Grid
- [ ] Thumbnail-Grid Komponente (responsive, CSS Grid)
- [ ] Virtual Scrolling für große Ordner
- [ ] Lazy Loading der Thumbnails (Intersection Observer)
- [ ] Thumbnail-Entschlüsselung & Caching (IndexedDB)
- [ ] Placeholder/Skeleton während Laden

### 3.3 Vollbild-Viewer
- [ ] Full-Res Entschlüsselung on demand
- [ ] Swipe-Gesten (Hammer.js oder CDK Drag)
- [ ] Zoom & Pan
- [ ] Download-Button (entschlüsselte Datei)
- [ ] Lösch-Button mit Bestätigung

### 3.4 Offline-Funktionalität
- [ ] Service Worker Caching-Strategien konfigurieren
- [ ] IndexedDB Thumbnail-Cache mit LRU-Eviction
- [ ] Offline-Indikator in UI
- [ ] Pending-Uploads Anzeige

---

## Phase 4: Share & Multi-Device (2 Wochen)

### 4.1 Web Share Target
- [ ] `manifest.json` um `share_target` erweitern
- [ ] `/share` Route für eingehende Shares
- [ ] Service Worker: Share-Daten aus POST extrahieren
- [ ] Dateien in Upload-Queue einreihen

### 4.2 iOS Kurzbefehl
- [ ] Custom URL-Schema definieren (`intimapic://share`)
- [ ] URL-Handler in Angular Router
- [ ] Kurzbefehl-Template erstellen (als .shortcut oder Anleitung)
- [ ] Dokumentation für Nutzer

### 4.3 Multi-Device Pairing
- [ ] Lambda WebSocket Relay (Serverless)
- [ ] Pairing-Initiation: Code + QR generieren
- [ ] QR-Code Anzeige (angularx-qrcode)
- [ ] QR-Code Scanner (html5-qrcode)
- [ ] Manueller 6-stelliger Code Input
- [ ] ECDH Key Agreement (Web Crypto)
- [ ] Verschlüsselten Master Key übertragen
- [ ] Passwort-Abfrage auf Gerät B
- [ ] Session-TTL (5 Min) & Cleanup

---

## Phase 5: Polish & iCloud (1-2 Wochen)

### 5.1 iCloud Drive Adapter
- [ ] File System Access API Integration prüfen
- [ ] Fallback: Manueller Upload/Download
- [ ] Ordner-Auswahl für iCloud Drive Sync-Ordner

### 5.2 Settings & UX
- [ ] Provider-Wechsel UI
- [ ] Passwort ändern (Re-Wrap Master Key)
- [ ] Storage-Quota Anzeige
- [ ] Über/Impressum Seite
- [ ] Onboarding-Flow (Ersteinrichtung)

### 5.3 Error Handling & Edge Cases
- [ ] Globaler Error Handler
- [ ] Retry-Logik für fehlgeschlagene Uploads
- [ ] Konflikt-Erkennung (gleiche Datei von 2 Geräten)
- [ ] Session-Timeout Handling
- [ ] Graceful Degradation bei fehlender API-Unterstützung

### 5.4 Performance
- [ ] Bundle-Size Optimierung (Tree Shaking, Lazy Loading)
- [ ] Web Worker für Crypto-Operationen
- [ ] Lighthouse Audit (PWA, Performance, A11y)
- [ ] Preload kritischer Ressourcen

---

## Phase 6: Deployment & Testing (1 Woche)

### 6.1 Deployment
- [ ] S3 Bucket + CloudFront Distribution (Terraform/CDK)
- [ ] Custom Domain + SSL
- [ ] CI/CD Pipeline (GitHub Actions)
- [ ] Environment-basierte Konfiguration

### 6.2 Testing
- [ ] Unit Tests: CryptoService (GoodSync-Kompatibilität!)
- [ ] Unit Tests: Storage Adapters (Mock)
- [ ] Integration Tests: Upload Pipeline
- [ ] E2E Tests: Cypress/Playwright
- [ ] Cross-Browser Testing (iOS Safari, Android Chrome)
- [ ] Security Audit: Keine Klartextdaten in Netzwerk-Requests

---

## Abhängigkeiten & Risiken

| Risiko | Auswirkung | Mitigation |
|--------|-----------|------------|
| GoodSync-Format undokumentiert | Inkompatibilität | Frühzeitig Testdateien erzeugen und validieren |
| iOS Safari PWA-Limitierungen | Share Target funktioniert nicht | Kurzbefehl als Fallback |
| Web Crypto API Performance | Langsam bei großen Dateien | Web Worker nutzen |
| iCloud Drive kein Web-Zugang | Feature nur auf Apple-Geräten | Klar kommunizieren, Alternative anbieten |
| Lambda Cold Starts | Langsames Pairing | Provisioned Concurrency oder Keep-Warm |
