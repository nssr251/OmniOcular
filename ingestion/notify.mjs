// Sends high-severity alerts to Gmail/email, Telegram and (optionally) WhatsApp/SMS via Twilio.
// Each channel switches on only if its secrets are set.
import nodemailer from 'nodemailer';

const env = process.env;
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const RANK = ['critical', 'high', 'medium', 'low'];
const MIN = env.NOTIFY_MIN_SEVERITY || 'high';
const APP_URL = env.APP_URL || '';

const line = t => `${t.severity.toUpperCase()} | ${t.location_name || 'Global'} | ${t.domain}\n${t.title}\n${t.summary || ''}\n${t.url}`;
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function sendEmail(alerts) {
  const to = list(env.NOTIFY_EMAIL_TO);
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD || !to.length) return null;
  const tx = nodemailer.createTransport({ service: 'gmail', auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD } });
  const worst = alerts[0].severity.toUpperCase();
  await tx.sendMail({
    from: `OmniOcular <${env.GMAIL_USER}>`, to,
    subject: alerts.length === 1
      ? `[${worst}] ${alerts[0].location_name || 'Global'}: ${alerts[0].title}`.slice(0, 200)
      : `[${worst}] ${alerts.length} new security alerts`,
    text: alerts.map(line).join('\n\n') + (APP_URL ? `\n\nDashboard: ${APP_URL}` : ''),
    html: alerts.map(t => `<p><b>${esc(t.severity.toUpperCase())}</b> · ${esc(t.location_name || 'Global')} · ${esc(t.domain)}<br><a href="${esc(t.url)}">${esc(t.title)}</a><br>${esc(t.summary || '')}</p>`).join('') +
      (APP_URL ? `<p><a href="${esc(APP_URL)}">Open dashboard</a></p>` : ''),
  });
  return 'email';
}

async function sendTelegram(alerts) {
  const chats = list(env.TELEGRAM_CHAT_IDS);
  if (!env.TELEGRAM_BOT_TOKEN || !chats.length) return null;
  const text = alerts.map(line).join('\n\n') + (APP_URL ? `\n\n${APP_URL}` : '');
  for (const chat_id of chats) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    if (!r.ok) throw new Error(`telegram ${r.status}`);
  }
  return 'telegram';
}

// WhatsApp or SMS through Twilio. TWILIO_FROM = "whatsapp:+14155238886" (sandbox) or an SMS number.
async function sendTwilio(alerts) {
  const to = list(env.TWILIO_TO);
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM || !to.length) return null;
  const body = (alerts.length === 1 ? line(alerts[0]) : `${alerts.length} new alerts, worst: ${alerts[0].severity.toUpperCase()}\n` + alerts.slice(0, 3).map(t => `- ${t.location_name}: ${t.title}`).join('\n') + (APP_URL ? `\n${APP_URL}` : '')).slice(0, 1500);
  for (const num of to) {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: env.TWILIO_FROM, To: num, Body: body }),
    });
    if (!r.ok) throw new Error(`twilio ${r.status}`);
  }
  return 'twilio';
}

/** rows = newly inserted threat rows. Returns { sent: [...channels], errors: [...] } */
export async function notifyHighAlerts(rows) {
  const alerts = rows
    .filter(t => RANK.indexOf(t.severity) <= RANK.indexOf(MIN))
    .sort((a, b) => RANK.indexOf(a.severity) - RANK.indexOf(b.severity));
  const out = { sent: [], errors: [], count: alerts.length };
  if (!alerts.length) return out;
  // Individual messages for up to 3 alerts, one digest beyond that, so phones don't get flooded.
  const groups = alerts.length <= 3 ? alerts.map(a => [a]) : [alerts];
  for (const g of groups) {
    for (const [name, fn] of [['email', sendEmail], ['telegram', sendTelegram], ['twilio', sendTwilio]]) {
      try { const ok = await fn(g); if (ok && !out.sent.includes(ok)) out.sent.push(ok); }
      catch (e) { out.errors.push(`notify ${name}: ${e.message}`); }
    }
  }
  return out;
}

