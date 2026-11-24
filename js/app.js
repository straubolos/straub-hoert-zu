// Straub hört zu – Oberfläche, Navigation und Ablauf.

import * as db from './db.js';
import * as openai from './openai.js';
import * as deepseek from './deepseek.js';
import * as deepgram from './deepgram.js';
import {
  PROVIDERS, TRANSCRIBERS, SUMMARIZERS, DEFAULT_SETTINGS, getKey, setKey, clearKey, hasAnyKey, maskKey,
  getSettings, saveSettings, partLimits,
} from './settings.js';
import * as pipeline from './pipeline.js';
import { Recorder, isRecordingSupported } from './recorder.js';
import {
  displayTitle, buildMarkdown, markdownFile, shareFiles, audioFiles, copyText, summaryMarkdown,
} from './export.js';
import { icons, logoSvg } from './icons.js';
import {
  $, esc, fmtClock, fmtDate, fmtTime, fmtDuration, fmtStamp, fmtWeekdayDate, dayKey, dayLabel,
  normalizeSearch, speakerName, fmtBytes, isStandalone, isIOS,
} from './util.js';

export const APP_VERSION = '1.1.1';

const recorder = new Recorder();
const state = {
  view: null,
  detailId: null,
  detail: null,
  search: '',
  audioUrls: [],
  audioReady: null,
  searchCache: new Map(),
};

let viewRecord, viewPage, tabbar, recbar;

// =====================================================================
// Start
// =====================================================================

async function boot() {
  buildShell();
  registerServiceWorker();

  pipeline.events.addEventListener('progress', (e) => onPipelineProgress(e.detail));
  pipeline.events.addEventListener('change', (e) => onPipelineChange(e.detail.id));
  recorder.addEventListener('state', () => renderRecState());
  recorder.addEventListener('wakelock', () => renderRecState());
  recorder.addEventListener('mute', () => renderRecState());
  recorder.addEventListener('saveerror', (e) => onSaveError(e.detail));

  window.addEventListener('hashchange', route);
  window.addEventListener('resize', sizeCanvas);
  window.addEventListener('online', retryNetworkErrors);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    retryNetworkErrors();
    updateProcessingLock();
  });
  window.addEventListener('beforeunload', (e) => {
    if (recorder.active) { e.preventDefault(); e.returnValue = ''; }
  });

  try {
    await pipeline.recoverOnStartup();
  } catch (e) {
    console.error(e);
  }
  route();
  retryNetworkErrors();
}

function buildShell() {
  const app = $('#app');
  app.innerHTML = `
    <section id="view-record" class="view view-record" hidden>
      <header class="topbar">
        <div class="brand">${logoSvg}<span class="brand-name">Straub hört zu</span></div>
        <a class="icon-btn" href="#/einstellungen" aria-label="Einstellungen">${icons.gear}</a>
      </header>
      <div class="rec-notices" id="rec-notices"></div>
      <div class="rec-stage">
        <div class="rec-status" id="rec-status"><span class="dot"></span><span id="rec-status-text">Bereit</span></div>
        <div class="rec-timer" id="rec-timer">00:00</div>
        <canvas class="rec-wave" id="rec-wave" aria-hidden="true"></canvas>
        <div class="rec-hint" id="rec-hint" hidden>
          <span class="rec-hint-icon">${icons.screen}</span>
          <div><strong>Bildschirm anlassen, App nicht wechseln</strong><span id="rec-hint-sub">Die Aufnahme wird laufend gesichert.</span></div>
        </div>
      </div>
      <div class="rec-controls">
        <div class="ctl-col">
          <button class="ctl-side" id="btn-pause" type="button" aria-label="Pause" hidden>${icons.pause}</button>
          <span class="ctl-label" id="lbl-pause"></span>
        </div>
        <div class="ctl-col">
          <button class="rec-btn" id="btn-rec" type="button" aria-label="Aufnahme starten"><span class="rec-btn-core"></span></button>
          <span class="ctl-label" id="lbl-rec">Aufnehmen</span>
        </div>
        <div class="ctl-col" aria-hidden="true"><span class="ctl-side ctl-ghost"></span><span class="ctl-label"></span></div>
      </div>
    </section>
    <section id="view-page" class="view view-page" hidden></section>
    <a id="recbar" class="recbar" href="#/" hidden>
      <span class="dot"></span><span id="recbar-label">Aufnahme läuft</span><span class="recbar-time" id="recbar-time">00:00</span>
    </a>
    <nav id="tabbar" class="tabbar" aria-label="Hauptnavigation">
      <a href="#/" data-tab="record">${icons.mic}<span>Aufnahme</span></a>
      <a href="#/archiv" data-tab="archive">${icons.list}<span>Archiv</span></a>
    </nav>`;
  viewRecord = $('#view-record');
  viewPage = $('#view-page');
  tabbar = $('#tabbar');
  recbar = $('#recbar');

  $('#btn-rec').addEventListener('click', onRecClick);
  $('#btn-pause').addEventListener('click', onPauseClick);
  $('#rec-notices').addEventListener('click', onNoticeClick);
  viewPage.addEventListener('click', onPageClick);
  sizeCanvas();
  drawWave();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  if (local && !new URLSearchParams(location.search).has('sw')) {
    // Lokal entwickeln ohne Cache (mit ?sw=1 testbar).
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    return;
  }
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch((e) => console.warn('SW', e));
}

// =====================================================================
// Navigation
// =====================================================================

function route() {
  cleanupPage();
  const hash = location.hash || '#/';

  if (!hasAnyKey()) {
    showView('page', null);
    renderSetup();
    return;
  }
  if (hash.startsWith('#/aufnahme/')) {
    showView('page', 'archive');
    renderDetail(decodeURIComponent(hash.slice('#/aufnahme/'.length)));
  } else if (hash.startsWith('#/archiv')) {
    showView('page', 'archive');
    renderArchive();
  } else if (hash.startsWith('#/einstellungen')) {
    showView('page', null);
    renderSettings();
  } else {
    showView('record', 'record');
    renderNotices();
    renderRecState();
    sizeCanvas();
  }
}

function showView(which, tab) {
  state.view = which === 'record' ? 'record' : null;
  viewRecord.hidden = which !== 'record';
  viewPage.hidden = which !== 'page';
  if (which === 'page') window.scrollTo(0, 0);
  tabbar.hidden = !hasAnyKey();
  for (const a of tabbar.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === tab);
  updateRecbar();
}

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

function cleanupPage() {
  for (const u of state.audioUrls) URL.revokeObjectURL(u);
  state.audioUrls = [];
  state.detailId = null;
  state.detail = null;
  state.audioReady = null;
}

// =====================================================================
// Aufnahme
// =====================================================================

async function onRecClick() {
  if (recorder.state === 'idle') {
    if (!isRecordingSupported()) {
      alertDialog('Aufnahme nicht möglich', 'Dieser Browser unterstützt keine Audioaufnahme. Bitte Safari auf dem iPhone verwenden.');
      return;
    }
    waveHistory.length = 0;
    try {
      await startRecording();
    } catch (e) {
      alertDialog('Aufnahme nicht möglich', e.message);
    }
  } else if (recorder.active) {
    try {
      const id = await recorder.stop();
      waveHistory.length = 0;
      if (id) {
        pipeline.enqueue(id);
        go(`#/aufnahme/${id}`);
      }
    } catch (e) {
      alertDialog('Hinweis', e.message);
      renderRecState();
    }
  }
}

/** Startet die Aufnahme mit der zum Transkriptionsdienst passenden Teillänge. */
function startRecording(opts = {}) {
  const limits = partLimits(getSettings().transcriber);
  recorder.partMaxMs = limits.partMaxMs;
  recorder.partMaxBytes = limits.partMaxBytes;
  return recorder.start(opts);
}

async function onPauseClick() {
  if (recorder.state === 'recording') {
    recorder.pause('user');
  } else if (recorder.state === 'paused') {
    try {
      await recorder.resume();
    } catch (e) {
      alertDialog('Fortsetzen nicht möglich', e.message);
    }
  }
}

function onSaveError(err) {
  recorder.pause('interrupted');
  const quota = err?.name === 'QuotaExceededError';
  alertDialog('Speichern fehlgeschlagen', quota
    ? 'Der Speicher auf dem iPhone ist voll. Die Aufnahme wurde pausiert. Bitte stoppen – das bisher Gesicherte bleibt erhalten.'
    : `Ein Audiostück konnte nicht gesichert werden (${err?.message || err}). Die Aufnahme wurde pausiert.`);
}

function renderRecState() {
  const s = recorder.state;
  const status = $('#rec-status');
  const statusText = $('#rec-status-text');
  const btnRec = $('#btn-rec');
  const btnPause = $('#btn-pause');
  const hint = $('#rec-hint');
  const hintSub = $('#rec-hint-sub');

  viewRecord.dataset.state = s;
  status.className = 'rec-status';
  btnRec.disabled = s === 'starting' || s === 'stopping';
  btnPause.disabled = s === 'starting' || s === 'stopping';

  const live = s === 'recording' || s === 'paused' || s === 'stopping' || (s === 'starting' && recorder.recId);
  btnRec.classList.toggle('is-live', !!live);
  btnRec.setAttribute('aria-label', live ? 'Aufnahme beenden' : 'Aufnahme starten');
  $('#lbl-rec').textContent = live ? 'Stopp' : 'Aufnehmen';

  btnPause.hidden = !live;
  $('#lbl-pause').textContent = s === 'paused' ? 'Fortsetzen' : live ? 'Pause' : '';
  btnPause.innerHTML = s === 'paused' ? icons.play : icons.pause;
  btnPause.setAttribute('aria-label', s === 'paused' ? 'Fortsetzen' : 'Pause');

  hint.hidden = !live;
  let sub = 'Die Aufnahme wird laufend gesichert.';
  if (!('wakeLock' in navigator)) {
    sub = 'Automatische Sperre bitte in den iPhone-Einstellungen vorübergehend ausschalten.';
  }

  if (s === 'idle') {
    statusText.textContent = isRecordingSupported() ? 'Bereit' : 'Aufnahme nicht unterstützt';
  } else if (s === 'starting') {
    statusText.textContent = 'Mikrofon wird gestartet …';
  } else if (s === 'recording') {
    status.classList.add('is-recording');
    statusText.textContent = recorder.micMuted ? 'Mikrofon unterbrochen' : 'Aufnahme läuft';
  } else if (s === 'paused') {
    status.classList.add('is-paused');
    const r = recorder.pauseReason;
    statusText.textContent = r === 'background' ? 'Unterbrochen – App war im Hintergrund'
      : r === 'interrupted' ? 'Unterbrochen – Mikrofon nicht verfügbar' : 'Pausiert';
    if (r === 'background' || r === 'interrupted') sub = 'Bisher Aufgenommenes ist gesichert. Tippe „Fortsetzen“ oder „Stopp“.';
  } else if (s === 'stopping') {
    statusText.textContent = 'Wird gespeichert …';
  }
  hintSub.textContent = sub;

  updateRecbar();
  if (recorder.active) startLoop(); else drawWave();
}

function updateRecbar() {
  const show = recorder.active && state.view !== 'record';
  recbar.hidden = !show;
  document.body.classList.toggle('has-recbar', show);
  if (show) {
    $('#recbar-label').textContent = recorder.state === 'paused' ? 'Aufnahme pausiert' : 'Aufnahme läuft';
    recbar.classList.toggle('is-paused', recorder.state === 'paused');
    $('#recbar-time').textContent = fmtClock(recorder.elapsed);
  }
}

// ---------- Pegel & Timer ----------

const waveHistory = [];
let loopRunning = false;
let lastSample = 0;
let lastTimerText = '';

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  const frame = (t) => {
    if (!recorder.active) { loopRunning = false; drawWave(); return; }
    const text = fmtClock(recorder.elapsed);
    if (text !== lastTimerText) {
      lastTimerText = text;
      $('#rec-timer').textContent = text;
      if (!recbar.hidden) $('#recbar-time').textContent = text;
    }
    if (t - lastSample > 55) {
      lastSample = t;
      if (recorder.state === 'recording') {
        waveHistory.push(recorder.readLevel());
        if (waveHistory.length > 400) waveHistory.splice(0, waveHistory.length - 400);
      }
      if (state.view === 'record') drawWave();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function sizeCanvas() {
  const c = $('#rec-wave');
  if (!c) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = c.clientWidth || 320;
  const h = c.clientHeight || 88;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  drawWave();
}

function drawWave() {
  const c = $('#rec-wave');
  if (!c || !c.width) return;
  const ctx = c.getContext('2d');
  const dpr = c.width / (c.clientWidth || 1);
  const W = c.width;
  const H = c.height;
  ctx.clearRect(0, 0, W, H);
  const barW = 3 * dpr;
  const gap = 3 * dpr;
  const count = Math.floor(W / (barW + gap));
  const live = recorder.state === 'recording';
  const start = Math.max(0, waveHistory.length - count);
  const data = waveHistory.slice(start);
  const offset = count - data.length;
  for (let i = 0; i < count; i++) {
    const v = i >= offset ? data[i - offset] : 0;
    const h = Math.max(2 * dpr, v * H * 0.92);
    const x = i * (barW + gap);
    const y = (H - h) / 2;
    const age = i / count;
    ctx.globalAlpha = (live ? 0.2 + 0.8 * age : 0.25 + 0.25 * age) * (i >= offset ? 1 : 0.5);
    ctx.fillStyle = '#F5F5F7';
    roundRect(ctx, x, y, barW, h, barW / 2);
  }
  ctx.globalAlpha = 1;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

// ---------- Hinweise auf dem Startbildschirm ----------

async function renderNotices() {
  const box = $('#rec-notices');
  if (!box) return;
  const recs = await db.getAllRecordings();
  const cards = [];

  if (isIOS() && !isStandalone() && !localStorage.getItem('shz.installHintHidden')) {
    cards.push(`
      <div class="notice">
        <span class="notice-icon">${icons.plusSquare}</span>
        <div class="notice-body"><strong>Als App installieren</strong>
          <span>In Safari auf ${icons.share} „Teilen“ tippen, dann „Zum Home-Bildschirm“.</span></div>
        <button class="icon-btn small" data-act="hide-install" aria-label="Ausblenden">${icons.close}</button>
      </div>`);
  }

  if (!getSettings().summarizer) {
    cards.push(`
      <a class="notice notice-link" href="#/einstellungen">
        <span class="notice-icon">${icons.key}</span>
        <div class="notice-body"><strong>Keine Titel und Zusammenfassungen</strong>
          <span>Dafür fehlt in dieser App ein DeepSeek-Schlüssel. Zum Eintragen tippen.</span></div>
        <span class="chev">${icons.chevron}</span>
      </a>`);
  }

  for (const r of recs) {
    if (r.id === recorder.recId) continue;
    if (r.status === 'interrupted') {
      cards.push(`
        <div class="notice">
          <span class="notice-icon">${icons.alert}</span>
          <div class="notice-body"><strong>Aufnahme unterbrochen</strong>
            <span>${fmtDate(r.createdAt)}, ${fmtTime(r.createdAt)} · ${fmtDuration(r.duration)} gesichert</span>
            <div class="notice-actions">
              <button class="btn btn-small" data-act="continue" data-id="${esc(r.id)}" ${recorder.state !== 'idle' ? 'disabled' : ''}>Weiter aufnehmen</button>
              <button class="btn btn-small btn-primary" data-act="finish" data-id="${esc(r.id)}">Transkribieren</button>
            </div>
          </div>
        </div>`);
    } else if (['queued', 'transcribing', 'summarizing'].includes(r.status) || pipeline.isBusy(r.id)) {
      const p = pipeline.getProgress(r.id);
      cards.push(`
        <a class="notice notice-link" href="#/aufnahme/${esc(r.id)}" data-progress-id="${esc(r.id)}">
          <span class="notice-icon spin-wrap"><span class="spinner"></span></span>
          <div class="notice-body"><strong>${esc(displayTitle(r))} · ${fmtTime(r.createdAt)}</strong>
            <span class="progress-text">${esc(p?.text || 'Wird verarbeitet …')}</span>
            <span class="bar"><span style="width:${Math.round((p?.fraction || 0) * 100)}%"></span></span>
          </div>
          <span class="chev">${icons.chevron}</span>
        </a>`);
    } else if (r.status === 'error' && Date.now() - (r.error?.at || 0) < 3 * 86400000) {
      cards.push(`
        <a class="notice notice-link" href="#/aufnahme/${esc(r.id)}">
          <span class="notice-icon">${icons.alert}</span>
          <div class="notice-body"><strong>${esc(displayTitle(r))} · ${fmtTime(r.createdAt)}</strong>
            <span>${r.error?.stage === 'summary' ? 'Zusammenfassung' : 'Transkription'} fehlgeschlagen – zum Wiederholen tippen</span></div>
          <span class="chev">${icons.chevron}</span>
        </a>`);
    }
    if (cards.length >= 3) break;
  }
  box.innerHTML = cards.join('');
}

async function onNoticeClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  e.preventDefault();
  const id = btn.dataset.id;
  if (btn.dataset.act === 'hide-install') {
    localStorage.setItem('shz.installHintHidden', '1');
    renderNotices();
  } else if (btn.dataset.act === 'continue') {
    waveHistory.length = 0;
    try {
      await startRecording({ continueId: id });
      renderNotices();
    } catch (err) {
      alertDialog('Aufnahme nicht möglich', err.message);
    }
  } else if (btn.dataset.act === 'finish') {
    await finishInterrupted(id);
  }
}

async function finishInterrupted(id) {
  await db.updateRecording(id, (r) => {
    r.status = 'queued';
    r.endedAt = r.endedAt || Date.now();
  });
  pipeline.enqueue(id);
  go(`#/aufnahme/${id}`);
}

// =====================================================================
// Archiv
// =====================================================================

async function renderArchive() {
  viewPage.innerHTML = `
    <header class="page-head">
      <h1>Archiv</h1>
      <a class="icon-btn" href="#/einstellungen" aria-label="Einstellungen">${icons.gear}</a>
    </header>
    <label class="search">
      ${icons.search}
      <input id="search" type="search" placeholder="Titel und Transkripte durchsuchen" value="${esc(state.search)}"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
    </label>
    <div id="archive-list" class="archive-list"><div class="loading"><span class="spinner"></span></div></div>`;
  const input = $('#search');
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { state.search = input.value; renderArchiveList(); }, 120);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  await renderArchiveList();
}

function searchText(r) {
  const key = `${r.status}|${r.title}|${r.segments?.length || 0}|${JSON.stringify(r.speakerNames || {})}`;
  const c = state.searchCache.get(r.id);
  if (c && c.key === key) return c;
  const transcript = (r.segments || []).map((s) => s.text).join(' ');
  const summary = r.summary ? summaryMarkdown(r.summary) : '';
  const entry = {
    key,
    head: normalizeSearch(`${displayTitle(r)} ${summary}`),
    body: normalizeSearch(transcript),
  };
  state.searchCache.set(r.id, entry);
  return entry;
}

function snippetFor(r, query) {
  const qn = normalizeSearch(query);
  for (const s of r.segments || []) {
    if (!normalizeSearch(s.text).includes(qn)) continue;
    const text = s.text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    const pos = idx >= 0 ? idx : 0;
    const from = Math.max(0, pos - 50);
    const to = Math.min(text.length, pos + query.length + 70);
    let html = (from > 0 ? '…' : '') + esc(text.slice(from, pos));
    if (idx >= 0) html += `<mark>${esc(text.slice(pos, pos + query.length))}</mark>` + esc(text.slice(pos + query.length, to));
    else html += esc(text.slice(pos, to));
    if (to < text.length) html += '…';
    return html;
  }
  return '';
}

async function renderArchiveList() {
  const box = $('#archive-list');
  if (!box) return;
  const recs = await db.getAllRecordings();
  const q = state.search.trim();
  const qn = normalizeSearch(q);
  const list = q ? recs.filter((r) => {
    const s = searchText(r);
    return s.head.includes(qn) || s.body.includes(qn);
  }) : recs;

  if (!recs.length) {
    box.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${icons.mic}</div>
        <p><strong>Noch keine Aufnahmen</strong></p>
        <p class="muted">Starte deine erste Aufnahme über den roten Knopf.</p>
        <a class="btn" href="#/">Zur Aufnahme</a>
      </div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="empty"><p><strong>Keine Treffer</strong></p><p class="muted">Für „${esc(q)}“ wurde nichts gefunden.</p></div>`;
    return;
  }

  const groups = new Map();
  for (const r of list) {
    const k = dayKey(r.createdAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  let html = '';
  for (const [, items] of groups) {
    html += `<h2 class="group-head">${esc(dayLabel(items[0].createdAt))}</h2><ul class="rows">`;
    for (const r of items) {
      const snippet = q ? snippetFor(r, q) : '';
      html += `
        <li><a class="row" href="#/aufnahme/${esc(r.id)}">
          <div class="row-main">
            <div class="row-title">${esc(displayTitle(r))}</div>
            <div class="row-meta">${fmtDate(r.createdAt)}, ${fmtTime(r.createdAt)} · ${fmtDuration(r.duration)}</div>
            ${snippet ? `<div class="row-snippet">${snippet}</div>` : ''}
          </div>
          ${statusChip(r)}
          <span class="chev">${icons.chevron}</span>
        </a></li>`;
    }
    html += '</ul>';
  }
  box.innerHTML = html;
}

function statusChip(r) {
  if (r.id === recorder.recId && recorder.active) return '<span class="chip chip-live">Läuft</span>';
  switch (r.status) {
    case 'queued':
    case 'transcribing':
    case 'summarizing':
      return '<span class="chip"><span class="spinner tiny"></span>In Arbeit</span>';
    case 'error': return '<span class="chip chip-warn">Fehler</span>';
    case 'interrupted': return '<span class="chip chip-warn">Unterbrochen</span>';
    case 'recording': return '<span class="chip">Unterbrochen</span>';
    default: return '';
  }
}

// =====================================================================
// Detailansicht
// =====================================================================

async function renderDetail(id, { keepScroll = false } = {}) {
  const scroll = window.scrollY;
  const rec = await db.getRecording(id);
  if (!location.hash.startsWith('#/aufnahme/')) return;
  state.detailId = id;
  state.detail = rec;
  if (!rec) {
    viewPage.innerHTML = `
      ${navBack('#/archiv', 'Archiv')}
      <div class="empty"><p><strong>Aufnahme nicht gefunden</strong></p><p class="muted">Sie wurde vielleicht gelöscht.</p></div>`;
    return;
  }

  const speakers = rec.speakers || [];
  const hasTranscript = !!rec.segments?.length;
  const metaBits = [fmtWeekdayDate(rec.createdAt), `${fmtTime(rec.createdAt)} Uhr`, fmtDuration(rec.duration)];
  if (speakers.length) metaBits.push(`${speakers.length} ${speakers.length === 1 ? 'Sprecher' : 'Sprecher'}`);

  viewPage.innerHTML = `
    ${navBack('#/archiv', 'Archiv')}
    <div class="detail-head">
      <div class="title-row">
        <h1 class="detail-title" id="d-title">${esc(displayTitle(rec))}</h1>
        <button class="icon-btn subtle" data-act="edit-title" aria-label="Titel ändern">${icons.pencil}</button>
      </div>
      <p class="detail-meta">${metaBits.map(esc).join(' · ')}</p>
    </div>
    <div id="d-status">${detailStatus(rec)}</div>
    <div class="actions">
      <button class="btn btn-primary btn-lg" data-act="share" ${hasTranscript ? '' : 'disabled'}>${icons.share}<span>Teilen</span></button>
      <div class="actions-row">
        <button class="btn" data-act="copy" ${hasTranscript ? '' : 'disabled'}>${icons.copy}<span>Text kopieren</span></button>
        <button class="btn" data-act="share-audio" id="btn-share-audio">${icons.audio}<span>Audio teilen</span></button>
      </div>
    </div>
    <section class="card">
      <h2 class="card-title">Zusammenfassung</h2>
      ${summaryHTML(rec)}
    </section>
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Transkript</h2>
        ${speakers.length ? `<button class="link-btn" data-act="rename">${icons.people}<span>Sprecher benennen</span></button>` : ''}
      </div>
      ${transcriptHTML(rec)}
    </section>
    <section class="card">
      <div class="card-head"><h2 class="card-title">Audio</h2><span class="muted small">${rec.parts.length > 1 ? `${rec.parts.length} Teile` : ''}</span></div>
      <div id="d-audio"><button class="btn btn-quiet" data-act="load-audio">${icons.play}<span>Anhören</span></button></div>
    </section>
    <div class="detail-footer">
      ${hasTranscript || rec.status === 'error' ? `<button class="btn btn-quiet" data-act="retranscribe">${icons.refresh}<span>Neu transkribieren</span></button>` : ''}
      <button class="btn btn-quiet" data-act="delete">${icons.trash}<span>Aufnahme löschen</span></button>
    </div>`;
  if (keepScroll) window.scrollTo(0, scroll);
}

function navBack(href, label) {
  return `<header class="navbar"><a class="nav-back" href="${href}">${icons.back}<span>${esc(label)}</span></a></header>`;
}

function detailStatus(rec) {
  const live = rec.id === recorder.recId && recorder.active;
  if (live || rec.status === 'recording') {
    return live
      ? `<a class="status-card" href="#/"><span class="dot live"></span><div><strong>Aufnahme läuft</strong><span>Zur Aufnahme wechseln</span></div></a>`
      : '';
  }
  if (rec.status === 'interrupted') {
    return `
      <div class="status-card">
        <span class="status-icon">${icons.alert}</span>
        <div><strong>Aufnahme wurde unterbrochen</strong><span>Bisher Aufgenommenes (${fmtDuration(rec.duration)}) ist gesichert.</span>
          <div class="notice-actions">
            <button class="btn btn-small" data-act="continue" ${recorder.state !== 'idle' ? 'disabled' : ''}>Weiter aufnehmen</button>
            <button class="btn btn-small btn-primary" data-act="finish">Transkribieren</button>
          </div>
        </div>
      </div>`;
  }
  if (['queued', 'transcribing', 'summarizing'].includes(rec.status) || pipeline.isBusy(rec.id)) {
    const p = pipeline.getProgress(rec.id);
    return `
      <div class="status-card" data-progress-id="${esc(rec.id)}">
        <span class="status-icon"><span class="spinner"></span></span>
        <div class="grow"><strong class="progress-text">${esc(p?.text || 'Wird verarbeitet …')}</strong>
          <span class="bar"><span style="width:${Math.round((p?.fraction || 0) * 100)}%"></span></span>
          <span class="muted small">Bitte die App geöffnet lassen, bis alles fertig ist. Wird sie unterbrochen, geht es beim nächsten Öffnen automatisch weiter.</span>
        </div>
      </div>`;
  }
  if (rec.status === 'error') {
    const summaryOnly = rec.error?.stage === 'summary';
    return `
      <div class="status-card is-error">
        <span class="status-icon">${icons.alert}</span>
        <div class="grow"><strong>${summaryOnly ? 'Zusammenfassung fehlgeschlagen' : 'Transkription fehlgeschlagen'}</strong>
          <span>${esc(rec.error?.message || 'Unbekannter Fehler')}</span>
          <span class="muted small">Das Audio ist gesichert. Bereits fertige Teile werden nicht erneut übertragen.</span>
          <div class="notice-actions">
            <button class="btn btn-small btn-primary" data-act="retry">${icons.refresh}<span>${summaryOnly ? 'Zusammenfassung erneut erstellen' : 'Erneut transkribieren'}</span></button>
          </div>
        </div>
      </div>`;
  }
  return '';
}

function summaryHTML(rec) {
  const s = rec.summary;
  if (!s) {
    const busy = ['queued', 'transcribing', 'summarizing'].includes(rec.status);
    return `<p class="muted">${busy ? 'Wird nach der Transkription automatisch erstellt.' : 'Keine Zusammenfassung vorhanden.'}</p>`;
  }
  const list = (title, items) => (items?.length
    ? `<h3>${title}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const todos = s.todos?.length
    ? `<h3>Offene To-dos</h3><ul class="todos">${s.todos.map((t) => `
        <li><span class="todo-box"></span><div>${esc(t.task)}${t.owner || t.due
          ? `<small>${[t.owner && `zuständig: ${esc(t.owner)}`, t.due && `bis: ${esc(t.due)}`].filter(Boolean).join(' · ')}</small>` : ''}</div></li>`).join('')}</ul>`
    : '';
  return `<div class="summary">
    ${s.overview ? `<p class="overview">${esc(s.overview)}</p>` : ''}
    ${list('Kernpunkte', s.keyPoints)}
    ${list('Vereinbarungen', s.agreements)}
    ${list('Zahlen und Preise', s.numbers)}
    ${list('Termine und Fristen', s.dates)}
    ${todos}
  </div>`;
}

function transcriptHTML(rec) {
  const blocks = pipeline.buildBlocks(rec.segments);
  if (!blocks.length) {
    const busy = ['queued', 'transcribing', 'summarizing'].includes(rec.status);
    return `<p class="muted">${busy ? 'Das Transkript erscheint hier, sobald es fertig ist.' : 'Kein Transkript vorhanden.'}</p>`;
  }
  const long = (rec.duration || 0) >= 3600000;
  const order = rec.speakers || [];
  return `<div class="transcript">${blocks.map((b) => {
    const idx = b.speaker ? order.indexOf(b.speaker) % 6 : -1;
    return `<div class="tblock">
      <div class="tmeta">${b.start != null ? `<span class="tts">${fmtStamp(b.start, long)}</span>` : ''}${b.speaker
        ? `<span class="tspk spk-${idx}">${esc(speakerName(b.speaker, rec.speakerNames))}</span>` : ''}</div>
      <p>${esc(b.text)}</p>
    </div>`;
  }).join('')}</div>`;
}

async function onPageClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  const rec = state.detail;

  switch (act) {
    // ----- Detail -----
    case 'share': return onShare(rec);
    case 'copy': {
      const ok = await copyText(buildMarkdown(rec));
      toast(ok ? 'Text kopiert' : 'Kopieren nicht möglich');
      return;
    }
    case 'share-audio': return onShareAudio(rec, btn);
    case 'load-audio': return loadAudio(rec);
    case 'edit-title': return editTitle(rec);
    case 'rename': return renameSpeakers(rec);
    case 'retry':
      pipeline.enqueue(rec.id);
      return renderDetail(rec.id, { keepScroll: true });
    case 'retranscribe': {
      const ok = await confirmDialog({
        title: 'Neu transkribieren?',
        message: 'Transkript und Zusammenfassung werden mit den aktuellen Einstellungen komplett neu erstellt. Dafür fallen erneut OpenAI-Kosten an.',
        confirm: 'Neu transkribieren',
      });
      if (!ok) return;
      pipeline.enqueue(rec.id, { force: true });
      return renderDetail(rec.id);
    }
    case 'delete': return deleteRec(rec);
    case 'continue': {
      try {
        waveHistory.length = 0;
        await startRecording({ continueId: rec.id });
        go('#/');
      } catch (err) {
        alertDialog('Aufnahme nicht möglich', err.message);
      }
      return;
    }
    case 'finish': return finishInterrupted(rec.id);

    // ----- Einstellungen -----
    case 'key-change': return changeKey(btn.dataset.provider);
    case 'key-test': return testStoredKey(btn.dataset.provider, btn);
    case 'key-delete': return deleteKey(btn.dataset.provider);
    case 'models-reset': {
      saveSettings({
        diarizeModel: DEFAULT_SETTINGS.diarizeModel,
        transcribeModel: DEFAULT_SETTINGS.transcribeModel,
        summaryModel: DEFAULT_SETTINGS.summaryModel,
        deepseekModel: DEFAULT_SETTINGS.deepseekModel,
        deepgramModel: DEFAULT_SETTINGS.deepgramModel,
      });
      toast('Standardmodelle wiederhergestellt');
      return renderSettings();
    }
    default:
  }
}

async function onShare(rec) {
  if (!rec?.segments?.length) return;
  // Wichtig: ohne vorheriges await teilen, damit iOS die Nutzeraktion erkennt.
  try {
    const file = markdownFile(rec);
    const result = await shareFiles([file], { title: displayTitle(rec) });
    if (result === 'downloaded') toast('Datei wurde heruntergeladen');
  } catch (e) {
    alertDialog('Teilen nicht möglich', e?.message || String(e));
  }
}

async function onShareAudio(rec, btn) {
  const label = btn.querySelector('span');
  if (state.audioReady?.id === rec.id) {
    try {
      const r = await shareFiles(state.audioReady.files, { title: displayTitle(rec) });
      if (r === 'downloaded') toast('Audio wurde heruntergeladen');
    } catch (e) {
      alertDialog('Teilen nicht möglich', e?.message || String(e));
    }
    return;
  }
  btn.disabled = true;
  label.textContent = 'Wird vorbereitet …';
  try {
    const files = await audioFiles(rec);
    if (!files.length) throw new Error('Kein Audio vorhanden.');
    state.audioReady = { id: rec.id, files };
    try {
      const r = await shareFiles(files, { title: displayTitle(rec) });
      if (r === 'downloaded') toast('Audio wurde heruntergeladen');
      label.textContent = 'Audio teilen';
    } catch (e) {
      // iOS verlangt evtl. einen frischen Tipp, wenn die Vorbereitung gedauert hat.
      if (e?.name === 'NotAllowedError') label.textContent = 'Audio bereit – tippen';
      else throw e;
    }
  } catch (e) {
    label.textContent = 'Audio teilen';
    alertDialog('Audio teilen nicht möglich', e?.message || String(e));
  } finally {
    btn.disabled = false;
  }
}

async function loadAudio(rec) {
  const box = $('#d-audio');
  box.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  try {
    const files = state.audioReady?.id === rec.id ? state.audioReady.files : await audioFiles(rec);
    if (!files.length) { box.innerHTML = '<p class="muted">Kein Audio vorhanden.</p>'; return; }
    box.innerHTML = files.map((f, i) => {
      const url = URL.createObjectURL(f);
      state.audioUrls.push(url);
      return `<div class="audio-part">${files.length > 1 ? `<span class="muted small">Teil ${i + 1}</span>` : ''}
        <audio controls preload="metadata" src="${url}"></audio></div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<p class="muted">Audio konnte nicht geladen werden: ${esc(e.message)}</p>`;
  }
}

function editTitle(rec) {
  const h1 = $('#d-title');
  if (!h1) return;
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = rec.title || '';
  input.placeholder = 'Titel';
  input.maxLength = 120;
  input.setAttribute('enterkeyhint', 'done');
  input.setAttribute('autocapitalize', 'sentences');
  h1.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.replace(/\s+/g, ' ').trim();
    if (save && value && value !== rec.title) {
      await db.updateRecording(rec.id, (r) => { r.title = value; r.titleManual = true; });
      toast('Titel gespeichert');
    }
    renderDetail(rec.id, { keepScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function renameSpeakers(rec) {
  const speakers = rec.speakers || [];
  const values = await formDialog({
    title: 'Sprecher benennen',
    message: 'Namen erscheinen im Transkript und im Export. Leer lassen für „Sprecher A“ usw.',
    fields: speakers.map((g) => ({
      name: g, label: `Sprecher ${g}`, value: rec.speakerNames?.[g] || '', placeholder: `Sprecher ${g}`,
    })),
    confirm: 'Speichern',
  });
  if (!values) return;
  await db.updateRecording(rec.id, (r) => {
    const oldNames = { ...(r.speakerNames || {}) };
    const newNames = {};
    for (const g of speakers) {
      const v = String(values[g] || '').replace(/\s+/g, ' ').trim();
      if (v) newNames[g] = v;
    }
    // Namen in der Zusammenfassung mitziehen.
    if (r.summary) {
      const swaps = speakers
        .map((g) => [speakerName(g, oldNames), speakerName(g, newNames)])
        .filter(([a, b]) => a !== b);
      if (swaps.length) {
        const fix = (t) => swaps.reduce((acc, [a, b]) =>
          acc.replace(new RegExp(`(^|[^\\p{L}])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'gu'), `$1${b}`), t);
        const s = r.summary;
        s.overview = fix(s.overview || '');
        for (const k of ['keyPoints', 'agreements', 'numbers', 'dates']) s[k] = (s[k] || []).map(fix);
        s.todos = (s.todos || []).map((t) => ({ ...t, task: fix(t.task), owner: t.owner ? fix(t.owner) : t.owner }));
      }
    }
    r.speakerNames = newNames;
  });
  toast('Sprecher gespeichert');
  renderDetail(rec.id, { keepScroll: true });
}

async function deleteRec(rec) {
  if (rec.id === recorder.recId && recorder.active) {
    alertDialog('Nicht möglich', 'Diese Aufnahme läuft noch. Bitte zuerst stoppen.');
    return;
  }
  const ok = await confirmDialog({
    title: 'Aufnahme löschen?',
    message: `„${displayTitle(rec)}“ wird mit Audio, Transkript und Zusammenfassung endgültig gelöscht. Das kann nicht rückgängig gemacht werden.`,
    confirm: 'Löschen',
    destructive: true,
  });
  if (!ok) return;
  await db.deleteRecording(rec.id);
  state.searchCache.delete(rec.id);
  toast('Aufnahme gelöscht');
  go('#/archiv');
}

// ---------- Fortschritt ----------

function onPipelineProgress({ id, text, fraction }) {
  for (const el of document.querySelectorAll(`[data-progress-id="${CSS.escape(id)}"]`)) {
    const t = el.querySelector('.progress-text');
    if (t) t.textContent = text;
    const bar = el.querySelector('.bar > span');
    if (bar && fraction != null) bar.style.width = `${Math.round(fraction * 100)}%`;
  }
}

function onPipelineChange(id) {
  state.searchCache.delete(id);
  updateProcessingLock();
  if (state.detailId === id && location.hash.startsWith('#/aufnahme/')) {
    if (document.activeElement?.classList.contains('title-input')) return;
    renderDetail(id, { keepScroll: true });
  } else if (location.hash.startsWith('#/archiv')) {
    renderArchiveList();
  } else if (state.view === 'record') {
    renderNotices();
  }
}

// Bildschirm auch während der Transkription anlassen (iOS bricht Uploads im Hintergrund ab).
let processingLock = null;
async function updateProcessingLock() {
  const busy = pipeline.isAnyBusy();
  if (busy && !processingLock && !document.hidden && 'wakeLock' in navigator) {
    try {
      processingLock = await navigator.wakeLock.request('screen');
      processingLock.addEventListener('release', () => { processingLock = null; });
    } catch { processingLock = null; }
  } else if (!busy && processingLock) {
    const l = processingLock;
    processingLock = null;
    l.release().catch(() => {});
  }
}

async function retryNetworkErrors() {
  if (!hasAnyKey() || navigator.onLine === false) return;
  const recs = await db.getAllRecordings();
  for (const r of recs) {
    if (r.status === 'error' && r.error?.network && !pipeline.isBusy(r.id)) pipeline.enqueue(r.id);
  }
}

// =====================================================================
// Einrichtung & Einstellungen
// =====================================================================

const KEY_TESTERS = { deepseek: deepseek.testKey, deepgram: deepgram.testKey, openai: openai.testKey };

function keyField(provider, { label, hint }) {
  const p = PROVIDERS[provider];
  return `
    <label class="field">
      <span>${esc(label)}</span>
      <input name="${provider}" class="secret" type="text" autocomplete="off" autocapitalize="off"
        autocorrect="off" spellcheck="false" placeholder="${esc(p.keyHint)}">
      ${hint ? `<small class="field-hint">${hint}</small>` : ''}
    </label>`;
}

function renderSetup() {
  tabbar.hidden = true;
  viewPage.innerHTML = `
    <div class="setup">
      <div class="setup-logo">${logoSvg}</div>
      <h1>Straub hört zu</h1>
      <p class="muted">Gespräche aufnehmen, transkribieren und zusammenfassen.</p>
      <form id="setup-form" class="card setup-card" autocomplete="off">
        ${keyField('deepseek', { label: 'DeepSeek-API-Schlüssel', hint: 'Für Titel, Zusammenfassung und Transkription (ohne Sprecher).' })}
        ${keyField('deepgram', { label: 'Deepgram-API-Schlüssel (optional)', hint: 'Für Sprechererkennung. Deepgram bietet Startguthaben ohne Kreditkarte.' })}
        <details class="setup-more">
          <summary>OpenAI (optional)</summary>
          ${keyField('openai', { label: 'OpenAI-API-Schlüssel', hint: '' })}
        </details>
        <p class="hint-line">${icons.lock}<span>Schlüssel werden nur auf diesem Gerät gespeichert und nur an den jeweiligen Dienst gesendet.</span></p>
        <button class="btn btn-primary btn-lg" type="submit">Speichern</button>
        <p class="form-msg" id="setup-msg" role="alert"></p>
      </form>
      <p class="muted small center">Schlüssel erstellen: platform.deepseek.com › API keys · console.deepgram.com › API Keys</p>
    </div>`;
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const values = Object.fromEntries(new FormData(form).entries());
    const msg = $('#setup-msg');
    const entered = Object.keys(PROVIDERS).filter((p) => String(values[p] || '').trim());
    if (!entered.length) {
      msg.textContent = 'Bitte mindestens einen Schlüssel eingeben (am besten DeepSeek).';
      return;
    }
    const button = form.querySelector('[type=submit]');
    for (const p of entered) {
      const ok = await saveKeyFlow(p, values[p], msg, button);
      if (!ok) return;
      form.elements[p].value = '';
    }
    toast(entered.length > 1 ? 'Schlüssel gespeichert' : `${PROVIDERS[entered[0]].name}-Schlüssel gespeichert`);
    db.requestPersistence();
    go('#/');
  });
}

/** Prüft und speichert einen Schlüssel. Gibt true zurück, wenn gespeichert. */
async function saveKeyFlow(provider, raw, msgEl, button) {
  const p = PROVIDERS[provider];
  const key = String(raw || '').trim();
  msgEl.textContent = '';
  if (!key) { msgEl.textContent = 'Bitte einen Schlüssel eingeben.'; return false; }
  if (!p.keyPattern.test(key)) {
    msgEl.textContent = `Das sieht nicht wie ein ${p.name}-Schlüssel aus.`;
    return false;
  }
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = `${p.name} wird geprüft …`; }
  const res = await KEY_TESTERS[provider](key);
  if (button) { button.disabled = false; button.textContent = label; }
  if (res.ok) { setKey(provider, key); return true; }
  if (res.reason === 'invalid') { msgEl.textContent = `${p.name} lehnt diesen Schlüssel ab. Bitte prüfen.`; return false; }
  // Offline oder anderer Fehler: trotzdem speichern.
  setKey(provider, key);
  toast(res.reason === 'network' ? `Offline – ${p.name}-Schlüssel ungeprüft gespeichert` : `${p.name}: Prüfung nicht möglich (${res.status}) – gespeichert`);
  return true;
}

function choiceList(name, table, current) {
  return Object.entries(table).map(([id, t]) => {
    const has = !!getKey(t.provider);
    return `
      <label class="choice ${has ? '' : 'is-disabled'}">
        <input type="radio" name="${name}" value="${id}" ${id === current ? 'checked' : ''} ${has ? '' : 'disabled'}>
        <span class="choice-dot"></span>
        <span class="choice-text"><strong>${esc(t.label)}</strong><small>${esc(t.detail)}${has ? '' : ' · Schlüssel fehlt'}</small></span>
      </label>`;
  }).join('');
}

async function renderSettings() {
  const s = getSettings();
  const recs = await db.getAllRecordings();
  const keyRows = Object.entries(PROVIDERS).map(([id, p]) => {
    const key = getKey(id);
    return `
      <div class="key-row">
        <div class="key-head">
          <strong>${esc(p.name)}</strong>
          <span class="mono muted">${key ? esc(maskKey(key)) : 'nicht hinterlegt'}</span>
        </div>
        ${id === 'deepseek' && key ? '<div class="key-extra muted small" id="ds-balance">Guthaben wird abgefragt …</div>' : ''}
        <div class="btn-row compact">
          <button class="btn btn-small" data-act="key-change" data-provider="${id}">${icons.key}<span>${key ? 'Ändern' : 'Hinzufügen'}</span></button>
          ${key ? `<button class="btn btn-small" data-act="key-test" data-provider="${id}">${icons.check}<span>Prüfen</span></button>
          <button class="btn btn-small btn-quiet" data-act="key-delete" data-provider="${id}">${icons.trash}<span>Löschen</span></button>` : ''}
        </div>
      </div>`;
  }).join('');

  viewPage.innerHTML = `
    ${navBack('#/', 'Zurück')}
    <h1 class="page-title">Einstellungen</h1>

    <h2 class="group-title">API-Schlüssel</h2>
    <div class="card">
      ${keyRows}
      <p class="hint-line">${icons.lock}<span>Schlüssel liegen nur auf diesem Gerät und gehen nur an den jeweiligen Dienst.</span></p>
    </div>

    <h2 class="group-title">Transkription</h2>
    <div class="card choices" data-setting="transcriber">
      ${choiceList('transcriber', TRANSCRIBERS, s.transcriber)}
      ${s.transcriber === 'openai' ? `
        <label class="toggle-row sub">
          <span><strong>Sprechererkennung</strong><small>Bei OpenAI abschaltbar (dann gpt-transcribe).</small></span>
          <input type="checkbox" class="switch" id="set-diarize" ${s.diarize ? 'checked' : ''}>
        </label>` : ''}
    </div>

    <h2 class="group-title">Titel und Zusammenfassung</h2>
    <div class="card choices" data-setting="summarizer">
      ${choiceList('summarizer', SUMMARIZERS, s.summarizer)}
      ${s.summarizer ? '' : '<p class="muted small">Ohne Dienst wird nur transkribiert; der Titel entsteht aus den ersten Worten.</p>'}
    </div>

    <details class="card adv">
      <summary>Modelle (erweitert)</summary>
      <label class="field"><span>DeepSeek: Zusammenfassung</span>
        <input id="set-deepseekModel" value="${esc(s.deepseekModel)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>Deepgram: Transkription</span>
        <input id="set-deepgramModel" value="${esc(s.deepgramModel)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>OpenAI: Transkription mit Sprechern</span>
        <input id="set-diarizeModel" value="${esc(s.diarizeModel)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>OpenAI: Transkription ohne Sprecher</span>
        <input id="set-transcribeModel" value="${esc(s.transcribeModel)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>OpenAI: Zusammenfassung</span>
        <input id="set-summaryModel" value="${esc(s.summaryModel)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <p class="muted small">Ist ein Modell nicht verfügbar, nutzt die App wenn möglich automatisch einen Ersatz.
        Hinweis: OpenAI stellt „gpt-4o-transcribe-diarize“ laut Doku am 26.02.2027 ein.</p>
      <button class="btn btn-quiet" data-act="models-reset">${icons.refresh}<span>Standard wiederherstellen</span></button>
    </details>

    <h2 class="group-title">Speicher</h2>
    <div class="card">
      <div class="kv"><span>Aufnahmen</span><span>${recs.length}</span></div>
      <div class="kv"><span>Belegt</span><span id="storage-used">…</span></div>
      <div class="kv"><span>Vor Löschen geschützt</span><span id="storage-persist">…</span></div>
    </div>

    <h2 class="group-title">Über</h2>
    <div class="card">
      <div class="kv"><span>Version</span><span>${APP_VERSION}</span></div>
      <p class="muted small">Aufnahmen, Transkripte und Schlüssel bleiben auf diesem iPhone. Audio und Text gehen nur
        zur Verarbeitung an die oben gewählten Dienste.</p>
    </div>`;

  for (const box of viewPage.querySelectorAll('.choices')) {
    box.addEventListener('change', (e) => {
      if (e.target.type !== 'radio') return;
      saveSettings({ [box.dataset.setting]: e.target.value });
      toast(`${e.target.closest('.choice').querySelector('strong').textContent} gewählt`);
      renderSettings();
    });
  }
  $('#set-diarize')?.addEventListener('change', (e) => {
    saveSettings({ diarize: e.target.checked });
    toast(e.target.checked ? 'Sprechererkennung an' : 'Sprechererkennung aus');
  });
  for (const k of ['deepseekModel', 'deepgramModel', 'diarizeModel', 'transcribeModel', 'summaryModel']) {
    $(`#set-${k}`).addEventListener('change', (e) => {
      saveSettings({ [k]: e.target.value.trim() || DEFAULT_SETTINGS[k] });
      toast('Gespeichert');
    });
  }

  if (getKey('deepseek')) {
    deepseek.balance().then((b) => {
      const el = $('#ds-balance');
      if (el) el.textContent = b ? `Guthaben: ${b}` : 'Guthaben nicht abrufbar';
    });
  }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est && $('#storage-used')) $('#storage-used').textContent = fmtBytes(est.usage || 0);
    const persisted = await navigator.storage?.persisted?.();
    if ($('#storage-persist')) $('#storage-persist').textContent = persisted ? 'Ja' : 'Nein';
  } catch {
    if ($('#storage-used')) $('#storage-used').textContent = '–';
  }
}

async function changeKey(provider) {
  const p = PROVIDERS[provider];
  const values = await formDialog({
    title: `${p.name}-Schlüssel ${getKey(provider) ? 'ändern' : 'hinzufügen'}`,
    message: `Erstellen unter ${p.keyUrl}. Der Schlüssel wird geprüft und nur auf diesem Gerät gespeichert.`,
    fields: [{ name: 'key', label: `${p.name}-API-Schlüssel`, placeholder: p.keyHint, secret: true }],
    confirm: 'Speichern',
    validate: async (v, msgEl, button) => saveKeyFlow(provider, v.key, msgEl, button),
  });
  if (values) { toast(`${p.name}-Schlüssel gespeichert`); renderSettings(); }
}

async function testStoredKey(provider, btn) {
  const p = PROVIDERS[provider];
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Prüfe …';
  const res = await KEY_TESTERS[provider](getKey(provider));
  btn.disabled = false;
  label.textContent = 'Prüfen';
  if (res.ok) toast(`${p.name}-Schlüssel funktioniert`);
  else if (res.reason === 'invalid') alertDialog('Schlüssel ungültig', `${p.name} lehnt den gespeicherten Schlüssel ab. Bitte einen neuen eingeben.`);
  else if (res.reason === 'network') alertDialog('Keine Verbindung', `${p.name} ist gerade nicht erreichbar.`);
  else alertDialog('Prüfung fehlgeschlagen', `${p.name} antwortet mit Status ${res.status}.`);
}

async function deleteKey(provider) {
  const p = PROVIDERS[provider];
  const ok = await confirmDialog({
    title: `${p.name}-Schlüssel löschen?`,
    message: 'Der Schlüssel wird von diesem Gerät entfernt. Aufnahmen bleiben erhalten.',
    confirm: 'Löschen',
    destructive: true,
  });
  if (!ok) return;
  clearKey(provider);
  toast('Schlüssel gelöscht');
  if (hasAnyKey()) renderSettings(); else go('#/');
}

// =====================================================================
// Dialoge & Hinweise
// =====================================================================

function openModal(html, { onReady, dismissValue = null } = {}) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal-backdrop"></div><div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    root.appendChild(wrap);
    void wrap.offsetWidth; // Startzustand festschreiben, dann einblenden
    wrap.classList.add('open');
    const close = (value) => {
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 220);
      resolve(value);
    };
    wrap.querySelector('.modal-backdrop').addEventListener('click', () => close(dismissValue));
    onReady?.(wrap.querySelector('.modal'), close);
  });
}

function confirmDialog({ title, message, confirm = 'OK', cancel = 'Abbrechen', destructive = false }) {
  return openModal(`
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    <div class="modal-actions">
      <button class="btn" data-v="0">${esc(cancel)}</button>
      <button class="btn ${destructive ? 'btn-danger' : 'btn-primary'}" data-v="1">${esc(confirm)}</button>
    </div>`, {
    dismissValue: false,
    onReady: (m, close) => m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (b) close(b.dataset.v === '1');
    }),
  });
}

function alertDialog(title, message) {
  return openModal(`
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    <div class="modal-actions single"><button class="btn btn-primary" data-v="1">OK</button></div>`, {
    onReady: (m, close) => m.querySelector('[data-v]').addEventListener('click', () => close(true)),
  });
}

function formDialog({ title, message, fields, confirm = 'OK', validate }) {
  return openModal(`
    <h2>${esc(title)}</h2>
    ${message ? `<p>${esc(message)}</p>` : ''}
    <form class="modal-form" autocomplete="off">
      ${fields.map((f) => `
        <label class="field"><span>${esc(f.label)}</span>
          <input name="${esc(f.name)}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"
            ${f.secret ? 'class="secret" autocapitalize="off" autocorrect="off" spellcheck="false"' : 'autocapitalize="words"'} autocomplete="off">
        </label>`).join('')}
      <p class="form-msg" role="alert"></p>
      <div class="modal-actions">
        <button class="btn" type="button" data-cancel>Abbrechen</button>
        <button class="btn btn-primary" type="submit">${esc(confirm)}</button>
      </div>
    </form>`, {
    onReady: (m, close) => {
      const form = m.querySelector('form');
      const first = form.querySelector('input');
      setTimeout(() => first?.focus(), 250);
      form.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(form).entries());
        if (validate) {
          const ok = await validate(values, form.querySelector('.form-msg'), form.querySelector('[type=submit]'));
          if (!ok) return;
        }
        close(values);
      });
    },
  });
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// Nur lokal zum Testen: interne Objekte zugänglich machen.
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__shz = { recorder, pipeline, db, state, settings: { getSettings, saveSettings, setKey, clearKey } };
}

boot();
