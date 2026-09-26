import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

export const env = process.env;
export const KEYS = (env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
export const MODEL = env.GEMINI_MODEL || 'gemini-2.5-flash';
export const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export const hash = s => crypto.createHash('sha1').update(s).digest('hex');
export const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);
export const text = v => (typeof v === 'string' ? v : v?.['#text'] ?? '');
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
export const strip = h => text(h).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m => ENT[m]).replace(/\s+/g, ' ').trim();
export const city = l => l.name.split(',')[0].trim();
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function getText(url, { timeout = 20000, headers = {} } = {}) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OmniOcular/1.0)', 'Accept-Language': 'en-IN,en;q=0.9', Cookie: 'CONSENT=YES+1', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${r.status} ${new URL(url).hostname}`);
  return (await r.text()).slice(0, 1_500_000);
}

/** Run fn over items with at most n running at once. */
export async function pMap(items, fn, n = 8) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

let keyIdx = 0;
/** Gemini call with key rotation. search=true uses Google Search grounding and returns raw text. */
export async function gemini({ prompt, schema, search = false }) {
  if (!KEYS.length) throw new Error('Missing GEMINI_API_KEYS');
  let last;
  for (let n = 0; n < KEYS.length; n++) {
    const key = KEYS[(keyIdx + n) % KEYS.length];
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } };
    if (search) body.tools = [{ google_search: {} }];
    else { body.generationConfig.responseMimeType = 'application/json'; body.generationConfig.responseSchema = schema; }
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
    if (r.ok) {
      keyIdx = (keyIdx + n + 1) % KEYS.length;
      const j = await r.json();
      const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      return search ? t : JSON.parse(t);
    }
    last = new Error(`gemini ${r.status}`);
    if (![429, 403, 503].includes(r.status)) throw last;
  }
  throw last;
}

export function extractJson(t) {
  const s = String(t || '').replace(/```json|```/g, '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

