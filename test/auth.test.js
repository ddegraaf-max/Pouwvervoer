const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://niet-gebruikt@localhost/x';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'testgeheim-voor-de-tests';
const auth = require('../src/auth');
const gebruikers = require('../src/gebruikers');
const context = require('../src/context');

// ---- Opslag in het geheugen: dezelfde functies als de PostgreSQL-store, zodat de hele flow zonder database draait ----
function geheugenStore() {
  const rijen = [];
  const log = [];
  let volgend = 1;
  return {
    rijen, log,
    opEmail: async (email) => rijen.find((r) => r.email === email) || null,
    opId: async (id) => rijen.find((r) => r.id === Number(id)) || null,
    opResetHash: async (hash) => rijen.find((r) => r.reset_token_hash === hash) || null,
    aantal: async (rollen) => rijen.filter((r) => rollen.includes(r.rol)).length,
    lijst: async () => rijen.map((r) => ({ ...r })),
    insert: async (v) => { const id = volgend++; rijen.push({ id, totp_actief: false, foute_pogingen: 0, geblokkeerd_tot: null, herstelcodes: null, created_at: new Date(), ...v }); return id; },
    update: async (id, velden) => { Object.assign(rijen.find((r) => r.id === Number(id)), velden); },
    logAuth: async (id, tekst) => { log.push({ id, tekst }); },
    activiteit: async () => log.slice(-30),
  };
}

test('wachtwoorden: scrypt-hash controleert goed en fout, regels voor sterkte', () => {
  const h = auth.hashWachtwoord('correct paard batterij nietje');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(auth.controleerWachtwoord('correct paard batterij nietje', h), true);
  assert.equal(auth.controleerWachtwoord('correct paard batterij nietjE', h), false);
  assert.equal(auth.controleerWachtwoord('x', null), false);
  assert.equal(auth.controleerWachtwoord('x', 'onzin'), false);
  assert.match(auth.valideerWachtwoord('kort', 'bas@pouw.nl'), /12 tekens/);
  assert.match(auth.valideerWachtwoord('basdegoeij-wachtwoord', 'basdegoeij@pouwvervoer.nl'), /e-mailadres/);
  assert.match(auth.valideerWachtwoord('aaaaaaaaaaaaaaa', 'x@y.nl'), /voorspelbaar/);
  assert.equal(auth.valideerWachtwoord('een zin met spaties is prima', 'bas@pouw.nl'), null);
});

test('TOTP volgens RFC 6238 (SHA-1, 6 cijfers) en replay-bescherming', () => {
  const geheim = auth.base32Encode(Buffer.from('12345678901234567890')); // testvector uit de RFC
  assert.equal(geheim, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(auth.totpCode(geheim, 59 * 1000), '287082');
  assert.equal(auth.totpCode(geheim, 1111111109 * 1000), '081804');
  assert.equal(auth.totpCode(geheim, 1234567890 * 1000), '005924');
  const nu = 1234567890 * 1000;
  assert.equal(auth.controleerTotp(geheim, '005924', nu).ok, true);
  assert.equal(auth.controleerTotp(geheim, '005 924', nu).ok, true);
  assert.equal(auth.controleerTotp(geheim, '000000', nu).ok, false);
  // één stap klokverschil mag, twee niet
  assert.equal(auth.controleerTotp(geheim, auth.totpCode(geheim, nu - 30e3), nu).ok, true);
  assert.equal(auth.controleerTotp(geheim, auth.totpCode(geheim, nu - 61e3), nu).ok, false);
  // dezelfde code nooit twee keer (laatste gebruikte stap)
  const r = auth.controleerTotp(geheim, '005924', nu);
  assert.equal(auth.controleerTotp(geheim, '005924', nu, r.stap).ok, false);
  assert.match(auth.otpauthUrl('bas@pouwvervoer.nl', geheim), /^otpauth:\/\/totp\/boekpouwvervoer:bas%40pouwvervoer\.nl\?secret=GEZD/);
  assert.equal(auth.base32Decode(auth.base32Encode(Buffer.from('hallo'))).toString(), 'hallo');
});

test('TOTP-geheim versleuteld in de database, herstelcodes eenmalig', () => {
  const geheim = auth.nieuwGeheim();
  assert.equal(geheim.length, 32);
  const v = auth.versleutel(geheim);
  assert.notEqual(v, geheim);
  assert.equal(auth.ontsleutel(v), geheim);
  const codes = auth.nieuweHerstelcodes();
  assert.equal(codes.length, 8);
  assert.match(codes[0], /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  const hashes = codes.map(auth.hashHerstelcode);
  const een = auth.gebruikHerstelcode(hashes, codes[3].toLowerCase().replace('-', ' '));
  assert.equal(een.ok, true);
  assert.equal(een.rest.length, 7);
  assert.equal(auth.gebruikHerstelcode(een.rest, codes[3]).ok, false);
  assert.equal(auth.gebruikHerstelcode(hashes, 'ABCDE-FGHJK').ok, false);
});

test('sessie verloopt na 8 uur en na 60 minuten zonder activiteit', () => {
  const t0 = Date.parse('2026-11-12T08:00:00Z');
  const s = { id: 1, ingelogd_op: t0, laatst_actief: t0 };
  assert.equal(auth.sessieGeldig(s, t0 + 59 * 60e3).ok, true);
  assert.equal(auth.sessieGeldig(s, t0 + 61 * 60e3).ok, false);
  const actief = { id: 1, ingelogd_op: t0, laatst_actief: t0 + 7.9 * 3600e3 };
  assert.equal(auth.sessieGeldig(actief, t0 + 7.95 * 3600e3).ok, true);
  assert.match(auth.sessieGeldig(actief, t0 + 8.01 * 3600e3).reden, /8 uur/);
  assert.equal(auth.sessieGeldig(null).ok, false);
});

test('rollen: alleen administratie en beheerder registreren betalingen en dragen over; alleen beheerder past de klasse aan', () => {
  assert.equal(auth.mag('sales', 'overdracht'), false);
  assert.equal(auth.mag('planning', 'betalingen'), false);
  assert.equal(auth.mag('administratie', 'betalingen'), true);
  assert.equal(auth.mag('administratie', 'creditnota'), true);
  assert.equal(auth.mag('administratie', 'klasse'), false);
  assert.equal(auth.mag('beheerder', 'klasse'), true);
  assert.equal(auth.mag('beheerder', 'gebruikers'), true);
  assert.equal(auth.mag('deurwaarder', 'betalingen'), false);
  assert.equal(auth.mag('beheerder', 'onbekend'), false);
  assert.equal(auth.ADMIN_ROLLEN.includes('deurwaarder'), false);
  assert.equal(auth.wieMag('klasse'), 'Beheerder');
});

test('middleware: een sales-gebruiker die een overdracht probeert, krijgt 403', () => {
  // Dezelfde guard als in server.js, los nagebouwd op auth.mag.
  const eis = (actie) => (req, res, next) => (auth.mag(req.session.gebruiker.rol, actie) ? next() : res.status(403).render('melding', { titel: 'Geen rechten' }));
  const res = () => { const r = { status(c) { r.code = c; return r; }, render(v, d) { r.view = v; r.data = d; return r; } }; return r; };
  let doorgelaten = 0;
  const r1 = res();
  eis('overdracht')({ session: { gebruiker: { rol: 'sales' } } }, r1, () => doorgelaten++);
  assert.equal(r1.code, 403);
  assert.equal(doorgelaten, 0);
  const r2 = res();
  eis('overdracht')({ session: { gebruiker: { rol: 'administratie' } } }, r2, () => doorgelaten++);
  assert.equal(r2.code, undefined);
  assert.equal(doorgelaten, 1);
  const r3 = res();
  eis('klasse')({ session: { gebruiker: { rol: 'administratie' } } }, r3, () => doorgelaten++);
  assert.equal(r3.code, 403);
});

test('volledig 2FA-pad: eerste beheerder, app koppelen, herstelcodes, inloggen, replay, herstelcode, blokkade, reset', async () => {
  const store = geheugenStore();
  const g = gebruikers.maak(store);
  const t0 = Date.parse('2026-11-12T09:00:00Z');

  // Migratie: nog geen account, dus het eerste account wordt beheerder.
  const bas = await g.eersteAccount({ naam: 'Bas de Goeij', email: 'Bas@PouwVervoer.nl', wachtwoord: 'correct paard batterij nietje', rol: 'beheerder' }, auth.ADMIN_ROLLEN);
  assert.equal(bas.rol, 'beheerder');
  assert.equal(bas.email, 'bas@pouwvervoer.nl');
  await assert.rejects(() => g.eersteAccount({ naam: 'X', email: 'x@y.nl', wachtwoord: 'nog een lang wachtwoord', rol: 'beheerder' }, auth.ADMIN_ROLLEN), /bestaat al/);

  // Stap 1: wachtwoord. Nog geen 2FA, dus eerst koppelen.
  assert.equal((await g.inloggen('bas@pouwvervoer.nl', 'verkeerd', { nu: t0 })).status, 'fout');
  const stap1 = await g.inloggen('bas@pouwvervoer.nl', 'correct paard batterij nietje', { nu: t0 });
  assert.equal(stap1.status, 'ok');
  assert.equal(stap1.tweedeFactor, false);
  // Een deurwaarder-rol mag niet in de backoffice en andersom.
  assert.equal((await g.inloggen('bas@pouwvervoer.nl', 'correct paard batterij nietje', { rollen: auth.PORTAAL_ROLLEN, nu: t0 })).status, 'fout');

  // App koppelen: QR-gegevens, bevestigen met een echte code, 8 herstelcodes.
  const setup = await g.start2fa(bas.id);
  assert.match(setup.otpauth, /^otpauth:\/\/totp\//);
  assert.equal((await g.bevestig2fa(bas.id, '000000', t0)).ok, false);
  const bevestigd = await g.bevestig2fa(bas.id, auth.totpCode(setup.geheim, t0), t0);
  assert.equal(bevestigd.ok, true);
  assert.equal(bevestigd.herstelcodes.length, 8);
  assert.equal(store.rijen[0].totp_actief, true);
  assert.notEqual(store.rijen[0].totp_geheim, setup.geheim, 'geheim staat versleuteld in de database');

  // Volgende login: wachtwoord én code.
  const t1 = t0 + 10 * 60e3;
  const login = await g.inloggen('bas@pouwvervoer.nl', 'correct paard batterij nietje', { nu: t1 });
  assert.equal(login.tweedeFactor, true);
  const code = auth.totpCode(setup.geheim, t1);
  const ok = await g.controleerCode(bas.id, code, t1);
  assert.equal(ok.ok, true);
  assert.equal(ok.gebruiker.naam, 'Bas de Goeij');
  assert.equal((await g.controleerCode(bas.id, code, t1 + 5e3)).ok, false, 'dezelfde code niet twee keer');

  // Herstelcode werkt één keer.
  const herstel = await g.controleerCode(bas.id, bevestigd.herstelcodes[0], t1 + 60e3);
  assert.equal(herstel.ok, true);
  assert.equal(herstel.herstelcode, true);
  assert.equal(herstel.over, 7);
  assert.equal((await g.controleerCode(bas.id, bevestigd.herstelcodes[0], t1 + 120e3)).ok, false);

  // Vijf foute codes: 15 minuten blokkade, ook voor het wachtwoord.
  for (let i = 0; i < 4; i++) assert.equal((await g.controleerCode(bas.id, '111111', t1 + 200e3)).ok, false);
  const vijfde = await g.controleerCode(bas.id, '111111', t1 + 200e3);
  assert.equal(vijfde.geblokkeerd, true);
  assert.equal((await g.inloggen('bas@pouwvervoer.nl', 'correct paard batterij nietje', { nu: t1 + 300e3 })).status, 'geblokkeerd');
  assert.equal((await g.inloggen('bas@pouwvervoer.nl', 'correct paard batterij nietje', { nu: t1 + 200e3 + 16 * 60e3 })).status, 'ok');

  // Wachtwoord vergeten: link 30 minuten geldig, eenmalig.
  assert.equal(await g.resetAanvragen('onbekend@pouwvervoer.nl', t1), null);
  const reset = await g.resetAanvragen('bas@pouwvervoer.nl', t1);
  assert.ok(reset.token.length > 30);
  assert.equal(store.rijen[0].reset_token_hash.includes(reset.token), false, 'alleen de hash wordt bewaard');
  assert.equal(await g.metResetToken(reset.token, t1 + 31 * 60e3), null, 'na 30 minuten verlopen');
  assert.equal((await g.resetMetToken(reset.token, 'kort', t1 + 60e3)).ok, false);
  const gezet = await g.resetMetToken(reset.token, 'nieuw wachtwoord van bas 2026', t1 + 60e3);
  assert.equal(gezet.ok, true);
  assert.equal((await g.resetMetToken(reset.token, 'nog een ander lang wachtwoord', t1 + 90e3)).ok, false, 'token is eenmalig');
  assert.equal((await g.inloggen('bas@pouwvervoer.nl', 'correct paard batterij nietje', { nu: t1 + 20 * 60e3 })).status, 'fout');
  assert.equal((await g.inloggen('bas@pouwvervoer.nl', 'nieuw wachtwoord van bas 2026', { nu: t1 + 20 * 60e3 })).status, 'ok');

  // Beheer: nieuwe gebruiker met uitnodiging (7 dagen), rol, uitzetten, laatste beheerder beschermd.
  const uitn = await g.nieuw({ naam: 'Sanne Sales', email: 'sanne@pouwvervoer.nl', rol: 'sales' }, 'Bas de Goeij', t1);
  assert.equal((await g.metResetToken(uitn.token, t1 + 6 * 24 * 3600e3)).reset_soort, 'uitnodiging');
  assert.equal((await g.inloggen('sanne@pouwvervoer.nl', 'wat dan ook maar lang genoeg', { nu: t1 })).status, 'fout', 'zonder wachtwoord nog geen toegang');
  assert.match((await g.resetMetToken(uitn.token, 'sanne haar eigen lange wachtwoord', t1 + 3600e3)).fout, /e-mailadres/, 'naam uit het e-mailadres mag niet in het wachtwoord');
  assert.equal((await g.resetMetToken(uitn.token, 'een eigen lang wachtwoord 2026', t1 + 3600e3)).ok, true);
  assert.equal((await g.inloggen('sanne@pouwvervoer.nl', 'een eigen lang wachtwoord 2026', { nu: t1 + 3600e3 })).status, 'ok');
  await assert.rejects(() => g.nieuw({ naam: 'Dubbel', email: 'sanne@pouwvervoer.nl', rol: 'sales' }), /bestaat al/);
  await assert.rejects(() => g.wijzig(bas.id, { actie: 'deactiveren' }, 'Bas de Goeij', bas.id), /eigen account/);
  await assert.rejects(() => g.wijzig(bas.id, { actie: 'rol', rol: 'sales' }, 'Sanne Sales', 2), /minimaal één beheerder/);
  assert.match(await g.wijzig(2, { actie: 'rol', rol: 'administratie' }, 'Bas de Goeij', bas.id), /Administratie/);
  assert.match(await g.wijzig(2, { actie: 'deactiveren' }, 'Bas de Goeij', bas.id), /uitgezet/);
  assert.equal((await g.inloggen('sanne@pouwvervoer.nl', 'een eigen lang wachtwoord 2026', { nu: t1 + 7200e3 })).status, 'inactief');
  assert.match(await g.wijzig(bas.id, { actie: '2fa-reset' }, 'Bas de Goeij', bas.id), /opnieuw/);
  assert.equal((await g.inloggen('bas@pouwvervoer.nl', 'nieuw wachtwoord van bas 2026', { nu: t1 + 7200e3 })).tweedeFactor, false);
  assert.ok(store.log.some((l) => /Ingelogd \(wachtwoord en authenticator-app\)/.test(l.tekst)));
});

test('context: de ingelogde gebruiker reist mee door asynchrone code', async () => {
  assert.equal(context.gebruikerId(), null);
  assert.equal(context.naam(), 'backoffice');
  const uit = await context.met({ id: 7, naam: 'Bas de Goeij', rol: 'beheerder' }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    return [context.gebruikerId(), context.naam()];
  });
  assert.deepEqual(uit, [7, 'Bas de Goeij']);
  assert.equal(context.gebruikerId(), null);
});
