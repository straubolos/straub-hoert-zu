// OpenAI: Transkription (mit Sprechererkennung) und Zusammenfassung.
//
// Geprüft gegen die OpenAI-Doku (developers.openai.com, Stand 24.11.2026):
// - Diarisierung: gpt-4o-transcribe-diarize, response_format=diarized_json,
//   chunking_strategy=auto (Pflicht ab 30 s), known_speaker_names[] /
//   known_speaker_references[] (max. 4, Clips 2–10 s als Data-URL), kein prompt.
//   Hinweis: gpt-4o-transcribe-diarize ist "deprecated" (Abschaltung 26.02.2027).
// - Ohne Sprecher: gpt-transcribe (Parameter "languages" statt "language"),
//   whisper-1 mit verbose_json (Segmente mit Zeitmarken).
// - Upload-Limit 25 MB pro Datei.
// - Zusammenfassung: Chat Completions, response_format json_schema (strict).
// OpenAI liefert manche Fehlerantworten (z. B. 401) ohne CORS-Header; deshalb
// klärt eine Prüfanfrage an /models den Grund (siehe http.js).

import { ApiError, request, withRetry, rejectsParam } from './http.js';
import { getKey, DEFAULT_SETTINGS } from './settings.js';
import { SUMMARY_SCHEMA, SUMMARY_SYSTEM, SUMMARY_JSON_EXAMPLE, parseSummaryContent } from './summary.js';

const API = 'https://api.openai.com/v1';
const SERVICE = 'OpenAI';
const SUMMARY_FALLBACK_MODELS = ['gpt-5.4-nano', 'gpt-5-mini', 'gpt-4.1-mini'];

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function auth() {
  const key = getKey('openai');
  if (!key) throw new ApiError('Kein OpenAI-API-Schlüssel hinterlegt.', { status: 0, retryable: false });
  return key;
}

async function probeStatus(key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal, cache: 'no-store' });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

function call(path, opts) {
  const key = auth();
  return request(API + path, {
    service: SERVICE,
    headers: { Authorization: `Bearer ${key}` },
    probe: () => probeStatus(key),
    ...opts,
  });
}

/**
 * mode: 'diarize' | 'json' | 'whisper'
 * knownSpeakers: [{ name, ref }] (nur diarize)
 */
export async function transcribe({ blob, filename, model, mode, language = 'de', knownSpeakers = [], timeout = 6 * 60 * 1000 }) {
  const optional = [];
  if (mode === 'diarize') {
    optional.push({ name: 'language', fields: [['language', language]] });
    if (knownSpeakers.length) {
      optional.push({
        name: 'known_speaker',
        fields: [
          ...knownSpeakers.map((s) => ['known_speaker_names[]', s.name]),
          ...knownSpeakers.map((s) => ['known_speaker_references[]', s.ref]),
        ],
      });
    }
  } else if (mode === 'json') {
    optional.push({ name: 'languages', fields: [['languages[]', language]], replace: { name: 'language', fields: [['language', language]] } });
  } else {
    optional.push({ name: 'language', fields: [['language', language]] });
  }

  for (let adapt = 0; adapt < 4; adapt++) {
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('model', model);
    if (mode === 'diarize') {
      fd.append('response_format', 'diarized_json');
      fd.append('chunking_strategy', 'auto');
    } else if (mode === 'json') {
      fd.append('response_format', 'json');
    } else {
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'segment');
    }
    for (const group of optional) for (const [k, v] of group.fields) fd.append(k, v);

    try {
      return await call('/audio/transcriptions', { body: fd, timeout });
    } catch (e) {
      const idx = optional.findIndex((g) => rejectsParam(e, g.name));
      if (idx === -1) throw e;
      const g = optional[idx];
      if (g.replace) optional.splice(idx, 1, g.replace); else optional.splice(idx, 1);
    }
  }
  throw new ApiError('Transkription nicht möglich: Parameter wurden mehrfach abgelehnt.', { status: 400, retryable: false });
}

/** Titel und Zusammenfassung; probiert bei nicht verfügbarem Modell günstige Ersatzmodelle. */
export async function summarize(transcriptText, { model, onRetry } = {}) {
  const models = [...new Set([model || DEFAULT_SETTINGS.summaryModel, ...SUMMARY_FALLBACK_MODELS])];
  let lastErr = null;
  for (const m of models) {
    try {
      return await withRetry(() => summarizeWith(m, transcriptText), { onRetry });
    } catch (e) {
      lastErr = e;
      const modelProblem = e instanceof ApiError && (e.opaque || e.status === 404 || e.status === 403 ||
        (e.status === 400 && /model/i.test(e.apiMessage || '') && !/context|token/i.test(e.apiMessage || '')));
      if (!modelProblem) throw e;
    }
  }
  throw lastErr;
}

async function summarizeWith(model, transcriptText) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `Transkript:\n\n${transcriptText}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'gespraechszusammenfassung', strict: true, schema: SUMMARY_SCHEMA },
    },
    reasoning_effort: 'low',
    max_completion_tokens: 12000,
  };

  for (let adapt = 0; adapt < 4; adapt++) {
    let data;
    try {
      data = await call('/chat/completions', { json: body, timeout: 4 * 60 * 1000 });
    } catch (e) {
      if (rejectsParam(e, 'reasoning_effort') && body.reasoning_effort) { delete body.reasoning_effort; continue; }
      if (rejectsParam(e, 'max_completion_tokens') && body.max_completion_tokens) { delete body.max_completion_tokens; continue; }
      if (rejectsParam(e, 'response_format') && body.response_format.type === 'json_schema') {
        body.response_format = { type: 'json_object' };
        body.messages[0].content += `\n\n${SUMMARY_JSON_EXAMPLE}`;
        continue;
      }
      throw e;
    }
    const msg = data?.choices?.[0]?.message;
    if (msg?.refusal) throw new ApiError(`Das Modell hat die Zusammenfassung abgelehnt: ${msg.refusal}`, { status: 200, retryable: false });
    return { model: data.model || model, ...parseSummaryContent(msg?.content, data?.choices?.[0]?.finish_reason) };
  }
  throw new ApiError('Zusammenfassung nicht möglich: Parameter wurden mehrfach abgelehnt.', { status: 400, retryable: false });
}

export async function testKey(key) {
  const st = await probeStatus(String(key).trim());
  if (st === 200) return { ok: true };
  if (st === 401) return { ok: false, reason: 'invalid' };
  if (st === 0) return { ok: false, reason: 'network' };
  return { ok: false, reason: 'http', status: st };
}
