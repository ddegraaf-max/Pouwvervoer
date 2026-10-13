const test = require('node:test');
const assert = require('node:assert');
const beleid = require('../src/beleid');
const voorwaarden = require('../src/voorwaarden');

test('bedenktijd van 24 uur na het akkoord', () => {
  const akkoord = '2026-10-13T10:00:00Z';
  assert.equal(beleid.bedenktijdTot(akkoord).toISOString(), '2026-10-14T10:00:00.000Z');
  assert.equal(beleid.binnenBedenktijd(akkoord, new Date('2026-10-14T09:59:00Z')), true);
  assert.equal(beleid.binnenBedenktijd(akkoord, new Date('2026-10-14T10:00:00Z')), false);
  assert.equal(beleid.binnenBedenktijd(null), false);
});

test('kosteloos wijzigen tot 7 dagen voor vertrek', () => {
  assert.equal(beleid.wijzigenTot('2026-11-20').toISOString(), '2026-11-13T00:00:00.000Z');
  assert.equal(beleid.wijzigenKosteloos('2026-11-20', new Date('2026-11-12T12:00:00Z')), true);
  assert.equal(beleid.wijzigenKosteloos('2026-11-20', new Date('2026-11-13T12:00:00Z')), false);
});

test('geldigheid van de prijs', () => {
  assert.equal(beleid.offerteGeldigTot(new Date('2026-10-13T10:00:00Z')), '2026-10-27');
  assert.equal(beleid.offerteVerlopen('2026-10-27', new Date('2026-10-27T20:00:00Z')), false);
  assert.equal(beleid.offerteVerlopen('2026-10-27', new Date('2026-10-28T06:00:00Z')), true);
  assert.equal(beleid.offerteVerlopen(null), false);
});

test('annuleringskosten voor een dossier: 0% binnen de bedenktijd, daarna de staffel', () => {
  const a = { ritprijs_cent: 200000, rit_datum: '2026-11-20', akkoord_op: '2026-10-13T10:00:00Z' };
  const binnen = voorwaarden.annuleringsKostenDossier(a, new Date('2026-10-13T20:00:00Z'));
  assert.equal(binnen.bedrag, 0);
  assert.equal(binnen.pct, 0);
  assert.equal(binnen.bedenktijd, true);
  const erna = voorwaarden.annuleringsKostenDossier(a, new Date('2026-10-15T10:00:00Z'));
  assert.equal(erna.pct, 30);
  assert.equal(erna.bedrag, 60000);
  assert.equal(erna.bedenktijd, false);
});

test('kernpunten beginnen met het beleid van Pouw en de mail noemt het ook', () => {
  assert.match(voorwaarden.KERNPUNTEN[0], /24 uur bedenktijd/);
  assert.match(voorwaarden.KERNPUNTEN[2], /7 dagen voor vertrek/);
  assert.match(voorwaarden.mailBlok('https://x.nl'), /24 uur bedenktijd/);
  assert.match(voorwaarden.mailBlok('https://x.nl'), /bereikbaar zijn voor een \(touring\)bus/);
});
