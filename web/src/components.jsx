import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SEV, sevRank, ago } from './util.js';

/* Last 24 hours as 24 bars: height = how many alerts, colour = worst severity in that hour. */
export function PulseStrip({ threats }) {
  const buckets = useMemo(() => {
    const now = Date.now();
    const b = Array.from({ length: 24 }, () => ({ n: 0, worst: 9 }));
    for (const t of threats) {
      const h = Math.floor((now - new Date(t.published_at).getTime()) / 3600e3);
      if (h < 0 || h > 23) continue;
      const x = b[23 - h];
      x.n++;
      x.worst = Math.min(x.worst, sevRank(t.severity));
    }
    return b;
  }, [threats]);
  const max = Math.max(3, ...buckets.map(b => b.n));
  const total = buckets.reduce((a, b) => a + b.n, 0);
  return (
    <figure className="pulse" aria-label={`${total} alerts in the last 24 hours`}>
      <svg viewBox="0 0 240 56" preserveAspectRatio="none" role="img">
        {buckets.map((b, i) => {
          const h = b.n ? 6 + (b.n / max) * 44 : 2;
          return (
            <rect key={i} x={i * 10 + 1} y={56 - h} width="8" height={h}
              className={b.n ? `bar sev-${SEV[b.worst]}` : 'bar empty'}>
              <title>{b.n} alert{b.n === 1 ? '' : 's'}, {23 - i} h ago</title>
            </rect>
          );
        })}
      </svg>
      <figcaption><span>24 h ago</span><span>{total} alerts</span><span>now</span></figcaption>
    </figure>
  );
}

export function AlertRow({ t, onOpen }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`alert sev-${t.severity}`}>
      <div className="rail" aria-hidden="true" />
      <div className="body">
        <div className="meta">
          <strong className="sevlabel">{t.severity}</strong>
          <span>{t.location_name || 'Global'}</span>
          <span>{t.source}</span>
          <time dateTime={t.published_at}>{ago(t.published_at)}</time>
        </div>
        <button className="title" onClick={() => onOpen(t)}>{t.title}</button>
        {t.summary && <p className="summary">{t.summary}</p>}
        <div className="chips">
          {t.video_id && <span className="chip media-chip">video</span>}
          {t.tweet_id && <span className="chip media-chip">X post</span>}
          <span className="chip">{t.domain}</span>
          {t.category && <span className="chip">{t.category}</span>}
          {t.mitre_tactic && <span className="chip">ATT&amp;CK: {t.mitre_tactic}</span>}
          {t.cve && <span className="chip">{t.cve}</span>}
          {t.confidence != null && (
            <button className="link" onClick={() => setOpen(o => !o)} aria-expanded={open}>
              {open ? 'Hide detail' : 'Detail'}
            </button>
          )}
        </div>
        {open && (
          <p className="detail">
            Classified by AI with {Math.round(t.confidence * 100)}% confidence. Source type: {t.source_type}.
            Check the linked report before acting.
          </p>
        )}
      </div>
    </li>
  );
}

export function Locations({ locations, onAdd, onToggle, onRemove, error }) {
  const [name, setName] = useState('');
  return (
    <section aria-labelledby="loc-h">
      <h2 id="loc-h">Watched locations</h2>
      <p className="hint">Use "City, Country" so news searches stay accurate. Anyone with this link can change this list.</p>
      <form className="add" onSubmit={e => { e.preventDefault(); if (name.trim()) { onAdd(name.trim()); setName(''); } }}>
        <label className="sr" htmlFor="loc">Location name</label>
        <input id="loc" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Pune, India" />
        <button type="submit">Add location</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {locations.length === 0 && <p className="empty">No locations yet. Add one above and alerts will start appearing within about 15 minutes.</p>}
      <ul className="locs">
        {locations.map(l => (
          <li key={l.id}>
            <label className="switch">
              <input type="checkbox" checked={l.active} onChange={() => onToggle(l)} />
              <span>{l.name}</span>
            </label>
            <button className="danger" onClick={() => onRemove(l)} aria-label={`Remove ${l.name}`}>Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Runs({ runs }) {
  return (
    <section aria-labelledby="run-h">
      <h2 id="run-h">Collection log</h2>
      <p className="hint">Each row is one scheduled scan. If nothing new appears here for over an hour, check the GitHub Actions tab.</p>
      {runs.length === 0 && <p className="empty">No scans yet. Run the "ingest-threats" workflow in GitHub Actions to start the first one.</p>}
      <ul className="runs">
        {runs.map(r => (
          <li key={r.id}>
            <time dateTime={r.started_at}>{ago(r.started_at)}</time>
            <span>{r.inserted ?? 0} new of {r.candidates ?? 0} checked</span>
            {r.errors && <details><summary>{r.errors.split('\n').length} source problem(s)</summary><pre>{r.errors}</pre></details>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* Opens when a headline is clicked: plays the video, shows the post, or reads the article. */
export function Viewer({ t, onClose }) {
  const ref = useRef(null);
  const [speaking, setSpeaking] = useState(false);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (canSpeak) window.speechSynthesis.cancel(); };
  }, [canSpeak]);

  const toggleSpeak = () => {
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    const u = new SpeechSynthesisUtterance([t.title, t.summary, t.excerpt].filter(Boolean).join('. '));
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
    setSpeaking(true);
  };

  return (
    <dialog ref={ref} className="viewer" onClose={onClose} aria-labelledby="viewer-title">
      <div className={`viewer-head sev-${t.severity}`}>
        <div className="meta">
          <strong className="sevlabel">{t.severity}</strong>
          <span>{t.location_name || 'Global'}</span>
          <span>{t.source}</span>
          <time dateTime={t.published_at}>{ago(t.published_at)}</time>
        </div>
        <button className="close" onClick={() => ref.current.close()} aria-label="Close">Close</button>
      </div>
      <h2 id="viewer-title">{t.title}</h2>

      {t.video_id && (
        <div className="media">
          <iframe src={`https://www.youtube-nocookie.com/embed/${t.video_id}?autoplay=1&rel=0`} title={t.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        </div>
      )}
      {t.tweet_id && (
        <div className="media tweet">
          <iframe src={`https://platform.twitter.com/embed/Tweet.html?id=${t.tweet_id}&theme=light`} title="Post on X" />
        </div>
      )}

      {t.summary && <p className="summary"><strong>Summary:</strong> {t.summary}</p>}
      {t.excerpt && !t.tweet_id && <p className="excerpt">{t.excerpt}</p>}

      <div className="viewer-actions">
        {canSpeak && <button onClick={toggleSpeak}>{speaking ? 'Stop listening' : 'Listen to this'}</button>}
        <a className="btn" href={t.url} target="_blank" rel="noopener noreferrer">
          {t.video_id ? 'Open on YouTube' : t.tweet_id ? 'Open on X' : 'Read the full article'}
        </a>
      </div>
      <p className="hint">The summary is written by AI. The excerpt comes from {t.source || 'the source'}. Check the original before acting.</p>
    </dialog>
  );
}

const KIND = { rss: 'News feed', youtube: 'YouTube', x: 'X account', webpage: 'Web page', unknown: 'Checking' };
const STATUS = { active: 'Watching', paused: 'Paused', failing: 'Not responding', pending: 'Being checked', rejected: 'Could not read' };

export function Sources({ sources, locations, onAdd, onToggle, onRemove, error }) {
  const [input, setInput] = useState('');
  const [loc, setLoc] = useState('');
  const groups = [{ id: null, name: 'All locations' }, ...locations].map(g => ({
    ...g, list: sources.filter(x => (x.location_id || null) === g.id),
  }));
  return (
    <section aria-labelledby="src-h">
      <h2 id="src-h">Sources</h2>
      <p className="hint">Sources for each location are found automatically and re-checked every week. Paste a link or an @handle to add your own.</p>
      <form className="add" onSubmit={e => { e.preventDefault(); if (input.trim()) { onAdd(input.trim(), loc || null); setInput(''); } }}>
        <label className="sr" htmlFor="src-in">Link or @handle</label>
        <input id="src-in" value={input} onChange={e => setInput(e.target.value)} placeholder="Link, YouTube channel or @handle" />
        <label className="sr" htmlFor="src-loc">For location</label>
        <select id="src-loc" value={loc} onChange={e => setLoc(e.target.value)}>
          <option value="">All locations</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button type="submit">Add source</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {groups.map(g => (
        <div key={g.id || 'all'} className="src-group">
          <h3>{g.name} <span className="hint">({g.list.length})</span></h3>
          {g.list.length === 0 && (
            <p className="empty small">{g.id ? `Finding sources for ${g.name}. This usually finishes within 10 minutes of adding the location.` : 'No shared sources.'}</p>
          )}
          <ul className="srcs">
            {g.list.map(x => (
              <li key={x.id} className={`st-${x.status}`}>
                <div>
                  <strong>{x.name}</strong>
                  <div className="meta">
                    <span>{KIND[x.kind] || x.kind}</span>
                    {x.category && <span>{x.category.replace('_', ' ')}</span>}
                    <span>{STATUS[x.status]}</span>
                    <span>{x.origin === 'manual' ? 'added by you' : x.origin === 'seed' ? 'starter list' : 'found automatically'}</span>
                    {x.last_ok_at && <span>read {ago(x.last_ok_at)}</span>}
                  </div>
                  {x.last_error && <p className="error small">{x.last_error}</p>}
                </div>
                <div className="row-actions">
                  {['active', 'paused', 'failing'].includes(x.status) && (
                    <button className="ghost" onClick={() => onToggle(x)}>{x.status === 'paused' ? 'Resume' : 'Pause'}</button>
                  )}
                  <button className="danger" onClick={() => onRemove(x)} aria-label={`Remove ${x.name}`}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

