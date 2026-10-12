const crypto = require('crypto');
const { q, one, all, tx } = require('./db');
const { berekenScore, aanbetalingsplan, dagenTussen } = require('./score');
const kvk = require('./kvk');
const mail = require('./mail');
const { euro, datum } = require('./format');

const BASE_URL = () => (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const token = () => crypto.randomBytes(24).toString('base64url');

const GRATIS_MAIL = new Set([
  'gmail.com', 'hotmail.com', 'hotmail.nl', 'outlook.com', 'outlook.nl', 'live.nl', 'live.com', 'yahoo.com',
  'yahoo.nl', 'icloud.com', 'me.com', 'ziggo.nl', 'kpnmail.nl', 'home.nl', 'planet.nl', 'hetnet.nl', 'xs4all.nl',
  'casema.nl', 'chello.nl', 'upcmail.nl', 'telfort.nl', 'msn.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.net',
]);

const domein = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';

function emailDomeinKlopt(klanttype, ...emails) {
  if (klanttype === 'particulier') return false;
  const ds = emails.map(domein).filter(Boolean);
  return ds.length > 0 && ds.every((d) => !GRATIS_MAIL.has(d));
}

async function log(aanvraagId, klantId, type, tekst, client) {
  const sql = 'INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)';
  return (client || { query: q }).query(sql, [aanvraagId, klantId, type, tekst]);
}

// ---- Betaalhistorie per opdrachtgever (uit eigen facturen) ----
async function historie(klantId, vandaag = new Date()) {
  const rows = await all('SELECT * FROM facturen WHERE klant_id = $1', [klantId]);
  const h = { betaaldOpTijd: 0, betaaldTeLaat1tot30: 0, ooitTeLaat30Plus: 0, incasso: 0, openVervallen: 0, open: 0 };
  for (const f of rows) {
    if (f.incasso) h.incasso++;
    if (f.betaald_op) {
      const telaat = dagenTussen(f.vervaldatum, f.betaald_op);
      if (telaat <= 0) h.betaaldOpTijd++;
      else if (telaat <= 30) h.betaaldTeLaat1tot30++;
      else h.ooitTeLaat30Plus++;
    } else {
      h.open++;
      const telaat = dagenTussen(f.vervaldatum, vandaag);
      if (telaat > 0) h.openVervallen++;
      if (telaat > 30) h.ooitTeLaat30Plus++;
    }
  }
  return h;
}

// ---- Score (her)berekenen voor een aanvraag ----
async function herberekenScore(aanvraagId) {
  const a = await one('SELECT * FROM aanvragen WHERE id = $1', [aanvraagId]);
  const k = await one('SELECT * FROM klanten WHERE id = $1', [a.klant_id]);
  const h = await historie(k.id);
  const res = berekenScore({
    klanttype: k.type,
    kvk: k.kvk ? { actief: k.kvk_actief, opgericht: k.kvk_opgericht, faillissement: k.kvk_faillissement } : null,
    emailDomeinKlopt: emailDomeinKlopt(k.type, k.teken_email, a.factuur_email),
    poNummer: a.po_nummer,
    historie: h,
    ritwaarde: a.ritprijs_cent != null ? a.ritprijs_cent / 100 : null,
    vertrek: a.rit_datum,
    aanvraag: a.created_at,
  });
  let klasse = res.klasse;
  if (k.klasse_override) {
    res.factoren.push({ label: `Handmatig naar klasse ${k.klasse_override}: ${k.override_reden}`, bron: 'Backoffice', punten: 0 });
    klasse = k.klasse_override;
  }
  await q(
    'UPDATE aanvragen SET score=$2, klasse=$3, score_factoren=$4, geblokkeerd=$5, blokkade_reden=$6 WHERE id=$1',
    [aanvraagId, res.score, klasse, JSON.stringify(res.factoren), res.geblokkeerd, res.blokkadeReden],
  );
  return { ...res, klasse };
}

// ---- Nieuwe aanvraag ----
async function nieuweAanvraag(d) {
  const type = d.klanttype;
  let check = null;
  if (type !== 'particulier' && d.kvk) check = await kvk.lookup(d.kvk);

  const sleutel = type === 'particulier' ? `mail:${d.teken_email.toLowerCase()}` : `kvk:${d.kvk}`;

  const ids = await tx(async (c) => {
    const bestaand = (await c.query('SELECT * FROM klanten WHERE sleutel=$1', [sleutel])).rows[0];
    let klantId;
    const kvkVelden = check && check.gevonden
      ? [true, check.opgericht, !!check.faillissement, check.bron]
      : [check ? false : null, null, false, check ? check.bron : null];
    if (bestaand) {
      klantId = bestaand.id;
      await c.query(
        `UPDATE klanten SET type=$2, naam=$3, kvk=$4, kvk_actief=$5, kvk_opgericht=$6, kvk_faillissement=$7, kvk_bron=$8,
         tekenbevoegde=$9, teken_email=$10 WHERE id=$1`,
        [klantId, type, d.org_naam, d.kvk || null, ...kvkVelden, d.tekenbevoegde, d.teken_email],
      );
    } else {
      klantId = (
        await c.query(
          `INSERT INTO klanten (sleutel, type, naam, kvk, kvk_actief, kvk_opgericht, kvk_faillissement, kvk_bron, tekenbevoegde, teken_email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [sleutel, type, d.org_naam, d.kvk || null, ...kvkVelden, d.tekenbevoegde, d.teken_email],
        )
      ).rows[0].id;
    }
    const aanvraagId = (
      await c.query(
        `INSERT INTO aanvragen (klant_id, aanvrager_naam, aanvrager_tel, aanvrager_email, aanvrager_rol, factuur_email,
          factuur_adres, po_nummer, reisleider_naam, reisleider_tel, rit_datum, vertrek_tijd, van, naar, personen, ritsoort,
          opmerkingen, akkoord_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [
          klantId, d.aanvrager_naam, d.aanvrager_tel, d.aanvrager_email, d.aanvrager_rol || null, d.factuur_email,
          d.factuur_adres || null, d.po_nummer || null, d.reisleider_naam || null, d.reisleider_tel || null,
          d.rit_datum, d.vertrek_tijd || null, d.van, d.naar, Number(d.personen), d.ritsoort, d.opmerkingen || null, token(),
        ],
      )
    ).rows[0].id;
    let kvkTekst = 'Geen KvK-check (particulier).';
    if (check) {
      kvkTekst = check.gevonden
        ? `KvK-check (${check.bron}): ingeschreven${check.faillissement ? ', FAILLISSEMENT/SURSEANCE' : ''}${check.opgericht ? `, sinds ${datum(check.opgericht)}` : ''}.`
        : `KvK-check (${check.bron}): niet gevonden${check.fout ? ` (${check.fout})` : ''}.`;
    }
    await log(aanvraagId, klantId, 'aanvraag', `Aanvraag ontvangen van ${d.aanvrager_naam}. ${kvkTekst}`, c);
    return { aanvraagId, klantId };
  });

  await herberekenScore(ids.aanvraagId);
  await mail.verstuur({
    aan: d.aanvrager_email,
    onderwerp: 'We hebben je busaanvraag ontvangen',
    tekst:
      `Beste ${d.aanvrager_naam},\n\nBedankt voor je aanvraag voor ${datum(d.rit_datum)} (${d.van} → ${d.naar}).\n` +
      `We maken een offerte en sturen die ter akkoord naar ${d.tekenbevoegde} (${d.teken_email}).\n\nMet vriendelijke groet,\nPouw Vervoer`,
    aanvraagId: ids.aanvraagId,
    klantId: ids.klantId,
  });
  return ids;
}

// ---- Offerte versturen naar opdrachtgever ----
async function verstuurOfferte(aanvraagId) {
  const a = await one('SELECT * FROM aanvragen WHERE id=$1', [aanvraagId]);
  if (!a || a.ritprijs_cent == null) throw new Error('Vul eerst de ritprijs in.');
  if (!['nieuw', 'offerte_verstuurd'].includes(a.status)) throw new Error('Offerte is al geaccordeerd.');
  const s = await herberekenScore(aanvraagId);
  if (s.geblokkeerd) throw new Error(`Geblokkeerd: ${s.blokkadeReden}`);
  const k = await one('SELECT * FROM klanten WHERE id=$1', [a.klant_id]);
  const plan = aanbetalingsplan(s.klasse, a.ritprijs_cent, a.rit_datum, a.nakosten_schatting_cent || 0);
  await q("UPDATE aanvragen SET status='offerte_verstuurd', offerte_verstuurd_op=now() WHERE id=$1", [aanvraagId]);
  const link = `${BASE_URL()}/akkoord/${a.akkoord_token}`;
  await mail.verstuur({
    aan: k.teken_email,
    onderwerp: `Offerte busvervoer ${datum(a.rit_datum)} ter akkoord`,
    tekst:
      `Beste ${k.tekenbevoegde},\n\n${a.aanvrager_naam} heeft namens ${k.naam} busvervoer aangevraagd ` +
      `op ${datum(a.rit_datum)} (${a.van} → ${a.naar}).\nRitprijs: ${euro(a.ritprijs_cent)} incl. 9% btw.\n` +
      `Betaling: ${plan.omschrijving}\n\nBekijk en accordeer de offerte: ${link}\n\nMet vriendelijke groet,\nPouw Vervoer`,
    aanvraagId,
    klantId: k.id,
  });
  await log(aanvraagId, k.id, 'offerte', `Offerte verstuurd naar ${k.teken_email} (klasse ${s.klasse}, score ${s.score}).`);
  return link;
}

// ---- Akkoord ----
async function geefAkkoord(akkoordToken, naam, ip) {
  return tx(async (c) => {
    const a = (await c.query('SELECT * FROM aanvragen WHERE akkoord_token=$1 FOR UPDATE', [akkoordToken])).rows[0];
    if (!a) throw new Error('Onbekende link.');
    if (a.status !== 'offerte_verstuurd') return a;
    const plan = aanbetalingsplan(a.klasse, a.ritprijs_cent, a.rit_datum, a.nakosten_schatting_cent || 0);
    for (const t of plan.termijnen) {
      await c.query(
        'INSERT INTO termijnen (aanvraag_id, soort, label, bedrag_cent, uiterlijk, token) VALUES ($1,$2,$3,$4,$5,$6)',
        [a.id, t.soort, t.label, t.bedrag, t.uiterlijk, token()],
      );
    }
    // Bevestigd als er niets direct bij akkoord betaald hoeft te worden.
    const directTeBetalen = plan.termijnen.some((t) => t.uiterlijk === null);
    const status = directTeBetalen ? 'wacht_op_betaling' : 'bevestigd';
    await c.query(
      'UPDATE aanvragen SET status=$2, akkoord_naam=$3, akkoord_op=now(), akkoord_ip=$4 WHERE id=$1',
      [a.id, status, naam, ip],
    );
    await log(a.id, a.klant_id, 'akkoord', `Akkoord gegeven door ${naam}. ${plan.omschrijving}`, c);
    if (status === 'bevestigd') await log(a.id, a.klant_id, 'status', 'Rit bevestigd en vrijgegeven voor de planning.', c);
    return { ...a, status };
  });
}

// ---- Termijn betaald (demo-iDEAL of handmatig door backoffice) ----
async function termijnBetaald(termijnId, betaalwijze) {
  return tx(async (c) => {
    const t = (await c.query('SELECT * FROM termijnen WHERE id=$1 FOR UPDATE', [termijnId])).rows[0];
    if (!t || t.betaald_op) return t;
    await c.query('UPDATE termijnen SET betaald_op=now(), betaalwijze=$2 WHERE id=$1', [t.id, betaalwijze]);
    const a = (await c.query('SELECT * FROM aanvragen WHERE id=$1 FOR UPDATE', [t.aanvraag_id])).rows[0];
    await log(a.id, a.klant_id, 'betaling', `${t.label} ontvangen: ${euro(t.bedrag_cent)} (${betaalwijze}).`, c);
    if (a.status === 'wacht_op_betaling') {
      const openDirect = (
        await c.query('SELECT count(*)::int n FROM termijnen WHERE aanvraag_id=$1 AND uiterlijk IS NULL AND betaald_op IS NULL', [a.id])
      ).rows[0].n;
      if (openDirect === 0) {
        await c.query("UPDATE aanvragen SET status='bevestigd', signaal_planner=false WHERE id=$1", [a.id]);
        await log(a.id, a.klant_id, 'status', 'Aanbetaling binnen: rit bevestigd en vrijgegeven voor de planning.', c);
      }
    }
    return t;
  });
}

// ---- Eindfactuur ----
async function maakEindfactuur(aanvraagId) {
  return tx(async (c) => {
    const a = (await c.query('SELECT * FROM aanvragen WHERE id=$1 FOR UPDATE', [aanvraagId])).rows[0];
    if (a.status !== 'gereden') throw new Error('Markeer de rit eerst als gereden.');
    const nak = (await c.query('SELECT coalesce(sum(bedrag_cent),0)::int s FROM nakosten WHERE aanvraag_id=$1', [a.id])).rows[0].s;
    const betaald = (
      await c.query('SELECT coalesce(sum(bedrag_cent),0)::int s FROM termijnen WHERE aanvraag_id=$1 AND betaald_op IS NOT NULL', [a.id])
    ).rows[0].s;
    // Openstaande termijnen vervallen; de eindfactuur neemt alles over.
    await c.query('DELETE FROM termijnen WHERE aanvraag_id=$1 AND betaald_op IS NULL', [a.id]);
    const totaal = a.ritprijs_cent + nak;
    const teBetalen = totaal - betaald;
    const jaar = new Date().getFullYear();
    const volg = (await c.query("SELECT count(*)::int n FROM facturen WHERE nummer LIKE $1", [`EPV-${jaar}-%`])).rows[0].n + 1;
    const nummer = `EPV-${jaar}-${String(volg).padStart(4, '0')}`;
    const vandaag = new Date();
    const verval = new Date(vandaag.getTime() + 14 * 864e5);
    const f = (
      await c.query(
        `INSERT INTO facturen (aanvraag_id, klant_id, nummer, totaal_cent, reeds_betaald_cent, te_betalen_cent, factuurdatum, vervaldatum, betaald_op, token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [a.id, a.klant_id, nummer, totaal, betaald, teBetalen, vandaag, verval, teBetalen <= 0 ? vandaag : null, token()],
      )
    ).rows[0];
    await c.query('UPDATE aanvragen SET status=$2 WHERE id=$1', [a.id, teBetalen <= 0 ? 'betaald' : 'gefactureerd']);
    await log(
      a.id,
      a.klant_id,
      'factuur',
      `Eindfactuur ${nummer}: totaal ${euro(totaal)}, al betaald ${euro(betaald)}, ` +
        (teBetalen < 0 ? `terug te betalen ${euro(-teBetalen)}.` : `te betalen ${euro(teBetalen)}.`),
      c,
    );
    return { f, a };
  }).then(async ({ f, a }) => {
    if (f.te_betalen_cent > 0) {
      await mail.verstuur({
        aan: a.factuur_email,
        onderwerp: `Factuur ${f.nummer} busvervoer ${datum(a.rit_datum)}`,
        tekst:
          `Geachte heer/mevrouw,\n\nHierbij de eindfactuur ${f.nummer}${a.po_nummer ? ` (uw referentie ${a.po_nummer})` : ''}.\n` +
          `Totaal: ${euro(f.totaal_cent)}\nAl voldaan: ${euro(f.reeds_betaald_cent)}\nTe betalen: ${euro(f.te_betalen_cent)} ` +
          `vóór ${datum(f.vervaldatum)}.\n\nOnline betalen: ${BASE_URL()}/factuur/${f.token}\n\nMet vriendelijke groet,\nPouw Vervoer`,
        aanvraagId: a.id,
        klantId: a.klant_id,
      });
    }
    return f;
  });
}

async function factuurBetaald(factuurId, betaalwijze) {
  const f = await one('SELECT * FROM facturen WHERE id=$1', [factuurId]);
  if (!f || f.betaald_op) return f;
  await q('UPDATE facturen SET betaald_op=CURRENT_DATE WHERE id=$1', [f.id]);
  await q("UPDATE aanvragen SET status='betaald' WHERE id=$1", [f.aanvraag_id]);
  await log(f.aanvraag_id, f.klant_id, 'betaling', `Factuur ${f.nummer} betaald (${betaalwijze}).`);
  return f;
}

// ---- Herinneringen (draait elk uur, of handmatig) ----
// Facturen: dag 0 (vervaldatum), 3, 10 (cc aanvrager), 17 aanmaning; particulier: 14-dagenbrief.
const NIVEAUS = [
  { dag: 0, naam: 'Herinnering: factuur vervalt vandaag' },
  { dag: 3, naam: 'Herinnering: factuur is verlopen' },
  { dag: 10, naam: 'Tweede herinnering', ccAanvrager: true },
  { dag: 17, naam: 'Aanmaning', ccAanvrager: true },
];

async function draaiHerinneringen(vandaag = new Date()) {
  const verslag = [];
  // 1. Termijnen met een uiterste datum die verstreken is
  const termijnen = await all(
    `SELECT t.*, a.klant_id, a.aanvrager_email, a.status, a.rit_datum, a.akkoord_op, a.signaal_planner,
            k.teken_email, k.tekenbevoegde
     FROM termijnen t JOIN aanvragen a ON a.id=t.aanvraag_id JOIN klanten k ON k.id=a.klant_id
     WHERE t.betaald_op IS NULL AND a.status IN ('wacht_op_betaling','bevestigd')`,
  );
  for (const t of termijnen) {
    // Termijn met datum: herinnering op de uiterste dag. Termijn "bij akkoord": herinnering na 24 uur.
    const tijdVoorHerinnering = t.uiterlijk
      ? dagenTussen(t.uiterlijk, vandaag) >= 0
      : t.akkoord_op && vandaag - new Date(t.akkoord_op) >= 24 * 3600e3;
    if (!t.herinnering_op && tijdVoorHerinnering) {
      await mail.verstuur({
        aan: [t.teken_email, t.aanvrager_email],
        onderwerp: `Herinnering: ${t.label.toLowerCase()} voor uw busrit van ${datum(t.rit_datum)}`,
        tekst: `Beste ${t.tekenbevoegde},\n\nWe hebben ${t.label.toLowerCase()} van ${euro(t.bedrag_cent)} nog niet ontvangen.\n` +
          `Betaal via ${BASE_URL()}/betalen/${t.token}\n\nMet vriendelijke groet,\nPouw Vervoer`,
        aanvraagId: t.aanvraag_id,
        klantId: t.klant_id,
      });
      await q('UPDATE termijnen SET herinnering_op=now() WHERE id=$1', [t.id]);
      verslag.push(`Herinnering termijn ${t.id}`);
    } else if (t.herinnering_op && vandaag - new Date(t.herinnering_op) >= 48 * 3600e3) {
      const gezet = await one(
        'UPDATE aanvragen SET signaal_planner=true WHERE id=$1 AND signaal_planner=false RETURNING id',
        [t.aanvraag_id],
      );
      if (gezet) {
        await log(t.aanvraag_id, t.klant_id, 'signaal', `${t.label} 48 uur na herinnering nog niet betaald. Planner beslist of de rit doorgaat.`);
        verslag.push(`Signaal planner aanvraag ${t.aanvraag_id}`);
      }
    }
  }

  // 2. Facturen
  const facturen = await all(
    `SELECT f.*, a.factuur_email, a.aanvrager_email, a.aanvrager_naam, a.po_nummer, k.type klanttype
     FROM facturen f JOIN aanvragen a ON a.id=f.aanvraag_id JOIN klanten k ON k.id=f.klant_id
     WHERE f.betaald_op IS NULL AND f.incasso = false`,
  );
  for (const f of facturen) {
    const dagen = dagenTussen(f.vervaldatum, vandaag);
    const nieuwNiveau = NIVEAUS.filter((n) => dagen >= n.dag).length;
    if (nieuwNiveau <= f.herinnering_niveau) continue;
    const n = NIVEAUS[nieuwNiveau - 1];
    const veertienDagenBrief = n.dag === 17 && f.klanttype === 'particulier';
    await mail.verstuur({
      aan: n.ccAanvrager ? [f.factuur_email, f.aanvrager_email] : f.factuur_email,
      onderwerp: `${veertienDagenBrief ? 'Laatste herinnering (14-dagenbrief)' : n.naam}: factuur ${f.nummer}`,
      tekst:
        `Geachte heer/mevrouw,\n\nFactuur ${f.nummer}${f.po_nummer ? ` (referentie ${f.po_nummer})` : ''} van ${euro(f.te_betalen_cent)} ` +
        `had betaald moeten zijn op ${datum(f.vervaldatum)}.\n` +
        (veertienDagenBrief
          ? 'U krijgt 14 dagen na ontvangst van deze brief om te betalen. Daarna brengen wij de wettelijke incassokosten in rekening.\n'
          : '') +
        `Betaal via ${BASE_URL()}/factuur/${f.token}\n\nMet vriendelijke groet,\nPouw Vervoer`,
      aanvraagId: f.aanvraag_id,
      klantId: f.klant_id,
    });
    await q('UPDATE facturen SET herinnering_niveau=$2, laatste_herinnering_op=$3 WHERE id=$1', [f.id, nieuwNiveau, vandaag]);
    verslag.push(`${n.naam} factuur ${f.nummer}`);
  }
  return verslag;
}

module.exports = {
  nieuweAanvraag, herberekenScore, verstuurOfferte, geefAkkoord, termijnBetaald, maakEindfactuur,
  factuurBetaald, draaiHerinneringen, historie, log, emailDomeinKlopt, token, BASE_URL,
};
