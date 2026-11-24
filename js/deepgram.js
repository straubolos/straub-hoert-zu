// Deepgram: Transkription mit Sprechererkennung (Nova-3, Deutsch).
//
// Geprüft gegen developers.deepgram.com (Stand 24.11.2026):
// - POST https://api.deepgram.com/v1/listen mit der Audiodatei als Body,
//   Header "Authorization: Token <KEY>", Content-Type der Datei.
// - Parameter: model=nova-3, language=de, diarize_model=latest (ältere Form:
//   diarize=true), punctuate, smart_format, utterances.
// - Antwort: results.utterances[] { start, end, speaker (Zahl), transcript },
//   metadata.duration. Dateien bis 2 GB, Sprechererkennung inklusive.
// - Fehlerantworten enthalten CORS-Header ({ err_code, err_msg }).

import { ApiError, request, rejectsParam } from './http.js';
import { getKey, DEFAULT_SETTINGS } from './settings.js';

const BASE = 'https://api.deepgram.com/v1/listen';
const SERVICE = 'Deepgram';

function params(model, legacyDiarize) {
  const p = new URLSearchParams({
    model: model || DEFAULT_SETTINGS.deepgramModel,
    language: 'de',
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
  });
  if (legacyDiarize) p.set('diarize', 'true'); else p.set('diarize_model', 'latest');
  return p;
}

/** Gibt die rohe Deepgram-Antwort zurück. */
export async function transcribe(blob, { model, timeout } = {}) {
  const key = getKey('deepgram');
  if (!key) throw new ApiError('Kein Deepgram-API-Schlüssel hinterlegt.', { status: 0, retryable: false });
  const type = String(blob.type || 'audio/mp4').split(';')[0];
  // Großzügiges Zeitlimit: Upload über Mobilfunk kann dauern.
  const limit = timeout || Math.max(6 * 60 * 1000, Math.round(blob.size / 30000) * 1000);
  let legacy = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await request(`${BASE}?${params(model, legacy)}`, {
        service: SERVICE,
        headers: { Authorization: `Token ${key}`, 'Content-Type': type },
        body: blob,
        timeout: limit,
      });
    } catch (e) {
      if (!legacy && rejectsParam(e, 'diarize_model')) { legacy = true; continue; }
      throw e;
    }
  }
  throw new ApiError('Deepgram: Anfrage wurde abgelehnt.', { status: 400, retryable: false });
}

/** Wandelt die Antwort in Segmente { start, end, speakerRaw, text } um. */
export function toSegments(data) {
  const utt = data?.results?.utterances;
  if (Array.isArray(utt) && utt.length) {
    return utt
      .map((u) => ({
        start: +u.start || 0,
        end: +u.end || 0,
        speakerRaw: u.speaker != null ? `dg${u.speaker}` : null,
        text: String(u.transcript || '').trim(),
      }))
      .filter((s) => s.text);
  }
  // Ohne Utterances: Wörter nach Sprecher gruppieren.
  const words = data?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
  const out = [];
  for (const w of words) {
    const spk = w.speaker != null ? `dg${w.speaker}` : null;
    const last = out[out.length - 1];
    const word = w.punctuated_word || w.word || '';
    if (last && last.speakerRaw === spk && w.start - last.end < 1.5) {
      last.text += ` ${word}`;
      last.end = w.end;
    } else {
      out.push({ start: +w.start || 0, end: +w.end || 0, speakerRaw: spk, text: word });
    }
  }
  return out.filter((s) => s.text.trim());
}

/** Prüft den Schlüssel mit einer halben Sekunde Stille (Kosten praktisch null). */
export async function testKey(key) {
  const sr = 16000;
  const n = sr / 2;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${BASE}?model=${DEFAULT_SETTINGS.deepgramModel}&language=de`, {
      method: 'POST',
      headers: { Authorization: `Token ${String(key).trim()}`, 'Content-Type': 'audio/wav' },
      body: buf,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'http', status: r.status };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(t);
  }
}
