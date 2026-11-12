const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://niet-gebruikt@localhost/x';
const dashboard = require('../src/dashboard');
const rapport = require('../src/rapport');
const { Document, breedte } = require('../src/pdf');

// Vaste testdata, peildatum 12 november 2026. Bedragen in centen.
const F = (o) => ({ credit_cent: 0, credit_op: null, reeds_betaald_cent: 0, betaald_op: null, incasso: false, laatste_herinnering_op: null, betalingen: [], klanttype: 'bedrijf', klasse: 'A', ...o });
const facturen = [
  // 1. Op tijd betaald, met aanbetaling van 300 (reeds betaald): hoofdsom 1000, open 0.
  F({ id: 1, nummer: 'F-1', klant_id: 1, klant_naam: 'Mariaschool', klanttype: 'onderwijs', klasse: 'A', totaal_cent: 100000, reeds_betaald_cent: 30000, factuurdatum: '2026-09-01', vervaldatum: '2026-09-15', betaald_op: '2026-09-10' }),
  // 2. Te laat betaald (20 dagen na vervaldatum), DSO 34 dagen.
  F({ id: 2, nummer: 'F-2', klant_id: 2, klant_naam: 'Bouwbedrijf Jansen', klanttype: 'bedrijf', klasse: 'B', totaal_cent: 200000, factuurdatum: '2026-09-20', vervaldatum: '2026-10-04', betaald_op: '2026-10-24' }),
  // 3. Open, 10 dagen vervallen, met creditnota van 100 op 5 november: open 1400.
  F({ id: 3, nummer: 'F-3', klant_id: 2, klant_naam: 'Bouwbedrijf Jansen', klanttype: 'bedrijf', klasse: 'B', totaal_cent: 150000, credit_cent: 10000, credit_op: '2026-11-05', factuurdatum: '2026-10-19', vervaldatum: '2026-11-02', laatste_herinnering_op: '2026-11-05' }),
  // 4. Bij de deurwaarder, 45 dagen vervallen, deelbetaling van 500 via Armaere: open 2500.
  F({ id: 4, nummer: 'F-4', klant_id: 3, klant_naam: 'Vereniging De Pedaal', klanttype: 'vereniging', klasse: 'C', totaal_cent: 300000, factuurdatum: '2026-09-14', vervaldatum: '2026-09-28', incasso: true, betalingen: [{ bedrag_cent: 50000, datum: '2026-11-01' }] }),
  // 5. Nog niet vervallen (vervalt 20 november), open 800.
  F({ id: 5, nummer: 'F-5', klant_id: 4, klant_naam: 'Fam. de Vries', klanttype: 'particulier', klasse: 'D', totaal_cent: 80000, factuurdatum: '2026-11-06', vervaldatum: '2026-11-20' }),
  // 6. Annuleringsfactuur van 125 (minimum), 70 dagen vervallen, open.
  F({ id: 6, nummer: 'F-6', klant_id: 5, klant_naam: 'Stichting Zon', klanttype: 'vereniging', klasse: 'C', totaal_cent: 12500, factuurdatum: '2026-08-20', vervaldatum: '2026-09-03' }),
  // 7. Volledig gecrediteerd: hoofdsom 0, telt nergens mee.
  F({ id: 7, nummer: 'F-7', klant_id: 1, klant_naam: 'Mariaschool', klanttype: 'onderwijs', klasse: 'A', totaal_cent: 50000, credit_cent: 50000, credit_op: '2026-10-02', factuurdatum: '2026-10-01', vervaldatum: '2026-10-15', betaald_op: '2026-10-02' }),
  // 8. Factuur van ná de peildatum: telt niet mee.
  F({ id: 8, nummer: 'F-8', klant_id: 1, klant_naam: 'Mariaschool', klanttype: 'onderwijs', klasse: 'A', totaal_cent: 90000, factuurdatum: '2026-11-20', vervaldatum: '2026-12-04' }),
];
const termijnen = [
  { bedrag_cent: 30000, betaald_op: '2026-08-20T10:00:00Z', soort: 'aanbetaling' },
  { bedrag_cent: 45000, betaald_op: '2026-10-03T10:00:00Z', soort: 'aanbetaling' },
  { bedrag_cent: 60000, betaald_op: '2026-11-02T10:00:00Z', soort: 'aanbetaling' },
];
const dossiers = [
  { id: 1, status: 'in_behandeling', hoofdsom_cent: 300000, ontvangen_cent: 50000, overgedragen_op: '2026-10-20' },
  { id: 2, status: 'betaald', hoofdsom_cent: 120000, ontvangen_cent: 120000, overgedragen_op: '2026-06-01', gesloten_op: '2026-07-10' },
  { id: 3, status: 'oninbaar', hoofdsom_cent: 40000, ontvangen_cent: 0, overgedragen_op: '2026-05-01', gesloten_op: '2026-09-01' },
];
const nu = new Date('2026-11-12T10:00:00Z');

test('openstaand en vervallen op de peildatum, met creditnota, deelbetaling en aanbetaling', () => {
  const o = dashboard.openstaandOp(facturen, nu);
  assert.equal(o.open, 140000 + 250000 + 80000 + 12500);
  assert.equal(o.vervallen, 140000 + 250000 + 12500);
  // Eind oktober: factuur 3 nog niet gecrediteerd (1500), factuur 4 nog zonder deelbetaling (3000), factuur 5 bestond nog niet.
  const vorig = dashboard.openstaandOp(facturen, new Date('2026-10-31T00:00:00Z'));
  assert.equal(vorig.open, 150000 + 300000 + 12500);
  assert.equal(vorig.vervallen, 300000 + 12500);
  const f4 = dashboard.factuurOp(facturen[3], nu);
  assert.equal(f4.dagenVervallen, 45);
  assert.equal(dashboard.factuurOp(facturen[7], nu), null, 'factuur van na de peildatum telt niet');
});

test('DSO en aandeel binnen de termijn over 90 dagen; volledig gecrediteerde factuur telt niet', () => {
  const g = dashboard.betaalgedrag(facturen, nu);
  assert.equal(g.aantal, 2);
  assert.equal(g.dso, (9 + 34) / 2);
  assert.equal(g.opTijd, 0.5);
  assert.equal(dashboard.betaalgedrag(facturen, new Date('2026-05-01')).dso, null);
});

test('ouderdomsanalyse in buckets met doorklik naar de facturen', () => {
  const o = dashboard.ouderdom(facturen, nu);
  const per = Object.fromEntries(o.map((b) => [b.id, b]));
  assert.equal(per.niet.bedrag, 80000);
  assert.equal(per['1-14'].bedrag, 140000);
  assert.equal(per['15-30'].bedrag, 0);
  assert.equal(per['31-60'].bedrag, 250000);
  assert.equal(per['60plus'].bedrag, 12500);
  assert.equal(per['31-60'].facturen[0].nummer, 'F-4');
  assert.equal(per['31-60'].facturen[0].incasso, true);
  assert.equal(dashboard.bucketVoor(14), '1-14');
  assert.equal(dashboard.bucketVoor(61), '60plus');
});

test('per klasse en per klanttype: ritten, omzet, aandeel te laat en gemiddelde dagen te laat', () => {
  const k = Object.fromEntries(dashboard.perGroep(facturen, nu, 'klasse', ['A', 'B', 'C', 'D']).map((g) => [g.groep, g]));
  assert.equal(k.A.ritten, 2, 'F-1 en F-7 (F-8 is van na de peildatum)');
  assert.equal(k.A.omzet, 100000);
  assert.equal(k.A.aandeelTeLaat, 0);
  assert.equal(k.B.ritten, 2);
  assert.equal(k.B.omzet, 340000);
  assert.equal(k.B.aandeelTeLaat, 1, 'F-2 was 20 dagen te laat, F-3 staat 10 dagen open');
  assert.equal(k.B.gemDagenTeLaat, 15);
  assert.equal(k.C.ritten, 2);
  assert.equal(k.C.gemDagenTeLaat, (45 + 70) / 2);
  assert.equal(k.D.ritten, 1);
  assert.equal(k.D.aandeelTeLaat, null, 'termijn nog niet verstreken');
  const t = Object.fromEntries(dashboard.perGroep(facturen, nu, 'klanttype', ['onderwijs', 'bedrijf', 'vereniging', 'particulier']).map((g) => [g.groep, g]));
  assert.equal(t.vereniging.omzet, 312500);
  assert.equal(t.particulier.ritten, 1);
});

test('dossiers bij de deurwaarder en top 10 debiteuren', () => {
  const a = dashboard.armaere(dossiers);
  assert.equal(a.aantal, 1);
  assert.equal(a.hoofdsom, 300000);
  assert.equal(a.ontvangen, 50000);
  assert.equal(a.slaging, 0.5);
  const top = dashboard.topDebiteuren(facturen, nu);
  assert.deepEqual(top.map((d) => d.klant), ['Vereniging De Pedaal', 'Bouwbedrijf Jansen', 'Fam. de Vries', 'Stichting Zon']);
  assert.equal(top[0].open, 250000);
  assert.equal(top[0].incasso, true);
  assert.equal(top[1].laatsteHerinnering, '2026-11-05');
  assert.equal(top[1].klasse, 'B');
});

test('weekreeks van 26 weken eindigt op de peildatum en kerncijfers vergelijken met vorige maand', () => {
  const d = dashboard.bereken({ facturen, termijnen, dossiers }, nu);
  assert.equal(d.weken.length, 26);
  assert.equal(d.weken[25].week, '2026-11-12');
  assert.equal(d.weken[25].open, 482500);
  assert.equal(d.weken[0].open, 0, 'half jaar geleden stond niets open');
  assert.equal(d.kerncijfers.openstaand.vorig, 462500);
  assert.equal(d.kerncijfers.aanbetalingen.nu, 60000);
  assert.equal(d.kerncijfers.aanbetalingen.vorig, 45000);
  assert.equal(d.kerncijfers.dso.nu, 21.5);
  assert.equal(d.peildatum, '2026-11-12');
  assert.equal(d.vorigePeildatum, '2026-10-31');
});

test('csv-export per tabel: puntkomma, BOM, komma als decimaalteken', () => {
  const d = dashboard.bereken({ facturen, termijnen, dossiers }, nu);
  const c = dashboard.TABELLEN.ouderdom(d);
  assert.ok(c.startsWith('﻿Bucket;Aantal;Bedrag'));
  assert.match(c, /Meer dan 60 dagen;1;125\r\n/);
  const deb = dashboard.TABELLEN.debiteuren(d);
  assert.match(deb, /Vereniging De Pedaal;C;vereniging;2500;2500;1;;ja/);
  assert.equal(dashboard.csv([{ a: 'x;y', b: 'zeg "hoi"' }], [{ label: 'A', waarde: 'a' }, { label: 'B', waarde: 'b' }]), '﻿A;B\r\n"x;y";"zeg ""hoi"""\r\n');
});

test('maandrapport: geldige pdf met de cijfers, en verzendmoment op de eerste werkdag om 08:00', () => {
  const d = dashboard.bereken({ facturen, termijnen, dossiers }, dashboard.eindeMaand(2026, 10));
  const pdf = rapport.maakPdf(d, { maandLabel: 'oktober 2026', peildatum: dashboard.eindeMaand(2026, 10) });
  assert.ok(pdf.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'));
  assert.ok(pdf.toString('latin1').includes('%%EOF'));
  assert.ok(pdf.toString('latin1').includes('(Maandrapport betalingen oktober 2026)'));
  assert.ok(pdf.toString('latin1').includes('Bouwbedrijf Jansen'));
  assert.ok(pdf.length > 3000);
  // kruisverwijzingstabel klopt: elke offset wijst naar "n 0 obj"
  const tekst = pdf.toString('latin1');
  const start = Number(tekst.match(/startxref\n(\d+)/)[1]);
  assert.equal(tekst.slice(start, start + 4), 'xref');
  const offsets = [...tekst.slice(start).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.equal(tekst.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  // euro-teken en accenten worden netjes gecodeerd
  const doc = new Document();
  doc.tekst('€ 1.250,00 à Ĉ');
  assert.ok(doc.buffer().toString('latin1').includes('(\\200 1.250,00 \\340 ?)'));
  assert.ok(breedte('Pouw', 10) > 20);
  assert.equal(rapport.eersteWerkdag(2026, 11).toISOString().slice(0, 10), '2026-11-02', '1 november 2026 is een zondag');
  assert.equal(rapport.eersteWerkdag(2026, 8).toISOString().slice(0, 10), '2026-08-03', '1 augustus 2026 is een zaterdag');
  assert.equal(rapport.isVerzendmoment(new Date('2026-11-02T07:30:00Z')), true, 'maandag 2 november 08:30 Amsterdam');
  assert.equal(rapport.isVerzendmoment(new Date('2026-11-02T06:30:00Z')), false, 'nog geen 08:00');
  assert.equal(rapport.isVerzendmoment(new Date('2026-11-03T09:00:00Z')), false);
  assert.equal(rapport.maandLabel(2026, 10), 'oktober 2026');
});
