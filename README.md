# Straub hört zu

Private Web-App (PWA) für das iPhone: Gespräche aufnehmen, transkribieren (optional mit Sprechererkennung),
Titel und Zusammenfassung erstellen lassen und als Markdown-Datei teilen.

Reines HTML, CSS und JavaScript – kein Backend, kein Build-Schritt. Läuft auf GitHub Pages.

## Dienste

| Aufgabe | Dienst | Hinweis |
|---|---|---|
| Transkription mit Sprechern | **Deepgram** (Nova-3, empfohlen) | Startguthaben ohne Kreditkarte; ganze Aufnahme in einer Datei, daher einheitliche Sprecher |
| Transkription ohne Sprecher | **DeepSeek** (`/v1/tools/asr`) | Sehr günstig; die App zerlegt das Audio an Sprechpausen in WAV-Stücke ≤ 110 s (Limit 120 s / 8 MiB) |
| Transkription mit Sprechern | **OpenAI** (`gpt-4o-transcribe-diarize`) | 10-Minuten-Teile, Sprecher über Stimmproben teilübergreifend gleich; Modell wird laut Doku am 26.02.2027 abgeschaltet |
| Titel und Zusammenfassung | **DeepSeek** (`deepseek-flash`) oder **OpenAI** (`gpt-6-luna`) | JSON-Ausgabe; unsichere Zahlen werden markiert |

Es genügt ein einziger Schlüssel (z. B. nur DeepSeek). Welcher Dienst was übernimmt, wird unter
„Einstellungen“ gewählt; ohne Auswahl nimmt die App automatisch den besten verfügbaren.

## Sicherheit

- API-Schlüssel stehen **nirgends im Code**. Sie werden in der App eingegeben und nur im Speicher
  des Geräts (localStorage) abgelegt. Ändern, prüfen oder löschen unter „Einstellungen“.
- Aufnahmen, Transkripte und Zusammenfassungen liegen nur in IndexedDB auf dem Gerät.
- Daten gehen ausschließlich an `api.deepseek.com`, `api.deepgram.com` bzw. `api.openai.com`
  (per Content-Security-Policy erzwungen).
- `tools/check_secrets.sh` prüft vor jedem Commit und Push, dass keine Schlüssel im Repo landen.

## Ablauf

1. **Aufnahme** mit `MediaRecorder` (iOS: `audio/mp4`, automatisch erkannt). Alle 4 Sekunden wird
   ein Audiostück in IndexedDB gesichert. Die Teillänge hängt vom Dienst ab (Deepgram: bis 150 Min.,
   sonst 10 Min.). Bildschirm bleibt per Wake Lock an. Wechselt die App in den Hintergrund, wird
   pausiert; nach einem Absturz lässt sich die Aufnahme fortsetzen oder transkribieren.
2. **Transkription** je Teil mit dem gewählten Dienst. Fehlgeschlagene Teile werden automatisch
   wiederholt; fertige Teile werden nie doppelt übertragen.
3. **Titel und Zusammenfassung** (Kernpunkte, Vereinbarungen, Zahlen/Preise, Termine, To-dos).
4. **Export**: `JJJJ-MM-TT_Titel.md` über das iPhone-Teilen-Menü (Web Share API).

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `manifest.json`, `sw.js` | App-Gerüst, PWA-Manifest, Offline-Cache |
| `css/app.css` | Gestaltung (Dark Mode, Rot nur für Aufnahme) |
| `js/app.js` | Oberfläche und Navigation |
| `js/recorder.js` | Aufnahme, Teile, Sicherung, Pegel, Wake Lock |
| `js/pipeline.js` | Transkription, Sprecherabgleich, Zusammenfassung |
| `js/settings.js` | Schlüssel, Dienstauswahl, Einstellungen |
| `js/http.js` | Gemeinsame Anfragen, Fehler, Wiederholungen |
| `js/deepseek.js`, `js/deepgram.js`, `js/openai.js` | Anbindung der Dienste |
| `js/summary.js` | Vorgaben für Titel und Zusammenfassung |
| `js/audio.js` | Dekodieren, Zerlegen an Pausen, WAV, Stimmproben |
| `js/export.js` | Markdown-Export, Teilen, Kopieren |
| `js/db.js` | IndexedDB |
| `icons/` | Logo (SVG), App-Icons, iOS-Startbildschirme |
| `tools/` | Icon-Erzeugung, lokaler Testserver, Geheimnis-Prüfung |

## Aktualisieren

Nach Änderungen die Versionsnummer in `sw.js` (`VERSION`) und `js/app.js` (`APP_VERSION`) erhöhen,
damit installierte Apps die neue Fassung laden.

Lokal testen: `python3 tools/dev_server.py 8765` und `http://localhost:8765` öffnen.
