const test = require('node:test');
const assert = require('node:assert');
const voorwaarden = require('../src/voorwaarden');

test('link naar de voorwaarden wordt absoluut voor in e-mails', () => {
  assert.equal(voorwaarden.absoluut('https://boekpouwvervoer.nl'), 'https://boekpouwvervoer.nl/documenten/knv-busvervoer-2025.pdf');
  assert.equal(voorwaarden.absoluut('https://boekpouwvervoer.nl/'), 'https://boekpouwvervoer.nl/documenten/knv-busvervoer-2025.pdf');
  assert.equal(voorwaarden.VERSIE, 'KNV Busvervoer 2025');
  assert.match(voorwaarden.NAAM, /KNV Busvervoer/);
});

test('de pdf is aanwezig als bijlage en heeft een hash', () => {
  const b = voorwaarden.bijlage();
  assert.ok(b && b.naam.endsWith('.pdf') && b.pad.endsWith('knv-busvervoer-2025.pdf'));
  assert.match(voorwaarden.hash(), /^[0-9a-f]{64}$/);
  assert.equal(voorwaarden.hash(), voorwaarden.hash());
});

test('annuleringsstaffel van artikel 5.1 per kalenderdag vóór vertrek', () => {
  const vertrek = '2026-11-20';
  const op = (d) => new Date(`${d}T12:00:00Z`);
  const k = (d) => voorwaarden.annuleringskosten(200000, vertrek, op(d));
  assert.deepEqual([k('2026-10-28').dagen, k('2026-10-28').pct, k('2026-10-28').bedrag], [23, 30, 60000]);
  assert.deepEqual([k('2026-10-29').dagen, k('2026-10-29').pct], [22, 40]);
  assert.deepEqual([k('2026-11-05').dagen, k('2026-11-05').pct], [15, 40]);
  assert.deepEqual([k('2026-11-06').dagen, k('2026-11-06').pct], [14, 50]);
  assert.deepEqual([k('2026-11-17').dagen, k('2026-11-17').pct], [3, 50]);
  assert.deepEqual([k('2026-11-18').dagen, k('2026-11-18').pct, k('2026-11-18').bedrag], [2, 75, 150000]);
  assert.deepEqual([k('2026-11-19').dagen, k('2026-11-19').pct], [1, 75]);
  assert.deepEqual([k('2026-11-20').dagen, k('2026-11-20').pct, k('2026-11-20').bedrag], [0, 100, 200000]);
  assert.deepEqual([k('2026-11-22').dagen, k('2026-11-22').pct], [-2, 100]);
  // minimum van € 125 bij 30%
  assert.equal(voorwaarden.annuleringskosten(30000, vertrek, op('2026-10-01')).bedrag, 12500);
  // datum uit de database (Date) en Nederlandse tijd: 23:30 UTC is al de volgende dag in Nederland
  assert.equal(voorwaarden.dagenVoorVertrek(new Date('2026-11-20T00:00:00Z'), new Date('2026-11-17T23:30:00Z')), 2);
});

test('kernpunten en mailblok noemen de staffel en de bijlage', () => {
  assert.match(voorwaarden.annuleringZin(), /meer dan 22 dagen voor vertrek 30% \(minimaal €\s125,00\); 22 tot en met 15 dagen voor vertrek 40%/);
  assert.ok(voorwaarden.KERNPUNTEN.length >= 6);
  const blok = voorwaarden.mailBlok('https://boekpouwvervoer.nl');
  assert.match(blok, /zitten als pdf bij deze e-mail/);
  assert.match(blok, /https:\/\/boekpouwvervoer\.nl\/documenten\/knv-busvervoer-2025\.pdf/);
  assert.match(voorwaarden.bedrijfRegel(), /^Pouw Vervoer, Hagenweg 3c, 4131 LX Vianen, 030 68 68 300, info@pouwvervoer\.nl/);
});
