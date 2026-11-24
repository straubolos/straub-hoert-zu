// Audio-Hilfen: Aufnahmeteil zu 16 kHz Mono dekodieren, an Sprechpausen zerlegen,
// WAV-Stücke (für DeepSeek) und kurze Stimmproben (für OpenAI) erzeugen.

export const RATE = 16000;

/** Dekodiert eine Audiodatei zu Mono-Samples mit 16 kHz. */
export async function decodeToMono16k(blob) {
  const data = await blob.arrayBuffer();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let ctx;
  try {
    ctx = new Offline(1, RATE, RATE);
  } catch {
    ctx = new Offline(1, 44100, 44100);
  }
  const buffer = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
  const n = buffer.length;
  let mono;
  if (buffer.numberOfChannels === 1) {
    mono = buffer.getChannelData(0);
  } else {
    mono = new Float32Array(n);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buffer.numberOfChannels;
    }
  }
  const samples = buffer.sampleRate === RATE ? mono : resample(mono, buffer.sampleRate, RATE);
  return { samples, sampleRate: RATE, duration: samples.length / RATE };
}

function resample(input, from, to) {
  const ratio = from / to;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/**
 * Zerlegt in Abschnitte von höchstens maxSec, geschnitten an der leisesten Stelle
 * zwischen minSec und maxSec (damit möglichst kein Wort zerschnitten wird).
 * Gibt Sample-Grenzen zurück: [0, c1, c2, …, length].
 */
export function splitAtPauses(samples, { maxSec = 110, minSec = 75, rate = RATE } = {}) {
  const cuts = [0];
  const total = samples.length;
  const frame = Math.floor(0.3 * rate);
  const hop = Math.floor(0.1 * rate);
  let pos = 0;
  while (total - pos > maxSec * rate) {
    const from = pos + minSec * rate;
    const to = pos + maxSec * rate;
    let best = to;
    let bestE = Infinity;
    for (let s = from; s + frame <= to; s += hop) {
      let e = 0;
      for (let i = s; i < s + frame; i += 4) e += samples[i] * samples[i];
      if (e < bestE) { bestE = e; best = s + (frame >> 1); }
    }
    cuts.push(best);
    pos = best;
  }
  cuts.push(total);
  return cuts;
}

/** WAV (16 Bit, Mono) aus einem Sample-Bereich. */
export function wavBlob(samples, from, to, rate = RATE) {
  return new Blob([encodeWav(samples.subarray(from, to), rate)], { type: 'audio/wav' });
}

/** Stimmprobe [start, end] in Sekunden als WAV-Data-URL (leicht normalisiert). */
export function clipToWavDataUrl(samples, start, end, rate = RATE) {
  const s = Math.max(0, Math.floor(start * rate));
  const e = Math.min(samples.length, Math.floor(end * rate));
  const part = samples.subarray(s, e);
  let peak = 0;
  for (let i = 0; i < part.length; i++) peak = Math.max(peak, Math.abs(part[i]));
  const gain = peak > 0.01 ? Math.min(8, 0.7 / peak) : 1;
  return 'data:audio/wav;base64,' + toBase64(encodeWav(part, rate, gain));
}

export function encodeWav(samples, rate, gain = 1) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // Mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const x = Math.max(-1, Math.min(1, samples[i] * gain));
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function toBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}
