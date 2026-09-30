// Vercel serverless function: sends a campaign through Brevo.
// Env vars: BREVO_API_KEY, SENDER_EMAIL, SENDER_NAME, ADMIN_PASSWORD, COMPANY_ADDRESS, UNSUBSCRIBE_EMAIL

// If the body has no HTML tags, turn plain text into clean paragraphs:
// blank line = new paragraph, single line break = <br>, lines starting with "- " = bullet list,
// and bare links become clickable. If the body already contains HTML, it is left as is.
const toHtml = (text) => {
  if (/<\s*(p|br|div|h[1-6]|ul|ol|li|table|a)\b/i.test(text)) return text;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const link = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length && lines.every((l) => /^[-•*]\s+/.test(l))) {
        return '<ul>' + lines.map((l) => `<li>${link(esc(l.replace(/^[-•*]\s+/, '')))}</li>`).join('') + '</ul>';
      }
      return `<p>${lines.map((l) => link(esc(l))).join('<br>')}</p>`;
    })
    .join('\n');
};

const wrap = (inner) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">${inner}</div>`;

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
  const body = toHtml(html);

  let sent = 0;
  for (let i = 0; i < recipients.length; i += 100) { // 100 personalised emails per API call
    const chunk = recipients.slice(i, i + 100);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: SENDER_NAME || 'Mailroom', email: SENDER_EMAIL },
        replyTo: { name: SENDER_NAME || 'Mailroom', email: SENDER_EMAIL },
        subject: fill(subject, {}),
        htmlContent: wrap(body) + footer,
        messageVersions: chunk.map(x => ({
          to: [{ email: x.email, name: x.name }],
          subject: fill(subject, x),
          htmlContent: wrap(fill(body, x)) + footer,
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
