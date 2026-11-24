// DeepSeek: Spracherkennung (ohne Sprecher) und Zusammenfassung.
//
// Geprüft gegen api-docs.deepseek.com (Stand 24.11.2026):
// - ASR: POST https://api.deepseek.com/v1/tools/asr, multipart-Feld "file",
//   16-Bit-PCM-WAV oder Ogg Opus, max. 120 s und 8 MiB, Sprache wird erkannt
//   (Deutsch unterstützt). Antwort: { request_id, text, duration_ms }.
//   Keine Zeitmarken je Satz, keine Sprecher. Max. 50 parallele Anfragen.
// - Chat: POST https://api.deepseek.com/chat/completions, Modell deepseek-flash,
//   response_format json_object (Wort "json" + Beispiel im Prompt nötig),
//   thinking {type: "disabled"} für schnelle, günstige Antworten.
// - Fehlerantworten enthalten CORS-Header (im Browser lesbar).

import { ApiError, request, withRetry, rejectsParam } from './http.js';
import { getKey, DEFAULT_SETTINGS } from './settings.js';
import { SUMMARY_SYSTEM, SUMMARY_JSON_EXAMPLE, parseSummaryContent } from './summary.js';

const BASE = 'https://api.deepseek.com';
const SERVICE = 'DeepSeek';
const FALLBACK_MODELS = ['deepseek-v4-pro'];

export const ASR_MAX_SECONDS = 120;
export const ASR_MAX_BYTES = 8 * 1024 * 1024;

function auth() {
  const key = getKey('deepseek');
  if (!key) throw new ApiError('Kein DeepSeek-API-Schlüssel hinterlegt.', { status: 0, retryable: false });
  return { Authorization: `Bearer ${key}` };
}

/** Transkribiert ein WAV-Stück (max. 120 s). Gibt { text, durationMs } zurück. */
export async function asr(wavBlob, { timeout = 3 * 60 * 1000 } = {}) {
  const fd = new FormData();
  fd.append('file', wavBlob, 'abschnitt.wav');
  const data = await request(`${BASE}/v1/tools/asr`, { service: SERVICE, headers: auth(), body: fd, timeout });
  return { text: String(data?.text || '').trim(), durationMs: Number(data?.duration_ms) || null };
}

export async function summarize(transcriptText, { model, onRetry } = {}) {
  const models = [...new Set([model || DEFAULT_SETTINGS.deepseekModel, ...FALLBACK_MODELS])];
  let lastErr = null;
  for (const m of models) {
    try {
      return await withRetry(() => summarizeWith(m, transcriptText), { onRetry });
    } catch (e) {
      lastErr = e;
      const modelProblem = e instanceof ApiError && (e.status === 404 ||
        ((e.status === 400 || e.status === 422) && /model/i.test(e.apiMessage || '') && !/context|token|length/i.test(e.apiMessage || '')));
      if (!modelProblem) throw e;
    }
  }
  throw lastErr;
}

async function summarizeWith(model, transcriptText) {
  const body = {
    model,
    messages: [
      { role: 'system', content: `${SUMMARY_SYSTEM}\n\n${SUMMARY_JSON_EXAMPLE}` },
      { role: 'user', content: `Transkript:\n\n${transcriptText}\n\nGib die Zusammenfassung als json zurück.` },
    ],
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    max_tokens: 8000,
    stream: false,
  };
  for (let adapt = 0; adapt < 4; adapt++) {
    let data;
    try {
      data = await request(`${BASE}/chat/completions`, { service: SERVICE, headers: auth(), json: body, timeout: 4 * 60 * 1000 });
    } catch (e) {
      if (rejectsParam(e, 'thinking') && body.thinking) { delete body.thinking; body.reasoning_effort = 'none'; continue; }
      if (rejectsParam(e, 'reasoning_effort') && body.reasoning_effort) { delete body.reasoning_effort; continue; }
      if (rejectsParam(e, 'max_tokens') && body.max_tokens) { delete body.max_tokens; continue; }
      throw e;
    }
    const choice = data?.choices?.[0];
    return { model: data?.model || model, ...parseSummaryContent(choice?.message?.content, choice?.finish_reason) };
  }
  throw new ApiError('Zusammenfassung nicht möglich: Parameter wurden mehrfach abgelehnt.', { status: 400, retryable: false });
}

export async function testKey(key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${String(key).trim()}` }, signal: ctrl.signal, cache: 'no-store',
    });
    if (r.ok) return { ok: true };
    if (r.status === 401) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'http', status: r.status };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(t);
  }
}

/** Kontostand als Text (z. B. "4,20 USD") oder null. */
export async function balance() {
  try {
    const data = await request(`${BASE}/user/balance`, { service: SERVICE, method: 'GET', headers: auth(), timeout: 15000 });
    const info = data?.balance_infos?.[0];
    if (!info) return null;
    const amount = Number(info.total_balance);
    const text = Number.isFinite(amount) ? amount.toFixed(2).replace('.', ',') : String(info.total_balance);
    return `${text} ${info.currency || ''}`.trim() + (data.is_available === false ? ' (gesperrt)' : '');
  } catch {
    return null;
  }
}
