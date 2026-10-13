// Adressen en routes via gratis open diensten, altijd via onze eigen server (de browser praat niet met derden):
//  - PDOK Locatieserver (Kadaster/overheid): Nederlandse adressen, straten en plaatsen, geen sleutel nodig.
//  - Photon (komoot, OpenStreetMap): bestemmingen en buitenland, bijvoorbeeld "Efteling" of "Disneyland Paris".
//  - OSRM (demo-server van het OSRM-project): route, afstand en reistijd over de weg.
// Antwoorden worden een tijd in het geheugen bewaard, zodat dezelfde vraag niet opnieuw naar buiten gaat.
const UA = 'boekpouwvervoer (info@pouwvervoer.nl)';
const LANDEN = {
  NL: 'Nederland', BE: 'België', DE: 'Duitsland', FR: 'Frankrijk', LU: 'Luxemburg', GB: 'Verenigd Koninkrijk', AT: 'Oostenrijk',
  CH: 'Zwitserland', IT: 'Italië', ES: 'Spanje', DK: 'Denemarken', CZ: 'Tsjechië', PL: 'Polen', PT: 'Portugal', SE: 'Zweden', NO: 'Noorwegen',
};
const MAX_PUNTEN = 7; // van + 5 tussenstops + naar

const cache = new Map();
function uitCache(sleutel) {
  const c = cache.get(sleutel);
  if (!c) return undefined;
  if (c.tot < Date.now()) {
    cache.delete(sleutel);
    return undefined;
  }
  return c.waarde;
}
function inCache(sleutel, waarde, ms) {
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(sleutel, { waarde, tot: Date.now() + ms });
  return waarde;
}

async function haalJson(url, ms = 6000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const rond = (n) => Math.round(Number(n) * 1e6) / 1e6;

// PDOK: "POINT(lon lat)" → { lat, lon }
function normaliseerPdok(doc) {
  const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(doc.centroide_ll || '');
  if (!m || !doc.weergavenaam) return null;
  const type = { adres: 'adres', weg: 'straat', woonplaats: 'plaats', gemeente: 'plaats' }[doc.type] || 'adres';
  return { label: String(doc.weergavenaam).replace(/(\d{4})([A-Z]{2})/, '$1 $2'), lat: rond(m[2]), lon: rond(m[1]), type, bron: 'pdok' };
}

// Photon: GeoJSON-feature → { label, lat, lon }
function normaliseerPhoton(f) {
  const p = f.properties || {};
  const [lon, lat] = (f.geometry && f.geometry.coordinates) || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const straat = [p.street, p.housenumber].filter(Boolean).join(' ');
  const plaats = [p.postcode, p.city || p.town || p.village || p.county].filter(Boolean).join(' ');
  const land = p.countrycode && p.countrycode !== 'NL' ? LANDEN[p.countrycode] || p.country || p.countrycode : '';
  const delen = [p.name, straat !== p.name ? straat : '', plaats, land].filter(Boolean);
  if (!delen.length) return null;
  const type = p.osm_key === 'place' ? 'plaats' : p.osm_key === 'highway' ? 'straat' : p.name && p.osm_key !== 'building' ? 'poi' : 'adres';
  return { label: delen.join(', '), lat: rond(lat), lon: rond(lon), type, bron: 'photon' };
}

async function zoekPdok(q) {
  const u = new URL('https://api.pdok.nl/bzk/locatieserver/search/v3_1/free');
  u.searchParams.set('q', q);
  u.searchParams.set('rows', '5');
  u.searchParams.set('fq', 'type:(adres OR weg OR woonplaats)');
  u.searchParams.set('fl', 'id,type,weergavenaam,centroide_ll,woonplaatsnaam');
  const j = await haalJson(u);
  return ((j.response && j.response.docs) || []).map(normaliseerPdok).filter(Boolean);
}

async function zoekPhoton(q) {
  const u = new URL('https://photon.komoot.io/api/');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '5');
  u.searchParams.set('lang', 'en');
  u.searchParams.set('lat', '52.1');
  u.searchParams.set('lon', '5.3');
  const j = await haalJson(u);
  return (j.features || []).map(normaliseerPhoton).filter(Boolean);
}

// Suggesties voor een (deel van een) adres, plaats of bestemming. PDOK eerst, dan Photon; dubbele weg.
async function zoekAdres(tekst) {
  const q = String(tekst || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (q.length < 3) return [];
  const sleutel = `a:${q.toLowerCase()}`;
  const bekend = uitCache(sleutel);
  if (bekend) return bekend;
  const [pdok, photon] = await Promise.allSettled([zoekPdok(q), zoekPhoton(q)]);
  const lijst = [];
  const gezien = new Set();
  for (const r of [...(pdok.status === 'fulfilled' ? pdok.value : []), ...(photon.status === 'fulfilled' ? photon.value : [])]) {
    const k = r.label.toLowerCase();
    if (gezien.has(k)) continue;
    gezien.add(k);
    lijst.push(r);
    if (lijst.length >= 7) break;
  }
  if (pdok.status === 'rejected' && photon.status === 'rejected') throw new Error('Adresdiensten niet bereikbaar.');
  return inCache(sleutel, lijst, 6 * 3600e3);
}

// Route over de weg langs de punten [[lat, lon], ...]: afstand in meters, duur in seconden en de lijn voor de kaart.
async function route(punten) {
  const p = (punten || []).filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1])).slice(0, MAX_PUNTEN);
  if (p.length < 2) return null;
  const sleutel = `r:${p.map((x) => `${rond(x[0])},${rond(x[1])}`).join(';')}`;
  const bekend = uitCache(sleutel);
  if (bekend) return bekend;
  const coords = p.map((x) => `${rond(x[1])},${rond(x[0])}`).join(';');
  const j = await haalJson(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=simplified&geometries=geojson`, 10000);
  const r = j.routes && j.routes[0];
  if (!r) throw new Error('Geen route gevonden.');
  const uit = {
    afstand_m: Math.round(r.distance),
    duur_s: Math.round(r.duration),
    lijn: (r.geometry.coordinates || []).map(([lon, lat]) => [rond(lat), rond(lon)]),
  };
  return inCache(sleutel, uit, 24 * 3600e3);
}

// "51.99,5.10;51.65,5.04" → [[51.99, 5.10], [51.65, 5.04]]
function parsePunten(s) {
  return String(s || '')
    .split(';')
    .map((deel) => deel.split(',').map(Number))
    .filter((x) => x.length === 2 && x.every(Number.isFinite) && Math.abs(x[0]) <= 90 && Math.abs(x[1]) <= 180)
    .slice(0, MAX_PUNTEN);
}

module.exports = { zoekAdres, route, parsePunten, normaliseerPdok, normaliseerPhoton, MAX_PUNTEN };
