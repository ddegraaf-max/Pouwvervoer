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

test('velden voor de database', () => {
  const d = reis.velden(reis.valideer(retour, nu).v);
  assert.equal(d.reistype, 'retour');
  assert.equal(d.ritsoort, 'brengen_halen');
  assert.equal(d.rit_datum, '2026-11-02');
  assert.equal(d.vertrek_tijd, '08:00');
  assert.equal(d.tijdtype_heen, 'vertrek');
  assert.deepEqual(d.via, [{ adres: 'Utrecht CS', wacht: 30 }, { adres: 'Amersfoort', wacht: 15 }]);
  assert.equal(d.datum_terug, '2026-11-02');
  assert.equal(d.tijd_terug, '18:30');
  assert.equal(d.tijdtype_terug, 'aankomst');
  assert.equal(d.andere_route, false);
  assert.deepEqual(d.terug_via, []);

  const meer = reis.velden(reis.valideer({ ...retour, datum_terug: '2026-11-04', andere_route: 'on', terug_van: 'Efteling', terug_naar: 'Vianen', terug_via: ['Breda'], terug_wacht: ['45'] }, nu).v);
  assert.equal(meer.ritsoort, 'meerdaags');
  assert.equal(meer.andere_route, true);
  assert.deepEqual(meer.terug_via, [{ adres: 'Breda', wacht: 45 }]);

  const enkel = reis.velden(reis.valideer({ ...retour, reistype: 'enkel', tijdtype_heen: 'aankomst', andere_route: 'on', terug_van: 'X', terug_naar: 'Y' }, nu).v);
  assert.equal(enkel.ritsoort, 'enkel');
  assert.equal(enkel.tijdtype_heen, 'aankomst');
  assert.equal(enkel.datum_terug, '');
  assert.equal(enkel.andere_route, false);
  assert.equal(enkel.terug_van, '');
});

test('reis terug uit een databaserij, ook een oude rij, en het soortlabel', () => {
  const rij = { reistype: 'retour', rit_datum: new Date('2026-11-02T00:00:00Z'), vertrek_tijd: '08:00', tijdtype_heen: 'vertrek', van: 'Vianen', naar: 'Efteling', personen: 54,
    via: [{ adres: 'Utrecht', wacht: 30 }], datum_terug: new Date('2026-11-04T00:00:00Z'), tijd_terug: '17:00', tijdtype_terug: 'aankomst', andere_route: true, terug_van: 'Efteling', terug_naar: 'Vianen', terug_via: [], bus_blijft: true };
  const r = reis.vanAanvraag(rij);
  assert.equal(r.datum_heen, '2026-11-02');
  assert.equal(r.datum_terug, '2026-11-04');
  assert.deepEqual(r.via, ['Utrecht']);
  assert.deepEqual(r.wacht, [30]);
  assert.equal(r.personen, '54');
  assert.equal(r.bus_blijft, true);
  assert.equal(reis.dagen(r), 3);
  assert.equal(reis.soortLabel(r), 'Meerdaagse reis, 3 dagen');
  assert.match(reis.samenvatting(r), /^Heenreis: Vianen → Utrecht \(wacht 30 min\) → Efteling, vertrek 2 november 2026 om 08:00\.$/m);
  assert.match(reis.samenvatting(r), /^Terugreis: Efteling → Vianen, aankomst 4 november 2026 om 17:00\.$/m);

  const oud = reis.vanAanvraag({ rit_datum: '2026-11-02', vertrek_tijd: null, van: 'A', naar: 'B', personen: 10, ritsoort: 'hele_dag' });
  assert.equal(oud.reistype, 'retour');
  assert.equal(oud.datum_terug, '');
  assert.equal(oud.bus_blijft, true);
  assert.deepEqual(oud.via, []);
  assert.equal(reis.soortLabel(oud), 'Retour op dezelfde dag');
  assert.equal(reis.soortLabel(reis.vanAanvraag({ rit_datum: '2026-11-02', van: 'A', naar: 'B', ritsoort: 'enkel' })), 'Enkele reis');
});

test('wachttijdlabels', () => {
  assert.equal(reis.wachtLabel(15), '15 min');
  assert.equal(reis.wachtLabel(60), '1 uur');
  assert.equal(reis.wachtLabel(135), '2 uur 15 min');
  assert.equal(reis.WACHTTIJDEN.length, 16);
  assert.equal(reis.WACHTTIJDEN[15], 240);
});
