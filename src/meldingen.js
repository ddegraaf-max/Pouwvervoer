// Meldingen: de losse eindjes die betaalproblemen veroorzaken (onduidelijke afspraak van sales, planning die anders
// uitvoert, chauffeur te laat, klacht niet verwerkt, creditnota die uitblijft, foutieve invoer in Trip). Elke melding
// heeft een eigenaar en een deadline, zodat de verantwoordelijkheid zichtbaar bij de organisatie ligt. Zolang er voor een
// aanvraag een melding open staat, pauzeren de herinneringen en kan de factuur niet naar de deurwaarder: eerst oplossen,
// dan pas aanmanen. De werklijst op /admin toont alles wat open staat, op volgorde van deadline.
const { q, one, all } = require('./db');
const mail = require('./mail');
const { datum } = require('./format');
const { dagenTussen } = require('./score');

const SOORTEN = {
  afspraak: 'Afspraak onduidelijk of niet vastgelegd (sales)',
  planning: 'Uitvoering anders dan afgesproken (planning)',
  uitvoering: 'Operationeel probleem: chauffeur te laat, bus, route',
  klacht: 'Klacht van de klant',
  credit: 'Creditnota nodig',
  trip: 'Foutieve invoer in Trip',
  betaling: 'Betalingsdispuut of liquiditeit van de klant',
  anders: 'Anders',
};
const EIGENAREN = { sales: 'Sales', planning: 'Planning', operatie: 'Operatie', administratie: 'Administratie', directie: 'Directie' };
const STANDAARD_EIGENAAR = {
  afspraak: 'sales', planning: 'planning', uitvoering: 'operatie', klacht: 'administratie', credit: 'administratie', trip: 'planning', betaling: 'administratie', anders: 'directie',
};
// Interne termijn om een melding op te lossen. De KNV-voorwaarden (artikel 11.3) eisen afhandeling van een klacht binnen een maand.
const WERKDAGEN = Number(process.env.MELDING_WERKDAGEN || 5);
const MAIL_PLANNING = process.env.MAIL_PLANNING || 'info@pouwvervoer.nl';

// Datum n werkdagen na 'vanaf' (weekend telt niet mee), als JJJJ-MM-DD.
function werkdagenLater(n, vanaf = new Date()) {
  const d = new Date(Date.UTC(vanaf.getUTCFullYear(), vanaf.getUTCMonth(), vanaf.getUTCDate()));
  let rest = n;
  while (rest > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dag = d.getUTCDay();
    if (dag !== 0 && dag !== 6) rest--;
  }
  return d.toISOString().slice(0, 10);
}

// Positief = zoveel dagen over de deadline; negatief = nog zoveel dagen te gaan.
function dagenOverDeadline(deadline, nu = new Date()) {
  return dagenTussen(deadline, nu);
}

function normaliseer({ soort, omschrijving, eigenaar, deadline, nu = new Date() }) {
  const s = SOORTEN[soort] ? soort : 'anders';
  const e = EIGENAREN[eigenaar] ? eigenaar : STANDAARD_EIGENAAR[s];
  const o = String(omschrijving || '').trim().slice(0, 2000);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(deadline || '')) ? deadline : werkdagenLater(WERKDAGEN, nu);
  return { soort: s, eigenaar: e, omschrijving: o, deadline: d };
}

async function log(aanvraagId, klantId, tekst) {
  await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [aanvraagId, klantId, 'melding', tekst]);
}

async function maak(aanvraagId, { soort, omschrijving, eigenaar, deadline, door = 'backoffice' }) {
  const a = await one('SELECT id, klant_id FROM aanvragen WHERE id=$1', [aanvraagId]);
  if (!a) throw new Error('Aanvraag niet gevonden.');
  const m = normaliseer({ soort, omschrijving, eigenaar, deadline });
  if (m.omschrijving.length < 5) throw new Error('Beschrijf de melding.');
  const rij = await one(
    `INSERT INTO meldingen (aanvraag_id, klant_id, soort, omschrijving, eigenaar, deadline, gemeld_door)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [a.id, a.klant_id, m.soort, m.omschrijving, m.eigenaar, m.deadline, door],
  );
  await log(a.id, a.klant_id, `Melding M-${rij.id} (${SOORTEN[m.soort]}) door ${door}, eigenaar ${EIGENAREN[m.eigenaar]}, deadline ${datum(m.deadline)}: ${m.omschrijving}`);
  return rij;
}

async function losOp(id, { oplossing, door = 'backoffice' }) {
  const o = String(oplossing || '').trim().slice(0, 2000);
  if (o.length < 3) throw new Error('Schrijf kort hoe het is opgelost.');
  const rij = await one("UPDATE meldingen SET status='opgelost', oplossing=$2, opgelost_op=now() WHERE id=$1 AND status='open' RETURNING *", [id, o]);
  if (!rij) throw new Error('Melding niet gevonden of al opgelost.');
  await log(rij.aanvraag_id, rij.klant_id, `Melding M-${rij.id} opgelost door ${door}: ${o}`);
  return rij;
}

async function voorAanvraag(aanvraagId) {
  return all("SELECT * FROM meldingen WHERE aanvraag_id=$1 ORDER BY (status='open') DESC, deadline, id", [aanvraagId]);
}

async function aantalOpen(aanvraagId) {
  const r = await one("SELECT count(*)::int n FROM meldingen WHERE aanvraag_id=$1 AND status='open'", [aanvraagId]);
  return r ? r.n : 0;
}

// Klacht van de klant via de akkoordpagina: melding voor de administratie, bericht aan de planning, bevestiging aan de klant.
async function klachtVanKlant(aanvraagId, { tekst, door, baseUrl }) {
  const a = await one('SELECT * FROM aanvragen WHERE id=$1', [aanvraagId]);
  if (!a) throw new Error('Aanvraag niet gevonden.');
  const k = await one('SELECT * FROM klanten WHERE id=$1', [a.klant_id]);
  const t = String(tekst || '').trim().slice(0, 2000);
  if (t.length < 10) throw new Error('Beschrijf uw klacht of vraag in minstens een paar woorden.');
  const m = await maak(a.id, { soort: 'klacht', omschrijving: t, eigenaar: 'administratie', door });
  await mail.verstuur({
    aan: MAIL_PLANNING,
    onderwerp: `Klacht EPV-${a.id} (${k.naam}, ${datum(a.rit_datum)}): melding M-${m.id}`,
    tekst: `${door} heeft een klacht ingediend over EPV-${a.id} (${k.naam}, ${datum(a.rit_datum)}, ${a.van} → ${a.naar}).\n\n${t}\n\nMelding M-${m.id}, eigenaar ${EIGENAREN[m.eigenaar]}, deadline ${datum(m.deadline)}. Zolang de melding open staat, gaan er geen herinneringen naar deze klant.\n\nDossier: ${baseUrl}/admin/aanvraag/${a.id}`,
    aanvraagId: a.id,
    klantId: k.id,
  });
  await mail.verstuur({
    aan: k.teken_email,
    cc: a.aanvrager_email,
    onderwerp: `Uw klacht over EPV-${a.id} is ontvangen`,
    tekst:
      `Beste ${k.tekenbevoegde},\n\nWij hebben uw klacht over de busrit van ${datum(a.rit_datum)} ontvangen:\n${t}\n\n` +
      `Wij nemen uiterlijk ${datum(m.deadline)} contact met u op en handelen de klacht binnen een maand af, zoals de voorwaarden voorschrijven (artikel 11). ` +
      'Zolang uw klacht in behandeling is, sturen wij geen betalingsherinneringen.\n\nMet vriendelijke groet,\nPouw Vervoer',
    aanvraagId: a.id,
    klantId: k.id,
  });
  return m;
}

// Werklijst voor de backoffice: alles wat open staat, zodat niets te lang blijft liggen.
async function werklijst(nu = new Date()) {
  const meldingen = await all(
    `SELECT m.*, a.rit_datum, a.status aanvraag_status, k.naam klant_naam
     FROM meldingen m JOIN aanvragen a ON a.id=m.aanvraag_id JOIN klanten k ON k.id=a.klant_id
     WHERE m.status='open' ORDER BY m.deadline, m.id`,
  );
  const perEigenaar = {};
  for (const m of meldingen) perEigenaar[m.eigenaar] = (perEigenaar[m.eigenaar] || 0) + 1;
  const wijzigingen = await all(
    `SELECT a.id, a.rit_datum, k.naam klant_naam FROM aanvragen a JOIN klanten k ON k.id=a.klant_id WHERE a.wijziging_open=true ORDER BY a.rit_datum`,
  );
  const signalen = await all(
    `SELECT a.id, a.rit_datum, k.naam klant_naam FROM aanvragen a JOIN klanten k ON k.id=a.klant_id WHERE a.signaal_planner=true AND a.status IN ('wacht_op_betaling','bevestigd') ORDER BY a.rit_datum`,
  );
  const offertes = await all(
    `SELECT a.id, a.rit_datum, a.offerte_geldig_tot, k.naam klant_naam FROM aanvragen a JOIN klanten k ON k.id=a.klant_id
     WHERE a.status='offerte_verstuurd' AND a.offerte_geldig_tot IS NOT NULL AND a.offerte_geldig_tot <= CURRENT_DATE + 3 ORDER BY a.offerte_geldig_tot`,
  );
  const facturen = await all(
    `SELECT f.id, f.nummer, f.aanvraag_id, f.te_betalen_cent, f.vervaldatum, f.herinnering_niveau, f.incasso, k.naam klant_naam, k.type klanttype,
            (SELECT count(*)::int FROM meldingen m WHERE m.aanvraag_id=f.aanvraag_id AND m.status='open') open_meldingen
     FROM facturen f JOIN klanten k ON k.id=f.klant_id
     WHERE f.betaald_op IS NULL AND f.te_betalen_cent > 0 AND f.vervaldatum < CURRENT_DATE ORDER BY f.vervaldatum`,
  );
  return {
    meldingen: meldingen.map((m) => ({ ...m, teLaat: dagenOverDeadline(m.deadline, nu) })),
    perEigenaar,
    wijzigingen,
    signalen,
    offertes: offertes.map((o) => ({ ...o, verlopen: dagenOverDeadline(o.offerte_geldig_tot, nu) > 0 })),
    facturen: facturen.map((f) => ({ ...f, dagenTeLaat: dagenOverDeadline(f.vervaldatum, nu) })),
  };
}

module.exports = {
  SOORTEN, EIGENAREN, STANDAARD_EIGENAAR, WERKDAGEN, werkdagenLater, dagenOverDeadline, normaliseer,
  maak, losOp, voorAanvraag, aantalOpen, klachtVanKlant, werklijst,
};
