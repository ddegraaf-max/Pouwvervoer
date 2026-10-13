const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./src/db');
const svc = require('./src/service');
const incasso = require('./src/incasso');
const kvk = require('./src/kvk');
const mail = require('./src/mail');
const fmt = require('./src/format');
const reis = require('./src/reis');
const assistent = require('./src/assistent');
const { version: VERSIE } = require('./package.json');
const voorwaarden = require('./src/voorwaarden');
const adres = require('./src/adres');
const beleid = require('./src/beleid');
const meldingen = require('./src/meldingen');
const { aanbetalingsplan } = require('./src/score');

const app = express();
// Kaartstijl (MapLibre): standaard OpenFreeMap, wereldwijd en gratis; een andere dienst via KAART_STIJL_URL.
const KAART_STIJL = process.env.KAART_STIJL_URL || 'https://tiles.openfreemap.org/styles/liberty';
const kaartHost = (process.env.KAART_HOSTS || new URL(KAART_STIJL).origin).trim();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

if (!process.env.ADMIN_PASSWORD) console.warn('Let op: ADMIN_PASSWORD ontbreekt; de backoffice is dicht tot die is gezet.');
if (PROD && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET ontbreekt.');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      // connect-src en worker-src: de kaart (MapLibre) haalt stijl, tegels, lettertypen en symbolen van de kaartdienst en draait een webworker.
      `default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' ${kaartHost}; worker-src 'self' blob:; form-action 'self'; frame-ancestors 'none'`,
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// Eén adres: staat BASE_URL (bijv. https://boekpouwvervoer.nl), dan gaat verkeer op elk ander adres (railway.app, www.)
// met een 301 daarheen. Zo werken links, cookies en de akkoordlinks altijd op het eigen domein. /health blijft overal bereikbaar.
const CANONIEK = (() => {
  try {
    return process.env.BASE_URL ? new URL(process.env.BASE_URL) : null;
  } catch {
    return null;
  }
})();
app.use((req, res, next) => {
  if (!CANONIEK || req.path === '/health' || !req.hostname || req.hostname === 'localhost') return next();
  if (req.hostname.toLowerCase() === CANONIEK.hostname.toLowerCase()) return next();
  return res.redirect(301, `${CANONIEK.origin}${req.originalUrl}`);
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(
  cookieSession({
    name: 'epv',
    secret: process.env.SESSION_SECRET || 'dev-alleen-lokaal',
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD,
    maxAge: 12 * 3600e3,
  }),
);

// CSRF: elk formulier draagt een token uit de sessie.
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString('base64url');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST') {
    const t = req.body && req.body._csrf;
    if (!t || t.length !== req.session.csrf.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(req.session.csrf))) {
      return res.status(403).render('melding', { titel: 'Sessie verlopen', tekst: 'Ververs de pagina en probeer het opnieuw.' });
    }
  }
  next();
});

Object.assign(app.locals, fmt, {
  versie: VERSIE,
  MELDING_SOORTEN: meldingen.SOORTEN,
  MELDING_EIGENAREN: meldingen.EIGENAREN,
  voorwaarden: {
    naam: voorwaarden.NAAM, versie: voorwaarden.VERSIE, url: voorwaarden.URL, depot: voorwaarden.DEPOT,
    annulering: voorwaarden.ANNULERING, kernpunten: voorwaarden.KERNPUNTEN, bedrijf: voorwaarden.BEDRIJF, bedrijfRegel: voorwaarden.bedrijfRegel(),
  },
  logoUrl: process.env.LOGO_URL || '',
  deurwaarder: incasso.NAAM(),
  DOSSIER_STATUS: incasso.DOSSIER_STATUS,
  demo: { kvk: kvk.DEMO, mail: mail.DEMO, betaling: !process.env.MOLLIE_API_KEY, assistent: assistent.DEMO },
  MAX_STOPS: reis.MAX_STOPS,
  WACHTTIJDEN: reis.WACHTTIJDEN,
  wachtLabel: reis.wachtLabel,
  soortLabel: reis.soortLabel,
  vanAanvraag: reis.vanAanvraag,
  kaartPunten: reis.kaartPunten,
  duurTekst: reis.duurTekst,
  beleid: { uren: beleid.BEDENKTIJD_UREN, dagen: beleid.WIJZIGEN_TOT_DAGEN, geldigDagen: beleid.OFFERTE_GELDIG_DAGEN, punten: beleid.PUNTEN, categorieen: beleid.WIJZIGING_CATEGORIEEN },
  kaartStijl: KAART_STIJL,
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Eenvoudige rate limit op de publieke formulieren
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const nu = Date.now();
    const lijst = (hits.get(key) || []).filter((t) => nu - t < windowMs);
    if (lijst.length >= max) return res.status(429).render('melding', { titel: 'Even geduld', tekst: 'Te veel pogingen. Probeer het later opnieuw.' });
    lijst.push(nu);
    hits.set(key, lijst);
    next();
  };
}

// ================= Publiek =================

// Stap 1: de reis (zelfde opbouw als de offertetool op aanvragen.pouwvervoer.nl).
// Bewaard in de sessie en vult daarna "De rit" van het aanvraagformulier.
app.get('/reis', (req, res) => {
  res.render('reis', { fouten: {}, lijst: [], v: req.session.reis || reis.leeg(), vandaag: reis.vandaag(), opgeslagen: !!req.session.reis });
});
app.post(
  '/reis',
  rateLimit(60, 3600e3),
  wrap(async (req, res) => {
    const { fouten, lijst, v } = reis.valideer(req.body);
    if (lijst.length) return res.status(422).render('reis', { fouten, lijst, v, vandaag: reis.vandaag(), opgeslagen: !!req.session.reis });
    // Afstand en reistijd over de weg, als er coördinaten zijn; mislukt dit, dan gaat de reis gewoon door zonder.
    const heenP = reis.kaartPunten(v).map((p) => [p.lat, p.lon]);
    const terugP = v.reistype === 'retour' && v.andere_route ? reis.kaartPunten(v, 'terug_').map((p) => [p.lat, p.lon]) : [];
    const [heen, terug] = await Promise.all([adres.route(heenP).catch(() => null), adres.route(terugP).catch(() => null)]);
    v.route = {
      heen: heen ? { afstand_m: heen.afstand_m, duur_s: heen.duur_s } : null,
      terug: terug ? { afstand_m: terug.afstand_m, duur_s: terug.duur_s } : null,
    };
    req.session.reis = v;
    res.redirect('/');
  }),
);
// Adressuggesties en routes voor de browser, via onze server (zie src/adres.js).
app.get(
  '/api/adres',
  rateLimit(600, 3600e3),
  wrap(async (req, res) => {
    try {
      res.set('Cache-Control', 'private, max-age=300');
      res.json(await adres.zoekAdres(req.query.q));
    } catch (e) {
      res.status(503).json({ fout: 'Adressen zijn even niet beschikbaar.' });
    }
  }),
);
app.get(
  '/api/route',
  rateLimit(300, 3600e3),
  wrap(async (req, res) => {
    try {
      const r = await adres.route(adres.parsePunten(req.query.p));
      if (!r) return res.status(400).json({ fout: 'Minstens twee punten nodig.' });
      res.set('Cache-Control', 'private, max-age=3600');
      res.json(r);
    } catch (e) {
      res.status(503).json({ fout: 'Route is even niet beschikbaar.' });
    }
  }),
);
app.post('/reis/opnieuw', (req, res) => {
  delete req.session.reis;
  res.redirect('/reis');
});
// Assistent: één zin van de klant wordt omgezet in de velden van de reis-stap (JSON voor reis.js).
app.post(
  '/reis/assistent',
  rateLimit(30, 3600e3),
  wrap(async (req, res) => {
    try {
      res.json(await assistent.reisUitTekst(req.body.tekst));
    } catch (e) {
      res.status(e instanceof assistent.AssistentFout ? 422 : 502).json({ fout: assistent.foutTekst(e) });
    }
  }),
);

// Stap 2: gegevens. Zonder samengestelde reis eerst naar stap 1.
app.get('/', (req, res) => {
  if (!req.session.reis) return res.redirect('/reis');
  res.render('aanvraag', { fouten: [], v: {}, reis: req.session.reis });
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function valideer(b) {
  const f = [];
  const v = {};
  const tekst = (k, max = 200) => (v[k] = String(b[k] || '').trim().slice(0, max));
  ['aanvrager_naam', 'aanvrager_tel', 'aanvrager_email', 'aanvrager_rol', 'org_naam', 'kvk', 'tekenbevoegde', 'teken_email',
    'factuur_email', 'factuur_adres', 'po_nummer', 'reisleider_naam', 'reisleider_tel', 'klanttype'].forEach((k) => tekst(k));
  tekst('opmerkingen', 2000);
  v.factuur_zelfde = b.factuur_zelfde === 'on';
  if (!['onderwijs', 'bedrijf', 'vereniging', 'particulier'].includes(v.klanttype)) f.push('Kies bij stap 3 voor wie de rit is.');
  if (!v.aanvrager_naam) f.push('Vul uw naam in (stap 2).');
  if (!v.aanvrager_tel) f.push('Vul uw mobiele nummer in (stap 2).');
  if (!EMAIL.test(v.aanvrager_email)) f.push('Vul een geldig e-mailadres in bij uw gegevens (stap 2).');
  if (v.klanttype === 'particulier') {
    if (!v.org_naam) v.org_naam = v.tekenbevoegde;
    v.kvk = '';
  } else {
    if (!v.org_naam) f.push('Vul de naam van de organisatie in (stap 3).');
    if (!kvk.geldigNummer(v.kvk)) f.push('Vul een KvK-nummer van 8 cijfers in (stap 3).');
  }
  if (!v.tekenbevoegde) f.push('Vul de naam in van wie mag tekenen (stap 3).');
  if (!EMAIL.test(v.teken_email)) f.push('Vul een geldig e-mailadres in voor de offerte (stap 3).');
  if (v.factuur_zelfde) v.factuur_email = v.teken_email;
  if (!EMAIL.test(v.factuur_email)) f.push('Vul een geldig e-mailadres voor de factuur in (stap 4).');
  if (v.klanttype === 'onderwijs' && !v.po_nummer) f.push('Scholen en overheid: vul het inkoop- of referentienummer in (stap 4). Vraag het bij uw administratie.');
  v.bus_blijft = b.bus_blijft === 'on';
  v.voorwaarden = b.voorwaarden === 'on';
  if (!v.voorwaarden) f.push('Vink aan dat u de Algemene Vervoer- en Reisvoorwaarden van KNV Busvervoer heeft gelezen en accepteert (onderaan).');
  return { f, v };
}

app.post(
  '/aanvraag',
  rateLimit(10, 3600e3),
  wrap(async (req, res) => {
    const r = req.session.reis;
    if (!r) return res.redirect('/reis');
    const { f, v } = valideer(req.body);
    if (f.length) return res.status(422).render('aanvraag', { fouten: f, v, reis: r });
    Object.assign(v, reis.velden(r), { bus_blijft: r.reistype !== 'enkel' && v.bus_blijft, voorwaarden_ip: req.ip });
    await svc.nieuweAanvraag(v);
    delete req.session.reis;
    res.render('bedankt', { v, reis: { ...r, bus_blijft: v.bus_blijft } });
  }),
);

async function laadAkkoord(token) {
  const a = await db.one('SELECT * FROM aanvragen WHERE akkoord_token=$1', [token]);
  if (!a || a.status === 'nieuw') return null;
  const k = await db.one('SELECT * FROM klanten WHERE id=$1', [a.klant_id]);
  const termijnen = await db.all('SELECT * FROM termijnen WHERE aanvraag_id=$1 ORDER BY id', [a.id]);
  const plan = aanbetalingsplan(a.klasse, a.ritprijs_cent, a.rit_datum, a.nakosten_schatting_cent || 0);
  return {
    a, k, termijnen, plan,
    bedenktijdTot: beleid.bedenktijdTot(a.akkoord_op),
    binnenBedenktijd: beleid.binnenBedenktijd(a.akkoord_op),
    wijzigenTot: beleid.wijzigenTot(a.rit_datum),
    wijzigenKosteloos: beleid.wijzigenKosteloos(a.rit_datum),
    verlopen: a.status === 'offerte_verstuurd' && beleid.offerteVerlopen(a.offerte_geldig_tot),
  };
}

app.get(
  '/akkoord/:token',
  wrap(async (req, res) => {
    const d = await laadAkkoord(req.params.token);
    if (!d) return res.status(404).render('melding', { titel: 'Link niet gevonden', tekst: 'Deze offerte bestaat niet of is nog niet verstuurd.' });
    const melding = req.session.akkoordMelding || null;
    req.session.akkoordMelding = null;
    res.render('akkoord', { ...d, fout: null, melding });
  }),
);

app.post(
  '/akkoord/:token',
  rateLimit(20, 3600e3),
  wrap(async (req, res) => {
    const d = await laadAkkoord(req.params.token);
    if (!d) return res.status(404).render('melding', { titel: 'Link niet gevonden', tekst: '' });
    if (d.verlopen) return res.status(422).render('akkoord', { ...d, fout: 'Deze offerte is verlopen. Bel ons voor een nieuwe prijs.' });
    const naam = String(req.body.naam || '').trim().slice(0, 120);
    if (!naam || req.body.voorwaarden !== 'on') {
      return res.status(422).render('akkoord', { ...d, fout: 'Vul uw naam in en vink het akkoord aan.' });
    }
    await svc.geefAkkoord(req.params.token, naam, req.ip, voorwaarden.VERSIE);
    if (d.a.status === 'offerte_verstuurd') await svc.stuurAkkoordBevestiging(d.a.id);
    const eerste = await db.one(
      'SELECT token FROM termijnen WHERE aanvraag_id=$1 AND uiterlijk IS NULL AND betaald_op IS NULL ORDER BY id LIMIT 1',
      [d.a.id],
    );
    if (eerste) return res.redirect(303, `/betalen/${eerste.token}`);
    res.redirect(303, `/akkoord/${req.params.token}`);
  }),
);

// Beleid Pouw: binnen de bedenktijd annuleert de klant zelf, kosteloos.
app.post(
  '/akkoord/:token/annuleren',
  rateLimit(10, 3600e3),
  wrap(async (req, res) => {
    const d = await laadAkkoord(req.params.token);
    if (!d) return res.status(404).render('melding', { titel: 'Link niet gevonden', tekst: '' });
    if (!['wacht_op_betaling', 'bevestigd'].includes(d.a.status)) return res.redirect(303, `/akkoord/${req.params.token}`);
    if (!d.binnenBedenktijd) return res.status(422).render('akkoord', { ...d, fout: `De bedenktijd van ${beleid.BEDENKTIJD_UREN} uur is verstreken. Annuleren kan schriftelijk per e-mail; dan gelden de annuleringskosten.` });
    if (req.body.bevestig !== 'on') return res.status(422).render('akkoord', { ...d, fout: 'Vink aan dat u de boeking wilt annuleren.' });
    await svc.annuleer(d.a.id, { reden: `Annulering door de klant binnen de bedenktijd van ${beleid.BEDENKTIJD_UREN} uur`, kostenInRekening: false, door: `${d.k.tekenbevoegde} (klant, bedenktijd)` });
    req.session.akkoordMelding = 'Uw boeking is geannuleerd, zonder kosten. U ontvangt een bevestiging per e-mail.';
    res.redirect(303, `/akkoord/${req.params.token}`);
  }),
);

// Beleid Pouw: wijziging doorgeven (kosteloos tot N dagen voor vertrek, daarna in overleg).
app.post(
  '/akkoord/:token/wijziging',
  rateLimit(20, 3600e3),
  wrap(async (req, res) => {
    const d = await laadAkkoord(req.params.token);
    if (!d) return res.status(404).render('melding', { titel: 'Link niet gevonden', tekst: '' });
    try {
      await svc.wijzigingsverzoek(d.a.id, { categorie: req.body.categorie, tekst: req.body.tekst, door: `${d.k.tekenbevoegde} (via de akkoordpagina)` });
      req.session.akkoordMelding = 'Uw wijzigingsverzoek is ontvangen. Onze planning neemt contact met u op en bevestigt de wijziging per e-mail.';
      res.redirect(303, `/akkoord/${req.params.token}`);
    } catch (e) {
      res.status(422).render('akkoord', { ...d, fout: e.message });
    }
  }),
);

// Klacht of vraag van de klant via de akkoordpagina: wordt een melding voor de administratie.
app.post(
  '/akkoord/:token/klacht',
  rateLimit(10, 3600e3),
  wrap(async (req, res) => {
    const d = await laadAkkoord(req.params.token);
    if (!d) return res.status(404).render('melding', { titel: 'Link niet gevonden', tekst: '' });
    try {
      await meldingen.klachtVanKlant(d.a.id, { tekst: req.body.tekst, door: `${d.k.tekenbevoegde} (klant, via de akkoordpagina)`, baseUrl: svc.BASE_URL() });
      req.session.akkoordMelding = 'Uw klacht is ontvangen. U krijgt een bevestiging per e-mail; wij nemen contact met u op.';
      res.redirect(303, `/akkoord/${req.params.token}`);
    } catch (e) {
      res.status(422).render('akkoord', { ...d, fout: e.message });
    }
  }),
);

// Demo-betaalpagina (vervangen door Mollie zodra MOLLIE_API_KEY er is)
app.get(
  '/betalen/:token',
  wrap(async (req, res) => {
    const t = await db.one('SELECT * FROM termijnen WHERE token=$1', [req.params.token]);
    if (!t) return res.status(404).render('melding', { titel: 'Betaallink niet gevonden', tekst: '' });
    const a = await db.one('SELECT * FROM aanvragen WHERE id=$1', [t.aanvraag_id]);
    res.render('betalen', { titel: t.label, bedrag: t.bedrag_cent, betaald: !!t.betaald_op, terug: `/akkoord/${a.akkoord_token}`, actie: `/betalen/${t.token}` });
  }),
);
app.post(
  '/betalen/:token',
  rateLimit(20, 3600e3),
  wrap(async (req, res) => {
    const t = await db.one('SELECT * FROM termijnen WHERE token=$1', [req.params.token]);
    if (!t) return res.status(404).render('melding', { titel: 'Betaallink niet gevonden', tekst: '' });
    await svc.termijnBetaald(t.id, 'iDEAL (demo)');
    const a = await db.one('SELECT akkoord_token FROM aanvragen WHERE id=$1', [t.aanvraag_id]);
    res.redirect(303, `/akkoord/${a.akkoord_token}`);
  }),
);

app.get(
  '/factuur/:token',
  wrap(async (req, res) => {
    const f = await db.one('SELECT * FROM facturen WHERE token=$1', [req.params.token]);
    if (!f) return res.status(404).render('melding', { titel: 'Factuur niet gevonden', tekst: '' });
    res.render('betalen', { titel: `Factuur ${f.nummer}`, bedrag: f.te_betalen_cent, betaald: !!f.betaald_op, terug: null, actie: `/factuur/${f.token}` });
  }),
);
app.post(
  '/factuur/:token',
  rateLimit(20, 3600e3),
  wrap(async (req, res) => {
    const f = await db.one('SELECT * FROM facturen WHERE token=$1', [req.params.token]);
    if (!f) return res.status(404).render('melding', { titel: 'Factuur niet gevonden', tekst: '' });
    await svc.factuurBetaald(f.id, 'iDEAL (demo)');
    res.redirect(303, `/factuur/${f.token}`);
  }),
);

// ================= Backoffice =================

function admin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => res.render('admin/login', { fout: null }));
app.post('/admin/login', rateLimit(10, 15 * 60e3), (req, res) => {
  const pw = process.env.ADMIN_PASSWORD;
  const gegeven = String(req.body.wachtwoord || '');
  const ok =
    pw &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(gegeven).digest(), crypto.createHash('sha256').update(pw).digest());
  if (!ok) return res.status(401).render('admin/login', { fout: pw ? 'Onjuist wachtwoord.' : 'ADMIN_PASSWORD is niet ingesteld.' });
  req.session.admin = true;
  req.session.deurwaarder = false;
  res.redirect('/admin');
});
app.post('/admin/uitloggen', (req, res) => {
  req.session = null;
  res.redirect('/admin/login');
});

app.get(
  '/admin',
  admin,
  wrap(async (req, res) => {
    const filter = req.query.status || '';
    const rows = await db.all(
      `SELECT a.*, k.naam klant_naam, k.type klanttype, (SELECT d.status FROM dossiers d WHERE d.aanvraag_id=a.id) dossier_status FROM aanvragen a JOIN klanten k ON k.id=a.klant_id
       ${filter ? 'WHERE a.status=$1' : ''} ORDER BY a.signaal_planner DESC, a.created_at DESC LIMIT 300`,
      filter ? [filter] : [],
    );
    const tellingen = await db.all('SELECT status, count(*)::int n FROM aanvragen GROUP BY status');
    const melding = req.session.melding || null;
    req.session.melding = null;
    const werklijst = await meldingen.werklijst();
    res.render('admin/lijst', { rows, filter, melding, werklijst, tellingen: Object.fromEntries(tellingen.map((t) => [t.status, t.n])) });
  }),
);

async function dossier(id) {
  const a = await db.one('SELECT * FROM aanvragen WHERE id=$1', [id]);
  if (!a) return null;
  const k = await db.one('SELECT * FROM klanten WHERE id=$1', [a.klant_id]);
  const [termijnen, nakosten, factuur, events, historie] = await Promise.all([
    db.all('SELECT * FROM termijnen WHERE aanvraag_id=$1 ORDER BY id', [id]),
    db.all('SELECT * FROM nakosten WHERE aanvraag_id=$1 ORDER BY id', [id]),
    db.one('SELECT * FROM facturen WHERE aanvraag_id=$1', [id]),
    db.all('SELECT * FROM events WHERE aanvraag_id=$1 ORDER BY created_at DESC, id DESC', [id]),
    svc.historie(a.klant_id),
  ]);
  const plan = a.ritprijs_cent != null ? aanbetalingsplan(a.klasse, a.ritprijs_cent, a.rit_datum, a.nakosten_schatting_cent || 0) : null;
  const incassoDossier = await db.one('SELECT * FROM dossiers WHERE aanvraag_id=$1', [id]);
  const dossierBerichten = incassoDossier
    ? await db.all('SELECT * FROM dossier_berichten WHERE dossier_id=$1 ORDER BY created_at, id', [incassoDossier.id])
    : [];
  const lijstMeldingen = await meldingen.voorAanvraag(id);
  const openMeldingen = lijstMeldingen.filter((m) => m.status === 'open').length;
  const overdracht = factuur && !incassoDossier ? incasso.magOverdragen(factuur, k.type, new Date(), openMeldingen) : null;
  return {
    a, k, termijnen, nakosten, factuur, events, historie, plan, incassoDossier, dossierBerichten, overdracht,
    meldingen: lijstMeldingen, openMeldingen,
    incassokosten: factuur ? incasso.incassokosten(factuur.te_betalen_cent, k.type) : 0,
    incassoGrondslag: incasso.grondslag(k.type),
    rente: factuur ? incasso.rente(factuur.te_betalen_cent, factuur.vervaldatum, k.type) : null,
    annulering: ['wacht_op_betaling', 'bevestigd'].includes(a.status) && a.ritprijs_cent != null ? voorwaarden.annuleringsKostenDossier(a) : null,
    akkoordLink: `${svc.BASE_URL()}/akkoord/${a.akkoord_token}`,
  };
}

app.get(
  '/admin/aanvraag/:id',
  admin,
  wrap(async (req, res) => {
    const d = await dossier(Number(req.params.id));
    if (!d) return res.status(404).render('melding', { titel: 'Niet gevonden', tekst: '' });
    res.render('admin/dossier', { ...d, melding: req.session.melding || null });
    req.session.melding = null;
  }),
);

// Chauffeursbriefing: alles wat de chauffeur moet weten op één printbare pagina (route, tijden, contact, afspraken).
app.get(
  '/admin/aanvraag/:id/briefing',
  admin,
  wrap(async (req, res) => {
    const d = await dossier(Number(req.params.id));
    if (!d) return res.status(404).render('melding', { titel: 'Niet gevonden', tekst: '' });
    res.render('admin/briefing', { ...d });
  }),
);

function terug(req, res, tekst) {
  req.session.melding = tekst;
  res.redirect(303, `/admin/aanvraag/${req.params.id}`);
}

// ---- Assistent in de backoffice: uitleg bij de score, concept-mail, versturen ----
app.post(
  '/admin/aanvraag/:id/assistent/risico',
  admin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const d = await dossier(id);
    if (!d) return res.status(404).render('melding', { titel: 'Niet gevonden', tekst: '' });
    try {
      const uitleg = await assistent.risicoUitleg(d);
      await db.q('UPDATE aanvragen SET assistent_risico=$2 WHERE id=$1', [id, uitleg]);
      terug(req, res, 'De assistent heeft de score uitgelegd.');
    } catch (e) {
      terug(req, res, `Assistent: ${assistent.foutTekst(e)}`);
    }
  }),
);

app.post(
  '/admin/aanvraag/:id/assistent/mail',
  admin,
  wrap(async (req, res) => {
    const d = await dossier(Number(req.params.id));
    if (!d) return res.status(404).render('melding', { titel: 'Niet gevonden', tekst: '' });
    try {
      const concept = await assistent.conceptMail(d, { aan: req.body.aan, vraag: req.body.vraag });
      res.render('admin/dossier', { ...d, melding: null, concept });
    } catch (e) {
      terug(req, res, `Assistent: ${assistent.foutTekst(e)}`);
    }
  }),
);

app.post(
  '/admin/aanvraag/:id/mail',
  admin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const d = await dossier(id);
    if (!d) return res.status(404).render('melding', { titel: 'Niet gevonden', tekst: '' });
    const o = assistent.ontvanger(d, req.body.aan);
    const onderwerp = String(req.body.onderwerp || '').trim().slice(0, 200);
    const tekst = String(req.body.tekst || '').trim().slice(0, 5000);
    if (!o || !onderwerp || !tekst) return terug(req, res, 'Vul onderwerp en tekst in.');
    const status = await mail.verstuur({ aan: o.email, onderwerp, tekst, aanvraagId: id, klantId: d.a.klant_id });
    terug(req, res, `Mail aan ${o.email}: ${status}.`);
  }),
);

app.post(
  '/admin/aanvraag/:id/prijs',
  admin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const a = await db.one('SELECT status FROM aanvragen WHERE id=$1', [id]);
    if (!['nieuw', 'offerte_verstuurd'].includes(a.status)) return terug(req, res, 'Prijs is vastgelegd na akkoord.');
    const prijs = fmt.parseEuro(req.body.ritprijs);
    const nak = fmt.parseEuro(req.body.nakosten_schatting) || 0;
    if (prijs == null || prijs === 0) return terug(req, res, 'Vul een geldige ritprijs in.');
    await db.q("UPDATE aanvragen SET ritprijs_cent=$2, nakosten_schatting_cent=$3, status='nieuw' WHERE id=$1", [id, prijs, nak]);
    await svc.herberekenScore(id);
    await svc.log(id, null, 'prijs', `Ritprijs ${fmt.euro(prijs)}, geschatte nakosten ${fmt.euro(nak)}.`);
    terug(req, res, 'Prijs opgeslagen en score herberekend. Verstuur nu de offerte.');
  }),
);

app.post(
  '/admin/aanvraag/:id/offerte',
  admin,
  wrap(async (req, res) => {
    try {
      await svc.verstuurOfferte(Number(req.params.id));
      terug(req, res, mail.DEMO ? 'Offerte klaargezet. Demo-modus: er is geen mail verstuurd; gebruik de akkoordlink hieronder.' : 'Offerte verstuurd naar de opdrachtgever.');
    } catch (e) {
      terug(req, res, e.message);
    }
  }),
);

app.post(
  '/admin/aanvraag/:id/termijn/:tid/betaald',
  admin,
  wrap(async (req, res) => {
    const t = await db.one('SELECT * FROM termijnen WHERE id=$1 AND aanvraag_id=$2', [Number(req.params.tid), Number(req.params.id)]);
    if (t) await svc.termijnBetaald(t.id, 'bankoverschrijving (handmatig)');
    terug(req, res, 'Betaling geregistreerd.');
  }),
);

app.post(
  '/admin/aanvraag/:id/gereden',
  admin,
  wrap(async (req, res) => {
    const r = await db.one("UPDATE aanvragen SET status='gereden' WHERE id=$1 AND status='bevestigd' RETURNING id, klant_id", [Number(req.params.id)]);
    if (r) await svc.log(r.id, r.klant_id, 'status', 'Rit gereden.');
    terug(req, res, r ? 'Rit gemarkeerd als gereden. Voer de nakosten in en maak de eindfactuur.' : 'Alleen een bevestigde rit kan als gereden worden gemarkeerd.');
  }),
);

app.post(
  '/admin/aanvraag/:id/nakosten',
  admin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const omschrijving = String(req.body.omschrijving || '').trim().slice(0, 120);
    const bedrag = fmt.parseEuro(req.body.bedrag);
    const a = await db.one('SELECT status FROM aanvragen WHERE id=$1', [id]);
    if (!['bevestigd', 'gereden'].includes(a.status)) return terug(req, res, 'Nakosten kunnen alleen bij een bevestigde of gereden rit.');
    if (!omschrijving || !bedrag) return terug(req, res, 'Vul omschrijving en bedrag in.');
    await db.q('INSERT INTO nakosten (aanvraag_id, omschrijving, bedrag_cent) VALUES ($1,$2,$3)', [id, omschrijving, bedrag]);
    terug(req, res, 'Nakosten toegevoegd.');
  }),
);

app.post(
  '/admin/aanvraag/:id/factuur',
  admin,
  wrap(async (req, res) => {
    try {
      const f = await svc.maakEindfactuur(Number(req.params.id));
      terug(req, res, `Eindfactuur ${f.nummer} aangemaakt.`);
    } catch (e) {
      terug(req, res, e.message);
    }
  }),
);

app.post(
  '/admin/aanvraag/:id/factuur-betaald',
  admin,
  wrap(async (req, res) => {
    const f = await db.one('SELECT id FROM facturen WHERE aanvraag_id=$1', [Number(req.params.id)]);
    if (f) await svc.factuurBetaald(f.id, 'bankoverschrijving (handmatig)');
    const d = f && (await db.one("SELECT id FROM dossiers WHERE factuur_id=$1 AND status <> ALL($2)", [f.id, incasso.GESLOTEN]));
    if (d) await incasso.bericht(d.id, 'Pouw Vervoer', 'Let op: de debiteur heeft de hoofdsom rechtstreeks aan Pouw Vervoer betaald.');
    terug(req, res, d ? `Factuur als betaald gemarkeerd. ${incasso.NAAM()} heeft hierover een bericht gekregen.` : 'Factuur als betaald gemarkeerd.');
  }),
);

app.post(
  '/admin/aanvraag/:id/incasso',
  admin,
  wrap(async (req, res) => {
    const f = await db.one('SELECT id FROM facturen WHERE aanvraag_id=$1', [Number(req.params.id)]);
    if (!f) return terug(req, res, 'Er is nog geen eindfactuur.');
    try {
      const d = await incasso.overdragen(f.id, String(req.body.notitie || '').trim());
      terug(req, res, `Overgedragen aan ${incasso.NAAM()} als dossier D-${d.id}. Dit telt mee in de klantscore.`);
    } catch (e) {
      terug(req, res, e.message);
    }
  }),
);

app.post(
  '/admin/aanvraag/:id/dossier-bericht',
  admin,
  wrap(async (req, res) => {
    const d = await db.one('SELECT id FROM dossiers WHERE aanvraag_id=$1', [Number(req.params.id)]);
    try {
      if (!d) throw new Error('Geen dossier.');
      await incasso.bericht(d.id, 'Pouw Vervoer', req.body.tekst);
      terug(req, res, `Bericht naar ${incasso.NAAM()} geplaatst.`);
    } catch (e) {
      terug(req, res, e.message);
    }
  }),
);

app.post(
  '/admin/aanvraag/:id/dossier-terugtrekken',
  admin,
  wrap(async (req, res) => {
    const d = await db.one('SELECT id FROM dossiers WHERE aanvraag_id=$1', [Number(req.params.id)]);
    try {
      if (!d) throw new Error('Geen dossier.');
      const reden = String(req.body.reden || '').trim();
      if (!reden) throw new Error('Vul de reden in.');
      await incasso.bericht(d.id, 'Pouw Vervoer', `Dossier teruggetrokken. Reden: ${reden}`);
      await incasso.zetStatus(d.id, 'teruggetrokken', 'Pouw Vervoer');
      terug(req, res, 'Dossier teruggetrokken.');
    } catch (e) {
      terug(req, res, e.message);
    }
  }),
);

app.post(
  '/admin/aanvraag/:id/annuleren',
  admin,
  wrap(async (req, res) => {
    const r = await svc.annuleer(Number(req.params.id), { reden: req.body.reden, kostenInRekening: req.body.kosten === 'on' });
    if (!r) return terug(req, res, 'Kan in deze status niet geannuleerd worden.');
    terug(
      req,
      res,
      r.rekenen
        ? `Geannuleerd. Annuleringskosten ${fmt.euro(r.kosten.bedrag)} (${r.kosten.pct}%) gefactureerd als ${r.factuur.nummer}; ${r.factuur.te_betalen_cent < 0 ? `terug te betalen ${fmt.euro(-r.factuur.te_betalen_cent)}` : `te betalen ${fmt.euro(r.factuur.te_betalen_cent)}`}. Bevestiging is gemaild.`
        : r.kosten
          ? `Geannuleerd zonder annuleringskosten${r.betaald ? `; ${fmt.euro(r.betaald)} terug te betalen` : ''}. Bevestiging is gemaild.`
          : 'Aanvraag geannuleerd; er was nog geen overeenkomst. Bevestiging is gemaild.',
    );
  }),
);

// ---- Afspraken, meldingen en creditnota's (zie src/meldingen.js) ----
app.post(
  '/admin/aanvraag/:id/afspraken',
  admin,
  wrap(async (req, res) => {
    await svc.afsprakenOpslaan(Number(req.params.id), req.body.afspraken);
    terug(req, res, 'Afspraken opgeslagen. Ze staan in de offerte, de bevestiging en de export voor trip.');
  }),
);
app.post(
  '/admin/aanvraag/:id/melding',
  admin,
  wrap(async (req, res) => {
    try {
      const m = await meldingen.maak(Number(req.params.id), { soort: req.body.soort, omschrijving: req.body.omschrijving, eigenaar: req.body.eigenaar, deadline: req.body.deadline });
      terug(req, res, `Melding M-${m.id} aangemaakt voor ${meldingen.EIGENAREN[m.eigenaar]}, deadline ${fmt.datum(m.deadline)}. Herinneringen staan stil tot de melding is opgelost.`);
    } catch (e) {
      terug(req, res, e.message);
    }
  }),
);
app.post(
  '/admin/aanvraag/:id/melding/:mid/oplossen',
  admin,
  wrap(async (req, res) => {
    try {
      const m = await meldingen.losOp(Number(req.params.mid), { oplossing: req.body.oplossing });
      terug(req, res, `Melding M-${m.id} opgelost.`);
    } catch (e) {
      terug(req, res, e.message);
    }
  }),
);
app.post(
  '/admin/aanvraag/:id/creditnota',
  admin,
  wrap(async (req, res) => {
    try {
      const f = await db.one('SELECT id FROM facturen WHERE aanvraag_id=$1', [Number(req.params.id)]);
      if (!f) return terug(req, res, 'Er is nog geen factuur.');
      const r = await svc.creditnota(f.id, { bedragCent: fmt.parseEuro(req.body.bedrag), reden: req.body.reden });
      terug(req, res, `Creditnota ${fmt.euro(r.bedrag)} verwerkt en gemaild. ${r.teBetalen > 0 ? `Nog te betalen ${fmt.euro(r.teBetalen)}.` : r.teBetalen < 0 ? `Terug te betalen ${fmt.euro(-r.teBetalen)}.` : 'Factuur volledig voldaan.'}`);
    } catch (e) {
      terug(req, res, e.message);
    }
  }),
);

app.post(
  '/admin/aanvraag/:id/wijziging-af',
  admin,
  wrap(async (req, res) => {
    await svc.wijzigingAfgehandeld(Number(req.params.id));
    terug(req, res, 'Wijzigingsverzoek afgehandeld.');
  }),
);

app.post(
  '/admin/aanvraag/:id/klasse',
  admin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const a = await db.one('SELECT klant_id, status FROM aanvragen WHERE id=$1', [id]);
    const klasse = req.body.klasse;
    const reden = String(req.body.reden || '').trim().slice(0, 300);
    if (klasse === 'auto') {
      await db.q('UPDATE klanten SET klasse_override=NULL, override_reden=NULL, override_op=NULL WHERE id=$1', [a.klant_id]);
      await svc.log(id, a.klant_id, 'klasse', 'Handmatige klasse verwijderd; weer berekend.');
    } else {
      if (!['A', 'B', 'C', 'D'].includes(klasse) || !reden) return terug(req, res, 'Kies een klasse en vul de reden in.');
      await db.q('UPDATE klanten SET klasse_override=$2, override_reden=$3, override_op=now() WHERE id=$1', [a.klant_id, klasse, reden]);
      await svc.log(id, a.klant_id, 'klasse', `Klasse handmatig op ${klasse} gezet. Reden: ${reden}`);
    }
    if (['nieuw', 'offerte_verstuurd'].includes(a.status)) await svc.herberekenScore(id);
    terug(req, res, ['nieuw', 'offerte_verstuurd'].includes(a.status)
      ? 'Klasse aangepast. Geldt voor deze aanvraag (verstuur de offerte zo nodig opnieuw) en volgende boekingen.'
      : 'Klasse aangepast voor volgende boekingen; deze rit is al geaccordeerd.');
  }),
);

app.post(
  '/admin/herinneringen',
  admin,
  wrap(async (req, res) => {
    const v = await svc.draaiHerinneringen();
    req.session.melding = v.length ? `Uitgevoerd: ${v.join('; ')}` : 'Geen herinneringen nodig.';
    res.redirect(303, '/admin');
  }),
);

// Export voor trip: alleen bevestigde ritten
app.get(
  '/admin/trip.csv',
  admin,
  wrap(async (req, res) => {
    const rows = await db.all(
      `SELECT a.*, k.naam klant_naam FROM aanvragen a JOIN klanten k ON k.id=a.klant_id
       WHERE a.status='bevestigd' ORDER BY a.rit_datum`,
    );
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const kop = ['ref', 'datum', 'vertrektijd', 'van', 'naar', 'personen', 'ritsoort', 'opdrachtgever', 'reisleider', 'reisleider_tel', 'aanvrager', 'aanvrager_tel', 'opmerkingen',
      'tijdtype', 'datum_terug', 'tijd_terug', 'tijdtype_terug', 'tussenstops', 'route_terug', 'bus_blijft', 'km_heen', 'reistijd_heen_min', 'km_terug', 'reistijd_terug_min', 'afspraken'];
    const km = (m) => (m != null ? (m / 1000).toFixed(1).replace('.', ',') : '');
    const minuten = (s) => (s != null ? Math.round(s / 60) : '');
    const stopsTekst = (x) => (Array.isArray(x) ? x : []).map((s) => `${s.adres} (${reis.wachtLabel(s.wacht || 15)})`).join('; ');
    const lijnen = rows.map((a) =>
      [`EPV-${a.id}`, fmt.iso(a.rit_datum), a.vertrek_tijd, a.van, a.naar, a.personen, a.ritsoort, a.klant_naam,
        a.reisleider_naam, a.reisleider_tel, a.aanvrager_naam, a.aanvrager_tel, a.opmerkingen,
        a.tijdtype_heen, a.datum_terug ? fmt.iso(a.datum_terug) : '', a.tijd_terug, a.tijdtype_terug, stopsTekst(a.via),
        a.andere_route ? [a.terug_van, stopsTekst(a.terug_via), a.terug_naar].filter(Boolean).join(' → ') : (a.ritsoort === 'enkel' ? '' : 'zelfde route'),
        a.bus_blijft || a.ritsoort === 'hele_dag' ? 'ja' : 'nee', km(a.afstand_m), minuten(a.duur_s), km(a.terug_afstand_m), minuten(a.terug_duur_s), a.afspraken].map(esc).join(';'),
    );
    if (rows.length) await db.q('UPDATE aanvragen SET trip_export_op=now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="trip-export-${fmt.iso(new Date())}.csv"`);
    res.send('﻿' + [kop.join(';'), ...lijnen].join('\r\n'));
  }),
);

// ================= Portaal deurwaarder =================

function deurwaarder(req, res, next) {
  if (req.session.deurwaarder) {
    res.locals.portaal = true;
    return next();
  }
  res.redirect('/deurwaarder/login');
}

function wachtwoordKlopt(gegeven, verwacht) {
  if (!verwacht) return false;
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(gegeven), h(verwacht));
}

app.get('/deurwaarder/login', (req, res) => res.render('deurwaarder/login', { fout: null, portaal: true, portaalLogin: true }));
app.post('/deurwaarder/login', rateLimit(10, 15 * 60e3), (req, res) => {
  const pw = process.env.DEURWAARDER_PASSWORD;
  if (!wachtwoordKlopt(req.body.wachtwoord || '', pw)) {
    return res.status(401).render('deurwaarder/login', { fout: pw ? 'Onjuist wachtwoord.' : 'Het portaal is nog niet ingericht.', portaal: true, portaalLogin: true });
  }
  req.session.deurwaarder = true;
  req.session.admin = false;
  res.redirect('/deurwaarder');
});
app.post('/deurwaarder/uitloggen', (req, res) => {
  req.session = null;
  res.redirect('/deurwaarder/login');
});

app.get(
  '/deurwaarder',
  deurwaarder,
  wrap(async (req, res) => {
    const open = req.query.weergave !== 'gesloten';
    const rows = await db.all(
      `SELECT d.*, f.nummer, f.vervaldatum, k.naam klant_naam, k.type klanttype,
         (SELECT max(created_at) FROM dossier_berichten b WHERE b.dossier_id=d.id AND b.van='Pouw Vervoer') laatste_bericht_pouw
       FROM dossiers d JOIN facturen f ON f.id=d.factuur_id JOIN klanten k ON k.id=d.klant_id
       WHERE ${open ? 'NOT' : ''} (d.status = ANY($1))
       ORDER BY (d.status='nieuw') DESC, d.overgedragen_op DESC`,
      [incasso.GESLOTEN],
    );
    const melding = req.session.melding || null;
    req.session.melding = null;
    res.render('deurwaarder/lijst', { rows, open, melding });
  }),
);

app.get(
  '/deurwaarder/dossier/:id',
  deurwaarder,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const v = await incasso.dossierVolledig(id);
    if (!v) return res.status(404).render('melding', { titel: 'Dossier niet gevonden', tekst: '', portaal: true });
    if (!v.d.geopend_op) {
      await db.q("UPDATE dossiers SET geopend_op=now(), status=CASE WHEN status='nieuw' THEN 'in_behandeling' ELSE status END WHERE id=$1", [id]);
      await incasso.bericht(id, incasso.NAAM(), 'Dossier geopend en in behandeling genomen.');
      return res.redirect(303, `/deurwaarder/dossier/${id}`);
    }
    const melding = req.session.melding || null;
    req.session.melding = null;
    res.render('deurwaarder/dossier', { ...v, melding, vandaag: fmt.iso(new Date()) });
  }),
);

function terugDossier(req, res, tekst) {
  req.session.melding = tekst;
  res.redirect(303, `/deurwaarder/dossier/${req.params.id}`);
}

app.post(
  '/deurwaarder/dossier/:id/status',
  deurwaarder,
  wrap(async (req, res) => {
    try {
      await incasso.zetStatus(Number(req.params.id), String(req.body.status), incasso.NAAM());
      terugDossier(req, res, 'Status bijgewerkt. Pouw ziet dit direct.');
    } catch (e) {
      terugDossier(req, res, e.message);
    }
  }),
);

app.post(
  '/deurwaarder/dossier/:id/referentie',
  deurwaarder,
  wrap(async (req, res) => {
    const ref = String(req.body.referentie || '').trim().slice(0, 60);
    await db.q('UPDATE dossiers SET referentie_deurwaarder=$2 WHERE id=$1', [Number(req.params.id), ref || null]);
    terugDossier(req, res, 'Uw dossiernummer is opgeslagen.');
  }),
);

app.post(
  '/deurwaarder/dossier/:id/betaling',
  deurwaarder,
  wrap(async (req, res) => {
    try {
      await incasso.registreerBetaling(Number(req.params.id), fmt.parseEuro(req.body.bedrag), req.body.datum, req.body.omschrijving);
      terugDossier(req, res, 'Ontvangst geregistreerd.');
    } catch (e) {
      terugDossier(req, res, e.message);
    }
  }),
);

app.post(
  '/deurwaarder/dossier/:id/bericht',
  deurwaarder,
  wrap(async (req, res) => {
    try {
      await incasso.bericht(Number(req.params.id), incasso.NAAM(), req.body.tekst);
      terugDossier(req, res, 'Bericht verstuurd naar Pouw Vervoer.');
    } catch (e) {
      terugDossier(req, res, e.message);
    }
  }),
);

app.get('/voorwaarden', (req, res) => res.render('voorwaarden'));
app.get('/health', (req, res) => res.json({ ok: true, versie: VERSIE, adres: CANONIEK ? CANONIEK.origin : null, host: req.hostname }));

app.use((req, res) => res.status(404).render('melding', { titel: 'Pagina niet gevonden', tekst: '' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('melding', { titel: 'Er ging iets mis', tekst: 'Probeer het later opnieuw of bel 030 68 68 300.' });
});

(async () => {
  await db.migrate();
  setInterval(() => svc.draaiHerinneringen().catch((e) => console.error('herinneringen', e)), 3600e3);
  app.listen(PORT, () => console.log(`boekpouwvervoer draait op poort ${PORT}`));
})();
