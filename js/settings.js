// API-Schlüssel und Einstellungen – nur im localStorage dieses Geräts.

export const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    keyHint: 'sk-…',
    keyPattern: /^sk-[A-Za-z0-9_-]{16,}$/,
    keyUrl: 'platform.deepseek.com › API keys',
  },
  deepgram: {
    name: 'Deepgram',
    keyHint: '40 Zeichen',
    keyPattern: /^[A-Za-z0-9_.-]{20,}$/,
    keyUrl: 'console.deepgram.com › API Keys',
  },
  openai: {
    name: 'OpenAI',
    keyHint: 'sk-…',
    keyPattern: /^sk-[A-Za-z0-9_-]{16,}$/,
    keyUrl: 'platform.openai.com › API keys',
  },
};

/** Transkription: Reihenfolge = Vorrang bei automatischer Wahl. */
export const TRANSCRIBERS = {
  deepgram: { provider: 'deepgram', label: 'Deepgram', detail: 'Mit Sprechererkennung (Nova-3)', speakers: true },
  openai: { provider: 'openai', label: 'OpenAI', detail: 'Mit Sprechererkennung (gpt-4o-transcribe-diarize)', speakers: true },
  deepseek: { provider: 'deepseek', label: 'DeepSeek', detail: 'Ohne Sprechererkennung, sehr günstig', speakers: false },
};

export const SUMMARIZERS = {
  deepseek: { provider: 'deepseek', label: 'DeepSeek', detail: 'deepseek-flash, sehr günstig' },
  openai: { provider: 'openai', label: 'OpenAI', detail: 'gpt-6-luna' },
};

export const DEFAULT_SETTINGS = Object.freeze({
  transcriber: null,
  summarizer: null,
  diarize: true,
  diarizeModel: 'gpt-4o-transcribe-diarize',
  transcribeModel: 'gpt-transcribe',
  summaryModel: 'gpt-6-luna',
  deepseekModel: 'deepseek-flash',
  deepgramModel: 'nova-3',
});

const KEY_PREFIX = 'shz.key.';
const SETTINGS_STORAGE = 'shz.settings';

// Alte Fassung (1.0) speicherte nur einen OpenAI-Schlüssel.
try {
  const legacy = localStorage.getItem('shz.apiKey');
  if (legacy && !localStorage.getItem(`${KEY_PREFIX}openai`)) localStorage.setItem(`${KEY_PREFIX}openai`, legacy);
  if (legacy) localStorage.removeItem('shz.apiKey');
} catch { /* egal */ }

export function getKey(provider) {
  try { return localStorage.getItem(KEY_PREFIX + provider) || ''; } catch { return ''; }
}
export function setKey(provider, key) {
  localStorage.setItem(KEY_PREFIX + provider, String(key).trim());
}
export function clearKey(provider) {
  localStorage.removeItem(KEY_PREFIX + provider);
}
export function hasAnyKey() {
  return Object.keys(PROVIDERS).some((p) => getKey(p));
}
export function maskKey(key) {
  if (!key) return '';
  return key.length > 10 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '…';
}

export function getSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) || '{}'); } catch { stored = {}; }
  const s = { ...DEFAULT_SETTINGS, ...stored };
  for (const k of ['diarizeModel', 'transcribeModel', 'summaryModel', 'deepseekModel', 'deepgramModel']) {
    if (!String(s[k] || '').trim()) s[k] = DEFAULT_SETTINGS[k];
  }
  // Gewählten Dienst nur verwenden, wenn ein Schlüssel vorhanden ist – sonst automatisch wählen.
  const usable = (id, table) => table[id] && getKey(table[id].provider);
  if (!usable(s.transcriber, TRANSCRIBERS)) {
    s.transcriber = Object.keys(TRANSCRIBERS).find((id) => usable(id, TRANSCRIBERS)) || null;
  }
  if (!usable(s.summarizer, SUMMARIZERS)) {
    s.summarizer = Object.keys(SUMMARIZERS).find((id) => usable(id, SUMMARIZERS)) || null;
  }
  return s;
}

export function saveSettings(patch) {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) || '{}'); } catch { stored = {}; }
  const next = { ...stored, ...patch };
  localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(next));
  return getSettings();
}

/** Länge der Aufnahmeteile je nach Transkriptionsdienst. */
export function partLimits(transcriber) {
  if (transcriber === 'deepgram') {
    // Deepgram verarbeitet große Dateien: ganze Aufnahme in einem Stück = einheitliche Sprecher.
    return { partMaxMs: 150 * 60 * 1000, partMaxBytes: 200 * 1024 * 1024 };
  }
  // OpenAI: Upload-Limit 25 MB; DeepSeek: Teil wird zum Zerlegen komplett dekodiert.
  return { partMaxMs: 10 * 60 * 1000, partMaxBytes: 20 * 1024 * 1024 };
}
