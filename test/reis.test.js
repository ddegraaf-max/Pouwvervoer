const test = require('node:test');
const assert = require('node:assert');
const reis = require('../src/reis');

const nu = new Date('2026-10-13T10:00:00Z');

const retour = {
  reistype: 'retour', personen: '45',
  van: 'Hagenweg 3c, Vianen', via: ['Utrecht CS', 'Amersfoort'], wacht: ['30', '20'], naar: 'De Efteling, Kaatsheuvel',
  tijdtype_heen: 'vertrek', datum_heen: '2026-11-02', tijd_heen: '08:00',
  tijdtype_terug: 'aankomst', datum_terug: '2026-11-02', tijd_terug: '18:30',
};

test('vandaag in Nederlandse tijd', () => {
  assert.equal(reis.vandaag(new Date('2026-10-13T22:30:00Z')), '2026-10-14');
});

test('retour met tussenstops is geldig, wachttijd gaat naar het dichtstbijzijnde kwartier', () => {
  const r = reis.valideer(retour, nu);
  assert.deepEqual(r.lijst, []);
  assert.deepEqual(r.v.via, ['Utrecht CS', 'Amersfoort']);
  assert.deepEqual(r.v.wacht, [30, 15]);
  assert.equal(r.v.andere_route, false);
  assert.equal(r.v.tijdtype_terug, 'aankomst');
});

test('één tussenstop komt als string binnen', () => {
  const r = reis.valideer({ ...retour, via: 'Utrecht CS', wacht: '45' }, nu);
  assert.deepEqual(r.lijst, []);
  assert.deepEqual(r.v.via, ['Utrecht CS']);
  assert.deepEqual(r.v.wacht, [45]);
});

test('enkele reis negeert de terugreis', () => {
  const r = reis.valideer({ ...retour, reistype: 'enkel', datum_terug: '', tijd_terug: '', andere_route: 'on', terug_van: '' }, nu);
  assert.deepEqual(r.lijst, []);
  assert.equal(r.v.andere_route, false);
  assert.equal(r.v.datum_terug, '');
});

test('verplichte velden', () => {
  const r = reis.valideer({}, nu);
  assert.equal(r.fouten.reistype, 'Kies retour of enkele reis.');
  assert.equal(r.fouten.personen, 'Vul het aantal personen in.');
  assert.equal(r.fouten.van, 'Vul het vertrekadres in.');
  assert.equal(r.fouten.naar, 'Vul de bestemming in.');
  assert.equal(r.fouten.datum_heen, 'Kies een datum.');
  assert.equal(r.fouten.tijd_heen, 'Kies een tijd.');
  assert.equal(r.fouten.datum_terug, 'Kies een datum voor de terugreis.');
  assert.equal(r.fouten.tijd_terug, 'Kies een tijd voor de terugreis.');
});

test('lege tussenstop en te veel tussenstops', () => {
  const r = reis.valideer({ ...retour, via: ['Utrecht', '', 'a', 'b', 'c', 'd'], wacht: [] }, nu);
  assert.equal(r.fouten['via.1'], 'Vul tussenstop 2 in of verwijder deze.');
  assert.equal(r.fouten.via, 'Maximaal 5 tussenstops.');
  assert.equal(r.v.via.length, 5);
  assert.deepEqual(r.v.wacht, [15, 15, 15, 15, 15]);
});

test('datum in het verleden, vandaag mag wel', () => {
  assert.equal(reis.valideer({ ...retour, datum_heen: '2026-10-12', datum_terug: '2026-10-12' }, nu).fouten.datum_heen, 'De datum ligt in het verleden.');
  assert.equal(reis.valideer({ ...retour, datum_heen: '2026-10-13', datum_terug: '2026-10-13' }, nu).fouten.datum_heen, undefined);
  assert.equal(reis.valideer({ ...retour, datum_heen: '2026-02-30', datum_terug: '2026-03-01' }, nu).fouten.datum_heen, 'Kies een geldige datum.');
});

test('terugreis vóór de heenreis of dezelfde dag eerder', () => {
  assert.equal(reis.valideer({ ...retour, datum_terug: '2026-11-01' }, nu).fouten.datum_terug, 'De terugreis kan niet vóór de heenreis zijn.');
  assert.equal(reis.valideer({ ...retour, tijd_terug: '08:00' }, nu).fouten.tijd_terug, 'De tijd van de terugreis moet na die van de heenreis liggen.');
  assert.equal(reis.valideer({ ...retour, datum_terug: '2026-11-03', tijd_terug: '07:00' }, nu).fouten.tijd_terug, undefined);
});

test('andere route terug vraagt om vertrek en bestemming van de terugreis', () => {
  const r = reis.valideer({ ...retour, andere_route: 'on', terug_via: ['Breda', ''], terug_wacht: ['60', '60'] }, nu);
  assert.equal(r.fouten.terug_van, 'Vul het vertrekadres van de terugreis in.');
  assert.equal(r.fouten.terug_naar, 'Vul de bestemming van de terugreis in.');
  assert.equal(r.fouten['terug_via.1'], 'Vul tussenstop 2 van de terugreis in of verwijder deze.');
  assert.equal(r.v.andere_route, true);
  assert.deepEqual(r.v.terug_wacht, [60, 60]);
});

test('vertaling naar het aanvraagformulier', () => {
  const dag = reis.naarAanvraag(reis.valideer(retour, nu).v);
  assert.equal(dag.ritsoort, 'brengen_halen');
  assert.equal(dag.rit_datum, '2026-11-02');
  assert.equal(dag.vertrek_tijd, '08:00');
  assert.equal(dag.personen, '45');
  assert.match(dag.opmerkingen, /^Heenreis: Hagenweg 3c, Vianen → Utrecht CS \(wacht 30 min\) → Amersfoort \(wacht 15 min\) → De Efteling, Kaatsheuvel, vertrek 2 november 2026 om 08:00\.$/m);
  assert.match(dag.opmerkingen, /^Terugreis: zelfde route terug, aankomst 2 november 2026 om 18:30\.$/m);

  const meer = reis.naarAanvraag(reis.valideer({ ...retour, datum_terug: '2026-11-04', andere_route: 'on', terug_van: 'Efteling', terug_naar: 'Vianen' }, nu).v);
  assert.equal(meer.ritsoort, 'meerdaags');
  assert.match(meer.opmerkingen, /Terugreis: Efteling → Vianen, aankomst 4 november 2026 om 18:30\./);

  const enkel = reis.naarAanvraag(reis.valideer({ ...retour, reistype: 'enkel', tijdtype_heen: 'aankomst' }, nu).v);
  assert.equal(enkel.ritsoort, 'enkel');
  assert.equal(enkel.vertrek_tijd, '');
  assert.match(enkel.opmerkingen, /aankomst 2 november 2026 om 08:00\.$/);
  assert.doesNotMatch(enkel.opmerkingen, /Terugreis/);
});

test('wachttijdlabels', () => {
  assert.equal(reis.wachtLabel(15), '15 min');
  assert.equal(reis.wachtLabel(60), '1 uur');
  assert.equal(reis.wachtLabel(135), '2 uur 15 min');
  assert.equal(reis.WACHTTIJDEN.length, 16);
  assert.equal(reis.WACHTTIJDEN[15], 240);
});
