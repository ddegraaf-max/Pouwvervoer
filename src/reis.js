// Reis-stap (/reis): dezelfde opbouw als de offertetool op aanvragen.pouwvervoer.nl.
// Valideert ritsoort, personen, route met tussenstops en wachttijden, en datum/tijd per richting.
// Vertaalt de reis daarna naar de velden van stap 1 van het aanvraagformulier.
const fmt = require('./format');

const MAX_STOPS = 5;
const WACHTTIJDEN = Array.from({ length: 16 }, (_, i) => (i + 1) * 15); // 15 min … 4 uur
const TIJDTYPES = ['vertrek', 'aankomst'];
const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const TIJD = /^([01]\d|2[0-3]):[0-5]\d$/;

function wachtLabel(min) {
  const u = Math.floor(min / 60);
  const m = min % 60;
  if (!u) return `${m} min`;
  if (!m) return `${u} uur`;
  return `${u} uur ${m} min`;
}

// Datum van vandaag in Nederland als 'JJJJ-MM-DD'.
function vandaag(nu = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nu);
}

function leeg() {
  return {
    reistype: 'retour', personen: '',
    van: '', naar: '', via: [], wacht: [],
    tijdtype_heen: 'vertrek', datum_heen: '', tijd_heen: '',
    andere_route: false, terug_van: '', terug_naar: '', terug_via: [], terug_wacht: [],
    tijdtype_terug: 'aankomst', datum_terug: '', tijd_terug: '',
  };
}

const lijst = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const tekst = (x, max = 200) => String(x ?? '').trim().slice(0, max);

// Wachttijd naar het dichtstbijzijnde kwartier uit de lijst (zoals de offertetool doet).
function dichtstbij(min) {
  const n = Number(min);
  if (!Number.isFinite(n)) return 15;
  return WACHTTIJDEN.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), 15);
}

function geldigeDatum(s) {
  if (!DATUM.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function route(b, p, v, f, richting) {
  v[`${p}van`] = tekst(b[`${p}van`]);
  v[`${p}naar`] = tekst(b[`${p}naar`]);
  let via = lijst(b[`${p}via`]).map((x) => tekst(x));
  const wacht = lijst(b[`${p}wacht`]).map(dichtstbij);
  if (via.length > MAX_STOPS) {
    f[`${p}via`] = `Maximaal ${MAX_STOPS} tussenstops${richting}.`;
    via = via.slice(0, MAX_STOPS);
  }
  v[`${p}via`] = via;
  v[`${p}wacht`] = via.map((_, i) => wacht[i] ?? 15);
  if (!v[`${p}van`]) f[`${p}van`] = `Vul het vertrekadres${richting} in.`;
  via.forEach((s, i) => {
    if (!s) f[`${p}via.${i}`] = `Vul tussenstop ${i + 1}${richting} in of verwijder deze.`;
  });
  if (!v[`${p}naar`]) f[`${p}naar`] = `Vul de bestemming${richting} in.`;
}

function wanneer(b, p, v, standaard) {
  v[`tijdtype_${p}`] = TIJDTYPES.includes(b[`tijdtype_${p}`]) ? b[`tijdtype_${p}`] : standaard;
  v[`datum_${p}`] = tekst(b[`datum_${p}`], 10);
  v[`tijd_${p}`] = tekst(b[`tijd_${p}`], 5);
}

function valideer(b = {}, nu = new Date()) {
  const f = {};
  const v = leeg();
  const vd = vandaag(nu);

  v.reistype = ['retour', 'enkel'].includes(b.reistype) ? b.reistype : '';
  if (!v.reistype) f.reistype = 'Kies retour of enkele reis.';

  v.personen = tekst(b.personen, 6);
  const p = Number(v.personen);
  if (!/^\d+$/.test(v.personen) || p < 1 || p > 15000) f.personen = 'Vul het aantal personen in.';

  route(b, '', v, f, '');

  wanneer(b, 'heen', v, 'vertrek');
  if (!v.datum_heen) f.datum_heen = 'Kies een datum.';
  else if (!geldigeDatum(v.datum_heen)) f.datum_heen = 'Kies een geldige datum.';
  else if (v.datum_heen < vd) f.datum_heen = 'De datum ligt in het verleden.';
  if (!v.tijd_heen) f.tijd_heen = 'Kies een tijd.';
  else if (!TIJD.test(v.tijd_heen)) f.tijd_heen = 'Kies een geldige tijd.';

  if (v.reistype !== 'enkel') {
    v.andere_route = b.andere_route === 'on';
    if (v.andere_route) route(b, 'terug_', v, f, ' van de terugreis');
    wanneer(b, 'terug', v, 'aankomst');
    if (!v.datum_terug) f.datum_terug = 'Kies een datum voor de terugreis.';
    else if (!geldigeDatum(v.datum_terug)) f.datum_terug = 'Kies een geldige datum voor de terugreis.';
    else if (!f.datum_heen && v.datum_terug < v.datum_heen) f.datum_terug = 'De terugreis kan niet vóór de heenreis zijn.';
    if (!v.tijd_terug) f.tijd_terug = 'Kies een tijd voor de terugreis.';
    else if (!TIJD.test(v.tijd_terug)) f.tijd_terug = 'Kies een geldige tijd voor de terugreis.';
    else if (!f.datum_heen && !f.datum_terug && !f.tijd_heen && v.datum_terug === v.datum_heen && v.tijd_terug <= v.tijd_heen) {
      f.tijd_terug = 'De tijd van de terugreis moet na die van de heenreis liggen.';
    }
  }

  return { fouten: f, lijst: Object.values(f), v };
}

function routeTekst(v, p) {
  const via = v[`${p}via`].map((s, i) => `${s} (wacht ${wachtLabel(v[`${p}wacht`][i])})`);
  return [v[`${p}van`], ...via, v[`${p}naar`]].join(' → ');
}

function tijdTekst(v, p) {
  return `${v[`tijdtype_${p}`] === 'aankomst' ? 'aankomst' : 'vertrek'} ${fmt.datum(v[`datum_${p}`])} om ${v[`tijd_${p}`]}`;
}

// Korte samenvatting voor het veld Bijzonderheden en de backoffice.
function samenvatting(v) {
  const r = [`Heenreis: ${routeTekst(v, '')}, ${tijdTekst(v, 'heen')}.`];
  if (v.reistype === 'retour') {
    r.push(`Terugreis: ${v.andere_route ? `${routeTekst(v, 'terug_')}, ` : 'zelfde route terug, '}${tijdTekst(v, 'terug')}.`);
  }
  return r.join('\n');
}

// Vult de velden van stap 1 (De rit) van het aanvraagformulier.
function naarAanvraag(v) {
  const retour = v.reistype === 'retour';
  const meerdaags = retour && !!v.datum_terug && v.datum_terug !== v.datum_heen;
  return {
    rit_datum: v.datum_heen,
    vertrek_tijd: v.tijdtype_heen === 'vertrek' ? v.tijd_heen : '',
    van: v.van,
    naar: v.naar,
    personen: v.personen,
    ritsoort: !retour ? 'enkel' : meerdaags ? 'meerdaags' : 'brengen_halen',
    opmerkingen: samenvatting(v),
  };
}

module.exports = { MAX_STOPS, WACHTTIJDEN, wachtLabel, vandaag, dichtstbij, leeg, valideer, samenvatting, naarAanvraag };
