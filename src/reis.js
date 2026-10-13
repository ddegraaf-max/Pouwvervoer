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

// Aantal reisdagen (heen- en terugdag meegeteld).
function dagen(v) {
  if (v.reistype === 'enkel' || !v.datum_terug || !v.datum_heen) return 1;
  const d = Math.round((Date.parse(`${v.datum_terug}T00:00:00Z`) - Date.parse(`${v.datum_heen}T00:00:00Z`)) / 864e5);
  return Number.isFinite(d) && d >= 0 ? d + 1 : 1;
}

function ritsoort(v) {
  if (v.reistype === 'enkel') return 'enkel';
  return dagen(v) > 1 ? 'meerdaags' : 'brengen_halen';
}

function soortLabel(v) {
  if (v.reistype === 'enkel') return 'Enkele reis';
  const n = dagen(v);
  return n > 1 ? `Meerdaagse reis, ${n} dagen` : 'Retour op dezelfde dag';
}

// Velden voor de tabel aanvragen uit een gevalideerde reis.
function velden(v) {
  const retour = v.reistype === 'retour';
  const anders = retour && !!v.andere_route;
  const stops = (p) => (v[`${p}via`] || []).map((adres, i) => ({ adres, wacht: (v[`${p}wacht`] || [])[i] ?? 15 }));
  return {
    reistype: v.reistype,
    rit_datum: v.datum_heen,
    vertrek_tijd: v.tijd_heen,
    tijdtype_heen: v.tijdtype_heen,
    van: v.van,
    naar: v.naar,
    via: stops(''),
    personen: v.personen,
    datum_terug: retour ? v.datum_terug : '',
    tijd_terug: retour ? v.tijd_terug : '',
    tijdtype_terug: retour ? v.tijdtype_terug : '',
    andere_route: anders,
    terug_van: anders ? v.terug_van : '',
    terug_naar: anders ? v.terug_naar : '',
    terug_via: anders ? stops('terug_') : [],
    ritsoort: ritsoort(v),
  };
}

// Reis-vorm uit een rij van de tabel aanvragen, ook voor oude rijen zonder de nieuwe kolommen.
function vanAanvraag(a) {
  const stops = (x) => (Array.isArray(x) ? x : []).filter((s) => s && s.adres);
  const via = stops(a.via);
  const tvia = stops(a.terug_via);
  return {
    reistype: a.reistype || (a.ritsoort === 'enkel' ? 'enkel' : 'retour'),
    personen: a.personen != null ? String(a.personen) : '',
    van: a.van || '',
    naar: a.naar || '',
    via: via.map((s) => s.adres),
    wacht: via.map((s) => dichtstbij(s.wacht)),
    tijdtype_heen: a.tijdtype_heen || 'vertrek',
    datum_heen: a.rit_datum ? fmt.iso(a.rit_datum) : '',
    tijd_heen: a.vertrek_tijd || '',
    andere_route: !!a.andere_route,
    terug_van: a.terug_van || '',
    terug_naar: a.terug_naar || '',
    terug_via: tvia.map((s) => s.adres),
    terug_wacht: tvia.map((s) => dichtstbij(s.wacht)),
    tijdtype_terug: a.tijdtype_terug || 'aankomst',
    datum_terug: a.datum_terug ? fmt.iso(a.datum_terug) : '',
    tijd_terug: a.tijd_terug || '',
    bus_blijft: !!a.bus_blijft || a.ritsoort === 'hele_dag',
  };
}

module.exports = { MAX_STOPS, WACHTTIJDEN, wachtLabel, vandaag, dichtstbij, leeg, valideer, samenvatting, dagen, ritsoort, soortLabel, velden, vanAanvraag };
