const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://niet-gebruikt@localhost/x';
const meldingen = require('../src/meldingen');
const { magOverdragen } = require('../src/incasso');

test('deadline in werkdagen slaat het weekend over', () => {
  // dinsdag 13 oktober 2026 + 5 werkdagen = dinsdag 20 oktober
  assert.equal(meldingen.werkdagenLater(5, new Date('2026-10-13T10:00:00Z')), '2026-10-20');
  // vrijdag 16 oktober + 1 werkdag = maandag 19 oktober
  assert.equal(meldingen.werkdagenLater(1, new Date('2026-10-16T10:00:00Z')), '2026-10-19');
  assert.equal(meldingen.werkdagenLater(0, new Date('2026-10-16T10:00:00Z')), '2026-10-16');
});

test('dagen over de deadline', () => {
  assert.equal(meldingen.dagenOverDeadline('2026-10-20', new Date('2026-10-22T08:00:00Z')), 2);
  assert.equal(meldingen.dagenOverDeadline('2026-10-20', new Date('2026-10-18T08:00:00Z')), -2);
});

test('normaliseren: soort, standaardeigenaar en standaarddeadline', () => {
  const m = meldingen.normaliseer({ soort: 'uitvoering', omschrijving: '  Chauffeur 20 minuten te laat  ', nu: new Date('2026-10-13T10:00:00Z') });
  assert.equal(m.soort, 'uitvoering');
  assert.equal(m.eigenaar, 'operatie');
  assert.equal(m.omschrijving, 'Chauffeur 20 minuten te laat');
  assert.equal(m.deadline, '2026-10-20');
  const x = meldingen.normaliseer({ soort: 'onzin', omschrijving: 'x', eigenaar: 'niemand', deadline: '2026-11-01' });
  assert.equal(x.soort, 'anders');
  assert.equal(x.eigenaar, 'directie');
  assert.equal(x.deadline, '2026-11-01');
  assert.equal(meldingen.normaliseer({ soort: 'credit', omschrijving: 'x', eigenaar: 'sales' }).eigenaar, 'sales');
  assert.equal(Object.keys(meldingen.SOORTEN).length, 8);
});

test('geen overdracht aan de deurwaarder zolang er een melding open staat', () => {
  const f = { betaald_op: null, incasso: false, herinnering_niveau: 4, laatste_herinnering_op: '2026-09-01' };
  assert.equal(magOverdragen(f, 'bedrijf', new Date('2026-10-13')).mag, true);
  const r = magOverdragen(f, 'bedrijf', new Date('2026-10-13'), 2);
  assert.equal(r.mag, false);
  assert.match(r.reden, /2 melding/);
});
