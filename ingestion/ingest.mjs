// OmniOcular ingestion: discover sources -> read them -> filter -> dedupe -> classify (Gemini) -> store -> notify
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import { notifyHighAlerts } from './notify.mjs';
import { env, KEYS, hash, city, sleep, getText, pMap, gemini } from './lib.mjs';
import { fetchSource, parseFeedXml, resolveSource, discoverForLocation, pageExcerpt } from './sources.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = env;
const MAX_CLASSIFY = Number(env.MAX_CLASSIFY || 60);
const MAX_AGE_MS = 48 * 3600e3;
const REDISCOVER_DAYS = Number(env.REDISCOVER_DAYS || 7);
const OFFICIAL = new Set(['government', 'police', 'disaster_authority']);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
if (!KEYS.length) throw new Error('Missing GEMINI_API_KEYS');

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const starter = JSON.parse(fs.readFileSync(new URL('./sources.json', import.meta.url)));

const THREAT_WORDS = /protest|riot|unrest|strike|bandh|curfew|attack|blast|explosion|shoot|terror|kidnap|abduct|theft|robbery|crime|murder|fire|flood|cyclone|earthquake|landslide|heatwave|storm|clash|violence|evacuat|lockdown|hostage|bomb|threat|outage|breach|ransomware|vulnerab|exploit|zero-day|malware|phishing|ddos|cve-|alert|warning|advisory|heavy rain|diversion/i;

const errors = [];
const daysAgo = d => new Date(Date.now() - d * 864e5).toISOString();

// ---- built-in searches that run for every location (queries, not fixed sources) ----
async function fetchGoogleNews(loc) {
  const q = `${loc.name} (protest OR unrest OR attack OR crime OR flood OR earthquake OR strike OR riot OR fire OR curfew OR blast) when:1d`;
  const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`);
  return parseFeedXml(xml, 'Google News').map(i => ({ ...i, sourceType: 'gnews', loc }));
}
async function fetchGdelt(loc) {
  const q = `"${city(loc)}" (protest OR unrest OR attack OR blast OR flood OR earthquake OR riot OR curfew OR strike)`;
  const raw = await getText(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=15&format=json&timespan=24h&sort=datedesc`);
  let j; try { j = JSON.parse(raw); } catch { return []; }
  return (j.articles || []).map(a => {
    const s = a.seendate || '';
    const iso = s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` : null;
    return { title: a.title, url: a.url, published: iso, desc: '', source: a.domain, sourceType: 'gdelt', loc };
  });
}

// ---- classification ----
const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      i: { type: 'INTEGER' }, relevant: { type: 'BOOLEAN' },
      domain: { type: 'STRING', enum: ['physical', 'cyber'] }, category: { type: 'STRING' },
      severity: { type: 'STRING', enum: ['critical', 'high', 'medium', 'low'] }, summary: { type: 'STRING' },
      mitre_tactic: { type: 'STRING', nullable: true }, cve: { type: 'STRING', nullable: true }, confidence: { type: 'NUMBER' },
    },
    required: ['i', 'relevant', 'domain', 'category', 'severity', 'summary'],
  },
};
async function classify(batch) {
  const list = batch.map((c, i) => `${i}. [${c.locationName || 'Global'}] ${c.title} — ${c.desc || ''}`).join('\n');
  const prompt = `You are a threat analyst for a corporate security risk team. For each item decide if it is a genuine, current threat, incident or advisory that a security operations team should act on.
Set relevant=false for opinion pieces, sports, entertainment, routine politics, old news or anything with no security impact.
domain: "physical" (crime, protests, unrest, terrorism, disasters, fires, strikes, infrastructure outages, weather warnings) or "cyber" (vulnerabilities, breaches, malware, ransomware, campaigns).
category: short label such as protest, civil-unrest, terror, crime, natural-disaster, fire, weather-warning, ransomware, data-breach, vulnerability, phishing.
severity: critical = loss of life or active, widespread disruption; high = serious, likely to disrupt operations; medium = notable, monitor; low = minor or background.
summary: one plain sentence, max 30 words, no hype.
mitre_tactic: for cyber items only, the closest MITRE ATT&CK tactic name, else null. cve: CVE id if present, else null.
Return one object per item using its index as "i".

Items:
${list}`;
  return gemini({ prompt, schema: SCHEMA });
}

async function main() {
  const { data: run } = await sb.from('ingest_runs').insert({}).select().single();
  const { data: locs, error: le } = await sb.from('locations').select('*').eq('active', true);
  if (le) throw le;

  // 1. first run: copy the starter list into the sources table
  const { count } = await sb.from('sources').select('id', { count: 'exact', head: true }).is('location_id', null);
  if (!count) await sb.from('sources').insert(starter.starter.map(s => ({ ...s, location_id: null, origin: 'seed', status: 'active' })));

  // 2. links or @handles that people added in the app: check what they are
  const { data: pending } = await sb.from('sources').select('*').eq('status', 'pending').limit(10);
  for (const p of pending || []) {
    try {
      const r = await resolveSource(p.url, null);
      if (r) await sb.from('sources').update({ kind: r.kind, name: r.name, url: r.url, handle: r.handle || null, x_user_id: r.x_user_id || null, status: 'active', last_error: null }).eq('id', p.id);
      else await sb.from('sources').update({ status: 'rejected', last_error: 'Could not read this as a feed, YouTube channel, X account or web page with news links.' }).eq('id', p.id);
    } catch (e) {
      await sb.from('sources').update({ status: 'rejected', last_error: String(e.message).slice(0, 200) }).eq('id', p.id);
    }
  }

  // 3. find sources for new locations, and refresh each location's list weekly
  const due = locs.filter(l => !l.sources_checked_at || l.sources_checked_at < daysAgo(REDISCOVER_DAYS)).slice(0, 2);
  for (const loc of due) {
    try {
      const found = await discoverForLocation(loc);
      const { data: have } = await sb.from('sources').select('url').eq('location_id', loc.id);
      const known = new Set((have || []).map(h => h.url.toLowerCase()));
      const fresh = [];
      for (const f of found) { const k = f.url.toLowerCase(); if (!known.has(k)) { known.add(k); fresh.push(f); } }
      if (fresh.length) {
        await sb.from('sources').insert(fresh.map(f => ({
          location_id: loc.id, kind: f.kind, name: (f.name || f.url).slice(0, 120), url: f.url, handle: f.handle || null,
          x_user_id: f.x_user_id || null, category: f.category || 'news', origin: 'auto', status: 'active',
        })));
      }
      // nothing verified? try again in a day rather than waiting a week
      await sb.from('locations').update({ sources_checked_at: found.length ? new Date().toISOString() : daysAgo(REDISCOVER_DAYS - 1) }).eq('id', loc.id);
      console.log(`sources for ${loc.name}: ${fresh.length} new, ${found.length} verified`);
    } catch (e) { errors.push(`discover ${loc.name}: ${e.message}`); }
  }

  // 4. read everything
  const raw = [];
  const attempt = async (label, fn) => { try { raw.push(...await fn()); } catch (e) { errors.push(`${label}: ${e.message}`); } };
  for (const loc of locs) {
    await attempt(`gnews ${loc.name}`, () => fetchGoogleNews(loc));
    await attempt(`gdelt ${loc.name}`, () => fetchGdelt(loc));
    await sleep(5500); // GDELT asks for about 1 request every 5 seconds
  }
  const { data: srcs } = await sb.from('sources').select('*').in('status', ['active', 'failing']);
  const locById = new Map(locs.map(l => [l.id, l]));
  const retryFailing = new Date().getMinutes() < 5;   // failing sources are retried once an hour
  const todo = (srcs || []).filter(s => (s.location_id == null || locById.has(s.location_id)) && (s.status === 'active' || retryFailing));
  await pMap(todo, async s => {
    const loc = s.location_id ? locById.get(s.location_id) : null;
    try {
      const { items, patch } = await fetchSource(s);
      const official = s.kind === 'x' || OFFICIAL.has(s.category);
      for (const it of items) raw.push({ ...it, sourceType: s.kind, loc, cyber: s.category === 'cyber', official, source: it.source || s.name });
      await sb.from('sources').update({ fail_count: 0, status: 'active', last_ok_at: new Date().toISOString(), last_error: null, ...patch }).eq('id', s.id);
    } catch (e) {
      const fails = (s.fail_count || 0) + 1;
      await sb.from('sources').update({ fail_count: fails, last_error: String(e.message).slice(0, 200), status: fails >= 20 ? 'failing' : s.status }).eq('id', s.id);
    }
  }, 8);

  // 5. filter, match to locations, dedupe
  const now = Date.now();
  const seen = new Set();
  let cands = [];
  for (const it of raw) {
    if (!it.title || !it.url) continue;
    const ts = Date.parse(it.published);
    if (!ts || now - ts > MAX_AGE_MS || ts > now + 3600e3) continue;
    if (!it.official && !THREAT_WORDS.test(`${it.title} ${it.desc}`)) continue;
    let loc = it.loc || null;
    if (!loc) {
      const hay = `${it.title} ${it.desc}`.toLowerCase();
      loc = locs.find(l => hay.includes(city(l).toLowerCase())) || null;
    }
    if (!loc && !it.cyber) continue;   // everything except cyber must relate to a watched place
    const h = hash(it.url);
    if (seen.has(h)) continue;
    seen.add(h);
    cands.push({ ...it, ts, hash: h, locationId: loc?.id || null, locationName: loc?.name || 'Global' });
  }
  if (cands.length) {
    const hashes = cands.map(c => c.hash);
    const existing = new Set();
    for (let i = 0; i < hashes.length; i += 100) {
      const { data } = await sb.from('threats').select('url_hash').in('url_hash', hashes.slice(i, i + 100));
      (data || []).forEach(r => existing.add(r.url_hash));
    }
    cands = cands.filter(c => !existing.has(c.hash)).sort((a, b) => b.ts - a.ts).slice(0, MAX_CLASSIFY);
  }

  // 6. classify
  const rows = [];
  for (let i = 0; i < cands.length; i += 15) {
    const batch = cands.slice(i, i + 15);
    try {
      for (const r of await classify(batch)) {
        const c = batch[r.i];
        if (!c || !r.relevant) continue;
        rows.push({
          url_hash: c.hash, title: c.title.slice(0, 300), url: c.url, source: c.source, source_type: c.sourceType,
          published_at: new Date(c.ts).toISOString(), location_id: c.locationId, location_name: c.locationName,
          domain: r.domain, category: r.category, severity: r.severity, summary: r.summary,
          mitre_tactic: r.mitre_tactic || null, cve: r.cve || null, confidence: r.confidence ?? null,
          video_id: c.videoId || null, tweet_id: c.tweetId || null,
          excerpt: c.desc && c.desc.length >= 80 ? c.desc.slice(0, 600) : null,
        });
      }
    } catch (e) { errors.push(`classify: ${e.message}`); }
  }

  // 7. give articles a short readable excerpt for the in-app reader
  await pMap(rows.filter(r => !r.excerpt && ['rss', 'webpage', 'gdelt'].includes(r.source_type)).slice(0, 15), async r => {
    r.excerpt = await pageExcerpt(r.url);
  }, 5);

  // 8. CISA Known Exploited Vulnerabilities
  if (starter.kev) {
    try {
      const kev = JSON.parse(await getText('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'));
      for (const v of kev.vulnerabilities || []) {
        const ts = Date.parse(v.dateAdded);
        if (!ts || now - ts > 7 * 864e5) continue;
        const url = `https://nvd.nist.gov/vuln/detail/${v.cveID}`;
        rows.push({
          url_hash: hash(url), title: `${v.cveID}: ${v.vendorProject} ${v.product} — ${v.vulnerabilityName}`.slice(0, 300),
          url, source: 'CISA KEV', source_type: 'kev', published_at: new Date(ts).toISOString(),
          location_id: null, location_name: 'Global', domain: 'cyber', category: 'exploited-vulnerability',
          severity: v.knownRansomwareCampaignUse === 'Known' ? 'critical' : 'high',
          summary: (v.shortDescription || '').slice(0, 220), excerpt: (v.shortDescription || '').slice(0, 600),
          mitre_tactic: null, cve: v.cveID, confidence: 1,
        });
      }
    } catch (e) { errors.push(`kev: ${e.message}`); }
  }

  // 9. store, then notify about brand-new rows only
  let inserted = 0;
  if (rows.length) {
    const { data, error } = await sb.from('threats').upsert(rows, { onConflict: 'url_hash', ignoreDuplicates: true }).select('*');
    if (error) errors.push(`insert: ${error.message}`);
    else {
      inserted = data.length;
      const n = await notifyHighAlerts(data);
      errors.push(...n.errors);
      if (n.count) console.log(`notified ${n.count} alert(s) via: ${n.sent.join(', ') || 'no channel configured'}`);
    }
  }

  await sb.from('ingest_runs').update({
    finished_at: new Date().toISOString(), candidates: cands.length, inserted,
    errors: errors.length ? errors.join('\n').slice(0, 2000) : null,
  }).eq('id', run.id);
  console.log(`sources=${todo.length} candidates=${cands.length} inserted=${inserted} errors=${errors.length}`);
  if (errors.length) console.log(errors.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
