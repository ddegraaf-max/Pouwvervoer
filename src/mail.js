// E-mail via Resend. Zonder RESEND_API_KEY wordt niets verstuurd;
// de mail wordt dan alleen gelogd in het dossier (demo-modus).
// Bijlagen (bijv. de voorwaarden als pdf) gaan als base64 mee en staan met naam in het logboek.

const fs = require('fs');
const { q } = require('./db');

const DEMO = !process.env.RESEND_API_KEY || !process.env.MAIL_FROM;

async function verstuur({ aan, cc = [], onderwerp, tekst, bijlagen = [], aanvraagId = null, klantId = null }) {
  const ontvangers = [].concat(aan).filter(Boolean);
  const kopie = [].concat(cc).filter((e) => e && !ontvangers.includes(e));
  const bestanden = bijlagen.filter(Boolean);
  let status = 'demo: niet verstuurd';
  if (!DEMO) {
    try {
      const attachments = bestanden.map((b) => ({ filename: b.naam, content: fs.readFileSync(b.pad).toString('base64') }));
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.MAIL_FROM,
          to: ontvangers,
          ...(kopie.length ? { cc: kopie } : {}),
          subject: onderwerp,
          text: tekst,
          ...(attachments.length ? { attachments } : {}),
        }),
        signal: AbortSignal.timeout(20000),
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
    `[${status}] Aan: ${ontvangers.join(', ')}${kopie.length ? ` · Cc: ${kopie.join(', ')}` : ''} · ${onderwerp}` +
      `${bestanden.length ? `\nBijlagen: ${bestanden.map((b) => b.naam).join(', ')}` : ''}\n\n${tekst}`,
  ]);
  return status;
}

module.exports = { verstuur, DEMO };
