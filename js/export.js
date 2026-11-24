// Export: Markdown-Datei erzeugen und über das iPhone-Teilen-Menü weitergeben.

import * as db from './db.js';
import { buildBlocks } from './pipeline.js';
import { extForMime } from './recorder.js';
import {
  fmtTime, fmtDuration, fmtStamp, isoDate, slugify, speakerName, fmtWeekdayDate,
} from './util.js';

export function displayTitle(rec) {
  return rec.title || (['done', 'error'].includes(rec.status) ? 'Aufnahme ohne Titel' : 'Neue Aufnahme');
}

export function baseFilename(rec) {
  return `${isoDate(rec.createdAt)}_${slugify(displayTitle(rec))}`;
}

export function markdownFilename(rec) {
  return `${baseFilename(rec)}.md`;
}

export function summaryMarkdown(sum, level = '###') {
  if (!sum) return '';
  const out = [];
  if (sum.overview) out.push(sum.overview, '');
  const list = (title, items) => {
    if (!items?.length) return;
    out.push(`${level} ${title}`, '', ...items.map((x) => `- ${x}`), '');
  };
  list('Kernpunkte', sum.keyPoints);
  list('Vereinbarungen', sum.agreements);
  list('Zahlen und Preise', sum.numbers);
  list('Termine und Fristen', sum.dates);
  if (sum.todos?.length) {
    out.push(`${level} Offene To-dos`, '');
    for (const t of sum.todos) {
      const extra = [t.owner && `zuständig: ${t.owner}`, t.due && `bis: ${t.due}`].filter(Boolean).join(', ');
      out.push(`- [ ] ${t.task}${extra ? ` (${extra})` : ''}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

export function buildMarkdown(rec) {
  const long = (rec.duration || 0) >= 3600000;
  const speakers = (rec.speakers || []).map((s) => speakerName(s, rec.speakerNames));
  const lines = [
    `# ${displayTitle(rec)}`,
    '',
    `- **Datum:** ${fmtWeekdayDate(rec.createdAt)}`,
    `- **Uhrzeit:** ${fmtTime(rec.createdAt)} Uhr`,
    `- **Dauer:** ${fmtDuration(rec.duration)}`,
  ];
  if (speakers.length) lines.push(`- **Sprecher:** ${speakers.join(', ')}`);
  lines.push(
    '- **Quelle:** Gesprächsaufnahme, automatisch transkribiert mit „Straub hört zu“. ' +
      'Sprecherzuordnung und Wortlaut können Fehler enthalten.',
    '',
    '## Zusammenfassung',
    '',
    rec.summary ? summaryMarkdown(rec.summary) : '_Keine Zusammenfassung vorhanden._',
    '',
    '## Transkript',
    '',
  );

  const blocks = buildBlocks(rec.segments);
  if (!blocks.length) lines.push('_Kein Transkript vorhanden._');
  for (const b of blocks) {
    const ts = b.start != null ? `[${fmtStamp(b.start, long)}] ` : '';
    const who = b.speaker ? `**${speakerName(b.speaker, rec.speakerNames)}:** ` : '';
    lines.push(`${ts}${who}${b.text}`, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Teilt Dateien über das Teilen-Menü. Gibt 'shared' | 'cancelled' | 'downloaded' zurück. */
export async function shareFiles(files, { title } = {}) {
  const canShareFiles = (list) => {
    try { return !!navigator.canShare && navigator.canShare({ files: list }); } catch { return false; }
  };
  if (navigator.share && canShareFiles(files)) {
    try {
      await navigator.share({ files, title });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  // Fallback: Download
  for (const f of files) downloadFile(f);
  return 'downloaded';
}

export function markdownFile(rec) {
  const text = buildMarkdown(rec);
  const name = markdownFilename(rec);
  const md = new File([text], name, { type: 'text/markdown' });
  try {
    if (navigator.canShare && !navigator.canShare({ files: [md] })) {
      return new File([text], name, { type: 'text/plain' });
    }
  } catch { /* egal */ }
  return md;
}

export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Audio-Teile als Dateien (ein Teil = eine Datei). */
export async function audioFiles(rec) {
  const files = [];
  const base = baseFilename(rec);
  const count = rec.parts.length;
  for (let i = 0; i < count; i++) {
    const p = rec.parts[i];
    if (!p) continue;
    const blob = await db.getPartBlob(rec.id, i, p.mime);
    if (!blob.size) continue;
    const type = String(p.mime || 'audio/mp4').split(';')[0];
    const suffix = count > 1 ? `_Teil-${i + 1}` : '';
    files.push(new File([blob], `${base}${suffix}.${extForMime(p.mime)}`, { type }));
  }
  return files;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

