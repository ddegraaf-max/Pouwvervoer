const test = require('node:test');
const assert = require('node:assert');
const { berekenScore, aanbetalingsplan, klasseVoorScore } = require('../src/score');

const nu = new Date('2026-10-12T12:00:00Z');
const vertrek = new Date('2026-12-01');
const leeg = { betaaldOpTijd: 0, betaaldTeLaat1tot30: 0, ooitTeLaat30Plus: 0, incasso: 0, openVervallen: 0 };

test('basisschool met PO-nummer, ouder dan 3 jaar → 85, klasse A', () => {
  const r = berekenScore({
    klanttype: 'onderwijs', kvk: { actief: true, opgericht: new Date('2001-01-01') }, emailDomeinKlopt: true,
    poNummer: 'PO-1', historie: leeg, ritwaarde: 1200, vertrek, aanvraag: nu,
  }, nu);
  assert.equal(r.score, 85);
  assert.equal(r.klasse, 'A');
});

test('particulier bruiloft € 2.400 → 40, klasse C, € 1.200 bij akkoord', () => {
  const r = berekenScore({ klanttype: 'particulier', kvk: null, emailDomeinKlopt: false, historie: leeg, ritwaarde: 2400, vertrek, aanvraag: nu }, nu);
  assert.equal(r.score, 40);
  assert.equal(r.klasse, 'C');
  const p = aanbetalingsplan('C', 240000, vertrek, 0, nu);
  assert.equal(p.termijnen[0].bedrag, 120000);
  assert.equal(p.termijnen[0].uiterlijk, null);
  assert.equal(p.termijnen[1].bedrag, 120000);
});

test('bedrijf 8 maanden, rit € 6.000 → 35, klasse C', () => {
  const opgericht = new Date(nu); opgericht.setMonth(opgericht.getMonth() - 8);
  const r = berekenScore({ klanttype: 'bedrijf', kvk: { actief: true, opgericht }, emailDomeinKlopt: false, historie: leeg, ritwaarde: 6000, vertrek, aanvraag: nu }, nu);
  assert.equal(r.score, 35);
  assert.equal(r.klasse, 'C');
});

test('incasso-verleden duwt naar D; open vervallen factuur blokkeert', () => {
  const r = berekenScore({ klanttype: 'particulier', historie: { ...leeg, incasso: 1, openVervallen: 1 }, ritwaarde: 500, vertrek, aanvraag: nu }, nu);
  assert.equal(r.score, 10);
  assert.equal(r.klasse, 'D');
  assert.equal(r.geblokkeerd, true);
});

test('faillissement blokkeert', () => {
  const r = berekenScore({ klanttype: 'bedrijf', kvk: { actief: true, faillissement: true }, historie: leeg, vertrek, aanvraag: nu }, nu);
  assert.equal(r.geblokkeerd, true);
});

test('vertrek binnen 7 dagen kost 5 punten', () => {
  const r = berekenScore({ klanttype: 'particulier', historie: leeg, vertrek: new Date('2026-10-15'), aanvraag: nu }, nu);
  assert.equal(r.score, 35);
});

test('klassegrenzen', () => {
  assert.equal(klasseVoorScore(70), 'A');
  assert.equal(klasseVoorScore(69), 'B');
  assert.equal(klasseVoorScore(50), 'B');
  assert.equal(klasseVoorScore(49), 'C');
  assert.equal(klasseVoorScore(30), 'C');
  assert.equal(klasseVoorScore(29), 'D');
});

test('klasse B: 30% uiterlijk 14 dagen voor vertrek; bij late boeking bij akkoord', () => {
  const p = aanbetalingsplan('B', 100000, vertrek, 0, nu);
  assert.equal(p.termijnen[0].bedrag, 30000);
  assert.equal(p.termijnen[0].uiterlijk.toISOString().slice(0, 10), '2026-11-17');
  const laat = aanbetalingsplan('B', 100000, new Date('2026-10-20'), 0, nu);
  assert.equal(laat.termijnen[0].uiterlijk, null);
});

test('klasse D: alles plus geschatte nakosten bij akkoord', () => {
  const p = aanbetalingsplan('D', 100000, vertrek, 5000, nu);
  assert.equal(p.termijnen.length, 1);
  assert.equal(p.termijnen[0].bedrag, 105000);
});
