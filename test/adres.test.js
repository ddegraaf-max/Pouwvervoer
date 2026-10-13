const test = require('node:test');
const assert = require('node:assert');
const adres = require('../src/adres');

test('PDOK-document wordt een suggestie met coördinaten en spatie in de postcode', () => {
  const s = adres.normaliseerPdok({ type: 'adres', weergavenaam: 'Hagenweg 3c, 4131LX Vianen', centroide_ll: 'POINT(5.10199009 51.98990449)' });
  assert.deepEqual(s, { label: 'Hagenweg 3c, 4131 LX Vianen', lat: 51.989904, lon: 5.10199, type: 'adres', bron: 'pdok' });
  assert.equal(adres.normaliseerPdok({ type: 'weg', weergavenaam: 'Hagenweg, Vianen', centroide_ll: 'POINT(5.1 51.9)' }).type, 'straat');
  assert.equal(adres.normaliseerPdok({ type: 'adres', weergavenaam: 'X' }), null);
});

test('Photon-feature wordt een suggestie met plaats en land', () => {
  const s = adres.normaliseerPhoton({
    properties: { name: 'Disneyland Paris', street: 'Avenue Robert Schuman', city: 'Coupvray', postcode: '77700', countrycode: 'FR', osm_key: 'tourism' },
    geometry: { coordinates: [2.774056, 48.8701103] },
  });
  assert.equal(s.label, 'Disneyland Paris, Avenue Robert Schuman, 77700 Coupvray, Frankrijk');
  assert.equal(s.type, 'poi');
  assert.equal(s.lat, 48.87011);
  const nl = adres.normaliseerPhoton({ properties: { name: 'Efteling', city: 'Kaatsheuvel', postcode: '5171 KW', countrycode: 'NL', osm_key: 'tourism' }, geometry: { coordinates: [5.04, 51.65] } });
  assert.equal(nl.label, 'Efteling, 5171 KW Kaatsheuvel');
  assert.equal(adres.normaliseerPhoton({ properties: {}, geometry: { coordinates: [5, 51] } }), null);
});

test('punten uit de querystring, hooguit 7 en alleen geldige coördinaten', () => {
  assert.deepEqual(adres.parsePunten('51.99,5.10;51.65,5.04'), [[51.99, 5.1], [51.65, 5.04]]);
  assert.deepEqual(adres.parsePunten('abc;91,5;51,5'), [[51, 5]]);
  assert.equal(adres.parsePunten(Array.from({ length: 9 }, (_, i) => `${50 + i},5`).join(';')).length, 7);
  assert.deepEqual(adres.parsePunten(''), []);
});

test('zoeken met minder dan 3 tekens vraagt niets op', async () => {
  assert.deepEqual(await adres.zoekAdres('ab'), []);
  assert.equal(await adres.route([[51.99, 5.1]]), null);
});
