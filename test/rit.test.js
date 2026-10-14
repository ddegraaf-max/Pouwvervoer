const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://niet-gebruikt@localhost/x';
const rit = require('../src/rit');
const meldingen = require('../src/meldingen');

test('ritmelding: omschrijving verplicht, bedrag als 12,50, onbekende soort wordt opmerking', () => {
  const leeg = rit.valideerMelding({ soort: 'schade', omschrijving: '  ' });
  assert.equal(leeg.ok, false);
  assert.match(leeg.fouten[0], /Beschrijf/);

  const goed = rit.valideerMelding({ soort: 'kosten', omschrijving: ' Parkeergeld Efteling ', bedrag: '€ 12,50', locatie: 'P1' });
  assert.equal(goed.ok, true);
  assert.deepEqual(goed.waarde, { soort: 'kosten', omschrijving: 'Parkeergeld Efteling', locatie: 'P1', bedrag_cent: 1250 });

  const fout = rit.valideerMelding({ soort: 'kosten', omschrijving: 'Tol', bedrag: 'twaalf' });
  assert.equal(fout.ok, false);
  assert.match(fout.fouten[0], /12,50/);

  const onbekend = rit.valideerMelding({ soort: 'hack', omschrijving: 'Iets' });
  assert.equal(onbekend.waarde.soort, 'opmerking');
});

test('controle vóór vertrek mag zonder tekst en krijgt een standaardomschrijving', () => {
  const v = rit.valideerMelding({ soort: 'start' });
  assert.equal(v.ok, true);
  assert.equal(v.waarde.omschrijving, 'Bus gecontroleerd vóór vertrek.');
  assert.equal(v.waarde.bedrag_cent, null);
});

test("foto's: alleen jpeg, png of webp als data-url, begrensd in grootte en aantal", () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from('fotobytes').toString('base64')}`;
  const png = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
  const html = `data:text/html;base64,${Buffer.from('<script>').toString('base64')}`;
  const teGroot = `data:image/jpeg;base64,${Buffer.alloc(rit.MAX_FOTO_BYTES + 1).toString('base64')}`;
  const uit = rit.parseFotos([jpeg, html, png, 'geen data-url', teGroot, jpeg, jpeg]);
  // Maximaal MAX_FOTOS worden bekeken (de eerste vier), waarvan alleen de geldige overblijven.
  assert.equal(uit.length, 2);
  assert.equal(uit[0].mime, 'image/jpeg');
  assert.equal(uit[0].data.toString(), 'fotobytes');
  assert.equal(uit[1].mime, 'image/png');
  assert.equal(rit.parseFoto(teGroot), null);
  assert.equal(rit.parseFoto(html), null);
  assert.deepEqual(rit.parseFotos('niet een lijst'), []);
});

test('checklist: alleen bekende items, de rest staat op niet gedaan', () => {
  const c = rit.normaliseerChecklist({ items: ['aanwezig', 'onzin', 'bonnen'] });
  assert.equal(c.aanwezig, true);
  assert.equal(c.bonnen, true);
  assert.equal(c.reisleider, false);
  assert.equal(Object.keys(c).length, rit.CHECKLIST.length);
  assert.equal('onzin' in c, false);
  assert.deepEqual(rit.normaliseerChecklist({ items: 'aanwezig' }).aanwezig, true);
});

test('ritlink: alleen voor bevestigde of gereden ritten en tot 14 dagen na de laatste ritdag', () => {
  const a = { chauffeur_token: 'x'.repeat(32), status: 'bevestigd', rit_datum: '2026-11-12', datum_terug: '2026-11-13' };
  assert.equal(rit.linkGeldig(a, new Date('2026-11-01T10:00:00Z')), true);
  assert.equal(rit.linkGeldig(a, new Date('2026-11-27T10:00:00Z')), true);
  assert.equal(rit.linkGeldig(a, new Date('2026-11-28T10:00:00Z')), false);
  assert.equal(rit.linkGeldig({ ...a, status: 'offerte_verstuurd' }), false);
  assert.equal(rit.linkGeldig({ ...a, status: 'gereden', datum_terug: null, rit_datum: new Date('2026-11-12T00:00:00Z') }, new Date('2026-11-20T10:00:00Z')), true);
  assert.equal(rit.linkGeldig({ ...a, chauffeur_token: null }), false);
});

test('werklijst: schade, rotzooi en extra kosten gaan naar de administratie; de meldingsoorten bestaan', () => {
  assert.equal(rit.WERKLIJST.schade.eigenaar, 'administratie');
  assert.equal(rit.WERKLIJST.rotzooi.eigenaar, 'administratie');
  assert.equal(rit.WERKLIJST.kosten.eigenaar, 'administratie');
  assert.equal(rit.WERKLIJST.incident.eigenaar, 'operatie');
  assert.equal(rit.WERKLIJST.opmerking, undefined);
  for (const w of Object.values(rit.WERKLIJST)) {
    assert.ok(meldingen.SOORTEN[w.soort], `meldingsoort ${w.soort} ontbreekt`);
    assert.ok(meldingen.EIGENAREN[w.eigenaar]);
  }
  assert.equal(meldingen.normaliseer({ soort: 'schade', omschrijving: 'Kras op de flank' }).eigenaar, 'administratie');
});

test('samenvatting telt per soort en de token is lang genoeg', () => {
  assert.equal(rit.samenvatting([]), 'geen meldingen');
  assert.equal(rit.samenvatting([{ soort: 'schade' }, { soort: 'schade' }, { soort: 'kosten' }]), '2× schade aan de bus, 1× extra kosten');
  assert.ok(rit.token().length >= 30);
  assert.notEqual(rit.token(), rit.token());
});
