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

const { incassokosten, rente, begonnenMaanden } = require('../src/incasso');

test('incassokosten: particulier de staffel, zakelijk 15% met minimum € 150 (artikel 4.7b)', () => {
  assert.equal(incassokosten(30000, 'particulier'), 4500);
  assert.equal(incassokosten(30000, 'bedrijf'), 15000);
  assert.equal(incassokosten(240000, 'onderwijs'), 36000);
  assert.equal(incassokosten(240000, 'vereniging'), 36000);
  assert.equal(incassokosten(0, 'bedrijf'), 0);
});

test('rente: zakelijk 1,5% per begonnen maand (artikel 4.6), particulier wettelijke rente naar rato', () => {
  assert.equal(begonnenMaanden('2026-10-01', '2026-10-02'), 1);
  assert.equal(begonnenMaanden('2026-10-01', '2026-11-01'), 1);
  assert.equal(begonnenMaanden('2026-10-01', '2026-11-02'), 2);
  assert.equal(begonnenMaanden('2026-10-01', '2026-10-01'), 0);
  const z = rente(240000, '2026-10-01', 'bedrijf', new Date('2026-11-02T10:00:00Z'));
  assert.equal(z.maanden, 2);
  assert.equal(z.bedrag, 7200);
  const p = rente(240000, '2026-10-01', 'particulier', new Date('2026-10-31T10:00:00Z'));
  assert.equal(p.dagen, 30);
  assert.equal(p.bedrag, Math.round((240000 * 0.06 * 30) / 365));
  assert.equal(rente(240000, '2026-10-01', 'bedrijf', new Date('2026-09-30T10:00:00Z')).bedrag, 0);
});
