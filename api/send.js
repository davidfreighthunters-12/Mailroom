// Vercel serverless function: sends a campaign through Brevo.
// Env vars: BREVO_API_KEY, SENDER_EMAIL, SENDER_NAME, ADMIN_PASSWORD, COMPANY_ADDRESS, UNSUBSCRIBE_EMAIL
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const { subject, html, recipients } = req.body || {};
  if (!subject || !html || !Array.isArray(recipients) || !recipients.length)
    return res.status(400).json({ error: 'Missing subject, html or recipients' });

  const { BREVO_API_KEY, SENDER_EMAIL, SENDER_NAME, COMPANY_ADDRESS, UNSUBSCRIBE_EMAIL } = process.env;
  const footer = `<hr><p style="font-size:12px;color:#777">${COMPANY_ADDRESS || ''}<br>
    Don't want these emails? <a href="mailto:${UNSUBSCRIBE_EMAIL || SENDER_EMAIL}?subject=Unsubscribe">Unsubscribe</a></p>`;
  const fill = (t, r) => t.replace(/{{\s*name\s*}}/g, r.name || 'there');

  let sent = 0;
  for (let i = 0; i < recipients.length; i += 100) {           // 100 personalised emails per API call
    const chunk = recipients.slice(i, i + 100);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: SENDER_NAME || 'Mailroom', email: SENDER_EMAIL },
        replyTo: { name: SENDER_NAME || 'Mailroom', email: SENDER_EMAIL },
        subject: fill(subject, {}),
        htmlContent: html + footer,
        messageVersions: chunk.map(x => ({
          to: [{ email: x.email, name: x.name }],
          subject: fill(subject, x),
          htmlContent: fill(html, x) + footer,
        })),
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: `Brevo error after ${sent} sent: ${err.slice(0, 200)}` });
    }
    sent += chunk.length;
  }
  res.json({ ok: true, sent });
}

