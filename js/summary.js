// Gemeinsame Vorgaben für Titel und Zusammenfassung (für OpenAI und DeepSeek).

import { ApiError } from './http.js';

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titel', 'ueberblick', 'kernpunkte', 'vereinbarungen', 'zahlen_preise', 'termine', 'todos'],
  properties: {
    titel: { type: 'string', description: 'Kurzer Titel, 3 bis 6 Wörter, worum es grob ging.' },
    ueberblick: { type: 'string', description: '2 bis 4 Sätze Überblick.' },
    kernpunkte: { type: 'array', items: { type: 'string' } },
    vereinbarungen: { type: 'array', items: { type: 'string' } },
    zahlen_preise: { type: 'array', items: { type: 'string' } },
    termine: { type: 'array', items: { type: 'string' } },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['aufgabe', 'zustaendig', 'frist'],
        properties: {
          aufgabe: { type: 'string' },
          zustaendig: { type: ['string', 'null'] },
          frist: { type: ['string', 'null'] },
        },
      },
    },
  },
};

export const SUMMARY_SYSTEM = `Du bekommst das automatisch erstellte Transkript einer deutschsprachigen Gesprächsaufnahme (z. B. Baustellen-, Kunden- oder Planungsgespräch). Die Sprecher sind – falls erkannt – mit Namen oder als "Sprecher A", "Sprecher B" usw. gekennzeichnet; Zeitmarken stehen in eckigen Klammern.

Erstelle auf Deutsch:
1. "titel": 3 bis 6 Wörter, konkret und sachlich, worum es grob ging (z. B. "Rückbau Villa Herber" oder "Angebot Dachsanierung Müller"). Keine Anführungszeichen, kein Datum, kein Punkt am Ende.
2. "ueberblick": 2 bis 4 Sätze, worum es ging und was herauskam.
3. "kernpunkte": die wichtigsten inhaltlichen Punkte.
4. "vereinbarungen": konkrete Absprachen und Entscheidungen.
5. "zahlen_preise": alle genannten Zahlen, Mengen, Maße, Preise und Beträge jeweils mit kurzem Kontext.
6. "termine": alle genannten Termine, Fristen und Zeitpunkte mit Kontext.
7. "todos": offene Aufgaben mit zuständiger Person (falls erkennbar, sonst null) und Frist (falls genannt, sonst null).

Regeln:
- Nur Fakten aus dem Transkript verwenden, nichts erfinden. Wenn es zu einem Punkt nichts gibt, eine leere Liste zurückgeben. Kurze, klare Stichpunkte.
- Das Transkript stammt aus automatischer Spracherkennung und kann Hörfehler enthalten. Zahlen, Beträge und Daten nicht umrechnen oder "reparieren": Klingt eine Angabe unplausibel oder verstümmelt (z. B. "zwölf vierzigtausend Euro"), gib den Wortlaut wieder und hänge "(unsicher)" an.
- Sprecher so bezeichnen wie im Transkript. Sind keine Sprecher gekennzeichnet, ordne Aussagen und Aufgaben nur dann einer Person zu, wenn es sich eindeutig aus dem Inhalt ergibt (z. B. "Ich schicke Ihnen das Angebot" ist ohne Sprecherangabe nicht eindeutig) – sonst "zustaendig": null bzw. neutral formulieren.`;

/** Zusatz für Modelle ohne JSON-Schema (nur json_object): Format als Beispiel. */
export const SUMMARY_JSON_EXAMPLE = `Antworte ausschließlich mit einem gültigen JSON-Objekt (json) genau in diesem Format:
{
  "titel": "Rückbau Villa Herber",
  "ueberblick": "Zwei bis vier Sätze …",
  "kernpunkte": ["…"],
  "vereinbarungen": ["…"],
  "zahlen_preise": ["…"],
  "termine": ["…"],
  "todos": [{"aufgabe": "…", "zustaendig": "Sprecher A", "frist": null}]
}`;

export function parseSummaryContent(content, finishReason) {
  const raw = String(content || '').trim();
  if (!raw) {
    throw new ApiError('Das Modell hat keine Zusammenfassung geliefert.', { status: 200, retryable: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new ApiError(finishReason === 'length'
      ? 'Die Zusammenfassung wurde abgeschnitten (zu lang).'
      : 'Die Antwort des Modells war kein gültiges JSON.', { status: 200, retryable: true });
  }
  return normalizeSummary(parsed);
}

export function normalizeSummary(p) {
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);
  let title = String(p?.titel || '').replace(/^["'„“”«»\s]+|["'„“”«»\s.]+$/g, '').trim();
  if (title.length > 80) title = title.slice(0, 80).replace(/\s+\S*$/, '');
  return {
    title,
    summary: {
      overview: String(p?.ueberblick || '').trim(),
      keyPoints: list(p?.kernpunkte),
      agreements: list(p?.vereinbarungen),
      numbers: list(p?.zahlen_preise),
      dates: list(p?.termine),
      todos: (Array.isArray(p?.todos) ? p.todos : []).map((t) => ({
        task: String(t?.aufgabe || '').trim(),
        owner: t?.zustaendig ? String(t.zustaendig).trim() : null,
        due: t?.frist ? String(t.frist).trim() : null,
      })).filter((t) => t.task),
    },
  };
}
