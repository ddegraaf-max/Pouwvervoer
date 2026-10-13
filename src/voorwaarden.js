// Algemene Vervoer- en Reisvoorwaarden van Busvervoer Nederland (KNV), gedeponeerd 8 april 2025 onder nr. 6/2025
// ter griffie van de rechtbank Den Haag. Dit bestand regelt: waar de voorwaarden staan en welke versie geldt,
// de pdf als bijlage (terhandstelling, art. 6:234 BW) met een hash als bewijs, de annuleringsregeling van artikel 5.1
// en de gegevens van Pouw als vervoerder voor de wettelijke informatie vóór de bestelling.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAAM = 'Algemene Vervoer- en Reisvoorwaarden van KNV Busvervoer';
const VERSIE = process.env.VOORWAARDEN_VERSIE || 'KNV Busvervoer 2025';
const URL = process.env.VOORWAARDEN_URL || '/documenten/knv-busvervoer-2025.pdf';
const DEPOT = 'gedeponeerd op 8 april 2025 onder nr. 6/2025 ter griffie van de rechtbank Den Haag';
const BESTAND = path.join(__dirname, '..', 'public', 'documenten', 'knv-busvervoer-2025.pdf');
const BIJLAGE_NAAM = 'Algemene-vervoer-en-reisvoorwaarden-KNV-Busvervoer-2025.pdf';

// Vervoerder, voor de informatie die de klant vóór de bestelling moet krijgen (art. 6:230m BW).
const BEDRIJF = {
  naam: 'Pouw Vervoer',
  adres: 'Hagenweg 3c, 4131 LX Vianen',
  telefoon: '030 68 68 300',
  email: 'info@pouwvervoer.nl',
  kvk: process.env.BEDRIJF_KVK || '',
  btw: process.env.BEDRIJF_BTW || '',
  lidmaatschap: 'lid van Busvervoer Nederland (KNV)',
};

// Volledige link voor in e-mails.
function absoluut(base) {
  return /^https?:\/\//i.test(URL) ? URL : `${String(base || '').replace(/\/$/, '')}${URL}`;
}

let hashCache = null;
// SHA-256 van de meegeleverde pdf: bewijs welk document precies is verstrekt.
function hash() {
  if (hashCache === null) {
    try {
      hashCache = crypto.createHash('sha256').update(fs.readFileSync(BESTAND)).digest('hex');
    } catch {
      hashCache = '';
    }
  }
  return hashCache;
}

// Bijlage voor e-mails; null als alleen een externe link is ingesteld en de pdf niet lokaal staat.
function bijlage() {
  return fs.existsSync(BESTAND) ? { naam: BIJLAGE_NAAM, pad: BESTAND } : null;
}

// Artikel 5.1: schadevergoeding bij opzegging door de opdrachtgever, naar kalenderdagen vóór de vertrekdag.
// "vanaf" is het kleinste aantal dagen vóór vertrek waarvoor de regel geldt.
const ANNULERING = [
  { vanaf: 23, pct: 30, minimum: 12500, tekst: 'Meer dan 22 dagen voor vertrek' },
  { vanaf: 15, pct: 40, minimum: 0, tekst: '22 tot en met 15 dagen voor vertrek' },
  { vanaf: 3, pct: 50, minimum: 0, tekst: '14 tot en met 3 dagen voor vertrek' },
  { vanaf: 1, pct: 75, minimum: 0, tekst: '2 dagen of 1 dag voor vertrek' },
  { vanaf: -Infinity, pct: 100, minimum: 0, tekst: 'Op de dag van vertrek' },
];

const isoDatum = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const amsterdamDatum = (d) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// Hele kalenderdagen tussen de dag van opzegging (Nederlandse tijd) en de vertrekdag.
function dagenVoorVertrek(vertrek, op = new Date()) {
  const v = Date.parse(`${isoDatum(vertrek)}T00:00:00Z`);
  const o = Date.parse(`${amsterdamDatum(op)}T00:00:00Z`);
  return Math.round((v - o) / 864e5);
}

function annuleringskosten(ritprijsCent, vertrek, op = new Date()) {
  const dagen = dagenVoorVertrek(vertrek, op);
  const regel = ANNULERING.find((r) => dagen >= r.vanaf);
  const prijs = Math.max(0, Number(ritprijsCent) || 0);
  const bedrag = Math.max(Math.round((prijs * regel.pct) / 100), regel.minimum);
  return { dagen, pct: regel.pct, minimum: regel.minimum, bedrag, tekst: regel.tekst };
}

const euro = (cent) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(cent / 100);

// De staffel als één zin, voor e-mails.
function annuleringZin() {
  return ANNULERING.map((r) => `${r.tekst.toLowerCase()} ${r.pct}%${r.minimum ? ` (minimaal ${euro(r.minimum)})` : ''}`).join('; ');
}

// Belangrijkste punten voor de klant vóór de aanvraag en vóór het akkoord.
const KERNPUNTEN = [
  `Annuleren kan alleen schriftelijk. De kosten zijn een percentage van de ritprijs: ${annuleringZin()} (artikel 5.1).`,
  'Voor personenvervoer geldt geen wettelijke bedenktijd of herroepingsrecht. Na uw akkoord is de bestelling bindend; de annuleringsregeling hierboven geldt dan.',
  'Pouw Vervoer mag een aanbetaling vragen. Wordt die niet op tijd betaald, dan mag Pouw de overeenkomst ontbinden en is minimaal 30% van de ritprijs verschuldigd (artikel 4.1). De rest betaalt u binnen 14 dagen na de factuurdatum (artikel 4.2).',
  'Wie namens een ander boekt, is samen met die ander hoofdelijk aansprakelijk voor alle verplichtingen (artikel 2.2).',
  'Meerkosten door file, extra uren of kilometers op uw verzoek, en kosten als tol, parkeren en pont komen op de eindfactuur (artikel 6.6 en 6.7). Stijgen brandstofkosten of heffingen sterk, dan mag Pouw die doorberekenen; u mag de verhoging afwijzen (artikel 3.2).',
  'Meld vooraf lichamelijke of geestelijke beperkingen die de rit beïnvloeden (artikel 9.10). Op verzoek levert u een passagierslijst (artikel 9.11). Bagage maximaal 20 kg per persoon (artikel 9.4).',
  'Bij extreem weer (KNMI-code geel, oranje of rood), staking of andere omstandigheden buiten de macht van Pouw mag Pouw de rit afzeggen; u krijgt dan de ritprijs terug (artikel 7).',
  'Klachten dient u direct en uiterlijk binnen een maand schriftelijk in bij Pouw Vervoer. Daarna kunt u binnen drie maanden naar de geschillencommissie van Busvervoer Nederland (artikel 11). Nederlands recht is van toepassing.',
];

// Tekstblok voor e-mails.
function mailBlok(base) {
  return (
    `Belangrijk uit de voorwaarden:\n${KERNPUNTEN.slice(0, 5).map((k) => `- ${k}`).join('\n')}\n` +
    `De volledige ${NAAM} (${VERSIE}, ${DEPOT}) ${bijlage() ? 'zitten als pdf bij deze e-mail en ' : ''}staan op ${absoluut(base)}. Bewaar ze bij uw administratie.`
  );
}

function bedrijfRegel() {
  return [BEDRIJF.naam, BEDRIJF.adres, BEDRIJF.telefoon, BEDRIJF.email, BEDRIJF.kvk && `KvK ${BEDRIJF.kvk}`, BEDRIJF.btw && `btw ${BEDRIJF.btw}`, BEDRIJF.lidmaatschap]
    .filter(Boolean)
    .join(', ');
}

module.exports = {
  NAAM, VERSIE, URL, DEPOT, BIJLAGE_NAAM, BEDRIJF, ANNULERING, KERNPUNTEN,
  absoluut, hash, bijlage, dagenVoorVertrek, annuleringskosten, annuleringZin, mailBlok, bedrijfRegel,
};
