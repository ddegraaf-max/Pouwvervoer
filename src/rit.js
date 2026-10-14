// Digitale chauffeursbriefing en ritrapport. De chauffeur opent de rit op zijn telefoon via een persoonlijke link,
// werkt de checklist af en legt onderweg vast wat afwijkt: schade aan de bus, rotzooi, afwijkingen van de afspraak,
// extra kosten en incidenten, met foto's. Alles komt in het dossier (logboek) en, waar het geld of een dispuut
// raakt, als melding op de werklijst: eerst afhandelen, dan pas factureren. Schade en vervuiling door reizigers
// zijn voor rekening van de opdrachtgever (KNV-voorwaarden artikel 9.7 en 9.13); dat is alleen aantoonbaar als het
// op de dag zelf met foto's is vastgelegd.
const crypto = require('crypto');
const { q, one, all } = require('./db');
const meldingen = require('./meldingen');
const mail = require('./mail');
const beleid = require('./beleid');
const { euro, datum, parseEuro } = require('./format');

const SOORTEN = {
  start: { label: 'Controle vóór vertrek', hint: 'Staat van de bus bij vertrek, met foto\'s als bewijs voor later.', bedrag: false },
  schade: { label: 'Schade aan de bus', hint: 'Wat, waar op de bus en door wie. Maak foto\'s van de schade.', bedrag: true },
  rotzooi: { label: 'Rotzooi of vervuiling', hint: 'Extra schoonmaak nodig. Maak foto\'s vóór het opruimen.', bedrag: true },
  afwijking: { label: 'Afwijking van de afspraak', hint: 'Andere tijd, route, extra stop of extra uren, en op wiens verzoek.', bedrag: false },
  kosten: { label: 'Extra kosten', hint: 'Tol, parkeergeld, pont, maaltijd: het bedrag en een foto van de bon.', bedrag: true },
  incident: { label: 'Incident of overlast', hint: 'Reizigers, veiligheid, politie: wat er gebeurde en wat u heeft gedaan.', bedrag: false },
  opmerking: { label: 'Opmerking', hint: 'Alles wat de planning verder moet weten.', bedrag: false },
};

// Welke rapportmeldingen een melding op de werklijst worden, en wie die oplost voordat de factuur gaat.
const WERKLIJST = {
  schade: { soort: 'schade', eigenaar: 'administratie' },
  rotzooi: { soort: 'schoonmaak', eigenaar: 'administratie' },
  kosten: { soort: 'nakosten', eigenaar: 'administratie' },
  afwijking: { soort: 'uitvoering', eigenaar: 'planning' },
  incident: { soort: 'uitvoering', eigenaar: 'operatie' },
};

const CHECKLIST = [
  ['aanwezig', 'Op tijd aanwezig, ook bij elke tussenstop'],
  ['bus_vooraf', 'Bus binnen en buiten gecontroleerd vóór vertrek (schade? foto in het rapport)'],
  ['reisleider', 'Reisleider gesproken en de afspraken doorgenomen'],
  ['bonnen', 'Bonnen van tol, parkeergeld en pont bewaard en gefotografeerd'],
  ['afwijkingen', 'Afwijkingen (extra kilometers, extra uren, andere route) in het rapport gezet'],
  ['bus_achteraf', 'Bus na de rit gecontroleerd op schade en rotzooi (met foto\'s)'],
];

const MAX_FOTOS = 4;
const MAX_FOTO_BYTES = 2 * 1024 * 1024;
const GELDIG_DAGEN_NA_RIT = 14;

function token() {
  return crypto.randomBytes(24).toString('base64url');
}

function valideerMelding(b = {}) {
  const soort = SOORTEN[b.soort] ? b.soort : 'opmerking';
  const omschrijving = String(b.omschrijving || '').trim().slice(0, 2000);
  const locatie = String(b.locatie || '').trim().slice(0, 200);
  const bedragRaw = String(b.bedrag || '').trim();
  const bedrag = bedragRaw ? parseEuro(bedragRaw) : null;
  const fouten = [];
  if (!omschrijving && soort !== 'start') fouten.push('Beschrijf kort wat er aan de hand is.');
  if (bedragRaw && bedrag == null) fouten.push('Vul het bedrag in als 12,50.');
  return {
    ok: !fouten.length,
    fouten,
    waarde: { soort, omschrijving: omschrijving || (soort === 'start' ? 'Bus gecontroleerd vóór vertrek.' : ''), locatie, bedrag_cent: bedrag },
  };
}

// Foto's komen als data-url, door de browser al verkleind. Alleen jpeg, png of webp, en begrensd in grootte en aantal.
function parseFoto(s) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) return null;
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || data.length > MAX_FOTO_BYTES) return null;
  return { mime: m[1], data };
}
function parseFotos(lijst) {
  return (Array.isArray(lijst) ? lijst : []).slice(0, MAX_FOTOS).map(parseFoto).filter(Boolean);
}

function normaliseerChecklist(b = {}) {
  const items = [].concat(b.items || []).map(String);
  const uit = {};
  for (const [id] of CHECKLIST) uit[id] = items.includes(id);
  return uit;
}

const isoDag = (d) =>
  d instanceof Date
    ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    : String(d).slice(0, 10);

// De link werkt voor bevestigde en gereden ritten, tot N dagen na de laatste ritdag (late meldingen kunnen nog).
function linkGeldig(a, nu = new Date()) {
  if (!a || !a.chauffeur_token) return false;
  if (!['bevestigd', 'gereden', 'gefactureerd', 'betaald'].includes(a.status)) return false;
  const laatste = a.datum_terug || a.rit_datum;
  if (!laatste) return true;
  const eind = Date.parse(`${isoDag(laatste)}T00:00:00Z`) + (GELDIG_DAGEN_NA_RIT + 1) * 864e5;
  return nu.getTime() < eind;
}

function samenvatting(lijst) {
  const telling = {};
  for (const m of lijst) telling[m.soort] = (telling[m.soort] || 0) + 1;
  const delen = Object.entries(telling).map(([s, n]) => `${n}× ${SOORTEN[s] ? SOORTEN[s].label.toLowerCase() : s}`);
  return delen.length ? delen.join(', ') : 'geen meldingen';
}

async function log(aanvraagId, klantId, tekst) {
  await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [aanvraagId, klantId, 'rit', tekst]);
}

// ---- Koppeling en toegang ----
async function koppel(aanvraagId, { naam, tel } = {}, door = 'backoffice', vernieuw = false) {
  const a = await one('SELECT id, klant_id, chauffeur_token FROM aanvragen WHERE id=$1', [aanvraagId]);
  if (!a) throw new Error('Aanvraag niet gevonden.');
  const nieuw = !a.chauffeur_token || vernieuw;
  const t = nieuw ? token() : a.chauffeur_token;
  const n = String(naam || '').trim().slice(0, 120);
  const tl = String(tel || '').trim().slice(0, 40);
  await q('UPDATE aanvragen SET chauffeur_token=$2, chauffeur_naam=$3, chauffeur_tel=$4 WHERE id=$1', [a.id, t, n || null, tl || null]);
  if (nieuw) await log(a.id, a.klant_id, `Digitale briefing ${vernieuw ? 'vernieuwd (oude link vervallen)' : 'gekoppeld'} door ${door}${n ? ` voor chauffeur ${n}` : ''}.`);
  return t;
}

async function metToken(t) {
  if (!t || String(t).length < 20) return null;
  const a = await one('SELECT * FROM aanvragen WHERE chauffeur_token=$1', [String(t)]);
  if (!a || !linkGeldig(a)) return null;
  const k = await one('SELECT * FROM klanten WHERE id=$1', [a.klant_id]);
  return { a, k };
}

// ---- Rapport ----
async function rapport(aanvraagId) {
  const lijst = await all('SELECT * FROM rit_meldingen WHERE aanvraag_id=$1 ORDER BY created_at DESC, id DESC', [aanvraagId]);
  if (!lijst.length) return [];
  const fotos = await all('SELECT id, rit_melding_id, mime, bytes FROM rit_fotos WHERE aanvraag_id=$1 ORDER BY id', [aanvraagId]);
  return lijst.map((m) => ({ ...m, fotos: fotos.filter((f) => f.rit_melding_id === m.id) }));
}

async function zetChecklist(a, items, door) {
  const c = normaliseerChecklist({ items });
  const eerste = !a.rit_gestart_op;
  await q('UPDATE aanvragen SET rit_checklist=$2, rit_gestart_op=COALESCE(rit_gestart_op, now()) WHERE id=$1', [a.id, JSON.stringify(c)]);
  if (eerste) await log(a.id, a.klant_id, `Chauffeur ${door} is met de rit begonnen (checklist geopend).`);
  return c;
}

async function voegMeldingToe(a, k, waarde, fotos, door, baseUrl) {
  const rij = await one(
    'INSERT INTO rit_meldingen (aanvraag_id, soort, omschrijving, bedrag_cent, locatie, door) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [a.id, waarde.soort, waarde.omschrijving, waarde.bedrag_cent, waarde.locatie || null, door],
  );
  for (const f of fotos) {
    await q('INSERT INTO rit_fotos (aanvraag_id, rit_melding_id, mime, bytes, data) VALUES ($1,$2,$3,$4,$5)', [a.id, rij.id, f.mime, f.data.length, f.data]);
  }
  const label = SOORTEN[waarde.soort].label;
  const extra = [waarde.locatie, waarde.bedrag_cent != null ? euro(waarde.bedrag_cent) : ''].filter(Boolean).join(', ');
  const fotoTekst = fotos.length ? `, ${fotos.length} foto${fotos.length === 1 ? '' : "'s"}` : '';
  await log(a.id, a.klant_id, `Ritrapport R-${rij.id} (${label}${extra ? `, ${extra}` : ''}${fotoTekst}) door chauffeur ${door}: ${waarde.omschrijving}`);

  const w = WERKLIJST[waarde.soort];
  let melding = null;
  if (w) {
    melding = await meldingen.maak(a.id, {
      soort: w.soort,
      eigenaar: w.eigenaar,
      omschrijving: `${label}${extra ? ` (${extra})` : ''}: ${waarde.omschrijving} [ritrapport R-${rij.id}${fotoTekst}]`,
      door: `chauffeur ${door}`,
    });
    await q('UPDATE rit_meldingen SET melding_id=$2 WHERE id=$1', [rij.id, melding.id]);
    await mail.verstuur({
      aan: beleid.MAIL_PLANNING,
      onderwerp: `Ritrapport EPV-${a.id} (${k.naam}, ${datum(a.rit_datum)}): ${label}`,
      tekst:
        `Chauffeur ${door} heeft in het ritrapport van EPV-${a.id} (${k.naam}, ${datum(a.rit_datum)}) vastgelegd:\n\n` +
        `${label}${extra ? ` (${extra})` : ''}\n${waarde.omschrijving}\n${fotos.length ? `${fotos.length} foto('s) in het dossier.\n` : ''}\n` +
        `Werklijst: melding M-${melding.id}, eigenaar ${meldingen.EIGENAREN[w.eigenaar]}, deadline ${datum(melding.deadline)}. ` +
        `Zolang de melding open staat, gaan er geen herinneringen naar de klant en kan de factuur niet worden overgedragen.\n\n` +
        `Briefing en rapport: ${baseUrl}/admin/aanvraag/${a.id}/briefing#rapport`,
      aanvraagId: a.id,
      klantId: k.id,
    });
  }
  return { ...rij, melding_id: melding ? melding.id : null, fotos: fotos.length };
}

async function rondAf(a, k, slot, door, baseUrl) {
  const s = String(slot || '').trim().slice(0, 2000);
  await q('UPDATE aanvragen SET rit_afgerond_op=now(), rit_slot=$2, rit_gestart_op=COALESCE(rit_gestart_op, now()) WHERE id=$1', [a.id, s || null]);
  const lijst = await rapport(a.id);
  await log(a.id, a.klant_id, `Rit afgerond door chauffeur ${door} (${samenvatting(lijst)})${s ? `: ${s}` : '.'}`);
  await mail.verstuur({
    aan: beleid.MAIL_PLANNING,
    onderwerp: `Rit EPV-${a.id} afgerond (${k.naam}, ${datum(a.rit_datum)})`,
    tekst:
      `Chauffeur ${door} heeft de rit EPV-${a.id} (${k.naam}, ${datum(a.rit_datum)}, ${a.van} → ${a.naar}) afgerond.\n\n` +
      `Ritrapport: ${samenvatting(lijst)}.\n${s ? `Slotopmerking: ${s}\n` : ''}\n` +
      `Briefing en rapport: ${baseUrl}/admin/aanvraag/${a.id}/briefing#rapport`,
    aanvraagId: a.id,
    klantId: k.id,
  });
  return lijst;
}

async function foto(id, aanvraagId) {
  return one('SELECT mime, data FROM rit_fotos WHERE id=$1 AND aanvraag_id=$2', [id, aanvraagId]);
}

module.exports = {
  SOORTEN, WERKLIJST, CHECKLIST, MAX_FOTOS, MAX_FOTO_BYTES, GELDIG_DAGEN_NA_RIT,
  token, valideerMelding, parseFoto, parseFotos, normaliseerChecklist, linkGeldig, samenvatting,
  koppel, metToken, rapport, zetChecklist, voegMeldingToe, rondAf, foto,
};
