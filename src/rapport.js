// Maandrapport als pdf met dezelfde cijfers als het dashboard. Gaat op de eerste werkdag van de maand om 08:00
// (Amsterdamse tijd) naar alle actieve beheerders; is ook te downloaden vanuit het dashboard.
const { q, one, all } = require('./db');
const dashboard = require('./dashboard');
const { Document } = require('./pdf');
const mail = require('./mail');
const { euro, datum } = require('./format');

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const dec = (v) => String(v).replace('.', ',');
const verschil = (nu, vorig, formaat = euro) => {
  if (vorig == null || nu == null) return '';
  const d = nu - vorig;
  return `${d >= 0 ? '+' : '-'}${formaat(Math.abs(d))} t.o.v. vorige maand`;
};

// Bouwt de pdf voor de maand waarin peildatum valt (peildatum = laatste dag van die maand voor een afgesloten maand).
function maakPdf(cijfers, { maandLabel, peildatum }) {
  const doc = new Document({ titel: `Maandrapport betalingen ${maandLabel}` });
  doc.tekst('boekpouwvervoer.nl · Pouw Vervoer', { grootte: 9, kleur: [91, 100, 120] });
  doc.witruimte(6);
  doc.tekst(`Maandrapport betalingen ${maandLabel}`, { grootte: 20, vet: true, kleur: [38, 54, 128] });
  doc.witruimte(4);
  doc.tekst(`Peildatum ${datum(peildatum)}. Alle cijfers rechtstreeks uit boekpouwvervoer; bedragen zijn hoofdsommen inclusief btw, na creditnota's.`, { grootte: 9, kleur: [91, 100, 120] });
  doc.witruimte(6);

  const k = cijfers.kerncijfers;
  doc.kop('Kerncijfers');
  doc.tabel(
    [{ label: 'Cijfer', breedte: 220 }, { label: 'Deze maand', breedte: 120, uitlijning: 'rechts' }, { label: 'Vorige maand', breedte: 159, uitlijning: 'rechts' }],
    [
      ['Totaal openstaand (hoofdsom)', euro(k.openstaand.nu), euro(k.openstaand.vorig)],
      ['Waarvan vervallen', euro(k.vervallen.nu), euro(k.vervallen.vorig)],
      ['DSO: dagen van factuur tot betaling (90 dagen)', k.dso.nu == null ? '-' : `${dec(k.dso.nu)} dagen`, k.dso.vorig == null ? '-' : `${dec(k.dso.vorig)} dagen`],
      ['Aandeel binnen de termijn betaald (90 dagen)', pct(k.opTijd.nu), pct(k.opTijd.vorig)],
      ['Vooraf ontvangen via aanbetalingen', euro(k.aanbetalingen.nu), euro(k.aanbetalingen.vorig)],
    ],
  );

  doc.kop('Openstaand en vervallen per week (26 weken)');
  doc.staven(
    cijfers.weken.map((w) => ({ label: w.week.slice(5), waarden: [w.open / 100, w.vervallen / 100] })),
    { legenda: ['Openstaand', 'Vervallen'], formaat: (v) => euro(Math.round(v * 100)) },
  );

  doc.kop('Ouderdomsanalyse van het openstaande saldo');
  doc.tabel(
    [{ label: 'Ouderdom', breedte: 220 }, { label: 'Facturen', breedte: 100, uitlijning: 'rechts' }, { label: 'Bedrag', breedte: 179, uitlijning: 'rechts' }],
    cijfers.ouderdom.map((b) => [b.label, b.aantal, euro(b.bedrag)]),
  );

  const groepTabel = (titel, rijen, labels) => {
    doc.kop(titel);
    doc.tabel(
      [{ label: labels, breedte: 120 }, { label: 'Ritten', breedte: 70, uitlijning: 'rechts' }, { label: 'Omzet', breedte: 110, uitlijning: 'rechts' }, { label: 'Te laat betaald', breedte: 100, uitlijning: 'rechts' }, { label: 'Gem. dagen te laat', breedte: 99, uitlijning: 'rechts' }],
      rijen.map((r) => [r.groep, r.ritten, euro(r.omzet), pct(r.aandeelTeLaat), dec(r.gemDagenTeLaat)]),
    );
  };
  groepTabel('Per klantklasse (laatste 12 maanden)', cijfers.perKlasse, 'Klasse');
  groepTabel('Per klanttype (laatste 12 maanden)', cijfers.perKlanttype, 'Klanttype');

  const a = cijfers.armaere;
  doc.kop('Dossiers bij de deurwaarder');
  doc.tabel(
    [{ label: 'Lopend', breedte: 100, uitlijning: 'rechts' }, { label: 'Hoofdsom', breedte: 120, uitlijning: 'rechts' }, { label: 'Ontvangen', breedte: 120, uitlijning: 'rechts' }, { label: 'Slagingspercentage', breedte: 159, uitlijning: 'rechts' }],
    [[a.aantal, euro(a.hoofdsom), euro(a.ontvangen), pct(a.slaging)]],
  );

  doc.kop('Top 10 debiteuren op openstaand bedrag');
  doc.tabel(
    [{ label: 'Debiteur', breedte: 170 }, { label: 'Klasse', breedte: 50, uitlijning: 'midden' }, { label: 'Open', breedte: 95, uitlijning: 'rechts' }, { label: 'Vervallen', breedte: 95, uitlijning: 'rechts' }, { label: 'Laatste herinnering', breedte: 89 }],
    cijfers.debiteuren.map((d) => [d.klant.slice(0, 34), d.klasse, euro(d.open), euro(d.vervallen), d.laatsteHerinnering ? datum(d.laatsteHerinnering) : '-']),
  );
  doc.witruimte(10);
  doc.regel('Dit rapport is automatisch gemaakt door boekpouwvervoer. Het dashboard in de backoffice toont dezelfde cijfers actueel, met doorklik naar de facturen.', { grootte: 8, kleur: [91, 100, 120] });
  return doc.buffer();
}

function maandLabel(jaar, maand) {
  return `${MAANDEN[maand - 1]} ${jaar}`;
}

// Eerste werkdag van de maand (ma t/m vr; feestdagen niet meegenomen).
function eersteWerkdag(jaar, maand) {
  const d = new Date(Date.UTC(jaar, maand - 1, 1));
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
function amsterdamUur(d) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(d)) % 24;
}
function amsterdamDatum(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// Moet het rapport over de vorige maand nu (op dit moment) gestuurd worden?
function isVerzendmoment(nu = new Date()) {
  const vandaag = amsterdamDatum(nu);
  const [jaar, maand] = vandaag.split('-').map(Number);
  const werkdag = eersteWerkdag(jaar, maand).toISOString().slice(0, 10);
  return vandaag === werkdag && amsterdamUur(nu) >= 8;
}

async function maakVoorMaand(jaar, maand, basis = null) {
  const peildatum = dashboard.eindeMaand(jaar, maand);
  const b = basis || (await dashboard.laadBasis());
  const cijfers = dashboard.bereken(b, peildatum);
  return { pdf: maakPdf(cijfers, { maandLabel: maandLabel(jaar, maand), peildatum }), cijfers, bestandsnaam: `maandrapport-${jaar}-${String(maand).padStart(2, '0')}.pdf` };
}

// Elke minuut aangeroepen; stuurt hooguit één keer per maand.
async function verstuurMaandrapport(nu = new Date()) {
  if (!isVerzendmoment(nu)) return null;
  const vorige = dashboard.eindeVorigeMaand(new Date(amsterdamDatum(nu)));
  const jaar = vorige.getUTCFullYear();
  const maand = vorige.getUTCMonth() + 1;
  const sleutel = `${jaar}-${String(maand).padStart(2, '0')}`;
  const al = await one('SELECT 1 FROM rapporten WHERE maand=$1', [sleutel]);
  if (al) return null;
  const beheerders = await all("SELECT email, naam FROM gebruikers WHERE rol='beheerder' AND actief=true");
  if (!beheerders.length) return null;
  await q('INSERT INTO rapporten (maand, verstuurd_op) VALUES ($1, now()) ON CONFLICT (maand) DO NOTHING', [sleutel]);
  const { pdf, bestandsnaam, cijfers } = await maakVoorMaand(jaar, maand);
  const k = cijfers.kerncijfers;
  await mail.verstuur({
    aan: beheerders.map((b) => b.email),
    onderwerp: `Maandrapport betalingen ${maandLabel(jaar, maand)}`,
    tekst:
      `Beste beheerders,\n\nIn de bijlage het maandrapport over ${maandLabel(jaar, maand)}.\n\n` +
      `Openstaand: ${euro(k.openstaand.nu)} (${verschil(k.openstaand.nu, k.openstaand.vorig)})\nVervallen: ${euro(k.vervallen.nu)}\n` +
      `DSO: ${k.dso.nu == null ? '-' : `${dec(k.dso.nu)} dagen`}\nBinnen de termijn betaald: ${pct(k.opTijd.nu)}\nVooraf via aanbetalingen: ${euro(k.aanbetalingen.nu)}\n\n` +
      'Het dashboard in de backoffice toont dezelfde cijfers actueel.\n\nboekpouwvervoer',
    bijlagen: [{ naam: bestandsnaam, inhoud: pdf }],
    logboek: false,
  });
  return sleutel;
}

module.exports = { maakPdf, maakVoorMaand, verstuurMaandrapport, isVerzendmoment, eersteWerkdag, maandLabel, MAANDEN };
