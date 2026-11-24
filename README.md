# Straub hört zu

Private Web-App (PWA) für das iPhone: Gespräche aufnehmen, mit Sprechererkennung transkribieren,
Titel und Zusammenfassung erstellen lassen und als Markdown-Datei teilen.

Reines HTML, CSS und JavaScript – kein Backend, kein Build-Schritt. Läuft auf GitHub Pages.

## Sicherheit

- Der OpenAI-API-Schlüssel steht **nirgends im Code**. Er wird beim ersten Start in der App eingegeben
  und nur im Speicher des Geräts (localStorage) abgelegt. Ändern oder löschen unter „Einstellungen“.
- Aufnahmen, Transkripte und Zusammenfassungen liegen nur in IndexedDB auf dem Gerät.
- Audio und Text gehen ausschließlich an `api.openai.com` (per Content-Security-Policy erzwungen).
- `tools/check_secrets.sh` prüft vor jedem Commit und Push, dass keine Schlüssel im Repo landen.

## Ablauf

1. **Aufnahme** mit `MediaRecorder` (iOS: `audio/mp4`, automatisch erkannt). Alle 4 Sekunden wird
   ein Audiostück in IndexedDB gesichert. Alle 10 Minuten beginnt ein neuer, eigenständiger Teil
   (max. 20 MB, OpenAI-Limit 25 MB). Bildschirm bleibt per Wake Lock an. Wechselt die App in den
   Hintergrund, wird pausiert; nach einem Absturz lässt sich die Aufnahme fortsetzen oder transkribieren.
2. **Transkription** je Teil mit `gpt-4o-transcribe-diarize` (`diarized_json`, Deutsch).
   Ab Teil 2 werden kurze Stimmproben der bisherigen Sprecher mitgeschickt
   (`known_speaker_references[]`), damit „Sprecher A/B/…“ über alle Teile gleich bleiben.
   Ersatz ohne Sprecher: `gpt-transcribe`, dann `whisper-1`. Fehlgeschlagene Teile werden
   automatisch wiederholt; fertige Teile werden nie doppelt übertragen.
3. **Titel und Zusammenfassung** mit `gpt-6-luna` (Structured Outputs), Ersatzmodelle automatisch.
4. **Export**: `JJJJ-MM-TT_Titel.md` über das iPhone-Teilen-Menü (Web Share API).

Hinweis: OpenAI stellt `gpt-4o-transcribe-diarize` laut Doku am 26.02.2027 ein. Danach
transkribiert die App automatisch ohne Sprecher, bis in den Einstellungen („Modelle“) ein
Nachfolgemodell eingetragen ist.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `manifest.json`, `sw.js` | App-Gerüst, PWA-Manifest, Offline-Cache |
| `css/app.css` | Gestaltung (Dark Mode, Rot nur für Aufnahme) |
| `js/app.js` | Oberfläche und Navigation |
| `js/recorder.js` | Aufnahme, Teile, Sicherung, Pegel, Wake Lock |
| `js/pipeline.js` | Transkription, Sprecherabgleich, Zusammenfassung |
| `js/openai.js` | OpenAI-Aufrufe, Wiederholungen, Einstellungen |
| `js/audio.js` | Stimmproben als WAV für den Sprecherabgleich |
| `js/export.js` | Markdown-Export, Teilen, Kopieren |
| `js/db.js` | IndexedDB |
| `icons/` | Logo (SVG), App-Icons, iOS-Startbildschirme |
| `tools/` | Icon-Erzeugung, lokaler Testserver, Geheimnis-Prüfung |

## Aktualisieren

Nach Änderungen die Versionsnummer in `sw.js` (`VERSION`) und `js/app.js` (`APP_VERSION`) erhöhen,
damit installierte Apps die neue Fassung laden.

Lokal testen: `python3 tools/dev_server.py 8765` und `http://localhost:8765` öffnen.
