// Koppeling met AFAS Online (Profit REST API, UpdateConnectors). Facturen, creditnota's, aanbetalingen en betalingen
// uit boekpouwvervoer komen vanzelf in de boekhouding; de debiteur wordt bij de eerste factuur aangemaakt.
// Alles loopt via een wachtrij in de database met herkansing (5, 30 en 120 minuten); daarna een melding op de werklijst.
// Zonder AFAS_TOKEN en AFAS_OMGEVING draait de koppeling in demo-modus: de boekingen worden gemaakt en gelogd, niet verstuurd.
//
// Veldcodes volgen de AFAS-documentatie van de UpdateConnectors FiEntries, KnSalesRelationOrg en KnSalesRelationPer.
// Controleer ze vóór livegang tegen de MetaInfo van de eigen omgeving (zie README, "AFAS Online"); de payloads staan
// in de wachtrij en in demo-modus in het logboek, zodat de AFAS-beheerder ze kan nalezen.
const { q, one, all } = require('./db');
const meldingen = require('./meldingen');
const context = require('./context');
const { euro, datum } = require('./format');

const CONFIG = () => ({
  token: process.env.AFAS_TOKEN || '',
  omgeving: process.env.AFAS_OMGEVING || '',
  type: process.env.AFAS_OMGEVING_TYPE || 'rest', // rest | resttest | restaccept
  dagboek: process.env.AFAS_DAGBOEK || '70', // verkoopboek
  dagboekBank: process.env.AFAS_DAGBOEK_BANK || '80', // bankboek voor ontvangsten
  omzet: process.env.AFAS_GROOTBOEK_OMZET || '8000',
  nakosten: process.env.AFAS_GROOTBOEK_NAKOSTEN || '8010',
  btw9: process.env.AFAS_GROOTBOEK_BTW_9 || '1500', // af te dragen btw laag
  btw21: process.env.AFAS_GROOTBOEK_BTW_21 || '1510', // af te dragen btw hoog
  vooruit: process.env.AFAS_GROOTBOEK_VOORUIT || '1700', // vooruitontvangen bedragen (aanbetalingen)
  bank: process.env.AFAS_GROOTBOEK_BANK || '1100',
  incasso: process.env.AFAS_GROOTBOEK_INCASSO || process.env.AFAS_GROOTBOEK_OMZET || '8000', // rente en incassokosten (zonder btw)
  btwCode9: process.env.AFAS_BTW_CODE_9 || '2',
  btwCode21: process.env.AFAS_BTW_CODE_21 || '1',
  btwCode0: process.env.AFAS_BTW_CODE_0 || '0',
  betalingsconditie: process.env.AFAS_BETALINGSCONDITIE || '14',
  btwPlicht: process.env.AFAS_BTWPLICHT || '1',
  nakosten21: (process.env.AFAS_NAKOSTEN_21 || 'schoon,schade,rotzooi,vervuil,verblijf,maaltijd,hotel').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
});
const DEMO = !process.env.AFAS_TOKEN || !process.env.AFAS_OMGEVING;
const HERKANSING_MINUTEN = [5, 30, 120];

// ---- Rekenwerk ----
// Bedragen in de app zijn in centen inclusief btw. AFAS wil bedragen in euro's; omzet exclusief, btw apart.
function splitsBtw(inclCent, pct) {
  const excl = Math.round(inclCent / (1 + pct / 100));
  return { excl, btw: inclCent - excl };
}
function euros(cent) {
  return Math.round(cent) / 100;
}
function btwVoorNakosten(omschrijving, cfg = CONFIG()) {
  const o = String(omschrijving || '').toLowerCase();
  return cfg.nakosten21.some((w) => o.includes(w)) ? 21 : 9;
}
function periode(d) {
  const x = new Date(d);
  return { Year: x.getUTCFullYear(), Peri: x.getUTCMonth() + 1 };
}
function iso(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.toISOString().slice(0, 10);
}

// "Hagenweg 3c, 4131 LX Vianen" → straat, huisnummer, toevoeging, postcode, plaats. Lukt het niet, dan gaat de hele regel in Ad.
function parseAdres(tekst) {
  const t = String(tekst || '').trim().replace(/\s+/g, ' ');
  const m = /^(.+?)\s+(\d+)\s*([a-zA-Z0-9-]{0,6})?,?\s+(\d{4})\s?([A-Za-z]{2})\s+(.+)$/.exec(t);
  if (!m) return { Ad: t.slice(0, 60), HmNr: null, HmAd: null, ZpCd: null, Rs: null, compleet: false };
  return { Ad: m[1].slice(0, 60), HmNr: Number(m[2]), HmAd: m[3] || null, ZpCd: `${m[4]}${m[5].toUpperCase()}`, Rs: m[6].slice(0, 40), compleet: true };
}
function adresObject(adres) {
  const p = parseAdres(adres);
  const velden = { PbAd: false, Ad: p.Ad, CoId: 'NL', ResZip: false };
  if (p.HmNr) velden.HmNr = p.HmNr;
  if (p.HmAd) velden.HmAd = p.HmAd;
  if (p.ZpCd) velden.ZpCd = p.ZpCd;
  if (p.Rs) velden.Rs = p.Rs;
  return { Element: { Fields: velden } };
}

// ---- Payloads (pure) ----
// Debiteur: organisatie (KnSalesRelationOrg met KnOrganisation) of particulier (KnSalesRelationPer met KnPerson).
function debiteurPayload(klant, aanvraag, cfg = CONFIG()) {
  const relatie = {
    IsDb: true,
    PaCd: cfg.betalingsconditie,
    VaDu: cfg.btwPlicht,
    CuId: 'EUR',
    EmFa: aanvraag.factuur_email || null,
    PrLi: 0, PrFc: 0, ClPc: 0, PrPt: 0, KrLi: 0,
  };
  const adres = adresObject(aanvraag.factuur_adres);
  if (klant.type === 'particulier') {
    const delen = String(klant.tekenbevoegde || klant.naam || '').trim().split(/\s+/);
    const voornaam = delen.length > 1 ? delen[0] : '';
    const achternaam = delen.length > 1 ? delen.slice(1).join(' ') : delen[0] || '';
    return {
      connector: 'KnSalesRelationPer',
      body: {
        KnSalesRelationPer: {
          Element: {
            Fields: relatie,
            Objects: {
              KnPerson: {
                Element: {
                  Fields: { MatchPer: '7', FiNm: voornaam || null, LaNm: achternaam, SeNm: String(klant.naam || '').slice(0, 10).toUpperCase(), EmAd: klant.teken_email || aanvraag.factuur_email || null, MbNr: aanvraag.aanvrager_tel || null },
                  Objects: { KnBasicAddressAdr: adres, KnBasicAddressPad: adres },
                },
              },
            },
          },
        },
      },
    };
  }
  return {
    connector: 'KnSalesRelationOrg',
    body: {
      KnSalesRelationOrg: {
        Element: {
          Fields: relatie,
          Objects: {
            KnOrganisation: {
              Element: {
                Fields: { MatchOga: '6', Nm: String(klant.naam || '').slice(0, 100), CcNr: klant.kvk || null, SeNm: String(klant.naam || '').slice(0, 10).toUpperCase(), EmAd: aanvraag.factuur_email || null, TeNr: aanvraag.aanvrager_tel || null },
                Objects: { KnBasicAddressAdr: adres, KnBasicAddressPad: adres },
              },
            },
          },
        },
      },
    },
  };
}

// Verkoopboeking: debiteurregel (debet, met factuurnummer), omzetregels (credit, excl. btw) en btw-regels (credit).
// Regels: [{ omschrijving, bedrag_cent (incl.), pct, rekening }].
function factuurRegels(aanvraag, nakosten, cfg = CONFIG()) {
  const regels = [{ omschrijving: `Busvervoer ${datum(aanvraag.rit_datum)} ${aanvraag.van} → ${aanvraag.naar}`, bedrag_cent: aanvraag.ritprijs_cent, pct: 9, rekening: cfg.omzet }];
  for (const n of nakosten || []) regels.push({ omschrijving: n.omschrijving, bedrag_cent: n.bedrag_cent, pct: btwVoorNakosten(n.omschrijving, cfg), rekening: cfg.nakosten });
  return regels;
}
function boekingPayload({ dagboek, boekdatum, factuurnummer, vervaldatum, debiteur, regels, credit = false, omschrijving }, cfg = CONFIG()) {
  const totaal = regels.reduce((s, r) => s + r.bedrag_cent, 0);
  const btwPerPct = {};
  const lijnen = [];
  for (const r of regels) {
    const { excl, btw } = splitsBtw(r.bedrag_cent, r.pct);
    btwPerPct[r.pct] = (btwPerPct[r.pct] || 0) + btw;
    lijnen.push({ VaAs: '1', AcNr: r.rekening, Ds: String(r.omschrijving).slice(0, 80), VaId: r.pct === 21 ? cfg.btwCode21 : r.pct === 9 ? cfg.btwCode9 : cfg.btwCode0, ...(credit ? { AmDe: euros(excl), AmCr: 0 } : { AmDe: 0, AmCr: euros(excl) }) });
  }
  for (const [pct, btw] of Object.entries(btwPerPct)) {
    if (!btw) continue;
    lijnen.push({ VaAs: '1', AcNr: Number(pct) === 21 ? cfg.btw21 : cfg.btw9, Ds: `Btw ${pct}% ${factuurnummer}`, VaId: Number(pct) === 21 ? cfg.btwCode21 : cfg.btwCode9, ...(credit ? { AmDe: euros(btw), AmCr: 0 } : { AmDe: 0, AmCr: euros(btw) }) });
  }
  const debiteurRegel = { VaAs: '2', AcNr: String(debiteur), Ds: omschrijving.slice(0, 80), InId: factuurnummer, BpNr: factuurnummer, ...(vervaldatum ? { DaEx: iso(vervaldatum) } : {}), ...(credit ? { AmDe: 0, AmCr: euros(totaal) } : { AmDe: euros(totaal), AmCr: 0 }) };
  const alle = [debiteurRegel, ...lijnen].map((l) => ({ Fields: { EnDa: iso(boekdatum), BpDa: iso(boekdatum), ...l } }));
  const p = periode(boekdatum);
  return {
    connector: 'FiEntries',
    body: { FiEntryPar: { Element: { Fields: { JoCo: dagboek, Year: p.Year, Peri: p.Peri, AuNu: false }, Objects: [{ FiEntries: { Element: alle } }] } } },
    totaal,
  };
}
// Ontvangst op een factuur: bank (debet) tegen debiteur met factuurnummer (credit). Een aanbetaling vóór de factuur
// gaat naar vooruitontvangen bedragen; bij de eindfactuur wordt die verrekend (vooruitontvangen debet, debiteur credit).
function betalingPayload({ dagboek, boekdatum, factuurnummer, debiteur, bedragCent, omschrijving, tegenrekening, extraCent = 0, extraRekening, extraOmschrijving }, cfg = CONFIG()) {
  const lijnen = [
    { Fields: { EnDa: iso(boekdatum), BpDa: iso(boekdatum), VaAs: '1', AcNr: tegenrekening, Ds: omschrijving.slice(0, 80), AmDe: euros(bedragCent + extraCent), AmCr: 0 } },
    { Fields: { EnDa: iso(boekdatum), BpDa: iso(boekdatum), VaAs: '2', AcNr: String(debiteur), Ds: omschrijving.slice(0, 80), InId: factuurnummer, AmDe: 0, AmCr: euros(bedragCent) } },
  ];
  if (extraCent > 0) lijnen.push({ Fields: { EnDa: iso(boekdatum), BpDa: iso(boekdatum), VaAs: '1', AcNr: extraRekening, Ds: String(extraOmschrijving || 'Rente en incassokosten').slice(0, 80), VaId: cfg.btwCode0, AmDe: 0, AmCr: euros(extraCent) } });
  const p = periode(boekdatum);
  return { connector: 'FiEntries', body: { FiEntryPar: { Element: { Fields: { JoCo: dagboek, Year: p.Year, Peri: p.Peri, AuNu: false }, Objects: [{ FiEntries: { Element: lijnen } }] } } } };
}
function aanbetalingPayload({ boekdatum, bedragCent, omschrijving }, cfg = CONFIG()) {
  const lijnen = [
    { Fields: { EnDa: iso(boekdatum), BpDa: iso(boekdatum), VaAs: '1', AcNr: cfg.bank, Ds: omschrijving.slice(0, 80), AmDe: euros(bedragCent), AmCr: 0 } },
    { Fields: { EnDa: iso(boekdatum), BpDa: iso(boekdatum), VaAs: '1', AcNr: cfg.vooruit, Ds: omschrijving.slice(0, 80), AmDe: 0, AmCr: euros(bedragCent) } },
  ];
  const p = periode(boekdatum);
  return { connector: 'FiEntries', body: { FiEntryPar: { Element: { Fields: { JoCo: cfg.dagboekBank, Year: p.Year, Peri: p.Peri, AuNu: false }, Objects: [{ FiEntries: { Element: lijnen } }] } } } };
}
function verrekeningPayload({ boekdatum, factuurnummer, debiteur, bedragCent, omschrijving }, cfg = CONFIG()) {
  const lijnen = [
    { Fields: { EnDa: iso(boekdatum), BpDa: iso(boekdatum), VaAs: '1', AcNr: cfg.vooruit, Ds: omschrijving.slice(0, 80), AmDe: euros(bedragCent), AmCr: 0 } },
    { Fields: { EnDa: iso(boekdatum), BpDa: iso(boekdatum), VaAs: '2', AcNr: String(debiteur), Ds: omschrijving.slice(0, 80), InId: factuurnummer, AmDe: 0, AmCr: euros(bedragCent) } },
  ];
  const p = periode(boekdatum);
  return { connector: 'FiEntries', body: { FiEntryPar: { Element: { Fields: { JoCo: cfg.dagboekBank, Year: p.Year, Peri: p.Peri, AuNu: false }, Objects: [{ FiEntries: { Element: lijnen } }] } } } };
}

// Controle: elke journaalpost moet in balans zijn (debet = credit), op de cent.
function inBalans(body) {
  const lijnen = (((body.FiEntryPar || {}).Element || {}).Objects || []).flatMap((o) => ((o.FiEntries || {}).Element || []).map((e) => e.Fields));
  const debet = lijnen.reduce((s, f) => s + Math.round((f.AmDe || 0) * 100), 0);
  const credit = lijnen.reduce((s, f) => s + Math.round((f.AmCr || 0) * 100), 0);
  return debet === credit;
}

// ---- Versturen ----
function authHeader(token) {
  const xml = `<token><version>1</version><data>${token}</data></token>`;
  return `AfasToken ${Buffer.from(xml, 'utf8').toString('base64')}`;
}
function basisUrl(cfg = CONFIG()) {
  return `https://${cfg.omgeving}.${cfg.type}.afas.online/ProfitRestServices`;
}
function foutUitAntwoord(res, tekst) {
  const kop = res.headers && res.headers.get ? res.headers.get('x-profit-error') : null;
  if (kop) {
    try {
      return Buffer.from(kop, 'base64').toString('utf8');
    } catch {
      return kop;
    }
  }
  return `HTTP ${res.status}${tekst ? `: ${String(tekst).slice(0, 300)}` : ''}`;
}
async function verzend({ connector, methode = 'POST', body }, cfg = CONFIG()) {
  const res = await fetch(`${basisUrl(cfg)}/connectors/${connector}`, {
    method: methode,
    headers: { Authorization: authHeader(cfg.token), 'Content-Type': 'application/json;charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const tekst = await res.text();
  if (!res.ok) throw new Error(foutUitAntwoord(res, tekst));
  try {
    return tekst ? JSON.parse(tekst) : {};
  } catch {
    return { raw: tekst };
  }
}

// ---- Wachtrij ----
function volgendePoging(pogingen, nu = Date.now()) {
  const m = HERKANSING_MINUTEN[pogingen];
  return m == null ? null : new Date(nu + m * 60e3);
}

async function zetInWachtrij({ soort, connector, methode = 'POST', body, aanvraagId = null, klantId = null, factuurId = null, omschrijving = '', wachtOp = null }) {
  if (body.FiEntryPar && !inBalans(body)) throw new Error(`Boeking ${omschrijving} is niet in balans.`);
  const rij = await one(
    `INSERT INTO afas_wachtrij (soort, connector, methode, payload, aanvraag_id, klant_id, factuur_id, omschrijving, wacht_op, status, volgende_poging)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'wacht',now()) RETURNING id`,
    [soort, connector, methode, JSON.stringify(body), aanvraagId, klantId, factuurId, omschrijving.slice(0, 200), wachtOp],
  );
  if (factuurId) await q("UPDATE facturen SET afas_status='wacht', afas_fout=NULL WHERE id=$1", [factuurId]);
  if (aanvraagId) {
    await q('INSERT INTO events (gebruiker_id, aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4,$5)', [
      context.gebruikerId(), aanvraagId, klantId, 'afas',
      `AFAS ${DEMO ? '(demo, niet verstuurd) ' : ''}in wachtrij: ${omschrijving} [${connector}${methode === 'PUT' ? ', wijziging' : ''}]${DEMO ? `\n${JSON.stringify(body)}` : ''}`,
    ]);
  }
  return rij.id;
}

// Debiteur aanmaken (of bijwerken als het nummer al bekend is). Geeft het wachtrij-id terug waarop de factuur moet wachten.
async function debiteurVoor(klant, aanvraag) {
  const p = debiteurPayload(klant, aanvraag);
  if (klant.afas_debiteur) {
    const body = JSON.parse(JSON.stringify(p.body));
    body[p.connector].Element['@DbId'] = klant.afas_debiteur;
    return zetInWachtrij({ soort: 'debiteur', connector: p.connector, methode: 'PUT', body, aanvraagId: aanvraag.id, klantId: klant.id, omschrijving: `Debiteur ${klant.afas_debiteur} bijwerken (${klant.naam})` });
  }
  const open = await one("SELECT id FROM afas_wachtrij WHERE klant_id=$1 AND soort='debiteur' AND status='wacht' ORDER BY id DESC LIMIT 1", [klant.id]);
  if (open) return open.id;
  return zetInWachtrij({ soort: 'debiteur', connector: p.connector, body: p.body, aanvraagId: aanvraag.id, klantId: klant.id, omschrijving: `Debiteur aanmaken (${klant.naam})` });
}

// Eindfactuur of annuleringsfactuur: debiteur, verkoopboeking en de verrekening van aanbetalingen.
async function boekFactuur(factuurId, { soort = 'eindfactuur' } = {}) {
  const f = await one('SELECT * FROM facturen WHERE id=$1', [factuurId]);
  if (!f) return null;
  const a = await one('SELECT * FROM aanvragen WHERE id=$1', [f.aanvraag_id]);
  const k = await one('SELECT * FROM klanten WHERE id=$1', [f.klant_id]);
  const nakosten = soort === 'eindfactuur' ? await all('SELECT omschrijving, bedrag_cent FROM nakosten WHERE aanvraag_id=$1 ORDER BY id', [a.id]) : [];
  const wachtOp = await debiteurVoor(k, a);
  const regels = soort === 'eindfactuur'
    ? factuurRegels(a, nakosten)
    : [{ omschrijving: `Annuleringskosten busvervoer ${datum(a.rit_datum)} (artikel 5.1)`, bedrag_cent: f.totaal_cent, pct: 9, rekening: CONFIG().omzet }];
  const p = boekingPayload({ dagboek: CONFIG().dagboek, boekdatum: f.factuurdatum, factuurnummer: f.nummer, vervaldatum: f.vervaldatum, debiteur: k.afas_debiteur || '{{DEBITEUR}}', regels, omschrijving: `${soort === 'eindfactuur' ? 'Factuur' : 'Annuleringsfactuur'} ${f.nummer} ${k.naam}` });
  const id = await zetInWachtrij({ soort, connector: p.connector, body: p.body, aanvraagId: a.id, klantId: k.id, factuurId: f.id, omschrijving: `${soort === 'eindfactuur' ? 'Factuur' : 'Annuleringsfactuur'} ${f.nummer} (${euro(f.totaal_cent)})`, wachtOp });
  if (f.reeds_betaald_cent > 0) {
    const v = verrekeningPayload({ boekdatum: f.factuurdatum, factuurnummer: f.nummer, debiteur: k.afas_debiteur || '{{DEBITEUR}}', bedragCent: f.reeds_betaald_cent, omschrijving: `Verrekening aanbetaling ${f.nummer}` });
    await zetInWachtrij({ soort: 'verrekening', connector: v.connector, body: v.body, aanvraagId: a.id, klantId: k.id, factuurId: f.id, omschrijving: `Verrekening aanbetaling ${euro(f.reeds_betaald_cent)} op ${f.nummer}`, wachtOp: id });
  }
  return id;
}

async function boekCreditnota(factuurId, bedragCent, reden) {
  const f = await one('SELECT * FROM facturen WHERE id=$1', [factuurId]);
  const a = await one('SELECT * FROM aanvragen WHERE id=$1', [f.aanvraag_id]);
  const k = await one('SELECT * FROM klanten WHERE id=$1', [f.klant_id]);
  const n = await one("SELECT count(*)::int n FROM afas_wachtrij WHERE factuur_id=$1 AND soort='creditnota'", [f.id]);
  const nummer = `${f.nummer}-C${(n ? n.n : 0) + 1}`;
  const wachtOp = k.afas_debiteur ? null : await debiteurVoor(k, a);
  const p = boekingPayload({ dagboek: CONFIG().dagboek, boekdatum: new Date(), factuurnummer: nummer, vervaldatum: null, debiteur: k.afas_debiteur || '{{DEBITEUR}}', regels: [{ omschrijving: `Creditnota op ${f.nummer}: ${reden}`, bedrag_cent: bedragCent, pct: 9, rekening: CONFIG().omzet }], credit: true, omschrijving: `Creditnota ${nummer} ${k.naam}` });
  return zetInWachtrij({ soort: 'creditnota', connector: p.connector, body: p.body, aanvraagId: a.id, klantId: k.id, factuurId: f.id, omschrijving: `Creditnota ${nummer} (${euro(bedragCent)})`, wachtOp });
}

async function boekAanbetaling(termijnId, betaalwijze) {
  const t = await one('SELECT * FROM termijnen WHERE id=$1', [termijnId]);
  if (!t) return null;
  const a = await one('SELECT * FROM aanvragen WHERE id=$1', [t.aanvraag_id]);
  const p = aanbetalingPayload({ boekdatum: t.betaald_op || new Date(), bedragCent: t.bedrag_cent, omschrijving: `${t.label} EPV-${a.id} (${betaalwijze})` });
  return zetInWachtrij({ soort: 'aanbetaling', connector: p.connector, body: p.body, aanvraagId: a.id, klantId: a.klant_id, omschrijving: `Aanbetaling ${euro(t.bedrag_cent)} EPV-${a.id} als vooruitontvangen` });
}

// Ontvangst op een factuur (iDEAL, handmatig, via de deurwaarder). Boven het openstaande bedrag: rente en incassokosten.
async function boekBetaling(factuurId, bedragCent, betaalwijze, datumStr) {
  const f = await one('SELECT * FROM facturen WHERE id=$1', [factuurId]);
  if (!f || bedragCent <= 0) return null;
  const a = await one('SELECT * FROM aanvragen WHERE id=$1', [f.aanvraag_id]);
  const k = await one('SELECT * FROM klanten WHERE id=$1', [f.klant_id]);
  const eerder = await one("SELECT coalesce(sum((payload->'FiEntryPar'->'Element'->'Objects'->0->'FiEntries'->'Element'->1->'Fields'->>'AmCr')::numeric),0) s FROM afas_wachtrij WHERE factuur_id=$1 AND soort='betaling' AND status<>'mislukt'", [f.id]);
  const open = Math.max(0, f.totaal_cent - (f.credit_cent || 0) - f.reeds_betaald_cent - Math.round(Number(eerder ? eerder.s : 0) * 100));
  const opFactuur = Math.min(bedragCent, open);
  const extra = bedragCent - opFactuur;
  const cfg = CONFIG();
  const p = betalingPayload({ dagboek: cfg.dagboekBank, boekdatum: datumStr || new Date(), factuurnummer: f.nummer, debiteur: k.afas_debiteur || '{{DEBITEUR}}', bedragCent: opFactuur, omschrijving: `Betaling ${f.nummer} (${betaalwijze})`, tegenrekening: cfg.bank, extraCent: extra, extraRekening: cfg.incasso, extraOmschrijving: `Rente en incassokosten ${f.nummer}` });
  if (opFactuur <= 0 && extra <= 0) return null;
  const wachtOp = await one("SELECT id FROM afas_wachtrij WHERE factuur_id=$1 AND soort IN ('eindfactuur','annulering') AND status='wacht' ORDER BY id DESC LIMIT 1", [f.id]);
  return zetInWachtrij({ soort: 'betaling', connector: p.connector, body: p.body, aanvraagId: a.id, klantId: k.id, factuurId: f.id, omschrijving: `Betaling ${euro(bedragCent)} op ${f.nummer} (${betaalwijze})`, wachtOp: wachtOp ? wachtOp.id : null });
}

// Alles van een factuur opnieuw aanbieden (knop voor de beheerder): debiteur, factuur, verrekening en betalingen.
async function opnieuw(factuurId) {
  await q("UPDATE afas_wachtrij SET status='vervallen' WHERE factuur_id=$1 AND status IN ('wacht','mislukt')", [factuurId]);
  const f = await one('SELECT * FROM facturen WHERE id=$1', [factuurId]);
  const a = await one('SELECT * FROM aanvragen WHERE id=$1', [f.aanvraag_id]);
  await boekFactuur(f.id, { soort: a.status === 'geannuleerd' ? 'annulering' : 'eindfactuur' });
  if (f.betaald_op && f.te_betalen_cent > 0) await boekBetaling(f.id, f.te_betalen_cent, 'opnieuw aangeboden', f.betaald_op);
  return true;
}

// Vult het debiteurnummer in dat AFAS teruggaf, in boekingen die daarop wachtten.
function vulDebiteur(body, nummer) {
  return JSON.parse(JSON.stringify(body).split('{{DEBITEUR}}').join(String(nummer)));
}
function debiteurUitAntwoord(antwoord) {
  const r = antwoord && antwoord.results ? antwoord.results : antwoord || {};
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (v && typeof v === 'object' && v.DbId != null) return String(v.DbId);
  }
  return r.DbId != null ? String(r.DbId) : null;
}

// De wachtrij verwerken: eerst wat geen voorganger heeft; na een fout opnieuw na 5, 30 en 120 minuten; daarna werklijst.
async function verwerkWachtrij({ verzender = verzend, nu = new Date() } = {}) {
  const rijen = await all(
    `SELECT w.* FROM afas_wachtrij w
     WHERE w.status='wacht' AND w.volgende_poging <= $1
       AND (w.wacht_op IS NULL OR EXISTS (SELECT 1 FROM afas_wachtrij v WHERE v.id=w.wacht_op AND v.status='verstuurd'))
       AND NOT EXISTS (SELECT 1 FROM afas_wachtrij v WHERE v.id=w.wacht_op AND v.status IN ('mislukt','vervallen'))
     ORDER BY w.id LIMIT 25`,
    [nu],
  );
  const verslag = [];
  for (const w of rijen) {
    let body = typeof w.payload === 'string' ? JSON.parse(w.payload) : w.payload;
    if (JSON.stringify(body).includes('{{DEBITEUR}}')) {
      const k = await one('SELECT afas_debiteur FROM klanten WHERE id=$1', [w.klant_id]);
      if (!k || !k.afas_debiteur) continue;
      body = vulDebiteur(body, k.afas_debiteur);
    }
    if (DEMO) {
      await q("UPDATE afas_wachtrij SET status='verstuurd', antwoord='demo: niet verstuurd', verwerkt_op=now(), payload=$2 WHERE id=$1", [w.id, JSON.stringify(body)]);
      if (w.soort === 'debiteur' && w.methode === 'POST') await q('UPDATE klanten SET afas_debiteur=$2 WHERE id=$1 AND afas_debiteur IS NULL', [w.klant_id, `DEMO-${w.klant_id}`]);
      if (w.factuur_id) await q("UPDATE facturen SET afas_status='verstuurd', afas_fout=NULL, afas_op=now(), afas_boekstuk='demo' WHERE id=$1", [w.factuur_id]);
      verslag.push(`demo ${w.id} ${w.omschrijving}`);
      continue;
    }
    try {
      const antwoord = await verzender({ connector: w.connector, methode: w.methode, body });
      await q("UPDATE afas_wachtrij SET status='verstuurd', antwoord=$2, verwerkt_op=now(), payload=$3 WHERE id=$1", [w.id, JSON.stringify(antwoord).slice(0, 2000), JSON.stringify(body)]);
      if (w.soort === 'debiteur' && w.methode === 'POST') {
        const nummer = debiteurUitAntwoord(antwoord);
        if (nummer) await q('UPDATE klanten SET afas_debiteur=$2 WHERE id=$1', [w.klant_id, nummer]);
      }
      if (w.factuur_id) {
        const en = antwoord && antwoord.results && antwoord.results.FiEntryPar ? antwoord.results.FiEntryPar.EnNo : null;
        await q("UPDATE facturen SET afas_status='verstuurd', afas_fout=NULL, afas_op=now(), afas_boekstuk=coalesce($2, afas_boekstuk) WHERE id=$1", [w.factuur_id, en ? String(en) : null]);
      }
      if (w.aanvraag_id) await q('INSERT INTO events (aanvraag_id, klant_id, type, tekst) VALUES ($1,$2,$3,$4)', [w.aanvraag_id, w.klant_id, 'afas', `AFAS: ${w.omschrijving} verstuurd.`]);
      verslag.push(`ok ${w.id} ${w.omschrijving}`);
    } catch (e) {
      const pogingen = (w.pogingen || 0) + 1;
      const volgende = volgendePoging(pogingen - 1, nu.getTime());
      const fout = String(e.message || e).slice(0, 1000);
      if (volgende) {
        await q("UPDATE afas_wachtrij SET pogingen=$2, fout=$3, volgende_poging=$4 WHERE id=$1", [w.id, pogingen, fout, volgende]);
        if (w.factuur_id) await q("UPDATE facturen SET afas_status='wacht', afas_fout=$2 WHERE id=$1", [w.factuur_id, fout]);
        verslag.push(`herkansing ${w.id} om ${volgende.toISOString()}: ${fout}`);
      } else {
        await q("UPDATE afas_wachtrij SET pogingen=$2, fout=$3, status='mislukt', verwerkt_op=now() WHERE id=$1", [w.id, pogingen, fout]);
        if (w.factuur_id) await q("UPDATE facturen SET afas_status='mislukt', afas_fout=$2, afas_op=now() WHERE id=$1", [w.factuur_id, fout]);
        if (w.aanvraag_id) {
          await meldingen.maak(w.aanvraag_id, { soort: 'boekhouding', eigenaar: 'administratie', omschrijving: `AFAS weigert ${w.omschrijving} na ${pogingen} pogingen: ${fout}. Herstel in AFAS of de gegevens en gebruik "Opnieuw naar AFAS".`, door: 'AFAS-koppeling' });
        }
        verslag.push(`mislukt ${w.id}: ${fout}`);
      }
    }
  }
  return verslag;
}

async function statusVoorFactuur(factuurId) {
  return all('SELECT id, soort, status, pogingen, fout, volgende_poging, verwerkt_op, omschrijving FROM afas_wachtrij WHERE factuur_id=$1 ORDER BY id', [factuurId]);
}

module.exports = {
  DEMO, CONFIG, HERKANSING_MINUTEN,
  splitsBtw, btwVoorNakosten, parseAdres, debiteurPayload, factuurRegels, boekingPayload, betalingPayload, aanbetalingPayload, verrekeningPayload, inBalans,
  authHeader, basisUrl, foutUitAntwoord, verzend, volgendePoging, vulDebiteur, debiteurUitAntwoord,
  zetInWachtrij, boekFactuur, boekCreditnota, boekAanbetaling, boekBetaling, opnieuw, verwerkWachtrij, statusVoorFactuur,
};
