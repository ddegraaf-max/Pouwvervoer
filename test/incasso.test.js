const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://niet-gebruikt@localhost/x';
const { wettelijkeIncassokosten, magOverdragen } = require('../src/incasso');

test('wettelijke incassokosten volgens de staffel', () => {
  assert.equal(wettelijkeIncassokosten(10000), 4000); // € 100 → minimum € 40
  assert.equal(wettelijkeIncassokosten(30000), 4500); // 15% van € 300
  assert.equal(wettelijkeIncassokosten(100000), 15000); // 15% van € 1.000
  assert.equal(wettelijkeIncassokosten(400000), 52500); // 375 + 150
  assert.equal(wettelijkeIncassokosten(1000000), 87500); // 375 + 250 + 250
  assert.equal(wettelijkeIncassokosten(1e10), 677500); // maximum € 6.775
});

const basis = { betaald_op: null, incasso: false, herinnering_niveau: 4, laatste_herinnering_op: new Date('2026-10-01') };

test('overdragen pas na aanmaning', () => {
  assert.equal(magOverdragen({ ...basis, herinnering_niveau: 3 }, 'bedrijf').mag, false);
  assert.equal(magOverdragen(basis, 'bedrijf', new Date('2026-10-02')).mag, true);
});

test('particulier: 14 dagen na de 14-dagenbrief', () => {
  assert.equal(magOverdragen(basis, 'particulier', new Date('2026-10-10')).mag, false);
  assert.equal(magOverdragen(basis, 'particulier', new Date('2026-10-16')).mag, true);
});

test('niet dubbel of na betaling', () => {
  assert.equal(magOverdragen({ ...basis, incasso: true }, 'bedrijf').mag, false);
  assert.equal(magOverdragen({ ...basis, betaald_op: new Date() }, 'bedrijf').mag, false);
});
