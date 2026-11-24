// Direkte Aufrufe der OpenAI-API aus dem Browser.
// Der API-Schlüssel liegt ausschließlich im localStorage dieses Geräts.
//
// Geprüft gegen die OpenAI-Doku (developers.openai.com, Stand 24.11.2026):
// - Diarisierung: gpt-4o-transcribe-diarize, response_format=diarized_json,
//   chunking_strategy=auto (Pflicht ab 30 s), known_speaker_names[] /
//   known_speaker_references[] (max. 4, Clips 2–10 s als Data-URL), kein prompt.
//   Hinweis: gpt-4o-transcribe-diarize ist "deprecated" (Abschaltung 26.02.2027).
// - Ohne Sprecher: gpt-transcribe (Parameter "languages" statt "language"),
//   whisper-1 mit verbose_json (Segmente mit Zeitmarken).
// - Upload-Limit 25 MB pro Datei.
// - Zusammenfassung: Chat Completions, response_format json_schema (strict),
//   reasoning_effort, max_completion_tokens. Standardmodell gpt-6-luna.

const API = 'https://api.openai.com/v1';
const KEY_STORAGE = 'shz.apiKey';
const SETTINGS_STORAGE = 'shz.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  diarize: true,
  diarizeModel: 'gpt-4o-transcribe-diarize',
  transcribeModel: 'gpt-transcribe',
  summaryModel: 'gpt-6-luna',
});

const SUMMARY_FALLBACK_MODELS = ['gpt-5.4-nano', 'gpt-5-mini', 'gpt-4.1-mini'];

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// ---------- Schlüssel & Einstellungen ----------

export function getKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}
export function setKey(key) {
  localStorage.setItem(KEY_STORAGE, String(key).trim());
}
export function clearKey() {
  localStorage.removeItem(KEY_STORAGE);
}
export function maskKey(key = getKey()) {
  if (!key) return '';
  return key.slice(0, 3) + '…' + key.slice(-4);
}

export function getSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) || '{}'); } catch { stored = {}; }
  const s = { ...DEFAULT_SETTINGS, ...stored };
  for (const k of ['diarizeModel', 'transcribeModel', 'summaryModel']) {
    if (!String(s[k] || '').trim()) s[k] = DEFAULT_SETTINGS[k];
  }
  return s;
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(next));
  return next;
}

// ---------- Fehler & Anfragen ----------

export class ApiError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, info);
  }
}

function germanMessage(status, err) {
  const msg = err?.message ? ` (${err.message})` : '';
  if (status === 401) return 'Der API-Schlüssel ist ungültig oder wurde widerrufen. Bitte in den Einstellungen prüfen.';
  if (status === 429 && err?.code === 'insufficient_quota') return 'Kein Guthaben bei OpenAI. Bitte die Abrechnung im OpenAI-Konto prüfen.';
  if (status === 429) return 'OpenAI meldet zu viele Anfragen. Es wird gleich erneut versucht.';
  if (status === 413) return 'Die Audiodatei ist zu groß für OpenAI (max. 25 MB).';
  if (status === 403) return `Kein Zugriff auf dieses Modell${msg}.`;
  if (status === 404) return `Modell oder Endpunkt nicht gefunden${msg}.`;
  if (status >= 500) return `OpenAI-Serverfehler (${status}). Es wird erneut versucht.`;
  return `OpenAI-Fehler ${status}${msg}`;
}

async function request(path, { method = 'POST', body, json, timeout = 120000 } = {}) {
  const key = getKey();
  if (!key) throw new ApiError('Kein API-Schlüssel hinterlegt.', { status: 0, code: 'no_key', retryable: false });

  const headers = { Authorization: `Bearer ${key}` };
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res, text;
  try {
    res = await fetch(API + path, { method, headers, body, signal: ctrl.signal, cache: 'no-store' });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    if (navigator.onLine === false) {
      throw new ApiError('Keine Internetverbindung.', { status: 0, network: true, retryable: true });
    }
    if (e.name === 'AbortError') {
      throw new ApiError('Zeitüberschreitung – OpenAI hat nicht rechtzeitig geantwortet.', { status: 0, network: true, retryable: true });
    }
    // OpenAI liefert manche Fehlerantworten (z. B. 401) ohne CORS-Header aus. Der Browser
    // meldet dann nur "Failed to fetch". Eine CORS-fähige Prüfanfrage klärt, was los ist.
    const probe = await probeKey(key);
    if (probe === 401) {
      throw new ApiError(germanMessage(401), { status: 401, code: 'invalid_api_key', retryable: false });
    }
    if (probe === 200) {
      throw new ApiError('OpenAI hat die Anfrage abgelehnt; der Browser kann den genauen Grund nicht lesen ' +
        '(z. B. Modell nicht verfügbar, Datei ungültig oder Limit erreicht).', { status: 0, opaque: true, retryable: true });
    }
    if (probe > 0) {
      throw new ApiError(`OpenAI antwortet mit Status ${probe}.`, { status: probe, retryable: probe === 429 || probe >= 500 });
    }
    throw new ApiError('Netzwerkfehler – OpenAI ist nicht erreichbar.', { status: 0, network: true, retryable: true });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    const err = data?.error || {};
    const code = err.code || err.type || null;
    const retryable = (res.status === 429 && code !== 'insufficient_quota') ||
      res.status >= 500 || res.status === 408 || res.status === 409;
    const ra = Number(res.headers.get('retry-after'));
    throw new ApiError(germanMessage(res.status, err), {
      status: res.status, code, param: err.param || null, apiMessage: err.message || '',
      retryable, retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : null,
    });
  }
  return data ?? text;
}

/** Leichte GET-Anfrage (CORS-fähig auch bei 401). Gibt den Status zurück, 0 bei Netzfehler. */
async function probeKey(key) {
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

function waitOnline(maxMs) {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { window.removeEventListener('online', done); clearTimeout(t); resolve(); };
    const t = setTimeout(done, maxMs);
    window.addEventListener('online', done);
  });
}

/** Wiederholt fn bei Netz-/Serverfehlern mit wachsender Wartezeit. */
export async function withRetry(fn, { attempts = 4, onRetry } = {}) {
  const delays = [3000, 8000, 20000, 40000];
  for (let i = 0; ; i++) {
    if (navigator.onLine === false) {
      onRetry?.({ offline: true });
      await waitOnline(180000);
    }
    try {
      return await fn(i);
    } catch (e) {
      // Unlesbare Ablehnungen nur einmal wiederholen, danach greift der Modell-Ersatz.
      const max = e?.opaque ? Math.min(attempts, 2) : attempts;
      const last = i >= max - 1;
      if (!(e instanceof ApiError) || !e.retryable || last) throw e;
      const delay = e.retryAfter ?? delays[Math.min(i, delays.length - 1)];
      onRetry?.({ attempt: i + 2, attempts, delay, error: e });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Prüft einen 400er-Fehler darauf, ob ein bestimmter Parameter abgelehnt wurde. */
function rejectsParam(err, name) {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  if (err.param && String(err.param).replace(/\[\]$/, '').startsWith(name)) return true;
  return new RegExp(`\\b${name}`, 'i').test(err.apiMessage || '');
}

// ---------- Transkription ----------

/**
 * mode: 'diarize' | 'json' | 'whisper'
 * knownSpeakers: [{ name, ref }] (nur diarize)
 * Gibt die rohe API-Antwort zurück.
 */
export async function transcribe({ blob, filename, model, mode, language = 'de', knownSpeakers = [], timeout = 6 * 60 * 1000 }) {
  // Optionale Parameter, die bei Ablehnung (400) entfernt bzw. ersetzt werden.
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
      return await request('/audio/transcriptions', { body: fd, timeout });
    } catch (e) {
      const idx = optional.findIndex((g) => rejectsParam(e, g.name));
      if (idx === -1) throw e;
      const g = optional[idx];
      if (g.replace) optional.splice(idx, 1, g.replace); else optional.splice(idx, 1);
    }
  }
  throw new ApiError('Transkription nicht möglich: Parameter wurden mehrfach abgelehnt.', { status: 400, retryable: false });
}

// ---------- Titel & Zusammenfassung ----------

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titel', 'ueberblick', 'kernpunkte', 'vereinbarungen', 'zahlen_preise', 'termine', 'todos'],
  properties: {
    titel: { type: 'string', description: 'Kurzer Titel, 3 bis 6 Wörter, worum es grob ging.' },
    ueberblick: { type: 'string', description: '2 bis 4 Sätze Überblick.' },
    kernpunkte: { type: 'array', items: { type: 'string' } },
    vereinbarungen: { type: 'array', items: { type: 'string' } },
    zahlen_preise: { type: 'array', items: { type: 'string' } },
    termine: { type: 'array', items: { type: 'string' } },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['aufgabe', 'zustaendig', 'frist'],
        properties: {
          aufgabe: { type: 'string' },
          zustaendig: { type: ['string', 'null'] },
          frist: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const SUMMARY_SYSTEM = `Du bekommst das automatisch erstellte Transkript einer deutschsprachigen Gesprächsaufnahme (z. B. Baustellen-, Kunden- oder Planungsgespräch). Die Sprecher sind mit Namen oder als "Sprecher A", "Sprecher B" usw. gekennzeichnet; Zeitmarken stehen in eckigen Klammern.

Erstelle auf Deutsch:
1. "titel": 3 bis 6 Wörter, konkret und sachlich, worum es grob ging (z. B. "Rückbau Villa Herber" oder "Angebot Dachsanierung Müller"). Keine Anführungszeichen, kein Datum, kein Punkt am Ende.
2. "ueberblick": 2 bis 4 Sätze, worum es ging und was herauskam.
3. "kernpunkte": die wichtigsten inhaltlichen Punkte.
4. "vereinbarungen": konkrete Absprachen und Entscheidungen.
5. "zahlen_preise": alle genannten Zahlen, Mengen, Maße, Preise und Beträge jeweils mit kurzem Kontext.
6. "termine": alle genannten Termine, Fristen und Zeitpunkte mit Kontext.
7. "todos": offene Aufgaben mit zuständiger Person (falls erkennbar, sonst null) und Frist (falls genannt, sonst null).

Regeln: Nur Fakten aus dem Transkript verwenden, nichts erfinden. Unsichere oder schwer verständliche Stellen als solche kennzeichnen. Wenn es zu einem Punkt nichts gibt, eine leere Liste zurückgeben. Kurze, klare Stichpunkte. Sprecher so bezeichnen wie im Transkript.`;

/**
 * Erstellt Titel und Zusammenfassung. Probiert bei nicht verfügbarem Modell
 * automatisch günstige Ersatzmodelle.
 */
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
      data = await request('/chat/completions', { json: body, timeout: 4 * 60 * 1000 });
    } catch (e) {
      if (rejectsParam(e, 'reasoning_effort') && body.reasoning_effort) { delete body.reasoning_effort; continue; }
      if (rejectsParam(e, 'max_completion_tokens') && body.max_completion_tokens) { delete body.max_completion_tokens; continue; }
      if (rejectsParam(e, 'response_format') && body.response_format.type === 'json_schema') {
        body.response_format = { type: 'json_object' };
        body.messages[0].content += `\n\nAntworte ausschließlich mit einem JSON-Objekt mit den Feldern: ${SUMMARY_SCHEMA.required.join(', ')}.`;
        continue;
      }
      throw e;
    }
    const msg = data?.choices?.[0]?.message;
    if (msg?.refusal) throw new ApiError(`Das Modell hat die Zusammenfassung abgelehnt: ${msg.refusal}`, { status: 200, retryable: false });
    let parsed;
    try {
      parsed = JSON.parse(msg?.content || '');
    } catch {
      const finish = data?.choices?.[0]?.finish_reason;
      throw new ApiError(finish === 'length'
        ? 'Die Zusammenfassung wurde abgeschnitten (zu lang).'
        : 'Die Antwort des Modells war kein gültiges JSON.', { status: 200, retryable: true });
    }
    return { model: data.model || model, ...normalizeSummary(parsed) };
  }
  throw new ApiError('Zusammenfassung nicht möglich: Parameter wurden mehrfach abgelehnt.', { status: 400, retryable: false });
}

function normalizeSummary(p) {
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);
  let title = String(p.titel || '').replace(/^["'„“”«»\s]+|["'„“”«»\s.]+$/g, '').trim();
  if (title.length > 80) title = title.slice(0, 80).replace(/\s+\S*$/, '');
  return {
    title,
    summary: {
      overview: String(p.ueberblick || '').trim(),
      keyPoints: list(p.kernpunkte),
      agreements: list(p.vereinbarungen),
      numbers: list(p.zahlen_preise),
      dates: list(p.termine),
      todos: (Array.isArray(p.todos) ? p.todos : []).map((t) => ({
        task: String(t?.aufgabe || '').trim(),
        owner: t?.zustaendig ? String(t.zustaendig).trim() : null,
        due: t?.frist ? String(t.frist).trim() : null,
      })).filter((t) => t.task),
    },
  };
}

// ---------- Schlüssel prüfen ----------

export async function testKey(key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${API}/models`, {
      headers: { Authorization: `Bearer ${String(key).trim()}` },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'http', status: res.status };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
