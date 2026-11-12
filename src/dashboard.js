// Dashboard voor Pouw: laat zien dat het systeem het probleem van de openstaande facturen oplost.
// laadBasis() haalt de ruwe rijen uit de database; bereken() is puur en wordt met vaste testdata getest
// (deelbetalingen via de deurwaarder, creditnota's, annuleringsfacturen, aanbetalingen).
const { all } = require('./db');

const DAG = 864e5;
const GESLOTEN_DOSSIER = ['betaald', 'oninbaar', 'teruggetrokken'];

function dagStart(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}
function dagen(van, tot) {
  return Math.round((dagStart(tot) - dagStart(van)) / DAG);
}
function iso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function eindeVorigeMaand(nu) {
  const x = new Date(nu);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 0));
}
function eindeMaand(jaar, maand) {
  return new Date(Date.UTC(jaar, maand, 0));
}

// Hoofdsom van een factuur op peildatum D: totaal min creditnota's tot D; nog open = hoofdsom min aanbetalingen min ontvangsten tot D.
function factuurOp(f, peil) {
  const p = dagStart(peil);
  if (dagStart(f.factuurdatum) > p) return null;
  const credit = f.credit_op && dagStart(f.credit_op) <= p ? f.credit_cent || 0 : 0;
  const hoofdsom = f.totaal_cent - credit;
  const ontvangen = (f.betalingen || []).filter((b) => dagStart(b.datum) <= p).reduce((s, b) => s + b.bedrag_cent, 0);
  const betaald = f.betaald_op && dagStart(f.betaald_op) <= p;
  const open = betaald ? 0 : Math.max(0, hoofdsom - (f.reeds_betaald_cent || 0) - ontvangen);
  const vervallen = open > 0 && dagStart(f.vervaldatum) < p;
  return { hoofdsom, open, vervallen, betaald, dagenVervallen: vervallen ? dagen(f.vervaldatum, peil) : 0 };
}
function openstaandOp(facturen, peil) {
  let open = 0;
  let vervallen = 0;
  for (const f of facturen) {
    const x = factuurOp(f, peil);
    if (!x) continue;
    open += x.open;
    if (x.vervallen) vervallen += x.open;
  }
  return { open, vervallen };
}

// DSO en aandeel op tijd over de facturen die in het venster (90 dagen tot peildatum) zijn betaald.
function betaalgedrag(facturen, peil, vensterDagen = 90) {
  const p = dagStart(peil);
  const van = p - vensterDagen * DAG;
  const betaald = facturen.filter((f) => f.betaald_op && dagStart(f.betaald_op) > van && dagStart(f.betaald_op) <= p && (f.totaal_cent - (f.credit_cent || 0)) > 0);
  if (!betaald.length) return { dso: null, opTijd: null, aantal: 0 };
  const dso = betaald.reduce((s, f) => s + dagen(f.factuurdatum, f.betaald_op), 0) / betaald.length;
  const opTijd = betaald.filter((f) => dagStart(f.betaald_op) <= dagStart(f.vervaldatum)).length / betaald.length;
  return { dso: Math.round(dso * 10) / 10, opTijd, aantal: betaald.length };
}
function aanbetalingenIn(termijnen, jaar, maand) {
  return termijnen.filter((t) => t.betaald_op && new Date(t.betaald_op).getUTCFullYear() === jaar && new Date(t.betaald_op).getUTCMonth() + 1 === maand).reduce((s, t) => s + t.bedrag_cent, 0);
}

const BUCKETS = [
  { id: 'niet', label: 'Niet vervallen', van: null, tot: 0 },
  { id: '1-14', label: '1 tot 14 dagen', van: 1, tot: 14 },
  { id: '15-30', label: '15 tot 30 dagen', van: 15, tot: 30 },
  { id: '31-60', label: '31 tot 60 dagen', van: 31, tot: 60 },
  { id: '60plus', label: 'Meer dan 60 dagen', van: 61, tot: null },
];
function bucketVoor(dagenVervallen) {
  if (dagenVervallen <= 0) return 'niet';
  if (dagenVervallen <= 14) return '1-14';
  if (dagenVervallen <= 30) return '15-30';
  if (dagenVervallen <= 60) return '31-60';
  return '60plus';
}
function ouderdom(facturen, peil) {
  const uit = BUCKETS.map((b) => ({ ...b, aantal: 0, bedrag: 0, facturen: [] }));
  for (const f of facturen) {
    const x = factuurOp(f, peil);
    if (!x || x.open <= 0) continue;
    const b = uit.find((u) => u.id === bucketVoor(x.dagenVervallen));
    b.aantal += 1;
    b.bedrag += x.open;
    b.facturen.push({ id: f.id, nummer: f.nummer, klant: f.klant_naam, aanvraag_id: f.aanvraag_id, open: x.open, vervaldatum: f.vervaldatum, dagen: x.dagenVervallen, incasso: !!f.incasso });
  }
  return uit;
}

// Per groep (klasse of klanttype): ritten (facturen), omzet, aandeel te laat en gemiddelde dagen te laat, laatste 12 maanden.
function perGroep(facturen, peil, sleutel, groepen) {
  const p = dagStart(peil);
  const van = p - 365 * DAG;
  const uit = groepen.map((g) => ({ groep: g, ritten: 0, omzet: 0, teLaat: 0, metTermijn: 0, dagenTeLaat: 0 }));
  for (const f of facturen) {
    if (dagStart(f.factuurdatum) <= van || dagStart(f.factuurdatum) > p) continue;
    const g = uit.find((u) => u.groep === f[sleutel]) || uit.find((u) => u.groep === 'onbekend');
    if (!g) continue;
    const x = factuurOp(f, peil);
    g.ritten += 1;
    g.omzet += x.hoofdsom;
    if (x.hoofdsom <= 0) continue;
    // Alleen facturen waarvan de termijn al is verstreken tellen mee voor "te laat".
    if (dagStart(f.vervaldatum) < p || x.betaald) {
      g.metTermijn += 1;
      const laat = x.betaald ? Math.max(0, dagen(f.vervaldatum, f.betaald_op)) : x.dagenVervallen;
      if (laat > 0) {
        g.teLaat += 1;
        g.dagenTeLaat += laat;
      }
    }
  }
  return uit.map((g) => ({ ...g, aandeelTeLaat: g.metTermijn ? g.teLaat / g.metTermijn : null, gemDagenTeLaat: g.teLaat ? Math.round((g.dagenTeLaat / g.teLaat) * 10) / 10 : 0 }));
}

function armaere(dossiers) {
  const lopend = dossiers.filter((d) => !GESLOTEN_DOSSIER.includes(d.status));
  const gesloten = dossiers.filter((d) => GESLOTEN_DOSSIER.includes(d.status));
  const geslaagd = gesloten.filter((d) => d.status === 'betaald').length;
  return {
    aantal: lopend.length,
    hoofdsom: lopend.reduce((s, d) => s + d.hoofdsom_cent, 0),
    ontvangen: lopend.reduce((s, d) => s + (d.ontvangen_cent || 0), 0),
    totaalOoit: dossiers.length,
    slaging: gesloten.length ? geslaagd / gesloten.length : null,
    ontvangenOoit: dossiers.reduce((s, d) => s + (d.ontvangen_cent || 0), 0),
    hoofdsomOoit: dossiers.reduce((s, d) => s + d.hoofdsom_cent, 0),
  };
}

function topDebiteuren(facturen, peil, n = 10) {
  const per = new Map();
  for (const f of facturen) {
    const x = factuurOp(f, peil);
    if (!x || x.open <= 0) continue;
    const k = per.get(f.klant_id) || { klant_id: f.klant_id, klant: f.klant_naam, klasse: f.klasse || '-', type: f.klanttype, open: 0, vervallen: 0, facturen: 0, laatsteHerinnering: null, incasso: false };
    k.open += x.open;
    if (x.vervallen) k.vervallen += x.open;
    k.facturen += 1;
    if (f.laatste_herinnering_op && (!k.laatsteHerinnering || new Date(f.laatste_herinnering_op) > new Date(k.laatsteHerinnering))) k.laatsteHerinnering = f.laatste_herinnering_op;
    if (f.incasso) k.incasso = true;
    per.set(f.klant_id, k);
  }
  return [...per.values()].sort((a, b) => b.open - a.open).slice(0, n);
}

function weekreeks(facturen, peil, weken = 26) {
  const p = dagStart(peil);
  const dagVanWeek = new Date(p).getUTCDay(); // 0 = zondag
  const zondag = p + ((7 - dagVanWeek) % 7) * DAG;
  const uit = [];
  for (let i = weken - 1; i >= 0; i--) {
    const d = Math.min(zondag - i * 7 * DAG, p);
    uit.push({ week: iso(d), ...openstaandOp(facturen, d) });
  }
  return uit;
}

function bereken(basis, nu = new Date()) {
  const { facturen, termijnen, dossiers } = basis;
  const peil = new Date(dagStart(nu));
  const vorige = eindeVorigeMaand(peil);
  const jaar = peil.getUTCFullYear();
  const maand = peil.getUTCMonth() + 1;
  const vorigJaar = vorige.getUTCFullYear();
  const vorigeMaand = vorige.getUTCMonth() + 1;
  const nuOpen = openstaandOp(facturen, peil);
  const vorigOpen = openstaandOp(facturen, vorige);
  const gedrag = betaalgedrag(facturen, peil);
  const gedragVorig = betaalgedrag(facturen, vorige);
  return {
    peildatum: iso(peil),
    vorigePeildatum: iso(vorige),
    kerncijfers: {
      openstaand: { nu: nuOpen.open, vorig: vorigOpen.open },
      vervallen: { nu: nuOpen.vervallen, vorig: vorigOpen.vervallen },
      dso: { nu: gedrag.dso, vorig: gedragVorig.dso, aantal: gedrag.aantal },
      opTijd: { nu: gedrag.opTijd, vorig: gedragVorig.opTijd },
      aanbetalingen: { nu: aanbetalingenIn(termijnen, jaar, maand), vorig: aanbetalingenIn(termijnen, vorigJaar, vorigeMaand) },
    },
    weken: weekreeks(facturen, peil),
    ouderdom: ouderdom(facturen, peil),
    perKlasse: perGroep(facturen, peil, 'klasse', ['A', 'B', 'C', 'D']),
    perKlanttype: perGroep(facturen, peil, 'klanttype', ['onderwijs', 'bedrijf', 'vereniging', 'particulier']),
    armaere: armaere(dossiers),
    debiteuren: topDebiteuren(facturen, peil),
  };
}

// ---- Database ----
async function laadBasis() {
  const facturen = await all(
    `SELECT f.id, f.nummer, f.aanvraag_id, f.klant_id, f.totaal_cent, f.reeds_betaald_cent, f.credit_cent, f.credit_op, f.factuurdatum, f.vervaldatum, f.betaald_op,
            f.incasso, f.laatste_herinnering_op, k.naam klant_naam, k.type klanttype, coalesce(k.klasse_override, a.klasse) klasse, a.annulering_op,
            coalesce((SELECT json_agg(json_build_object('bedrag_cent', b.bedrag_cent, 'datum', b.datum)) FROM dossier_betalingen b JOIN dossiers d ON d.id=b.dossier_id WHERE d.factuur_id=f.id), '[]'::json) betalingen
     FROM facturen f JOIN klanten k ON k.id=f.klant_id JOIN aanvragen a ON a.id=f.aanvraag_id`,
  );
  const termijnen = await all('SELECT bedrag_cent, betaald_op, soort FROM termijnen WHERE betaald_op IS NOT NULL');
  const dossiers = await all('SELECT id, status, hoofdsom_cent, ontvangen_cent, overgedragen_op, gesloten_op FROM dossiers');
  return { facturen, termijnen, dossiers };
}

// ---- CSV ----
function csv(rijen, kolommen) {
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[kolommen.map((k) => esc(k.label)).join(';'), ...rijen.map((r) => kolommen.map((k) => esc(typeof k.waarde === 'function' ? k.waarde(r) : r[k.waarde])).join(';'))].join('\r\n')}\r\n`;
}
const eur = (c) => Math.round(c) / 100;
const TABELLEN = {
  weken: (d) => csv(d.weken, [{ label: 'Week t/m', waarde: 'week' }, { label: 'Openstaand', waarde: (r) => eur(r.open) }, { label: 'Vervallen', waarde: (r) => eur(r.vervallen) }]),
  ouderdom: (d) => csv(d.ouderdom, [{ label: 'Bucket', waarde: 'label' }, { label: 'Aantal', waarde: 'aantal' }, { label: 'Bedrag', waarde: (r) => eur(r.bedrag) }]),
  klasse: (d) => csv(d.perKlasse, [{ label: 'Klasse', waarde: 'groep' }, { label: 'Ritten', waarde: 'ritten' }, { label: 'Omzet', waarde: (r) => eur(r.omzet) }, { label: 'Aandeel te laat', waarde: (r) => (r.aandeelTeLaat == null ? '' : Math.round(r.aandeelTeLaat * 100)) }, { label: 'Gem. dagen te laat', waarde: 'gemDagenTeLaat' }]),
  klanttype: (d) => csv(d.perKlanttype, [{ label: 'Klanttype', waarde: 'groep' }, { label: 'Ritten', waarde: 'ritten' }, { label: 'Omzet', waarde: (r) => eur(r.omzet) }, { label: 'Aandeel te laat', waarde: (r) => (r.aandeelTeLaat == null ? '' : Math.round(r.aandeelTeLaat * 100)) }, { label: 'Gem. dagen te laat', waarde: 'gemDagenTeLaat' }]),
  debiteuren: (d) => csv(d.debiteuren, [{ label: 'Debiteur', waarde: 'klant' }, { label: 'Klasse', waarde: 'klasse' }, { label: 'Type', waarde: 'type' }, { label: 'Open', waarde: (r) => eur(r.open) }, { label: 'Waarvan vervallen', waarde: (r) => eur(r.vervallen) }, { label: 'Facturen', waarde: 'facturen' }, { label: 'Laatste herinnering', waarde: (r) => (r.laatsteHerinnering ? iso(new Date(r.laatsteHerinnering).getTime()) : '') }, { label: 'Bij deurwaarder', waarde: (r) => (r.incasso ? 'ja' : 'nee') }]),
  armaere: (d) => csv([d.armaere], [{ label: 'Lopende dossiers', waarde: 'aantal' }, { label: 'Hoofdsom', waarde: (r) => eur(r.hoofdsom) }, { label: 'Ontvangen', waarde: (r) => eur(r.ontvangen) }, { label: 'Slagingspercentage', waarde: (r) => (r.slaging == null ? '' : Math.round(r.slaging * 100)) }]),
  facturen: (d) => csv(d.ouderdom.flatMap((b) => b.facturen.map((f) => ({ ...f, bucket: b.label }))), [{ label: 'Factuur', waarde: 'nummer' }, { label: 'Debiteur', waarde: 'klant' }, { label: 'Bucket', waarde: 'bucket' }, { label: 'Open', waarde: (r) => eur(r.open) }, { label: 'Vervaldatum', waarde: (r) => iso(new Date(r.vervaldatum).getTime()) }, { label: 'Dagen vervallen', waarde: 'dagen' }]),
};

module.exports = { bereken, laadBasis, factuurOp, openstaandOp, betaalgedrag, ouderdom, bucketVoor, BUCKETS, perGroep, armaere, topDebiteuren, weekreeks, csv, TABELLEN, dagen, eindeVorigeMaand, eindeMaand, GESLOTEN_DOSSIER };
