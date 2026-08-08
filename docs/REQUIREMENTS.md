# IntimaPic – Requirements

## 1. Übersicht

IntimaPic ist eine Progressive Web App (PWA), mit der Nutzer ihre Fotos Ende-zu-Ende verschlüsselt in der Cloud speichern und als Fotogalerie mit Ordnern durchsuchen können. Der Verschlüsselungsschlüssel verlässt niemals das Gerät des Nutzers.

---

## 2. Funktionale Anforderungen

### F1 – Ende-zu-Ende-Verschlüsselung

- Alle Fotos werden **client-seitig** verschlüsselt, bevor sie hochgeladen werden.
- Die Master Keys werden lokal generiert und verlassen das Gerät nie unverschlüsselt.
- Verschlüsselungsformat: **Cryptomator Vault Format 8** (offener Standard).
- Dateinamen: AES-SIV (RFC 5297) → Base64url + `.c9r`.
- Dateiinhalte: AES-GCM in 32KiB Chunks mit per-file Content Key.

### F2 – Passwortschutz

- Die Master Keys werden mit einem vom Nutzer gewählten Passwort geschützt.
- Key-Derivation: **scrypt** (N=32768, r=8, p=1).
- Key-Wrapping: **AES Key Wrap** (RFC 3394) – deterministische Passwort-Verifikation.
- Konfiguration gespeichert in `masterkey.cryptomator` (JSON).

### F3 – Cryptomator-Kompatibilität

- Der verschlüsselte Vault ist vollständig kompatibel mit Cryptomator Desktop/Mobile Apps.
- Falls IntimaPic eingestellt wird, können Nutzer ihre Fotos mit Cryptomator, Cyberduck oder Mountain Duck entschlüsseln.
- Vault-Struktur: `masterkey.cryptomator`, `vault.cryptomator`, `d/`-Verzeichnisbaum.

### F4 – Fotogalerie

- Ordner-/Album-basierte Navigation.
- Thumbnail-Übersicht mit Lazy Loading.
- Vollbild-Viewer mit Swipe-Gesten.
- Offline-Cache für bereits entschlüsselte Thumbnails.

### F5 – Import via iOS Share Sheet (Shortcuts + Cryptomator)

- Fotos werden über das iOS Share Sheet via **Shortcuts** und der **Cryptomator App** direkt in den Vault importiert.
- Die Cryptomator App legt die Fotos ohne Thumbnails im **Root-Ordner** des Vaults ab.
- Beim nächsten Öffnen des Tresors erkennt IntimaPic die unsortierten Fotos und startet einen **Einsortieren-Wizard**.
- Der Wizard zeigt jedes unsortierte Foto mit Vorschau und fragt nach der Album-Zuweisung.
- Alternativ können Fotos auch direkt in der PWA via Web Share Target empfangen werden (Fallback).
- Unterstützte Typen: `image/jpeg`, `image/png`, `image/heic`, `image/webp`.

### F6 – Upload via manuelle Auswahl

- File Input mit `accept="image/*"` und `multiple`.
- Drag & Drop auf Desktop-Browsern.

### F7 – iOS Kurzbefehl-Integration

- Ein iOS Shortcut öffnet die Cryptomator App und legt ausgewählte Fotos im Vault-Root ab.
- IntimaPic erkennt diese Fotos beim nächsten Tresor-Öffnen automatisch als unsortiert.
- Ablauf:
  1. Nutzer teilt Fotos via Share Sheet → iOS Shortcut.
  2. Shortcut ruft Cryptomator auf und speichert die Dateien im Vault-Root.
  3. Beim nächsten Öffnen von IntimaPic startet der Einsortieren-Wizard.
- Anleitung/Template für den Kurzbefehl wird in der App bereitgestellt.

### F7a – Thumbnail-Synchronisation

- Beim Öffnen des Tresors werden alle Album-Ordner gescannt.
- Für Fotos ohne vorhandene Thumbnails in `_intimapic/thumbs/` werden Thumbnails nachgeneriert.
- Dies betrifft extern importierte Fotos (via Cryptomator/Shortcuts) sowie veränderte Dateien.
- Die Sync läuft im Hintergrund und blockiert nicht die Nutzung der App.

### F8 – Multi-Device Key-Transfer

- Weitere Geräte können per **QR-Code** oder **manueller 6-stelliger Code-Eingabe** aktiviert werden.
- Ablauf:
  1. Gerät A generiert temporären Pairing-Code und zeigt QR-Code an.
  2. Gerät B scannt/tippt den Code ein.
  3. Verschlüsselte Master Keys werden über einen temporären Kanal übertragen (ECDH).
  4. Gerät B fragt das Passwort ab und verifiziert die Keys (AES Key Unwrap).
- Der Transfer-Kanal ist end-to-end verschlüsselt (ECDH Key Agreement).

### F9 – Cloud-Speicher-Provider

| Provider     | Zugriff                        | Auth           |
|-------------|-------------------------------|----------------|
| OneDrive    | Microsoft Graph API           | OAuth 2.0 PKCE |
| AWS S3      | Lambda Pre-Signed URLs        | Cognito / JWT  |
| iCloud Drive| File System Access API (Apple) | Nativ          |

---

## 3. Nicht-funktionale Anforderungen

### NFR1 – Progressive Web App

- Vollständig offline-fähig (nach initialem Load).
- Installierbar auf iOS, Android und Desktop.
- Service Worker für Caching und Background Sync.

### NFR2 – Performance

- Thumbnails: max. 200KB, lazy-loaded.
- Progressive Entschlüsselung: Thumbnails zuerst, Full-Res on demand.
- Ziel: Gallery-View < 2s Time-to-Interactive.

### NFR3 – Sicherheit

- Keine Klartextdaten verlassen das Gerät.
- Kein persistentes Backend speichert Schlüssel.
- HTTPS everywhere.
- CSP-Header konfiguriert.
- AES Key Unwrap garantiert: falsches Passwort = sofortige Fehlermeldung (kein Raten möglich).

### NFR4 – Plattform-Support

- iOS Safari 16+
- Android Chrome 100+
- Desktop: Chrome, Firefox, Edge (aktuelle Versionen)

### NFR5 – Serverless Architecture

- Kein persistenter Server.
- Bei Bedarf: AWS Lambda + API Gateway (Serverless Framework).
- Use Cases: S3 Pre-Signed URLs, Key-Transfer-Relay.

---

## 4. Einschränkungen & Annahmen

- iCloud Drive ist nur auf Apple-Geräten verfügbar (kein Web-Zugang).
- AES-SIV ist nicht nativ in Web Crypto → Custom-Implementierung nötig.
- scrypt ist nicht nativ in Web Crypto → JS-Implementierung (CPU-intensiv, ~100-500ms).
- Maximale Dateigröße: 100MB pro Foto (für HEIC/RAW).

---

## 5. Offene Punkte

| #  | Frage | Status |
|----|-------|--------|
| 1  | Thumbnail-Strategie: Eigener Cryptomator-Ordner oder separates System? | Empfehlung: Eigener Ordner im Vault |
| 2  | Key-Transfer: WebRTC DataChannel vs. Lambda WebSocket? | Empfehlung: Lambda WebSocket |
| 3  | iCloud Drive: Funktioniert File System Access API in iOS Safari PWA? | Zu prüfen |
| 4  | scrypt Performance im Browser: Akzeptabel auf älteren Geräten? | Zu testen |
| 5  | Name Shortening (>220 chars): Für Fotonamen normalerweise kein Problem | Monitor |
