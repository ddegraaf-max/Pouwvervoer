// Overdracht van onbetaalde facturen aan de deurwaarder (standaard Armaere) en het dossier daarna.
const { q, one, all, tx } = require('./db');
const mail = require('./mail');
const { euro, datum } = require('./format');
const { dagenTussen } = require('./score');

const NAAM = () => process.env.DEURWAARDER_NAAM || 'Armaere';

const DOSSIER_STATUS = {
  nieuw: 'Nieuw, nog niet geopend',
  in_behandeling: 'In behandeling',
  betalingsregeling: 'Betalingsregeling',
  dagvaarding: 'Dagvaarding',
  beslag: 'Beslag',
  betaald: 'Volledig betaald',
  oninbaar: 'Oninbaar, gesloten',
  teruggetrokken: 'Teruggetrokken door Pouw',
};
const GESLOTEN = ['betaald', 'oninbaar', 'teruggetrokken'];

// Artikel 4.7 van de KNV-voorwaarden: particulieren volgens het Besluit (de staffel hieronder, pas 15 dagen na de
// 14-dagenbrief); zakelijke opdrachtgevers 15% van de openstaande hoofdsom met een minimum van € 150 (artikel 4.7b).
function incassokosten(hoofdsomCent, klanttype) {
  if (hoofdsomCent <= 0) return 0;
  if (klanttype === 'particulier') return wettelijkeIncassokosten(hoofdsomCent);
  return Math.max(Math.round(hoofdsomCent * 0.15), 15000);
}
function grondslag(klanttype) {
  return klanttype === 'particulier'
    ? 'wettelijke staffel (Besluit vergoeding voor buitengerechtelijke incassokosten)'
    : 'artikel 4.7b KNV-voorwaarden: 15% van de hoofdsom, minimaal € 150';
}

// Begonnen maanden tussen twee datums; een gedeelte van een maand telt als een hele maand (artikel 4.6).
function begonnenMaanden(van, tot) {
  const a = new Date(van);
  const b = new Date(tot);
  if (b <= a) return 0;
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() > a.getUTCDate()) m += 1;
  return Math.max(1, m);
}

// Rente over het achterstallige bedrag: zakelijk 1,5% per begonnen maand zonder ingebrekestelling (artikel 4.6);
// particulier de wettelijke rente per jaar naar rato van de dagen (WETTELIJKE_RENTE_PCT, standaard 6; controleer het geldende percentage).
const WETTELIJKE_RENTE_PCT = Number(process.env.WETTELIJKE_RENTE_PCT || 6);
function rente(hoofdsomCent, vervaldatum, klanttype, nu = new Date()) {
  if (!hoofdsomCent || hoofdsomCent <= 0 || !vervaldatum) return { bedrag: 0, maanden: 0, dagen: 0, omschrijving: 'geen' };
  const dagen = Math.max(0, dagenTussen(vervaldatum, nu));
  if (dagen === 0) return { bedrag: 0, maanden: 0, dagen: 0, omschrijving: 'nog niet vervallen' };
  if (klanttype === 'particulier') {
    const bedrag = Math.round((hoofdsomCent * (WETTELIJKE_RENTE_PCT / 100) * dagen) / 365);
    return { bedrag, maanden: 0, dagen, omschrijving: `wettelijke rente ${WETTELIJKE_RENTE_PCT}% per jaar over ${dagen} dag(en)` };
  }
  const maanden = begonnenMaanden(vervaldatum, nu);
  return { bedrag: Math.round(hoofdsomCent * 0.015 * maanden), maanden, dagen, omschrijving: `1,5% per begonnen maand (artikel 4.6 KNV), ${maanden} maand(en)` };
}

/**
 * Wettelijke buitengerechtelijke incassokosten (Besluit vergoeding voor buitengerechtelijke incassokosten).
 * Staffel over de hoofdsom, minimaal € 40, maximaal € 6.775, exclusief btw. In centen.
 */
function wettelijkeIncassokosten(hoofdsomCent) {
  if (hoofdsomCent <= 0) return 0;
  const schijven = [
    [250000, 0.15],
    [250000, 0.1],
    [500000, 0.05],
    [19000000, 0.01],
    [Infinity, 0.005],
  ];
  let rest = hoofdsomCent;
  let kosten = 0;
  for (const [grootte, pct] of schijven) {
    const deel = Math.min(rest, grootte);
    kosten += deel * pct;
    rest -= deel;
    if (rest <= 0) break;
  }
  return Math.round(Math.min(677500, Math.max(4000, kosten)));
}

/**
 * Mag deze factuur naar de deurwaarder?
 * Alle klanten: aanmaning verstuurd (herinneringsniveau 4).
 * Particulieren: daarnaast moeten 14 dagen na de 14-dagenbrief verstreken zijn (+1 dag voor ontvangst).
 */
function magOverdragen(f, klanttype, nu = new Date(), openMeldingen = 0) {
  if (f.betaald_op) return { mag: false, reden: 'De factuur is al betaald.' };
  if (openMeldingen > 0) return { mag: false, reden: `Er ${openMeldingen === 1 ? 'staat nog 1 melding' : `staan nog ${openMeldingen} meldingen`} open (klacht, afspraak, creditnota). Eerst oplossen, dan pas overdragen.` };
  if (f.incasso) return { mag: false, reden: `De factuur is al overgedragen aan ${NAAM()}.` };
  if (f.herinnering_niveau < 4) return { mag: false, reden: 'Eerst moet de aanmaning verstuurd zijn (17 dagen na de vervaldatum).' };
  if (klanttype === 'particulier') {
    if (!f.laatste_herinnering_op) return { mag: false, reden: 'De datum van de 14-dagenbrief is onbekend.' };
    const dagen = dagenTussen(f.laatste_herinnering_op, nu);
    if (dagen < 15) return { mag: false, reden: `Particulier: wacht tot 14 dagen na de 14-dagenbrief. Nog ${15 - dagen} dag(en).` };
  }
  return { mag: true, reden: null };
}

async function overdragen(factuurId, notitie) {
  const res = await tx(async (c) => {
    const f = (await c.query('SELECT * FROM facturen WHERE id=$1 FOR UPDATE', [factuurId])).rows[0];
    if (!f) throw new Error('Factuur niet gevonden.');
    const k = (await c.query('SELECT type FROM klanten WHERE id=$1', [f.klant_id])).rows[0];
    const check = magOverdragen(f, k.type);
    if (!check.mag) throw new Error(check.reden);
    const kosten = incassokosten(f.te_betalen_cent, k.type);
    const r = rente(f.te_betalen_cent, f.vervaldatum, k.type);
    const d = (
      await c.query(
        `INSERT INTO dossiers (factuur_id, aanvraag_id, klant_id, hoofdsom_cent, incassokosten_cent, rente_cent, grondslag)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [f.id, f.aanvraag_id, f.klant_id, f.te_betalen_cent, kosten, r.bedrag, `${grondslag(k.type)}; rente: ${r.omschrijving}`],
      )
    ).rows[0];
    await c.query('UPDATE facturen SET incasso=true WHERE id=$1', [f.id]);
    if (notitie) await c.query('INSERT INTO dossier_berichten (dossier_id, van, tekst) VALUES ($1,$2,$3)', [d.id, 'Pouw Vervoer', notitie]);
    await c.query('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [
      f.aanvraag_id,
      f.klant_id,
      'incasso',
      `Factuur ${f.nummer} overgedragen aan ${NAAM()} (dossier D-${d.id}). Hoofdsom ${euro(f.te_betalen_cent)}, incassokosten ${euro(kosten)} (${grondslag(k.type)}), rente tot vandaag ${euro(r.bedrag)} (${r.omschrijving}).`,
    ]);
    return { d, f };
  });
  if (process.env.DEURWAARDER_EMAIL) {
    await mail.verstuur({
      aan: process.env.DEURWAARDER_EMAIL,
      onderwerp: `Nieuw dossier D-${res.d.id} van Pouw Vervoer`,
      tekst:
        `Pouw Vervoer heeft factuur ${res.f.nummer} aan u overgedragen (hoofdsom ${euro(res.d.hoofdsom_cent)}).\n` +
        `Het volledige dossier staat in het portaal: ${(process.env.BASE_URL || '').replace(/\/$/, '')}/deurwaarder/dossier/${res.d.id}`,
      aanvraagId: res.f.aanvraag_id,
      klantId: res.f.klant_id,
    });
  }
  return res.d;
}

async function bericht(dossierId, van, tekst) {
  tekst = String(tekst || '').trim().slice(0, 4000);
  if (!tekst) throw new Error('Typ een bericht.');
  await q('INSERT INTO dossier_berichten (dossier_id, van, tekst) VALUES ($1,$2,$3)', [dossierId, van, tekst]);
}

async function zetStatus(dossierId, status, door) {
  if (!DOSSIER_STATUS[status]) throw new Error('Onbekende status.');
  const d = await one('SELECT * FROM dossiers WHERE id=$1', [dossierId]);
  if (!d) throw new Error('Dossier niet gevonden.');
  if (GESLOTEN.includes(d.status)) throw new Error('Dit dossier is gesloten.');
  if (status === 'teruggetrokken' && door !== 'Pouw Vervoer') throw new Error('Alleen Pouw kan een dossier terugtrekken.');
  await q(`UPDATE dossiers SET status=$2, gesloten_op = CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1`, [
    dossierId,
    status,
    GESLOTEN.includes(status),
  ]);
  await q('INSERT INTO dossier_berichten (dossier_id, van, tekst) VALUES ($1,$2,$3)', [
    dossierId,
    door,
    `Status gewijzigd naar: ${DOSSIER_STATUS[status]}.`,
  ]);
  await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [
    d.aanvraag_id,
    d.klant_id,
    'incasso',
    `Dossier D-${d.id}: ${DOSSIER_STATUS[status]} (door ${door}).`,
  ]);
}

// Ontvangst bij de deurwaarder. Is de hoofdsom voldaan, dan staat de factuur bij Pouw op betaald.
async function registreerBetaling(dossierId, bedragCent, datumStr, omschrijving) {
  if (!bedragCent || bedragCent <= 0) throw new Error('Vul een bedrag in.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datumStr || '')) throw new Error('Vul een datum in.');
  return tx(async (c) => {
    const d = (await c.query('SELECT * FROM dossiers WHERE id=$1 FOR UPDATE', [dossierId])).rows[0];
    if (!d) throw new Error('Dossier niet gevonden.');
    if (GESLOTEN.includes(d.status)) throw new Error('Dit dossier is gesloten.');
    await c.query('INSERT INTO dossier_betalingen (dossier_id, bedrag_cent, datum, omschrijving) VALUES ($1,$2,$3,$4)', [
      d.id, bedragCent, datumStr, String(omschrijving || '').slice(0, 200) || null,
    ]);
    const ontvangen = d.ontvangen_cent + bedragCent;
    await c.query('UPDATE dossiers SET ontvangen_cent=$2 WHERE id=$1', [d.id, ontvangen]);
    let tekst = `Betaling ontvangen door ${NAAM()}: ${euro(bedragCent)} op ${datum(datumStr)}. Totaal ontvangen ${euro(ontvangen)}.`;
    if (ontvangen >= d.hoofdsom_cent) {
      await c.query('UPDATE facturen SET betaald_op=$2 WHERE id=$1 AND betaald_op IS NULL', [d.factuur_id, datumStr]);
      await c.query("UPDATE aanvragen SET status='betaald' WHERE id=$1 AND status <> 'geannuleerd'", [d.aanvraag_id]);
      tekst += ' Hoofdsom voldaan: factuur staat op betaald.';
    }
    if (ontvangen >= d.hoofdsom_cent + d.incassokosten_cent + (d.rente_cent || 0)) {
      await c.query("UPDATE dossiers SET status='betaald', gesloten_op=now() WHERE id=$1", [d.id]);
      tekst += ' Dossier gesloten.';
    }
    await c.query('INSERT INTO dossier_berichten (dossier_id, van, tekst) VALUES ($1,$2,$3)', [d.id, NAAM(), tekst]);
    await c.query('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [d.aanvraag_id, d.klant_id, 'incasso', tekst]);
  });
}

// Alles wat de deurwaarder nodig heeft als bewijs, en niets meer.
async function dossierVolledig(dossierId) {
  const d = await one('SELECT * FROM dossiers WHERE id=$1', [dossierId]);
  if (!d) return null;
  const [f, a, k, termijnen, nakosten, berichten, betalingen, mails] = await Promise.all([
    one('SELECT * FROM facturen WHERE id=$1', [d.factuur_id]),
    one('SELECT * FROM aanvragen WHERE id=$1', [d.aanvraag_id]),
    one('SELECT * FROM klanten WHERE id=$1', [d.klant_id]),
    all('SELECT * FROM termijnen WHERE aanvraag_id=$1 ORDER BY id', [d.aanvraag_id]),
    all('SELECT * FROM nakosten WHERE aanvraag_id=$1 ORDER BY id', [d.aanvraag_id]),
    all('SELECT * FROM dossier_berichten WHERE dossier_id=$1 ORDER BY created_at, id', [d.id]),
    all('SELECT * FROM dossier_betalingen WHERE dossier_id=$1 ORDER BY datum, id', [d.id]),
    all("SELECT * FROM events WHERE aanvraag_id=$1 AND type IN ('mail','akkoord','offerte','factuur','betaling','status') ORDER BY created_at, id", [d.aanvraag_id]),
  ]);
  return { d, f, a, k, termijnen, nakosten, berichten, betalingen, mails };
}

module.exports = {
  NAAM, DOSSIER_STATUS, GESLOTEN, wettelijkeIncassokosten, incassokosten, grondslag, begonnenMaanden, rente, magOverdragen, overdragen, bericht, zetStatus,
  registreerBetaling, dossierVolledig,
};
