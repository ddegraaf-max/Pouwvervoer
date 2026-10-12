// E-mail via Resend. Zonder RESEND_API_KEY wordt niets verstuurd;
// de mail wordt dan alleen gelogd in het dossier (demo-modus).

const { q } = require('./db');

const DEMO = !process.env.RESEND_API_KEY || !process.env.MAIL_FROM;

async function verstuur({ aan, onderwerp, tekst, aanvraagId = null, klantId = null }) {
  const ontvangers = [].concat(aan).filter(Boolean);
  let status = 'demo: niet verstuurd';
  if (!DEMO) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.MAIL_FROM, to: ontvangers, subject: onderwerp, text: tekst }),
        signal: AbortSignal.timeout(10000),
      });
      status = res.ok ? 'verstuurd' : `fout ${res.status}`;
    } catch (e) {
      status = `fout: ${e.message}`;
    }
  }
  await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [
    aanvraagId,
    klantId,
    'mail',
    `[${status}] Aan: ${ontvangers.join(', ')} · ${onderwerp}\n\n${tekst}`,
  ]);
  return status;
}

module.exports = { verstuur, DEMO };
