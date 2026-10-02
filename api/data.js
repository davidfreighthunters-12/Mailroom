// Vercel serverless function: saves and loads your subscribers and campaigns in a Redis database.
// Env vars: ADMIN_PASSWORD, KV_REST_API_URL, KV_REST_API_TOKEN (Vercel adds the last two when you connect the database)

const CHUNK = 2000; // subscribers stored per database key

async function redis(commands, path = 'pipeline') {
  const r = await fetch(`${process.env.KV_REST_API_URL}/${path}`, {
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
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || req.headers['x-admin-password'] !== pw) return res.status(401).json({ error: 'Wrong password' });
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)
    return res.status(500).json({ error: 'The database is not connected to this Vercel project yet' });

  try {
    const [metaRaw] = await redis([['GET', 'mailroom:meta']]);
    const meta = metaRaw ? JSON.parse(metaRaw) : null;

    if (req.method === 'GET') {
      if (!meta) return res.json({ empty: true });
      const parts = meta.chunks
        ? await redis(Array.from({ length: meta.chunks }, (_, i) => ['GET', `mailroom:subs:${i}`]))
        : [];
      return res.json({ subs: parts.flatMap(p => (p ? JSON.parse(p) : [])), camps: meta.camps || [] });
    }

    if (req.method === 'PUT') {
      const { subs, camps } = req.body || {};
      if (!Array.isArray(subs) || !Array.isArray(camps)) return res.status(400).json({ error: 'Bad data' });
      const n = Math.ceil(subs.length / CHUNK);
      const cmds = [];
      for (let i = 0; i < n; i++)
        cmds.push(['SET', `mailroom:subs:${i}`, JSON.stringify(subs.slice(i * CHUNK, (i + 1) * CHUNK))]);
      for (let i = n; i < (meta ? meta.chunks : 0); i++) cmds.push(['DEL', `mailroom:subs:${i}`]);
      cmds.push(['SET', 'mailroom:meta', JSON.stringify({ chunks: n, camps })]);
      await redis(cmds, 'multi-exec');
      return res.json({ ok: true, saved: subs.length });
    }

    return res.status(405).json({ error: 'GET or PUT only' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
