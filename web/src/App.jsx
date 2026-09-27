import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { PulseStrip, AlertRow, Locations, Runs, Sources, Viewer } from './components.jsx';
import { SEV, sevRank, notify, ago } from './util.js';

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export default function App() {
  const [tab, setTab] = useState('feed');
  const [threats, setThreats] = useState([]);
  const [locations, setLocations] = useState([]);
  const [runs, setRuns] = useState([]);
  const [sources, setSources] = useState([]);
  const [srcError, setSrcError] = useState('');
  const [viewing, setViewing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [locError, setLocError] = useState('');
  const [toast, setToast] = useState(null);
  const [domain, setDomain] = useState('all');
  const [minSev, setMinSev] = useState('low');
  const [where, setWhere] = useState('all');
  const [perm, setPerm] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const [alertFrom, setAlertFrom] = useState(load('alertFrom', 'high'));

  const fetchAll = useCallback(async () => {
    const since = new Date(Date.now() - 72 * 3600e3).toISOString();
    const [t, l, r, sr] = await Promise.all([
      supabase.from('threats').select('*').gte('published_at', since).order('published_at', { ascending: false }).limit(300),
      supabase.from('locations').select('*').order('name'),
      supabase.from('ingest_runs').select('*').order('started_at', { ascending: false }).limit(10),
      supabase.from('sources').select('*').order('created_at'),
    ]);
    if (t.error || l.error) setError((t.error || l.error).message);
    else setError('');
    setThreats(t.data || []); setLocations(l.data || []); setRuns(r.data || []); setSources(sr.data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const onVis = () => document.visibilityState === 'visible' && fetchAll();
    document.addEventListener('visibilitychange', onVis);
    const timer = setInterval(fetchAll, 120000); // keep the scan status fresh without any button
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(timer); };
  }, [fetchAll]);

  // Live alerts
  useEffect(() => {
    const ch = supabase.channel('threats-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'threats' }, ({ new: t }) => {
        setThreats(prev => (prev.some(p => p.id === t.id) ? prev : [t, ...prev]));
        if (sevRank(t.severity) <= sevRank(alertFrom)) {
          setToast(t);
          notify(t);
          setTimeout(() => setToast(cur => (cur?.id === t.id ? null : cur)), 12000);
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [alertFrom]);

  const visible = useMemo(() => threats.filter(t =>
    (domain === 'all' || t.domain === domain) &&
    sevRank(t.severity) <= sevRank(minSev) &&
    (where === 'all' || t.location_name === where)
  ), [threats, domain, minSev, where]);

  const lastRun = runs.find(r => r.finished_at) || null;
  const stalled = !loading && (!lastRun || Date.now() - new Date(lastRun.finished_at).getTime() > 30 * 60000);

  const counts = useMemo(() => SEV.map(s => threats.filter(t => t.severity === s).length), [threats]);

  const enableNotifications = async () => {
    if (!('Notification' in window)) return;
    setPerm(await Notification.requestPermission());
  };

  const addLocation = async name => {
    setLocError('');
    const { error } = await supabase.from('locations').insert({ name });
    if (error) setLocError(error.code === '23505' ? `${name} is already on the list.` : error.message);
    fetchAll();
  };
  const toggleLocation = async l => { await supabase.from('locations').update({ active: !l.active }).eq('id', l.id); fetchAll(); };
  const addSource = async (input, locationId) => {
    setSrcError('');
    const { error } = await supabase.from('sources').insert({ location_id: locationId, kind: 'unknown', name: input.slice(0, 120), url: input, status: 'pending', origin: 'manual' });
    if (error) setSrcError(error.code === '23505' ? 'That source is already on the list.' : error.message);
    fetchAll();
  };
  const toggleSource = async x => { await supabase.from('sources').update({ status: x.status === 'paused' ? 'active' : 'paused' }).eq('id', x.id); fetchAll(); };
  const removeSource = async x => {
    if (!window.confirm(`Remove ${x.name}?`)) return;
    await supabase.from('sources').delete().eq('id', x.id); fetchAll();
  };
  const removeLocation = async l => {
    if (!window.confirm(`Remove ${l.name}? Past alerts stay in the feed.`)) return;
    await supabase.from('locations').delete().eq('id', l.id); fetchAll();
  };

  return (
    <div className="app">
      <header>
        <h1>OmniOcular</h1>
        <div className="head-actions">
          {perm === 'default' && <button onClick={enableNotifications}>Turn on browser alerts</button>}
          {perm === 'denied' && <span className="hint">Browser alerts are blocked in this browser's site settings.</span>}
          {perm === 'granted' && (
            <label className="inline">Alert me for
              <select value={alertFrom} onChange={e => { setAlertFrom(e.target.value); save('alertFrom', e.target.value); }}>
                <option value="critical">critical only</option>
                <option value="high">high and above</option>
                <option value="medium">medium and above</option>
                <option value="low">everything</option>
              </select>
            </label>
          )}
        </div>
      </header>

      {!loading && (
        <p className={`watch ${stalled ? 'stalled' : 'ok'}`} role="status">
          {stalled
            ? (lastRun
                ? `Scanning has stalled. Last scan finished ${ago(lastRun.finished_at)}. Check the ingest-threats workflow in GitHub Actions.`
                : 'No scan has finished yet. The first scan starts automatically after you push the code to GitHub.')
            : `Watching ${locations.filter(l => l.active).length} location${locations.filter(l => l.active).length === 1 ? '' : 's'} through ${sources.filter(x => x.status === 'active').length} sources. Last scan ${ago(lastRun.finished_at)}, next within 5 minutes.`}
        </p>
      )}

      <PulseStrip threats={threats} />

      <dl className="tally">
        {SEV.map((s, i) => (
          <div key={s} className={`sev-${s}`}><dt>{s}</dt><dd>{counts[i]}</dd></div>
        ))}
      </dl>

      <nav className="tabs" aria-label="Sections">
        {[['feed', 'Alerts'], ['locations', 'Locations'], ['sources', 'Sources'], ['log', 'Collection log']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      {toast && (
        <div className={`toast sev-${toast.severity}`} role="status">
          <button className="toast-open" onClick={() => { setViewing(toast); setToast(null); }}>
            <strong>New {toast.severity} alert, {toast.location_name || 'Global'}</strong><span>{toast.title}</span>
          </button>
          <button onClick={() => setToast(null)} aria-label="Dismiss alert">Dismiss</button>
        </div>
      )}

      <main>
        {error && <p className="error" role="alert">Could not load data: {error}. Check the Supabase URL and anon key in your Vercel environment variables.</p>}

        {tab === 'feed' && (
          <>
            <div className="filters">
              <label>Type
                <select value={domain} onChange={e => setDomain(e.target.value)}>
                  <option value="all">Physical and cyber</option><option value="physical">Physical</option><option value="cyber">Cyber</option>
                </select>
              </label>
              <label>Severity
                <select value={minSev} onChange={e => setMinSev(e.target.value)}>
                  <option value="low">All</option><option value="medium">Medium and above</option>
                  <option value="high">High and above</option><option value="critical">Critical only</option>
                </select>
              </label>
              <label>Place
                <select value={where} onChange={e => setWhere(e.target.value)}>
                  <option value="all">All places</option>
                  <option value="Global">Global</option>
                  {[...new Set(threats.map(t => t.location_name).filter(n => n && n !== 'Global'))].sort().map(n => <option key={n}>{n}</option>)}
                </select>
              </label>
            </div>
            {loading && <p className="empty">Loading alerts…</p>}
            {!loading && visible.length === 0 && (
              <p className="empty">{threats.length === 0
                ? 'No alerts yet. Add locations, then run the ingest-threats workflow in GitHub Actions to collect the first batch.'
                : 'No alerts match these filters. Widen severity or place to see more.'}</p>
            )}
            <ul className="alerts">{visible.map(t => <AlertRow key={t.id} t={t} onOpen={setViewing} />)}</ul>
          </>
        )}

        {tab === 'locations' && (
          <Locations locations={locations} onAdd={addLocation} onToggle={toggleLocation} onRemove={removeLocation} error={locError} />
        )}
        {tab === 'sources' && (
          <Sources sources={sources} locations={locations} onAdd={addSource} onToggle={toggleSource} onRemove={removeSource} error={srcError} />
        )}
        {tab === 'log' && <Runs runs={runs} />}
      </main>
      {viewing && <Viewer key={viewing.id} t={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

