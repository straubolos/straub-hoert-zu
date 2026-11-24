// Audio-Hilfen: Teil dekodieren und kurze Sprecher-Referenzclips als WAV (Data-URL) erzeugen.
// Damit bleiben die Sprecher über mehrere 10-Minuten-Teile hinweg einheitlich.

const TARGET_RATE = 16000;

/** Dekodiert eine Audiodatei zu einem AudioBuffer mit (möglichst) 16 kHz. */
export async function decodeAudio(blob) {
  const data = await blob.arrayBuffer();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let ctx;
  try {
    ctx = new Offline(1, TARGET_RATE, TARGET_RATE);
  } catch {
    ctx = new Offline(1, 44100, 44100);
  }
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/** Ausschnitt [start, end] in Sekunden als 16-kHz-Mono-WAV-Data-URL. */
export function clipToWavDataUrl(buffer, start, end) {
  const sr = buffer.sampleRate;
  const s = Math.max(0, Math.floor(start * sr));
  const e = Math.min(buffer.length, Math.floor(end * sr));
  const n = Math.max(0, e - s);
  const mono = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) mono[i] += data[s + i] / buffer.numberOfChannels;
  }
  const samples = sr === TARGET_RATE ? mono : resample(mono, sr, TARGET_RATE);

  // Lautstärke behutsam angleichen (Spitze auf ca. -3 dB).
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak > 0.01 ? Math.min(8, 0.7 / peak) : 1;

  return 'data:audio/wav;base64,' + toBase64(encodeWav(samples, TARGET_RATE, gain));
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

function encodeWav(samples, rate, gain = 1) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
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
