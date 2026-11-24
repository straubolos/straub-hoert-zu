// Verarbeitung nach der Aufnahme: Teile transkribieren (mit Sprechererkennung),
// Sprecher über Teile hinweg vereinheitlichen, zusammensetzen, Titel + Zusammenfassung.
// Fortschritt wird pro Teil gespeichert – ein Neustart macht nur Fehlendes neu.

import * as db from './db.js';
import * as api from './openai.js';
import { decodeAudio, clipToWavDataUrl } from './audio.js';
import { extForMime } from './recorder.js';
import { fmtStamp, speakerName } from './util.js';

export const events = new EventTarget();

const progress = new Map();
const queued = new Set();
let chain = Promise.resolve();

export function getProgress(id) { return progress.get(id) || null; }
export function isBusy(id) { return queued.has(id); }
export function isAnyBusy() { return queued.size > 0; }

function emitProgress(id, text, fraction = null) {
  progress.set(id, { text, fraction });
  events.dispatchEvent(new CustomEvent('progress', { detail: { id, text, fraction } }));
}
function emitChange(id) {
  events.dispatchEvent(new CustomEvent('change', { detail: { id } }));
}

/** Aufnahme zur Verarbeitung einreihen. force: alles neu transkribieren. */
export function enqueue(id, { force = false } = {}) {
  if (queued.has(id)) return;
  queued.add(id);
  emitProgress(id, 'Wartet auf Verarbeitung …', 0);
  emitChange(id);
  db.updateRecording(id, (r) => {
    if (force) {
      r.transcriptParts = {};
      r.speakers = [];
      r.speakerTime = {};
      r.speakerRefs = {};
      r.segments = null;
      r.summary = null;
    }
    r.status = 'queued';
    r.error = null;
  }).then(() => emitChange(id));

  chain = chain.then(async () => {
    try {
      await processRecording(id);
    } catch (e) {
      console.error(e);
    } finally {
      queued.delete(id);
      progress.delete(id);
      emitChange(id);
    }
  });
}

const letterFor = (i) => (i < 26 ? String.fromCharCode(65 + i) : `S${i + 1}`);
const KNOWN_PREFIX = 'SPK_';

async function processRecording(id) {
  let rec = await db.getRecording(id);
  if (!rec) return;
  const settings = api.getSettings();
  const n = rec.parts.length;
  let stage = 'transcribe';

  try {
    if (!api.getKey()) throw new api.ApiError('Kein API-Schlüssel hinterlegt.', { status: 0 });
    rec = await db.updateRecording(id, (r) => { r.status = 'transcribing'; r.error = null; });
    emitChange(id);

    const speakers = [...(rec.speakers || [])];
    const speakerTime = { ...(rec.speakerTime || {}) };
    const refs = { ...(rec.speakerRefs || {}) };
    const parts = rec.transcriptParts || {};
    const failedModes = new Set(); // in diesem Durchlauf nicht nutzbare Modelle überspringen

    for (let i = 0; i < n; i++) {
      if (parts[i]) continue;
      const part = rec.parts[i];
      const label = n > 1 ? `Teil ${i + 1} von ${n} wird transkribiert …` : 'Wird transkribiert …';
      emitProgress(id, label, i / n * 0.9);

      const blob = await db.getPartBlob(id, i, part?.mime);
      if (!part || blob.size < 1000) {
        parts[i] = { empty: true, segments: [], duration: (part?.duration || 0) / 1000 };
        await db.updateRecording(id, (r) => { r.transcriptParts = { ...r.transcriptParts, [i]: parts[i] }; });
        continue;
      }
      if (blob.size > api.MAX_UPLOAD_BYTES) {
        throw new Error(`Teil ${i + 1} ist mit ${(blob.size / 1048576).toFixed(1)} MB größer als das OpenAI-Limit von 25 MB.`);
      }

      const onRetry = (info) => {
        if (info.offline) emitProgress(id, 'Warte auf Internetverbindung …', i / n * 0.9);
        else emitProgress(id, `${label.replace(' …', '')} – neuer Versuch ${info.attempt} von ${info.attempts} …`, i / n * 0.9);
      };

      const result = await transcribePart({
        blob, index: i, mime: part.mime, settings, refs, speakers, speakerTime, onRetry, failedModes,
      });

      // Sprecher den einheitlichen Buchstaben zuordnen.
      const local = new Map();
      for (const s of result.segments) {
        if (!s.speakerRaw) { s.speaker = null; continue; }
        const raw = String(s.speakerRaw);
        let g = raw.startsWith(KNOWN_PREFIX) ? raw.slice(KNOWN_PREFIX.length) : local.get(raw);
        if (!g) {
          g = letterFor(speakers.length);
          local.set(raw, g);
        }
        if (!speakers.includes(g)) speakers.push(g);
        s.speaker = g;
        speakerTime[g] = (speakerTime[g] || 0) + Math.max(0, (s.end || 0) - (s.start || 0));
        delete s.speakerRaw;
      }

      parts[i] = {
        model: result.model,
        diarized: result.diarized,
        duration: result.duration ?? (part.duration || 0) / 1000,
        segments: result.segments,
      };

      // Referenzclips für Sprecher ohne Referenz – nur nötig, wenn weitere Teile folgen.
      if (result.diarized && i < n - 1) {
        const missing = speakers.filter((g) => !refs[g]);
        if (missing.length) {
          emitProgress(id, `${label.replace(' wird transkribiert …', '')}: Stimmen werden abgeglichen …`, (i + 0.95) / n * 0.9);
          await extractRefs(blob, result.segments, missing, refs).catch((e) => console.warn('Referenzclips:', e));
        }
      }

      await db.updateRecording(id, (r) => {
        r.transcriptParts = { ...r.transcriptParts, [i]: parts[i] };
        r.speakers = speakers;
        r.speakerTime = speakerTime;
        r.speakerRefs = refs;
      });
      emitChange(id);
    }

    // Zusammensetzen
    const segments = mergeParts(rec.parts, parts);
    const totalSec = Object.values(parts).reduce((s, p) => s + (p.duration || 0), 0);
    rec = await db.updateRecording(id, (r) => {
      r.segments = segments;
      if (totalSec > 0 && Math.abs(totalSec * 1000 - r.duration) > 2000) r.duration = Math.round(totalSec * 1000);
    });
    emitChange(id);

    // Titel & Zusammenfassung
    stage = 'summary';
    const text = transcriptForModel(rec);
    if (!text.trim()) {
      await db.updateRecording(id, (r) => {
        r.status = 'done';
        r.summary = null;
        if (!r.titleManual) r.title = 'Keine Sprache erkannt';
        r.speakerRefs = {};
      });
      return;
    }
    rec = await db.updateRecording(id, (r) => { r.status = 'summarizing'; });
    emitChange(id);
    emitProgress(id, 'Titel und Zusammenfassung werden erstellt …', 0.94);
    const sum = await api.summarize(text, {
      model: settings.summaryModel,
      onRetry: (info) => emitProgress(id, info.offline ? 'Warte auf Internetverbindung …'
        : `Zusammenfassung – neuer Versuch ${info.attempt} von ${info.attempts} …`, 0.94),
    });
    await db.updateRecording(id, (r) => {
      r.summary = sum.summary;
      r.summaryModel = sum.model;
      if (!r.titleManual && sum.title) r.title = sum.title;
      r.status = 'done';
      r.error = null;
      r.speakerRefs = {}; // nur während der Verarbeitung nötig
    });
  } catch (e) {
    console.error('Verarbeitung fehlgeschlagen', e);
    await db.updateRecording(id, (r) => {
      r.status = 'error';
      r.error = { stage, message: e?.message || String(e), network: !!e?.network, at: Date.now() };
    });
  }
}

/** Transkribiert einen Teil. Fällt bei Modellproblemen auf Modelle ohne Sprecher zurück. */
async function transcribePart({ blob, index, mime, settings, refs, speakers, speakerTime, onRetry, failedModes }) {
  const filename = `teil-${index + 1}.${extForMime(mime)}`;
  const steps = [];
  if (settings.diarize) steps.push({ mode: 'diarize', model: settings.diarizeModel });
  steps.push({ mode: 'json', model: settings.transcribeModel });
  steps.push({ mode: 'whisper', model: 'whisper-1' });
  const usable = steps.filter((st) => !failedModes.has(st.mode));
  const list = usable.length ? usable : steps.slice(-1);

  // Bekannte Sprecher (max. 4, nach Sprechzeit) für einheitliche Kennung.
  const known = speakers
    .filter((g) => refs[g])
    .sort((a, b) => (speakerTime[b] || 0) - (speakerTime[a] || 0))
    .slice(0, 4)
    .map((g) => ({ name: KNOWN_PREFIX + g, ref: refs[g] }));

  let lastErr = null;
  for (let s = 0; s < list.length; s++) {
    const step = list[s];
    try {
      const raw = await api.withRetry(() => api.transcribe({
        blob, filename, model: step.model, mode: step.mode,
        knownSpeakers: step.mode === 'diarize' ? known : [],
      }), { onRetry });
      return normalize(raw, step);
    } catch (e) {
      lastErr = e;
      const isLast = s === list.length - 1;
      const modelProblem = e instanceof api.ApiError && (e.opaque || [400, 403, 404, 422].includes(e.status));
      if (!modelProblem || isLast) throw e;
      failedModes.add(step.mode);
      console.warn(`Modell ${step.model} nicht nutzbar, versuche nächstes`, e);
    }
  }
  throw lastErr;
}

function normalize(raw, step) {
  const data = typeof raw === 'string' ? { text: raw } : (raw || {});
  if (step.mode === 'diarize' && Array.isArray(data.segments)) {
    return {
      model: step.model,
      diarized: true,
      duration: Number.isFinite(data.duration) ? data.duration : null,
      segments: data.segments
        .map((s) => ({ start: +s.start || 0, end: +s.end || 0, speakerRaw: s.speaker ?? null, text: String(s.text || '').trim() }))
        .filter((s) => s.text),
    };
  }
  if (Array.isArray(data.segments)) {
    return {
      model: step.model,
      diarized: false,
      duration: Number.isFinite(data.duration) ? data.duration : null,
      segments: data.segments
        .map((s) => ({ start: +s.start || 0, end: +s.end || 0, speakerRaw: null, text: String(s.text || '').trim() }))
        .filter((s) => s.text),
    };
  }
  // Nur Text ohne Zeitmarken: in Absätze teilen, Zeitmarke nur am Anfang.
  const text = String(data.text || '').trim();
  const sentences = text.match(/[^.!?…]+[.!?…]+["'»“”]?\s*|[^.!?…]+$/g) || (text ? [text] : []);
  const paras = [];
  for (let i = 0; i < sentences.length; i += 5) paras.push(sentences.slice(i, i + 5).join('').trim());
  return {
    model: step.model,
    diarized: false,
    duration: Number.isFinite(data.duration) ? data.duration : null,
    segments: paras.filter(Boolean).map((t, i) => ({ start: i === 0 ? 0 : null, end: null, speakerRaw: null, text: t })),
  };
}

async function extractRefs(blob, segments, missing, refs) {
  const audio = await decodeAudio(blob);
  for (const g of missing) {
    const best = segments
      .filter((s) => s.speaker === g && s.end - s.start >= 2.5)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (!best) continue;
    const start = best.start + 0.2;
    const end = Math.min(best.end - 0.2, start + 8);
    if (end - start < 2.1) continue;
    refs[g] = clipToWavDataUrl(audio, start, end);
  }
}

function mergeParts(recParts, parts) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < recParts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    for (const s of p.segments || []) {
      out.push({
        start: s.start == null ? null : offset + s.start,
        end: s.end == null ? null : offset + s.end,
        speaker: s.speaker || null,
        text: s.text,
        part: i,
      });
    }
    offset += p.duration || (recParts[i]?.duration || 0) / 1000;
  }
  return out;
}

/** Absätze für Anzeige und Export: gleicher Sprecher wird zusammengefasst. */
export function buildBlocks(segments) {
  const blocks = [];
  for (const s of segments || []) {
    const last = blocks[blocks.length - 1];
    const maxSpan = s.speaker ? 120 : 60;
    const merge = last && s.start != null && last.start != null &&
      last.speaker === s.speaker && last.part === s.part && s.start - last.start <= maxSpan;
    if (merge) last.text += ' ' + s.text;
    else blocks.push({ speaker: s.speaker, start: s.start, text: s.text, part: s.part });
  }
  return blocks;
}

export function transcriptForModel(rec) {
  const long = (rec.duration || 0) >= 3600000;
  return buildBlocks(rec.segments).map((b) => {
    const ts = b.start != null ? `[${fmtStamp(b.start, long)}] ` : '';
    const who = b.speaker ? `${speakerName(b.speaker, rec.speakerNames)}: ` : '';
    return `${ts}${who}${b.text}`;
  }).join('\n');
}

/** Beim App-Start: abgebrochene Aufnahmen markieren, offene Verarbeitungen fortsetzen. */
export async function recoverOnStartup() {
  const all = await db.getAllRecordings();
  for (const r of all) {
    if (r.status === 'recording') {
      await db.updateRecording(r.id, (x) => {
        x.status = 'interrupted';
        x.duration = x.parts.reduce((s, p) => s + (p?.duration || 0), 0);
      });
    } else if (['queued', 'transcribing', 'summarizing'].includes(r.status) && api.getKey()) {
      enqueue(r.id);
    }
  }
}
