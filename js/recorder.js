// Aufnahme mit MediaRecorder.
// - Jede Aufnahme besteht aus Teilen von max. 10 Minuten. Jeder Teil ist eine
//   eigenständige Audiodatei (eigener MediaRecorder) und kann direkt an OpenAI
//   geschickt werden (Limit 25 MB).
// - Innerhalb eines Teils landen alle 4 Sekunden Audiostücke in IndexedDB.
//   Bricht die App ab, ist alles bis dahin gesichert.
// - Wechselt die App in den Hintergrund, wird automatisch pausiert.

import * as db from './db.js';
import { uid, sleep } from './util.js';

const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  }) || '';
}

export function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg')) return 'mp3';
  return 'm4a';
}

export function isRecordingSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
}

export class RecorderError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function micError(e) {
  const name = e?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecorderError('Kein Zugriff auf das Mikrofon. Bitte den Mikrofonzugriff erlauben (iPhone: Einstellungen › Apps › Safari › Mikrofon).', 'denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new RecorderError('Kein Mikrofon gefunden.', 'notfound');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new RecorderError('Das Mikrofon wird gerade von einer anderen App benutzt (z. B. Telefonat).', 'busy');
  }
  return new RecorderError(`Aufnahme konnte nicht gestartet werden: ${e?.message || e}`, 'unknown');
}

export class Recorder extends EventTarget {
  constructor({ partMaxMs = 10 * 60 * 1000, partMaxBytes = 20 * 1024 * 1024, timeslice = 4000 } = {}) {
    super();
    this.partMaxMs = partMaxMs;
    this.partMaxBytes = partMaxBytes;
    this.timeslice = timeslice;

    this.state = 'idle'; // idle | starting | recording | paused | stopping
    this.pauseReason = null; // user | background | interrupted
    this.recId = null;
    this.stream = null;
    this.part = null;
    this.nextPart = 0;
    this.doneMs = 0;
    this.saveChain = Promise.resolve();
    this.wakeLock = null;
    this.micMuted = false;
    this.lastSaveError = null;

    this.ctx = null;
    this.analyser = null;
    this.levelBuf = null;

    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('pagehide', () => this.flush());
  }

  // ---------- Zustand ----------

  get active() { return this.state === 'recording' || this.state === 'paused'; }

  get elapsed() {
    return this.doneMs + (this.part ? this.partActive(this.part) : 0);
  }

  get wakeLockActive() { return !!this.wakeLock; }

  partActive(p) {
    return p.activeMs + (p.runningSince != null ? performance.now() - p.runningSince : 0);
  }

  setState(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, reason: this.pauseReason, ...extra } }));
  }

  // ---------- Start / Stopp ----------

  /** Startet eine neue Aufnahme oder setzt eine unterbrochene fort (continueId). */
  async start({ continueId = null } = {}) {
    if (this.state !== 'idle') return;
    if (!isRecordingSupported()) throw new RecorderError('Dieser Browser kann keine Audioaufnahmen erstellen.', 'unsupported');
    this.setState('starting');
    this.ensureContext(); // noch innerhalb des Tipps, damit iOS den Pegel-Kontext startet
    try {
      await this.openStream();
    } catch (e) {
      this.setState('idle');
      throw micError(e);
    }

    this.mime = pickMimeType();
    try {
      if (continueId) {
        const rec = await db.updateRecording(continueId, (r) => { r.status = 'recording'; r.error = null; });
        if (!rec) throw new Error('Aufnahme nicht gefunden.');
        this.recId = rec.id;
        this.nextPart = rec.parts.length;
        this.doneMs = rec.parts.reduce((s, p) => s + (p.duration || 0), 0);
      } else {
        const rec = {
          id: uid(),
          createdAt: Date.now(),
          endedAt: null,
          duration: 0,
          status: 'recording',
          title: '',
          titleManual: false,
          parts: [],
          transcriptParts: {},
          speakers: [],
          speakerTime: {},
          speakerNames: {},
          speakerRefs: {},
          segments: null,
          summary: null,
          error: null,
        };
        await db.putRecording(rec);
        this.recId = rec.id;
        this.nextPart = 0;
        this.doneMs = 0;
      }
      this.saveChain = Promise.resolve();
      this.startPart();
    } catch (e) {
      this.stopStream();
      this.setState('idle');
      throw new RecorderError(`Aufnahme konnte nicht gestartet werden: ${e.message || e}`, 'start');
    }

    this.pauseReason = null;
    this.setState('recording');
    this.requestWakeLock();
    clearInterval(this.rotateTimer);
    this.rotateTimer = setInterval(() => this.checkRotate(), 500);
    db.requestPersistence();
  }

  /** Beendet die Aufnahme. Gibt die ID zurück (oder null, wenn nichts aufgenommen wurde). */
  async stop() {
    if (!this.active) return null;
    const prevState = this.state;
    this.setState('stopping');
    clearInterval(this.rotateTimer);
    try {
      if (this.part) await this.finishPart(this.part);
      await this.saveChain;
    } catch (e) {
      // Speichern fehlgeschlagen: Zustand zurücksetzen, damit erneut gestoppt werden kann.
      this.setState(prevState === 'recording' ? 'paused' : prevState);
      throw new RecorderError(`Aufnahme konnte nicht gespeichert werden: ${e.message || e}`, 'save');
    }
    this.stopStream();
    this.releaseWakeLock();

    const id = this.recId;
    let rec = await db.getRecording(id);
    const bytes = rec ? rec.parts.reduce((s, p) => s + (p.bytes || 0), 0) : 0;
    if (!rec || bytes === 0) {
      if (rec) await db.deleteRecording(id);
      this.reset();
      this.setState('idle');
      throw new RecorderError('Es wurden keine Audiodaten aufgenommen.', 'empty');
    }
    rec = await db.updateRecording(id, (r) => {
      r.status = 'queued';
      r.endedAt = Date.now();
      r.duration = r.parts.reduce((s, p) => s + (p.duration || 0), 0);
    });
    this.reset();
    this.setState('idle');
    return id;
  }

  reset() {
    this.recId = null;
    this.part = null;
    this.doneMs = 0;
    this.pauseReason = null;
    this.micMuted = false;
  }

  // ---------- Pause ----------

  pause(reason = 'user') {
    if (this.state !== 'recording') return;
    const p = this.part;
    if (p) {
      if (p.runningSince != null) { p.activeMs += performance.now() - p.runningSince; p.runningSince = null; }
      try { if (p.mr.state === 'recording') { p.mr.requestData(); p.mr.pause(); } } catch { /* egal */ }
    }
    this.pauseReason = reason;
    this.setState('paused');
  }

  async resume() {
    if (this.state !== 'paused') return;
    this.ensureContext();
    const track = this.stream?.getAudioTracks()[0];
    const trackOk = track && track.readyState === 'live' && !track.muted;
    try {
      if (trackOk && this.part && this.part.mr.state === 'paused') {
        this.part.mr.resume();
        this.part.runningSince = performance.now();
      } else if (trackOk && !this.part) {
        this.startPart();
      } else {
        // Mikrofon wurde entzogen (Anruf, App-Wechsel): neuen Teil mit neuem Stream beginnen.
        this.setState('starting');
        if (this.part) await this.finishPart(this.part);
        this.stopStream();
        await this.openStream();
        this.startPart();
      }
    } catch (e) {
      this.pauseReason = 'interrupted';
      this.setState('paused');
      throw micError(e);
    }
    this.pauseReason = null;
    this.setState('recording');
    this.requestWakeLock();
  }

  // ---------- Teile ----------

  startPart() {
    const index = this.nextPart++;
    const opts = { audioBitsPerSecond: 64000 };
    if (this.mime) opts.mimeType = this.mime;
    let mr;
    try { mr = new MediaRecorder(this.stream, opts); } catch { mr = new MediaRecorder(this.stream); }
    const part = {
      index, mr, mime: mr.mimeType || this.mime || 'audio/mp4',
      activeMs: 0, runningSince: null, bytes: 0, chunks: 0,
    };
    part.stopped = new Promise((resolve) => mr.addEventListener('stop', resolve, { once: true }));
    mr.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this.saveChunk(part, e.data);
    });
    mr.addEventListener('error', () => this.onInterruption());

    const recId = this.recId;
    this.saveChain = this.saveChain.then(() => db.updateRecording(recId, (r) => {
      r.parts[index] = { index, mime: part.mime, duration: 0, bytes: 0, chunks: 0 };
    }));

    mr.start(this.timeslice);
    part.runningSince = performance.now();
    this.part = part;
  }

  saveChunk(part, blob) {
    const recId = this.recId;
    const seq = part.chunks++;
    part.bytes += blob.size;
    const bytes = part.bytes;
    const duration = Math.round(this.partActive(part));
    this.saveChain = this.saveChain.then(async () => {
      const buf = await blob.arrayBuffer();
      await db.putChunk(recId, part.index, seq, buf);
      await db.updateRecording(recId, (r) => {
        const p = r.parts[part.index] || { index: part.index, mime: part.mime };
        r.parts[part.index] = { ...p, duration: Math.max(p.duration || 0, duration), bytes, chunks: seq + 1 };
        r.duration = r.parts.reduce((s, x) => s + (x?.duration || 0), 0);
      });
    }).catch((err) => {
      this.lastSaveError = err;
      this.dispatchEvent(new CustomEvent('saveerror', { detail: err }));
    });
  }

  async finishPart(part) {
    if (part.runningSince != null) {
      part.activeMs += performance.now() - part.runningSince;
      part.runningSince = null;
    }
    if (part.mr.state !== 'inactive') {
      try { part.mr.stop(); } catch { /* egal */ }
    }
    await Promise.race([part.stopped, sleep(5000)]);
    await this.saveChain;
    const recId = this.recId;
    const duration = Math.round(part.activeMs);
    this.doneMs += part.activeMs;
    await db.updateRecording(recId, (r) => {
      if (r.parts[part.index]) r.parts[part.index].duration = duration;
      r.duration = r.parts.reduce((s, x) => s + (x?.duration || 0), 0);
    });
    if (this.part === part) this.part = null;
  }

  async checkRotate() {
    if (this.state !== 'recording' || !this.part || this.rotating) return;
    const p = this.part;
    if (this.partActive(p) < this.partMaxMs && p.bytes < this.partMaxBytes) return;
    this.rotating = true;
    try {
      await this.finishPart(p);
      // Wurde während des Wechsels pausiert, beginnt der neue Teil erst beim Fortsetzen.
      if (this.state === 'recording') this.startPart();
    } finally {
      this.rotating = false;
    }
  }

  /** Schreibt gepuffertes Audio sofort weg. */
  flush() {
    const p = this.part;
    if (p && p.mr.state === 'recording') {
      try { p.mr.requestData(); } catch { /* egal */ }
    }
  }

  // ---------- Mikrofon & Pegel ----------

  async openStream() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = this.stream.getAudioTracks()[0];
    const stream = this.stream;
    track.addEventListener('ended', () => { if (this.stream === stream) this.onInterruption(); });
    track.addEventListener('mute', () => {
      if (this.stream !== stream) return;
      this.micMuted = true;
      this.flush();
      this.dispatchEvent(new CustomEvent('mute', { detail: true }));
    });
    track.addEventListener('unmute', () => {
      if (this.stream !== stream) return;
      this.micMuted = false;
      this.dispatchEvent(new CustomEvent('mute', { detail: false }));
    });
    this.connectAnalyser();
  }

  stopStream() {
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* egal */ }
    this.stream = null;
    try { this.source?.disconnect(); } catch { /* egal */ }
    this.source = null;
    this.analyser = null;
  }

  ensureContext() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!this.ctx && Ctx) this.ctx = new Ctx();
      this.ctx?.resume?.().catch(() => {});
    } catch { /* Pegelanzeige ist optional */ }
  }

  connectAnalyser() {
    try {
      this.ensureContext();
      if (!this.ctx) return;
      this.source = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      this.source.connect(analyser);
      // Stummer Ausgang, damit Safari den Graphen sicher verarbeitet.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      analyser.connect(mute);
      mute.connect(this.ctx.destination);
      this.analyser = analyser;
      this.levelBuf = new Float32Array(analyser.fftSize);
    } catch {
      this.analyser = null;
    }
  }

  /** Aktueller Pegel 0..1 */
  readLevel() {
    if (!this.analyser || this.state !== 'recording') return 0;
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    const rms = Math.sqrt(sum / this.levelBuf.length);
    const dbfs = 20 * Math.log10(rms + 1e-8);
    return Math.max(0, Math.min(1, (dbfs + 58) / 50));
  }

  // ---------- Unterbrechungen ----------

  onInterruption() {
    this.flush();
    if (this.state === 'recording') this.pause('interrupted');
  }

  onVisibility() {
    if (document.hidden) {
      this.flush();
      if (this.state === 'recording') this.pause('background');
    } else if (this.active) {
      this.requestWakeLock();
    }
  }

  // ---------- Bildschirm anlassen ----------

  async requestWakeLock() {
    if (!('wakeLock' in navigator) || document.hidden || this.wakeLock) {
      this.dispatchEvent(new CustomEvent('wakelock', { detail: !!this.wakeLock }));
      return;
    }
    try {
      const lock = await navigator.wakeLock.request('screen');
      this.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
        this.dispatchEvent(new CustomEvent('wakelock', { detail: false }));
      });
    } catch {
      this.wakeLock = null;
    }
    this.dispatchEvent(new CustomEvent('wakelock', { detail: !!this.wakeLock }));
  }

  releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    lock?.release?.().catch(() => {});
  }
}
