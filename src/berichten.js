// WhatsApp (en sms als terugval) als tweede kanaal naast e-mail, via de API van SMSTools (api.smsgatewayapi.com):
// offerte klaar, aanbetaling open, factuur vervalt of is verlopen, rit morgen, en een seintje bij de 14-dagenbrief.
// Alleen met toestemming (vinkje bij de aanvraag, bewaard met tijdstip), nooit naar een afgemeld nummer (STOP),
// en niet tussen 21:00 en 08:00: dan om 08:00. Zonder SMSTOOLS_CLIENT_ID en -SECRET draait dit in demo-modus:
// het bericht komt alleen in het dossier.
const crypto = require('crypto');
const { q, one, all } = require('./db');
const context = require('./context');
const { euro, datum } = require('./format');

const CONFIG = () => ({
  clientId: process.env.SMSTOOLS_CLIENT_ID || '',
  clientSecret: process.env.SMSTOOLS_CLIENT_SECRET || '',
  webhookSecret: process.env.SMSTOOLS_WEBHOOK_SECRET || '',
  zender: process.env.SMSTOOLS_SENDER || '', // WhatsApp Business-nummer, internationaal zonder plus (bijv. 31306868300)
  smsZender: (process.env.SMSTOOLS_SMS_SENDER || 'Pouw').slice(0, 11),
  templates: {
    offerte: process.env.SMSTOOLS_TPL_OFFERTE || 'pouw_offerte',
    aanbetaling: process.env.SMSTOOLS_TPL_AANBETALING || 'pouw_aanbetaling',
    factuur: process.env.SMSTOOLS_TPL_FACTUUR || 'pouw_factuur',
    rit_morgen: process.env.SMSTOOLS_TPL_RIT || 'pouw_rit_morgen',
    brief: process.env.SMSTOOLS_TPL_BRIEF || 'pouw_brief',
  },
  basis: process.env.SMSTOOLS_API || 'https://api.smsgatewayapi.com/v1',
});
const DEMO = !process.env.SMSTOOLS_CLIENT_ID || !process.env.SMSTOOLS_CLIENT_SECRET;
const STIL_VAN = 21; // geen berichten vanaf 21:00
const STIL_TOT = 8; // ... tot 08:00

// ---- Telefoonnummers ----
// Nederlandse mobiele nummers naar internationaal formaat zonder plus (zoals de API wil): 06 12345678 → 31612345678.
function normaliseerNummer(s) {
  let t = String(s || '').replace(/[^\d+]/g, '');
  if (!t) return null;
  if (t.startsWith('00')) t = t.slice(2);
  else if (t.startsWith('+')) t = t.slice(1);
  else if (t.startsWith('0')) t = `31${t.slice(1)}`;
  if (!/^\d{10,15}$/.test(t)) return null;
  return t;
}
function isMobielNl(nummer) {
  return /^316\d{8}$/.test(String(nummer || ''));
}

// ---- Stille uren (Europe/Amsterdam) ----
function amsterdam(d) {
  const delen = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const v = Object.fromEntries(delen.map((p) => [p.type, p.value]));
  return { jaar: Number(v.year), maand: Number(v.month), dag: Number(v.day), uur: Number(v.hour) % 24, minuut: Number(v.minute) };
}
// Verschil (ms) tussen lokale tijd Amsterdam en UTC op een gegeven moment.
function offsetMs(d) {
  const a = amsterdam(d);
  const alsUtc = Date.UTC(a.jaar, a.maand - 1, a.dag, a.uur, a.minuut);
  const afgerond = Math.floor(d.getTime() / 60000) * 60000;
  return alsUtc - afgerond;
}
function verzendMoment(nu = new Date()) {
  const a = amsterdam(nu);
  if (a.uur >= STIL_TOT && a.uur < STIL_VAN) return nu;
  // Vóór 08:00: vandaag om 08:00; vanaf 21:00: morgen om 08:00 (lokale tijd Amsterdam).
  const dagen = a.uur >= STIL_VAN ? 1 : 0;
  const lokaal = Date.UTC(a.jaar, a.maand - 1, a.dag + dagen, STIL_TOT, 0);
  const doel = new Date(lokaal - offsetMs(nu));
  return new Date(doel.getTime() - offsetMs(doel) + offsetMs(nu)); // corrigeer als de offset wisselt (zomer/wintertijd)
}

// ---- Teksten: WhatsApp-templates (door Pouw bij Meta ter goedkeuring aangeboden) en de sms-terugval ----
const TEMPLATES = {
  offerte: {
    naam: 'pouw_offerte',
    tekst: 'Beste {{1}}, de offerte van Pouw Vervoer voor uw busrit op {{2}} staat klaar. Bekijk en accordeer de offerte via de knop hieronder. De offerte is geldig tot en met {{3}}. Vragen? Bel 030 68 68 300.',
    knop: 'Offerte bekijken', knopUrl: '/akkoord/{{1}}',
    sms: (v) => `Pouw Vervoer: de offerte voor uw busrit op ${v[2]} staat klaar, geldig t/m ${v[3]}. Bekijk en accordeer: ${v.link}`,
  },
  aanbetaling: {
    naam: 'pouw_aanbetaling',
    tekst: 'Beste {{1}}, voor uw busrit op {{2}} staat de aanbetaling van {{3}} nog open. Betaal eenvoudig via de knop hieronder, dan staat de rit definitief vast. Pouw Vervoer',
    knop: 'Nu betalen', knopUrl: '/betalen/{{1}}',
    sms: (v) => `Pouw Vervoer: de aanbetaling van ${v[3]} voor uw busrit op ${v[2]} staat nog open. Betaal via ${v.link}`,
  },
  factuur: {
    naam: 'pouw_factuur',
    tekst: 'Beste {{1}}, factuur {{2}} van Pouw Vervoer ({{3}}) {{4}}. Betaal via de knop hieronder. Vragen? Bel 030 68 68 300.',
    knop: 'Factuur betalen', knopUrl: '/factuur/{{1}}',
    sms: (v) => `Pouw Vervoer: factuur ${v[2]} (${v[3]}) ${v[4]}. Betaal via ${v.link}`,
  },
  rit_morgen: {
    naam: 'pouw_rit_morgen',
    tekst: 'Beste {{1}}, morgen {{2}} rijdt Pouw Vervoer voor u. Vertrek om {{3}} vanaf {{4}}. Uw chauffeur is {{5}}. Bij vragen: 030 68 68 300. Goede reis!',
    knop: null, knopUrl: null,
    sms: (v) => `Pouw Vervoer: morgen ${v[2]} vertrek om ${v[3]} vanaf ${v[4]}. Chauffeur: ${v[5]}. Vragen? 030 68 68 300.`,
  },
  brief: {
    naam: 'pouw_brief',
    tekst: 'Beste {{1}}, wij hebben u vandaag per e-mail een laatste herinnering (14-dagenbrief) gestuurd voor factuur {{2}}. Lees die e-mail goed: betaalt u binnen 14 dagen, dan voorkomt u incassokosten. Pouw Vervoer',
    knop: 'Factuur betalen', knopUrl: '/factuur/{{1}}',
    sms: (v) => `Pouw Vervoer: vandaag is per e-mail een laatste herinnering (14-dagenbrief) gestuurd voor factuur ${v[2]}. Betaal binnen 14 dagen en voorkom incassokosten: ${v.link}`,
  },
};
function vulTekst(sjabloon, variabelen) {
  return sjabloon.replace(/\{\{(\d+)\}\}/g, (_, n) => String(variabelen[Number(n)] ?? ''));
}
// Variabelen per soort: genummerd zoals in de template; link = de volledige URL (knop en sms).
function bouwBericht(soort, v, cfg = CONFIG()) {
  const t = TEMPLATES[soort];
  if (!t) throw new Error(`Onbekend berichtsoort ${soort}`);
  const vars = {};
  for (let i = 1; i <= 5; i++) if (v[i] != null) vars[i] = String(v[i]);
  const whatsapp = { template_name: cfg.templates[soort] || t.naam, variabelen: vars, knopVariabele: v.knop || null };
  const tekst = vulTekst(t.tekst, vars);
  const sms = t.sms({ ...vars, link: v.link || '' });
  return { whatsapp, tekst, sms };
}

// ---- Handtekening van webhooks (SMSTools v2): HMAC-SHA256 over "{t}.{body}" met het endpoint-secret ----
function controleerHandtekening(kop, body, secret, nu = Date.now()) {
  if (!secret) return { ok: true, reden: 'geen secret ingesteld' };
  const m = /t=(\d+),v1=([0-9a-f]+)/i.exec(String(kop || ''));
  if (!m) return { ok: false, reden: 'geen handtekening' };
  const t = Number(m[1]);
  if (Math.abs(nu / 1000 - t) > 300) return { ok: false, reden: 'handtekening te oud' };
  const verwacht = crypto.createHmac('sha256', secret).update(`${t}.${typeof body === 'string' ? body : body.toString('utf8')}`).digest('hex');
  const gegeven = m[2].toLowerCase();
  const ok = verwacht.length === gegeven.length && crypto.timingSafeEqual(Buffer.from(verwacht), Buffer.from(gegeven));
  return { ok, reden: ok ? 'ok' : 'handtekening klopt niet' };
}
function isStop(tekst) {
  return /^\s*(stop|stoppen|afmelden|uitschrijven)\b/i.test(String(tekst || ''));
}
const AFLEVERCODES = { 0: 'verstuurd', 1: 'afgeleverd', 2: 'mislukt', 3: 'verstuurd', 4: 'mislukt', 5: 'mislukt', 9: 'onbekend' };

// ---- Versturen (HTTP) ----
async function roep(pad, body, cfg = CONFIG()) {
  const res = await fetch(`${cfg.basis}${pad}`, {
    method: 'POST',
    headers: { 'X-Client-Id': cfg.clientId, 'X-Client-Secret': cfg.clientSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const tekst = await res.text();
  let j = {};
  try { j = tekst ? JSON.parse(tekst) : {}; } catch { j = { raw: tekst }; }
  if (!res.ok || j.error) throw Object.assign(new Error(j.errorMsg || j.error || `HTTP ${res.status}`), { code: String(j.error || res.status) });
  return j;
}
async function verstuurWhatsapp(b, cfg = CONFIG()) {
  const body = { template_name: b.template_name, to: b.naar, sender: cfg.zender };
  for (const [i, w] of Object.entries(b.variabelen || {})) body[`variable${i}`] = w;
  if (b.knopVariabele) body.button_variable1 = b.knopVariabele;
  if (b.referentie) body.reference = b.referentie;
  const r = await roep('/whatsapp/send_template', body, cfg);
  return r.messageid || (r.messageids && r.messageids[0]) || null;
}
async function verstuurSms(b, cfg = CONFIG()) {
  const r = await roep('/message/send', { message: b.tekst, to: b.naar, sender: cfg.smsZender, ...(b.referentie ? { reference: b.referentie } : {}) }, cfg);
  return r.messageid || (r.messageids && r.messageids[0]) || null;
}

// ---- Plannen en verwerken ----
async function isAfgemeld(nummer) {
  const r = await one('SELECT 1 FROM optouts WHERE nummer=$1', [nummer]);
  return !!r;
}
async function meldAf(nummer, bron = 'STOP') {
  const n = normaliseerNummer(nummer);
  if (!n) return false;
  await q('INSERT INTO optouts (nummer, bron) VALUES ($1,$2) ON CONFLICT (nummer) DO NOTHING', [n, bron]);
  await q("UPDATE berichten SET status='afgemeld', status_detail='nummer afgemeld', status_op=now() WHERE naar=$1 AND status='gepland'", [n]);
  return true;
}

// Een bericht inplannen. Sleutel voorkomt dubbele berichten (bijv. offerte:12). Zonder toestemming of met afmelding: niets.
async function plan({ aanvraagId, soort, naar, variabelen, sleutel, nu = new Date() }) {
  const a = await one('SELECT id, klant_id, whatsapp_ok FROM aanvragen WHERE id=$1', [aanvraagId]);
  if (!a || !a.whatsapp_ok) return { gepland: false, reden: 'geen toestemming' };
  const nummer = normaliseerNummer(naar);
  if (!nummer) return { gepland: false, reden: 'geen bruikbaar nummer' };
  if (await isAfgemeld(nummer)) return { gepland: false, reden: 'afgemeld' };
  const b = bouwBericht(soort, variabelen);
  const moment = verzendMoment(nu);
  const rij = await one(
    `INSERT INTO berichten (aanvraag_id, klant_id, soort, kanaal, naar, tekst, sms_tekst, template, variabelen, knop_variabele, sleutel, status, gepland_op)
     VALUES ($1,$2,$3,'whatsapp',$4,$5,$6,$7,$8,$9,$10,'gepland',$11)
     ON CONFLICT (sleutel) DO NOTHING RETURNING id`,
    [a.id, a.klant_id, soort, nummer, b.tekst, b.sms, b.whatsapp.template_name, JSON.stringify(b.whatsapp.variabelen), b.whatsapp.knopVariabele, sleutel, moment],
  );
  if (!rij) return { gepland: false, reden: 'al verstuurd' };
  if (moment.getTime() - nu.getTime() > 60e3) {
    await q('INSERT INTO events (gebruiker_id, aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4,$5)', [context.gebruikerId(), a.id, a.klant_id, 'bericht', `WhatsApp ${soort} naar ${nummer} ingepland voor ${datumTijd(moment)} (stille uren).`]);
  }
  return { gepland: true, id: rij.id, moment };
}
function datumTijd(d) {
  const a = amsterdam(d);
  return `${String(a.dag).padStart(2, '0')}-${String(a.maand).padStart(2, '0')}-${a.jaar} ${String(a.uur).padStart(2, '0')}:${String(a.minuut).padStart(2, '0')}`;
}

// Verwerkt geplande berichten: WhatsApp-template, bij een fout sms met dezelfde kern en link. Demo: alleen loggen.
async function verwerk({ nu = new Date(), whatsapp = verstuurWhatsapp, sms = verstuurSms } = {}) {
  const rijen = await all("SELECT * FROM berichten WHERE status='gepland' AND gepland_op <= $1 ORDER BY id LIMIT 50", [nu]);
  const verslag = [];
  for (const b of rijen) {
    if (await isAfgemeld(b.naar)) {
      await q("UPDATE berichten SET status='afgemeld', status_detail='nummer afgemeld', status_op=now() WHERE id=$1", [b.id]);
      continue;
    }
    if (DEMO) {
      await q("UPDATE berichten SET status='demo', verstuurd_op=now(), status_op=now(), status_detail='demo: niet verstuurd' WHERE id=$1", [b.id]);
      await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [b.aanvraag_id, b.klant_id, 'bericht', `WhatsApp (demo, niet verstuurd) naar ${b.naar}:\n${b.tekst}`]);
      verslag.push(`demo ${b.id}`);
      continue;
    }
    try {
      const id = await whatsapp({ template_name: b.template, variabelen: b.variabelen || {}, knopVariabele: b.knop_variabele, naar: b.naar, referentie: `B-${b.id}` });
      await q("UPDATE berichten SET status='verstuurd', kanaal='whatsapp', messageid=$2, verstuurd_op=now(), status_op=now(), status_detail=NULL WHERE id=$1", [b.id, id]);
      await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [b.aanvraag_id, b.klant_id, 'bericht', `WhatsApp naar ${b.naar} verstuurd (${b.soort}):\n${b.tekst}`]);
      verslag.push(`whatsapp ${b.id}`);
    } catch (e) {
      const reden = String(e.message || e).slice(0, 300);
      try {
        const id = await sms({ tekst: b.sms_tekst, naar: b.naar, referentie: `B-${b.id}` });
        await q("UPDATE berichten SET status='verstuurd', kanaal='sms', messageid=$2, verstuurd_op=now(), status_op=now(), status_detail=$3 WHERE id=$1", [b.id, id, `WhatsApp niet mogelijk (${reden}); sms gestuurd`]);
        await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [b.aanvraag_id, b.klant_id, 'bericht', `Sms naar ${b.naar} verstuurd (${b.soort}; WhatsApp niet mogelijk: ${reden}):\n${b.sms_tekst}`]);
        verslag.push(`sms ${b.id}`);
      } catch (e2) {
        const r2 = String(e2.message || e2).slice(0, 300);
        await q("UPDATE berichten SET status='mislukt', status_op=now(), status_detail=$2 WHERE id=$1", [b.id, `WhatsApp: ${reden}; sms: ${r2}`]);
        await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [b.aanvraag_id, b.klant_id, 'bericht', `Bericht (${b.soort}) naar ${b.naar} mislukt. WhatsApp: ${reden}. Sms: ${r2}.`]);
        verslag.push(`mislukt ${b.id}`);
      }
    }
  }
  return verslag;
}

// Webhook van SMSTools: afleverstatus, leesbevestiging, inkomend bericht (STOP) en opt-outs.
async function verwerkWebhook(payload, { sms = verstuurSms } = {}) {
  const type = payload && payload.webhook_type;
  if (type === 'delivery_report' && payload.message) {
    const m = payload.message;
    const status = AFLEVERCODES[Number(m.delivery_code)] || 'onbekend';
    const detail = [m.delivery_status, m.delivery_code_detail_description].filter(Boolean).join(': ');
    const b = await one('SELECT * FROM berichten WHERE messageid=$1', [String(m.messageid)]);
    if (!b) return { verwerkt: false, reden: 'onbekend bericht' };
    if (status === 'mislukt' && b.kanaal === 'whatsapp' && !b.sms_na_mislukking) {
      // WhatsApp niet afgeleverd (bijv. geen WhatsApp op dit nummer): dezelfde kern per sms.
      await q("UPDATE berichten SET status='mislukt', status_detail=$2, status_op=now(), sms_na_mislukking=true WHERE id=$1", [b.id, detail || 'niet afgeleverd']);
      if (!DEMO) {
        try {
          const id = await sms({ tekst: b.sms_tekst, naar: b.naar, referentie: `B-${b.id}-sms` });
          await q("UPDATE berichten SET status='verstuurd', kanaal='sms', messageid=$2, verstuurd_op=now(), status_op=now(), status_detail=$3 WHERE id=$1", [b.id, id, `WhatsApp niet afgeleverd (${detail || 'onbekend'}); sms gestuurd`]);
          await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [b.aanvraag_id, b.klant_id, 'bericht', `WhatsApp naar ${b.naar} niet afgeleverd (${detail || 'onbekend'}); sms gestuurd:\n${b.sms_tekst}`]);
          return { verwerkt: true, actie: 'sms' };
        } catch (e) {
          await q("UPDATE berichten SET status_detail=$2 WHERE id=$1", [b.id, `WhatsApp niet afgeleverd; sms mislukt: ${String(e.message || e).slice(0, 200)}`]);
        }
      }
      return { verwerkt: true, actie: 'mislukt' };
    }
    if (status !== 'onbekend') await q("UPDATE berichten SET status=$2, status_detail=$3, status_op=now() WHERE id=$1 AND status <> 'gelezen'", [b.id, status, detail || null]);
    return { verwerkt: true, actie: status };
  }
  if (type === 'read_report' && payload.message) {
    await q("UPDATE berichten SET status='gelezen', status_op=now() WHERE messageid=$1", [String(payload.message.messageid)]);
    return { verwerkt: true, actie: 'gelezen' };
  }
  if (type === 'inbox_message' && payload.message) {
    const m = payload.message;
    if (isStop(m.content)) {
      await meldAf(m.sender, 'STOP');
      return { verwerkt: true, actie: 'afgemeld' };
    }
    return { verwerkt: true, actie: 'inkomend' };
  }
  if ((type === 'add_optout' || type === 'delete_optout') && payload.optout) {
    const n = normaliseerNummer(payload.optout.number);
    if (type === 'add_optout') await meldAf(n, 'SMSTools');
    else if (n) await q('DELETE FROM optouts WHERE nummer=$1', [n]);
    return { verwerkt: true, actie: type };
  }
  return { verwerkt: false, reden: 'onbekend type' };
}

async function voorAanvraag(aanvraagId) {
  return all('SELECT id, soort, kanaal, naar, status, status_detail, gepland_op, verstuurd_op, status_op, tekst FROM berichten WHERE aanvraag_id=$1 ORDER BY id DESC', [aanvraagId]);
}

// Rit morgen: elke dag om 08:00 (Amsterdam) voor bevestigde ritten met vertrek morgen, naar de aanvrager.
async function planRitMorgen(nu = new Date(), baseUrl = '') {
  const a = amsterdam(nu);
  if (a.uur !== STIL_TOT) return [];
  const morgen = new Date(Date.UTC(a.jaar, a.maand - 1, a.dag + 1));
  const ritten = await all(
    `SELECT a.*, k.tekenbevoegde FROM aanvragen a JOIN klanten k ON k.id=a.klant_id
     WHERE a.status='bevestigd' AND a.whatsapp_ok=true AND a.rit_datum=$1::date`,
    [morgen.toISOString().slice(0, 10)],
  );
  const uit = [];
  for (const r of ritten) {
    const res = await plan({
      aanvraagId: r.id, soort: 'rit_morgen', naar: r.aanvrager_tel, sleutel: `rit:${r.id}`, nu,
      variabelen: { 1: r.aanvrager_naam, 2: datum(r.rit_datum), 3: r.vertrek_tijd || '-', 4: r.van, 5: r.chauffeur_naam || 'nog niet bekend', link: baseUrl },
    });
    if (res.gepland) uit.push(r.id);
  }
  return uit;
}

module.exports = {
  DEMO, CONFIG, TEMPLATES, STIL_VAN, STIL_TOT, AFLEVERCODES,
  normaliseerNummer, isMobielNl, verzendMoment, amsterdam, vulTekst, bouwBericht, controleerHandtekening, isStop,
  verstuurWhatsapp, verstuurSms, plan, verwerk, verwerkWebhook, meldAf, isAfgemeld, voorAanvraag, planRitMorgen, datumTijd,
  euro,
};
