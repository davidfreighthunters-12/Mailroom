// Vercel serverless function: one-click unsubscribe.
// Each email carries a personal link signed with TRACK_KEY, so nobody can unsubscribe other people.
// Env vars: TRACK_KEY, ADMIN_PASSWORD, KV_REST_API_URL, KV_REST_API_TOKEN
import { createHmac, timingSafeEqual } from 'node:crypto';

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

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tokenFor = e => createHmac('sha256', process.env.TRACK_KEY || '').update(e.toLowerCase()).digest('hex').slice(0, 32);
const valid = (e, t) => {
  if (!process.env.TRACK_KEY || !e || !t) return false;
  const a = Buffer.from(tokenFor(e)), b = Buffer.from(String(t));
  return a.length === b.length && timingSafeEqual(a, b);
};

function html(res, code, body) {
  res.status(code);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
<style>body{font:16px/1.5 system-ui,Arial,sans-serif;background:#f2f5f7;color:#17212b;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;border:1px solid #dbe2e8;border-radius:10px;padding:28px;max-width:420px;margin:16px;text-align:center}
button{background:#1c6e8c;color:#fff;border:0;border-radius:6px;padding:10px 22px;font:inherit;font-weight:600;cursor:pointer}</style></head>
<body><div class="c">${body}</div></body></html>`);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)
    return html(res, 500, '<h2>Something went wrong</h2><p>Please try again later.</p>');

  try {
    // The Mailroom page asks which addresses have unsubscribed (needs the admin password)
    if (req.method === 'GET' && req.query.list) {
      const pw = process.env.ADMIN_PASSWORD;
      if (!pw || req.headers['x-admin-password'] !== pw) return res.status(401).json({ error: 'Wrong password' });
      const [members] = await redis([['SMEMBERS', 'mailroom:unsub']]);
      return res.json({ emails: members || [] });
    }

    const email = String(req.query.e || '').trim().toLowerCase();
    const t = String(req.query.t || '');
    if (!valid(email, t))
      return html(res, 400, '<h2>This link is not valid</h2><p>Please use the unsubscribe link from your most recent email.</p>');

    // The unsubscribe itself. Mail apps with one-click unsubscribe also use POST.
    if (req.method === 'POST') {
      await redis([['SADD', 'mailroom:unsub', email]]);
      return html(res, 200, `<h2>You are unsubscribed</h2><p>${esc(email)} will not receive more emails from us.</p>`);
    }

    // Opening the link only shows a button, so email scanners that pre-open links do not unsubscribe anyone
    if (req.method === 'GET')
      return html(res, 200, `<h2>Unsubscribe</h2><p>Stop sending emails to <b>${esc(email)}</b>?</p>
<form method="POST" action="/api/unsubscribe?e=${encodeURIComponent(email)}&t=${encodeURIComponent(t)}"><button type="submit">Yes, unsubscribe me</button></form>`);

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return html(res, 500, '<h2>Something went wrong</h2><p>Please try again later.</p>');
  }
}
