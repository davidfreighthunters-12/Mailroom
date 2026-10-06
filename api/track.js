// Vercel serverless function: receives Brevo "opened" and "click" notifications and reports the counts.
// Env vars: TRACK_KEY (a secret you choose), ADMIN_PASSWORD, KV_REST_API_URL, KV_REST_API_TOKEN

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)
    return res.status(500).json({ error: 'The database is not connected to this Vercel project yet' });

  try {
    // 1) Brevo calls this (POST) every time someone opens or clicks
    if (req.method === 'POST') {
      const key = process.env.TRACK_KEY;
      if (!key || req.query.key !== key) return res.status(401).json({ error: 'Bad key' });
      const b = req.body || {};
      const ev = String(b.event || '').toLowerCase();
      const kind = ev.includes('open') ? 'o' : ev.includes('click') ? 'c' : null;
      const m = /mr-(\d+)/.exec(JSON.stringify(b.tag ?? b.tags ?? ''));
      const who = String(b['message-id'] || b.email || '');
      if (!kind || !m || !who) return res.json({ ignored: true });
      // a set holds each message once, so repeat opens/clicks count as one person
      await redis([['SADD', `mailroom:${kind}:${m[1]}`, who]]);
      return res.json({ ok: true });
    }

    // 2) The Mailroom page asks for the counts (GET)
    if (req.method === 'GET') {
      const pw = process.env.ADMIN_PASSWORD;
      if (!pw || req.headers['x-admin-password'] !== pw) return res.status(401).json({ error: 'Wrong password' });
      const ids = String(req.query.ids || '').split(',').filter(x => /^\d+$/.test(x)).slice(0, 200);
      if (!ids.length) return res.json({});
      const out = await redis(ids.flatMap(id => [['SCARD', `mailroom:o:${id}`], ['SCARD', `mailroom:c:${id}`]]));
      const stats = {};
      ids.forEach((id, i) => { stats[id] = { opens: out[2 * i] || 0, clicks: out[2 * i + 1] || 0 }; });
      return res.json(stats);
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
