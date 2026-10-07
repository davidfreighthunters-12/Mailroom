// Vercel serverless function: sends a campaign through Brevo.
// Env vars: BREVO_API_KEY, SENDER_EMAIL, SENDER_NAME, ADMIN_PASSWORD, COMPANY_ADDRESS, UNSUBSCRIBE_EMAIL,
//           TRACK_KEY (also signs the unsubscribe links), KV_REST_API_URL, KV_REST_API_TOKEN
import { createHmac } from 'node:crypto';

async function redis(commands) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Database error ${r.status}`);
  const out = await r.json();
  const bad = out.find(x => x && x.error);
  if (bad) throw new Error(bad.error);
  return out.map(x => x.result);
}

const tokenFor = e => createHmac('sha256', process.env.TRACK_KEY || '').update(e.toLowerCase()).digest('hex').slice(0, 32);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || req.headers['x-admin-password'] !== pw) return res.status(401).json({ error: 'Wrong password' });

  const { subject, html, recipients, tag } = req.body || {};
  if (!subject || !html || !Array.isArray(recipients) || !recipients.length)
    return res.status(400).json({ error: 'Missing subject, html or recipients' });

  // Never email people who unsubscribed, even if they are still in the list
  let list = recipients;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const [members] = await redis([['SMEMBERS', 'mailroom:unsub']]);
      const gone = new Set((members || []).map(x => String(x).toLowerCase()));
      list = recipients.filter(r => !gone.has(String(r.email).toLowerCase()));
    } catch (e) {
      return res.status(500).json({ error: `Could not check the unsubscribe list: ${e.message}` });
    }
  }
  const skipped = recipients.length - list.length;
  if (!list.length) return res.json({ ok: true, sent: 0, skipped });

  const { BREVO_API_KEY, SENDER_EMAIL, SENDER_NAME, COMPANY_ADDRESS, UNSUBSCRIBE_EMAIL, TRACK_KEY } = process.env;
  const base = `https://${req.headers.host}`;
  const mailto = `mailto:${UNSUBSCRIBE_EMAIL || SENDER_EMAIL}?subject=Unsubscribe`;
  // every person gets their own signed unsubscribe link
  const footerFor = x => {
    const link = TRACK_KEY && x.email
      ? `${base}/api/unsubscribe?e=${encodeURIComponent(x.email.toLowerCase())}&t=${tokenFor(x.email)}`
      : mailto;
    return `<hr><p style="font-size:12px;color:#777">${COMPANY_ADDRESS || ''}<br>
  Don't want these emails? <a href="${link}">Unsubscribe</a></p>`;
  };
  const fill = (t, r) => t.replace(/{{\s*name\s*}}/g, r.name || 'there');

  // the tag (like "mr-5") lets Brevo tell us which campaign an open or click belongs to
  const tags = typeof tag === 'string' && /^mr-\d+$/.test(tag) ? { tags: [tag] } : {};

  let sent = 0;
  for (let i = 0; i < list.length; i += 100) { // 100 personalised emails per API call
    const chunk = list.slice(i, i + 100);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: SENDER_NAME || 'Mailroom', email: SENDER_EMAIL },
        replyTo: { name: SENDER_NAME || 'Mailroom', email: SENDER_EMAIL },
        subject: fill(subject, {}),
        htmlContent: html + footerFor({}),
        ...tags,
        messageVersions: chunk.map(x => ({
          to: [{ email: x.email, name: x.name }],
          subject: fill(subject, x),
          htmlContent: fill(html, x) + footerFor(x),
        })),
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: `Brevo error after ${sent} sent: ${err.slice(0, 200)}` });
    }
    sent += chunk.length;
  }
  res.json({ ok: true, sent, skipped });
}
