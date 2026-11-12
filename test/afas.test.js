const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://niet-gebruikt@localhost/x';
process.env.AFAS_GROOTBOEK_OMZET = '8000';
process.env.AFAS_GROOTBOEK_NAKOSTEN = '8010';
process.env.AFAS_DAGBOEK = '70';
const afas = require('../src/afas');

test('btw splitsen op de cent: 9% en 21%, en de keuze per nakostenregel', () => {
  assert.deepEqual(afas.splitsBtw(109000, 9), { excl: 100000, btw: 9000 });
  assert.deepEqual(afas.splitsBtw(12100, 21), { excl: 10000, btw: 2100 });
  const s = afas.splitsBtw(2500, 9);
  assert.equal(s.excl + s.btw, 2500, 'excl en btw tellen altijd op tot het bedrag incl.');
  assert.equal(afas.btwVoorNakosten('Parkeergeld Efteling'), 9);
  assert.equal(afas.btwVoorNakosten('Tol'), 9);
  assert.equal(afas.btwVoorNakosten('Schoonmaakkosten'), 21);
  assert.equal(afas.btwVoorNakosten('Verblijf chauffeur'), 21);
  assert.equal(afas.btwVoorNakosten('Schade aan de bus (ritrapport R-3)'), 21);
});

test('factuuradres uit één regel: straat, huisnummer, toevoeging, postcode, plaats', () => {
  assert.deepEqual(afas.parseAdres('Hagenweg 3c, 4131 LX Vianen'), { Ad: 'Hagenweg', HmNr: 3, HmAd: 'c', ZpCd: '4131LX', Rs: 'Vianen', compleet: true });
  assert.deepEqual(afas.parseAdres('Europalaan 1 5171KW Kaatsheuvel'), { Ad: 'Europalaan', HmNr: 1, HmAd: null, ZpCd: '5171KW', Rs: 'Kaatsheuvel', compleet: true });
  assert.equal(afas.parseAdres('Postbus 12').compleet, false);
  assert.equal(afas.parseAdres('').Ad, '');
});

test('debiteur: organisatie met KvK en adres, particulier als persoon', () => {
  const org = afas.debiteurPayload({ id: 3, type: 'onderwijs', naam: 'Mariaschool', kvk: '12345678' }, { factuur_email: 'adm@mariaschool.nl', factuur_adres: 'Schoolstraat 1, 4131 AB Vianen', aanvrager_tel: '0612345678' });
  assert.equal(org.connector, 'KnSalesRelationOrg');
  const e = org.body.KnSalesRelationOrg.Element;
  assert.equal(e.Fields.IsDb, true);
  assert.equal(e.Fields.EmFa, 'adm@mariaschool.nl');
  assert.equal(e.Objects.KnOrganisation.Element.Fields.CcNr, '12345678');
  assert.equal(e.Objects.KnOrganisation.Element.Fields.Nm, 'Mariaschool');
  assert.equal(e.Objects.KnOrganisation.Element.Objects.KnBasicAddressAdr.Element.Fields.ZpCd, '4131AB');
  assert.equal(e.Objects.KnOrganisation.Element.Objects.KnBasicAddressAdr.Element.Fields.CoId, 'NL');
  const per = afas.debiteurPayload({ id: 4, type: 'particulier', naam: 'Jan de Vries', tekenbevoegde: 'Jan de Vries', teken_email: 'jan@x.nl' }, { factuur_email: 'jan@x.nl', factuur_adres: 'Dorpsweg 10, 1234 AB Dorp' });
  assert.equal(per.connector, 'KnSalesRelationPer');
  const p = per.body.KnSalesRelationPer.Element.Objects.KnPerson.Element.Fields;
  assert.equal(p.FiNm, 'Jan');
  assert.equal(p.LaNm, 'de Vries');
  assert.equal(p.MatchPer, '7');
});

test('verkoopboeking: debiteur debet, omzet en btw credit, in balans, met factuurnummer en vervaldatum', () => {
  const a = { rit_datum: '2026-11-12', van: 'Vianen', naar: 'Kaatsheuvel', ritprijs_cent: 240000 };
  const regels = afas.factuurRegels(a, [{ omschrijving: 'Parkeergeld', bedrag_cent: 2500 }, { omschrijving: 'Schoonmaakkosten', bedrag_cent: 12100 }]);
  assert.equal(regels.length, 3);
  assert.deepEqual(regels.map((r) => r.pct), [9, 9, 21]);
  const p = afas.boekingPayload({ dagboek: '70', boekdatum: '2026-11-13', factuurnummer: 'EPV-2026-0005', vervaldatum: '2026-11-27', debiteur: '10234', regels, omschrijving: 'Factuur EPV-2026-0005 Mariaschool' });
  assert.equal(p.connector, 'FiEntries');
  assert.equal(p.totaal, 254600);
  const kop = p.body.FiEntryPar.Element.Fields;
  assert.deepEqual(kop, { JoCo: '70', Year: 2026, Peri: 11, AuNu: false });
  const lijnen = p.body.FiEntryPar.Element.Objects[0].FiEntries.Element.map((e) => e.Fields);
  assert.equal(lijnen[0].VaAs, '2');
  assert.equal(lijnen[0].AcNr, '10234');
  assert.equal(lijnen[0].InId, 'EPV-2026-0005');
  assert.equal(lijnen[0].DaEx, '2026-11-27');
  assert.equal(lijnen[0].AmDe, 2546);
  const omzet = lijnen.filter((l) => l.AcNr === '8000' || l.AcNr === '8010');
  assert.equal(omzet.length, 3);
  assert.equal(omzet[0].AmCr, 2201.83); // 2400 / 1,09
  assert.equal(omzet[2].AmCr, 100); // 121 / 1,21
  const btw = lijnen.filter((l) => l.AcNr === '1500' || l.AcNr === '1510');
  assert.equal(btw.length, 2);
  assert.equal(btw.find((l) => l.AcNr === '1510').AmCr, 21);
  assert.equal(afas.inBalans(p.body), true);
  const credit = afas.boekingPayload({ dagboek: '70', boekdatum: '2026-11-13', factuurnummer: 'EPV-2026-0005-C1', vervaldatum: null, debiteur: '10234', regels: [{ omschrijving: 'Creditnota', bedrag_cent: 15000, pct: 9, rekening: '8000' }], credit: true, omschrijving: 'Creditnota' });
  const cl = credit.body.FiEntryPar.Element.Objects[0].FiEntries.Element.map((e) => e.Fields);
  assert.equal(cl[0].AmCr, 150);
  assert.equal(cl[0].AmDe, 0);
  assert.equal(cl[0].DaEx, undefined);
  assert.equal(afas.inBalans(credit.body), true);
});

test('aanbetaling, verrekening en betaling: bankboek, vooruitontvangen en debiteur met factuurnummer; rente apart', () => {
  const aanb = afas.aanbetalingPayload({ boekdatum: '2026-10-20', bedragCent: 72000, omschrijving: 'Aanbetaling 30% EPV-12 (iDEAL)' });
  const al = aanb.body.FiEntryPar.Element.Objects[0].FiEntries.Element.map((e) => e.Fields);
  assert.equal(al[0].AcNr, '1100');
  assert.equal(al[0].AmDe, 720);
  assert.equal(al[1].AcNr, '1700');
  assert.equal(al[1].AmCr, 720);
  assert.equal(afas.inBalans(aanb.body), true);
  const ver = afas.verrekeningPayload({ boekdatum: '2026-11-13', factuurnummer: 'EPV-2026-0005', debiteur: '10234', bedragCent: 72000, omschrijving: 'Verrekening' });
  const vl = ver.body.FiEntryPar.Element.Objects[0].FiEntries.Element.map((e) => e.Fields);
  assert.equal(vl[0].AcNr, '1700');
  assert.equal(vl[1].VaAs, '2');
  assert.equal(vl[1].InId, 'EPV-2026-0005');
  assert.equal(afas.inBalans(ver.body), true);
  const bet = afas.betalingPayload({ dagboek: '80', boekdatum: '2026-12-01', factuurnummer: 'EPV-2026-0005', debiteur: '10234', bedragCent: 182600, omschrijving: 'Betaling (Armaere)', tegenrekening: '1100', extraCent: 37500, extraRekening: '8000', extraOmschrijving: 'Rente en incassokosten' });
  const bl = bet.body.FiEntryPar.Element.Objects[0].FiEntries.Element.map((e) => e.Fields);
  assert.equal(bl[0].AmDe, 2201);
  assert.equal(bl[1].AmCr, 1826);
  assert.equal(bl[2].AmCr, 375);
  assert.equal(afas.inBalans(bet.body), true);
});

test('AfasToken-header, basis-URL, foutmelding uit X-Profit-Error en de herkansingstijden', () => {
  const h = afas.authHeader('ABC123');
  assert.match(h, /^AfasToken /);
  assert.equal(Buffer.from(h.slice(10), 'base64').toString(), '<token><version>1</version><data>ABC123</data></token>');
  assert.equal(afas.basisUrl({ omgeving: '12345', type: 'rest' }), 'https://12345.rest.afas.online/ProfitRestServices');
  assert.equal(afas.basisUrl({ omgeving: '12345', type: 'resttest' }), 'https://12345.resttest.afas.online/ProfitRestServices');
  const res = { status: 500, headers: { get: (n) => (n === 'x-profit-error' ? Buffer.from('Debiteur 10234 bestaat niet').toString('base64') : null) } };
  assert.equal(afas.foutUitAntwoord(res, ''), 'Debiteur 10234 bestaat niet');
  assert.equal(afas.foutUitAntwoord({ status: 401, headers: { get: () => null } }, 'nee'), 'HTTP 401: nee');
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  assert.equal(afas.volgendePoging(0, t0).toISOString(), '2026-11-12T10:05:00.000Z');
  assert.equal(afas.volgendePoging(1, t0).toISOString(), '2026-11-12T10:30:00.000Z');
  assert.equal(afas.volgendePoging(2, t0).toISOString(), '2026-11-12T12:00:00.000Z');
  assert.equal(afas.volgendePoging(3, t0), null, 'na de derde herkansing stopt het en komt er een melding');
  assert.deepEqual(afas.HERKANSING_MINUTEN, [5, 30, 120]);
});

test('debiteurnummer uit het antwoord en invullen in wachtende boekingen', () => {
  assert.equal(afas.debiteurUitAntwoord({ results: { KnSalesRelationOrg: { DbId: '10234', BcCo: '55', BcId: '7' } } }), '10234');
  assert.equal(afas.debiteurUitAntwoord({ DbId: 9 }), '9');
  assert.equal(afas.debiteurUitAntwoord({ results: {} }), null);
  const body = { FiEntryPar: { Element: { Objects: [{ FiEntries: { Element: [{ Fields: { VaAs: '2', AcNr: '{{DEBITEUR}}' } }] } }] } } };
  assert.equal(afas.vulDebiteur(body, '10234').FiEntryPar.Element.Objects[0].FiEntries.Element[0].Fields.AcNr, '10234');
});
