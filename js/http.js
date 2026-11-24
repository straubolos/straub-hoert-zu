// Gemeinsame HTTP-Hilfen für alle Dienste: Fehler, Zeitlimits, Wiederholungen.

export class ApiError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, info);
  }
}

function germanMessage(service, status, apiMessage) {
  const detail = apiMessage ? ` (${apiMessage})` : '';
  if (status === 401) return `Der ${service}-API-Schlüssel ist ungültig oder wurde widerrufen. Bitte in den Einstellungen prüfen.`;
  if (status === 402) return `Kein Guthaben bei ${service}. Bitte das Konto aufladen oder in den Einstellungen einen anderen Dienst wählen.`;
  if (status === 403) return `${service} verweigert den Zugriff${detail}.`;
  if (status === 404) return `${service}: Modell oder Endpunkt nicht gefunden${detail}.`;
  if (status === 408) return `${service}: Zeitüberschreitung beim Hochladen. Es wird erneut versucht.`;
  if (status === 413) return `Die Audiodatei ist zu groß für ${service}.`;
  if (status === 429) return `${service} meldet zu viele Anfragen. Es wird gleich erneut versucht.`;
  if (status >= 500) return `${service}-Serverfehler (${status}). Es wird erneut versucht.`;
  return `${service}-Fehler ${status}${detail}`;
}

/**
 * Führt eine Anfrage aus und wirft bei Fehlern ApiError.
 * - service: Anzeigename ("OpenAI", "DeepSeek", "Deepgram")
 * - probe: optionale Funktion, die bei "Failed to fetch" den Grund ermittelt
 *   (manche Dienste senden Fehlerantworten ohne CORS-Header).
 */
export async function request(url, {
  service, method = 'POST', headers = {}, body, json, timeout = 120000, probe,
} = {}) {
  const h = { ...headers };
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  let text;
  try {
    res = await fetch(url, { method, headers: h, body, signal: ctrl.signal, cache: 'no-store' });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    if (navigator.onLine === false) {
      throw new ApiError('Keine Internetverbindung.', { status: 0, network: true, retryable: true });
    }
    if (e.name === 'AbortError') {
      throw new ApiError(`Zeitüberschreitung – ${service} hat nicht rechtzeitig geantwortet.`, { status: 0, network: true, retryable: true });
    }
    if (probe) {
      const st = await probe();
      if (st === 401) throw new ApiError(germanMessage(service, 401), { status: 401, retryable: false });
      if (st === 200) {
        throw new ApiError(`${service} hat die Anfrage abgelehnt; der Browser kann den genauen Grund nicht lesen ` +
          '(z. B. Modell nicht verfügbar, Datei ungültig oder kein Guthaben).', { status: 0, opaque: true, retryable: true });
      }
      if (st > 0) throw new ApiError(germanMessage(service, st), { status: st, retryable: st === 429 || st >= 500 });
    }
    throw new ApiError(`Netzwerkfehler – ${service} ist nicht erreichbar.`, { status: 0, network: true, retryable: true });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    // OpenAI/DeepSeek: {error:{message,code,param}} – Deepgram: {err_code, err_msg}
    const err = data?.error && typeof data.error === 'object' ? data.error : {};
    const apiMessage = err.message || data?.err_msg || (typeof data?.error === 'string' ? data.error : '') || '';
    const code = err.code || err.type || data?.err_code || null;
    const quota = res.status === 402 || code === 'insufficient_quota' || /insufficient (balance|quota)/i.test(apiMessage);
    const retryable = !quota && (res.status === 429 || res.status >= 500 || res.status === 408 || res.status === 409);
    throw new ApiError(quota ? germanMessage(service, 402) : germanMessage(service, res.status, apiMessage), {
      status: res.status, code, param: err.param || null, apiMessage, retryable, quota,
    });
  }
  return data ?? text;
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
      // Unlesbare Ablehnungen nur einmal wiederholen, danach greift ein Ersatz.
      const max = e?.opaque ? Math.min(attempts, 2) : attempts;
      const last = i >= max - 1;
      if (!(e instanceof ApiError) || !e.retryable || last) throw e;
      const delay = delays[Math.min(i, delays.length - 1)];
      onRetry?.({ attempt: i + 2, attempts: max, delay, error: e });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Prüft einen 400er-Fehler darauf, ob ein bestimmter Parameter abgelehnt wurde. */
export function rejectsParam(err, name) {
  if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 422)) return false;
  if (err.param && String(err.param).replace(/\[\]$/, '').startsWith(name)) return true;
  return new RegExp(`\\b${name}`, 'i').test(err.apiMessage || '');
}

/** Führt Aufgaben mit begrenzter Parallelität aus (Reihenfolge der Ergebnisse bleibt). */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failed = null;
  const run = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        failed = failed || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (failed) throw failed;
  return results;
}
