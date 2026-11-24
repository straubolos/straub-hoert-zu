// Kleine Hilfsfunktionen: Formatierung, DOM, Text.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uid() {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return 'r' + Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36);
}

const pad = (n) => String(Math.floor(n)).padStart(2, '0');

/** Laufender Timer: 00:00 bzw. 1:02:03 */
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Zeitmarke im Transkript: MM:SS oder HH:MM:SS */
export function fmtStamp(sec, long = false) {
  const total = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return long || h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Dauer für Listen: "45 Sek", "58 Min", "1 Std 30 Min" */
export function fmtDuration(ms) {
  const sec = Math.round((ms || 0) / 1000);
  if (sec < 60) return `${sec} Sek`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} Min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} Std ${m} Min` : `${h} Std`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtWeekdayDate(ts) {
  return new Intl.DateTimeFormat('de-DE', { weekday: 'long' }).format(new Date(ts)) + ', ' + fmtDate(ts);
}

/** JJJJ-MM-TT in lokaler Zeit */
export function isoDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayKey(ts) {
  return isoDate(ts);
}

export function dayLabel(ts) {
  const today = new Date();
  const d = new Date(ts);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
}

/** Umlaute ersetzen, Sonderzeichen entfernen – für Dateinamen. */
export function slugify(text, max = 60) {
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', ẞ: 'SS' };
  let s = String(text || '').replace(/[äöüÄÖÜßẞ]/g, (c) => map[c]);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/-+[^-]*$/, '') || s.slice(0, max);
  return s || 'Aufnahme';
}

/** Für die Suche: klein, ohne Akzente; "ü" und "ue" gelten als gleich, ß = ss. */
export function normalizeSearch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([aou])e/g, '$1');
}

export function speakerName(letter, names) {
  if (!letter) return '';
  return (names && names[letter]) || `Sprecher ${letter}`;
}

export function fmtBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0).replace('.', ',')} MB`;
  return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
