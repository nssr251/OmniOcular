// Everything about sources: reading them, checking they are real, and finding new ones per location.
import { parser, arr, text, strip, hash, getText, gemini, extractJson, env, pMap } from './lib.mjs';

const RESERVED_X = new Set(['i', 'home', 'search', 'intent', 'share', 'explore', 'hashtag', 'login', 'settings']);

export const isFeed = xml => /<(rss|feed|rdf:RDF)[\s>]/i.test(String(xml).slice(0, 3000));

export function parseFeedXml(xml, name) {
  const doc = parser.parse(xml);
  const out = [];
  for (const it of arr(doc?.rss?.channel?.item)) {
    out.push({ title: strip(it.title), url: text(it.link), published: it.pubDate, desc: strip(it.description).slice(0, 400), source: it.source ? text(it.source) : name });
  }
  for (const e of arr(doc?.feed?.entry)) {
    const links = arr(e.link);
    const href = (links.find(l => !l['@_rel'] || l['@_rel'] === 'alternate') || links[0])?.['@_href'];
    out.push({
      title: strip(e.title), url: href, published: e.published || e.updated,
      desc: strip(e['media:group']?.['media:description'] || e.summary).slice(0, 400),
      source: name, videoId: e['yt:videoId'] || undefined,
    });
  }
  for (const it of arr(doc?.['rdf:RDF']?.item)) {
    out.push({ title: strip(it.title), url: text(it.link), published: it['dc:date'], desc: strip(it.description).slice(0, 400), source: name });
  }
  return out;
}

const feedTitle = xml => {
  const d = parser.parse(xml);
  return strip(d?.rss?.channel?.title || d?.feed?.title || d?.['rdf:RDF']?.channel?.title || '');
};

export function extractLinks(html, base) {
  const out = new Map();
  const re = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = strip(m[2]);
    if (t.length < 25 || t.length > 250) continue;
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, '&'), base).href; } catch { continue; }
    if (!/^https?:/.test(u)) continue;
    if (!out.has(u)) out.set(u, t);
  }
  return [...out].slice(0, 60).map(([url, title]) => ({ url, title }));
}

/** Short readable text from an article page: meta description plus the first paragraphs. */
export async function pageExcerpt(url) {
  try {
    const html = await getText(url, { timeout: 10000 });
    const meta = html.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|description)["']/i);
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => strip(m[1])).filter(p => p.length > 60);
    let out = meta ? strip(meta[1]) : '';
    for (const p of paras) { if (out.length >= 500) break; if (!out.includes(p.slice(0, 40))) out += (out ? ' ' : '') + p; }
    return out.slice(0, 600) || null;
  } catch { return null; }
}

// ---------- readers: each returns { items, patch } where patch updates the source row ----------

async function fetchX(src) {
  const tok = env.X_BEARER_TOKEN;
  if (!tok) throw new Error('No X API token set. Add X_BEARER_TOKEN to read X accounts.');
  const headers = { Authorization: `Bearer ${tok}` };
  const patch = {};
  let uid = src.x_user_id;
  if (!uid) {
    const r = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(src.handle)}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`X lookup ${r.status}`);
    uid = (await r.json()).data?.id;
    if (!uid) throw new Error('X account not found');
    patch.x_user_id = uid;
  }
  // since_id means only posts we have not seen are returned, and only those are billed.
  const q = `max_results=10&exclude=retweets,replies&tweet.fields=created_at${src.since_id ? `&since_id=${src.since_id}` : ''}`;
  const r = await fetch(`https://api.x.com/2/users/${uid}/tweets?${q}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`X posts ${r.status}`);
  const j = await r.json();
  const items = (j.data || []).map(t => {
    const body = t.text.replace(/\s+/g, ' ');
    return { title: body.slice(0, 200), desc: body.slice(0, 600), url: `https://x.com/${src.handle}/status/${t.id}`, published: t.created_at, tweetId: t.id, source: `@${src.handle}` };
  });
  if (j.meta?.newest_id) patch.since_id = j.meta.newest_id;
  return { items, patch };
}

async function fetchWebpage(src) {
  const html = await getText(src.url);
  const links = extractLinks(html, src.url);
  if (links.length < 3) throw new Error('Page has no readable links (it may need JavaScript)');
  const hashes = links.map(l => hash(l.url));
  const prev = Array.isArray(src.seen) ? new Set(src.seen) : null;
  const patch = { seen: [...new Set([...hashes, ...(src.seen || [])])].slice(0, 300) };
  if (!prev) return { items: [], patch };   // first visit: remember what is already there, report nothing
  const now = new Date().toISOString();
  const items = links.filter((l, i) => !prev.has(hashes[i])).map(l => ({ title: l.title, url: l.url, published: now, desc: '', source: src.name }));
  return { items, patch };
}

export async function fetchSource(src) {
  if (src.kind === 'rss' || src.kind === 'youtube') return { items: parseFeedXml(await getText(src.url), src.name), patch: {} };
  if (src.kind === 'x') return fetchX(src);
  if (src.kind === 'webpage') return fetchWebpage(src);
  throw new Error(`Unknown source kind: ${src.kind}`);
}

// ---------- checking that a link or handle is real, and what kind of source it is ----------

export async function resolveSource(input, hintName) {
  let s = String(input || '').trim();
  if (!s) return null;

  const xHandle = s.match(/^@([A-Za-z0-9_]{1,15})$/)?.[1];
  if (xHandle) return verifyX(xHandle);

  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  const host = u.hostname.replace(/^www\./, '');

  if (['x.com', 'twitter.com', 'mobile.twitter.com'].includes(host)) {
    const seg = u.pathname.split('/')[1];
    return seg && !RESERVED_X.has(seg.toLowerCase()) ? verifyX(seg) : null;
  }

  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    let id = u.pathname.match(/^\/channel\/(UC[\w-]{22})/)?.[1];
    if (!id) {
      const html = await getText(u.href);
      id = html.match(/"channelId":"(UC[\w-]{22})"/)?.[1]
        || html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1]
        || html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
    }
    if (!id) return null;
    const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
    const xml = await getText(feed);
    if (!isFeed(xml)) return null;
    return { kind: 'youtube', name: feedTitle(xml) || hintName || 'YouTube channel', url: feed, handle: id };
  }

  const body = await getText(u.href);
  if (isFeed(body)) return { kind: 'rss', name: hintName || feedTitle(body) || host, url: u.href };

  // a normal web page: look for the feed it advertises
  for (const l of body.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)) {
    const href = l[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const fu = new URL(href.replace(/&amp;/g, '&'), u.href).href;
      if (isFeed(await getText(fu))) return { kind: 'rss', name: hintName || host, url: fu };
    } catch { /* try the next one */ }
  }
  if (extractLinks(body, u.href).length >= 5) return { kind: 'webpage', name: hintName || host, url: u.href };
  return null;
}

async function verifyX(handle) {
  const base = { kind: 'x', name: `@${handle}`, url: `https://x.com/${handle}`, handle };
  const tok = env.X_BEARER_TOKEN;
  if (!tok) return base;                       // cannot verify without a token; failures show up later in the log
  const r = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const id = (await r.json()).data?.id;
  return id ? { ...base, x_user_id: id } : null;
}

// ---------- finding sources for a location ----------

export async function discoverForLocation(loc) {
  const prompt = `A corporate security team needs to keep watch on ${loc.name}. Use web search to find real, currently active public sources for news and official notices about this place.

Look for:
- local and national newspapers and news portals (give the RSS feed URL if you saw one, otherwise the site or section URL)
- TV news channels that have a YouTube channel covering this place
- official government bodies: state or city government press releases, police, municipal corporation, disaster management authority, weather department (website press-release pages and their official X accounts)

Return ONLY a JSON array of up to 15 objects, no other text. Each object:
{"name": string, "type": "newspaper" | "news_portal" | "tv_news" | "government" | "police" | "disaster_authority", "url": string or null, "youtube_channel_url": string or null, "x_handle": string or null}

Only include addresses you actually saw in search results. Never guess a URL or a handle.`;
  const list = extractJson(await gemini({ prompt, search: true })) || [];
  const found = [];
  await pMap(list.slice(0, 20), async c => {
    const inputs = [c.x_handle && `@${String(c.x_handle).replace(/^@/, '')}`, c.youtube_channel_url, c.url].filter(Boolean);
    for (const inp of inputs) {
      try {
        const r = await resolveSource(inp, c.name);
        if (r) found.push({ ...r, category: c.type || 'news' });
      } catch { /* not reachable, so it is not added */ }
    }
  }, 4);
  return found;
}

