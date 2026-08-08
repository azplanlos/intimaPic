# IntimaPic

Ende-zu-Ende verschlüsselte Foto-Cloud-Speicher App als Progressive Web App (PWA).

## Überblick

IntimaPic ermöglicht es, Fotos sicher und verschlüsselt in der Cloud zu speichern und als Fotogalerie zu durchsuchen. Der Verschlüsselungsschlüssel verlässt niemals das Gerät.

## Features

- **E2E-Verschlüsselung** – Cryptomator Vault Format 8 (offener Standard)
- **Fotogalerie** – Ordnerbasierte Navigation mit Thumbnails und Vollbild-Viewer
- **Upload via Share Sheet** – iOS Shortcuts + Cryptomator App für nahtlosen Import
- **iOS Kurzbefehl** – Fotos via Share Sheet direkt in den Vault importieren
- **Einsortieren-Wizard** – Unsortierte Fotos beim Öffnen automatisch Album zuweisen
- **Thumbnail-Sync** – Fehlende Thumbnails werden beim Tresor-Öffnen nachgeneriert
- **Multi-Device** – Weitere Geräte per QR-Code oder Code aktivieren
- **Passwortschutz** – scrypt + AES Key Wrap (deterministische Verifikation)
- **Cloud Storage** – OneDrive, AWS S3, iCloud Drive
- **Zukunftssicher** – Vault jederzeit mit Cryptomator, Cyberduck oder Mountain Duck öffenbar

## Verschlüsselung

- **Key-Derivation**: scrypt (N=32768, r=8, p=1)
- **Key-Wrapping**: AES Key Wrap (RFC 3394)
- **Dateinamen**: AES-SIV (RFC 5297) + Base64url + `.c9r`
- **Dateiinhalte**: AES-256-GCM in 32KiB Chunks
- **Per-File Keys**: Jede Datei hat einen eigenen Content Key

## Tech Stack

- Angular 18+ (PWA)
- Web Crypto API + custom AES-SIV
- Angular Material
- AWS Lambda + Serverless (optional Backend)

## Dokumentation

- [Requirements](docs/REQUIREMENTS.md)
- [Architektur](docs/ARCHITECTURE.md)
- [Implementierungs-Tasks](docs/TASKS.md)

## Entwicklung

```bash
ng serve
```

## Build

```bash
ng build --configuration production
```
