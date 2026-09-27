export const SEV = ['critical', 'high', 'medium', 'low'];
export const sevRank = s => SEV.indexOf(s);

export function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export async function notify(t) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `${t.severity.toUpperCase()}: ${t.location_name || 'Global'}`;
  const opts = { body: t.title, tag: t.id, icon: '/icon.svg' };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) return reg.showNotification(title, opts);
  } catch { /* fall through */ }
  new Notification(title, opts);
}
