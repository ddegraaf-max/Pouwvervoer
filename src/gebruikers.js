// Persoonlijke accounts voor de backoffice en het portaal van de deurwaarder: inloggen met e-mail en wachtwoord,
// daarna een code uit de authenticator-app (of een herstelcode), wachtwoord vergeten, uitnodigingen, blokkade na
// foute pogingen en beheer door beheerders. De opslag zit achter een kleine "store" zodat de hele flow zonder
// database te testen is (zie test/auth.test.js); de standaardstore gebruikt PostgreSQL.
const auth = require('./auth');

function pgStore() {
  const { q, one, all } = require('./db');
  const KOLOMMEN = 'id, naam, email, rol, wachtwoord_hash, totp_geheim, totp_actief, totp_laatste_stap, herstelcodes, actief, laatst_ingelogd, foute_pogingen, geblokkeerd_tot, reset_token_hash, reset_geldig_tot, reset_soort, created_at';
  return {
    opEmail: (email) => one(`SELECT ${KOLOMMEN} FROM gebruikers WHERE email=$1`, [email]),
    opId: (id) => one(`SELECT ${KOLOMMEN} FROM gebruikers WHERE id=$1`, [id]),
    opResetHash: (hash) => one(`SELECT ${KOLOMMEN} FROM gebruikers WHERE reset_token_hash=$1`, [hash]),
    aantal: async (rollen) => {
      const r = await one('SELECT count(*)::int n FROM gebruikers WHERE rol = ANY($1)', [rollen]);
      return r ? r.n : 0;
    },
    lijst: () => all('SELECT id, naam, email, rol, totp_actief, actief, laatst_ingelogd, geblokkeerd_tot, reset_soort, reset_geldig_tot, created_at FROM gebruikers ORDER BY actief DESC, rol, naam'),
    insert: async (v) => {
      const r = await one(
        'INSERT INTO gebruikers (naam, email, rol, wachtwoord_hash, actief) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [v.naam, v.email, v.rol, v.wachtwoord_hash || null, v.actief !== false],
      );
      return r.id;
    },
    update: async (id, velden) => {
      const keys = Object.keys(velden);
      if (!keys.length) return;
      const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      await q(`UPDATE gebruikers SET ${sets} WHERE id=$1`, [id, ...keys.map((k) => (k === 'herstelcodes' ? JSON.stringify(velden[k]) : velden[k]))]);
    },
    logAuth: (gebruikerId, tekst) => q('INSERT INTO events (aanvraag_id, klant_id, type, tekst, gebruiker_id) VALUES (NULL, NULL, $1, $2, $3)', ['auth', tekst, gebruikerId]),
    activiteit: (n = 30) =>
      all(
        `SELECT e.created_at, e.tekst, g.naam FROM events e LEFT JOIN gebruikers g ON g.id=e.gebruiker_id WHERE e.type='auth' ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
        [n],
      ),
  };
}

function maak(store) {
  const nuDatum = (nu) => (nu instanceof Date ? nu : new Date(nu || Date.now()));

  function publiek(g) {
    return g ? { id: g.id, naam: g.naam, email: g.email, rol: g.rol, totp_actief: !!g.totp_actief, actief: g.actief !== false } : null;
  }

  // Stap 1: e-mail en wachtwoord. Telt foute pogingen per account en blokkeert 15 minuten na de vijfde.
  async function inloggen(email, wachtwoord, { rollen = auth.ADMIN_ROLLEN, nu = Date.now() } = {}) {
    const e = auth.normaliseerEmail(email);
    const g = e ? await store.opEmail(e) : null;
    if (!g || !rollen.includes(g.rol)) {
      // Ook bij een onbekend adres een scrypt-berekening, zodat de responstijd niets verraadt.
      auth.controleerWachtwoord(wachtwoord, auth.hashWachtwoord('x'));
      return { status: 'fout' };
    }
    if (g.actief === false) return { status: 'inactief' };
    if (auth.isGeblokkeerd(g, nu)) return { status: 'geblokkeerd', tot: new Date(g.geblokkeerd_tot) };
    if (!g.wachtwoord_hash || !auth.controleerWachtwoord(wachtwoord, g.wachtwoord_hash)) {
      const v = auth.naFoutePoging(g, nu);
      await store.update(g.id, v);
      await store.logAuth(g.id, `Mislukte inlogpoging (wachtwoord)${v.geblokkeerd_tot ? '; account 15 minuten geblokkeerd' : ''}.`);
      return v.geblokkeerd_tot ? { status: 'geblokkeerd', tot: v.geblokkeerd_tot } : { status: 'fout' };
    }
    return { status: 'ok', gebruiker: publiek(g), tweedeFactor: !!g.totp_actief };
  }

  // Eerste keer: geheim maken (versleuteld bewaard) en de QR-gegevens teruggeven. Pas na bevestiging staat 2FA aan.
  async function start2fa(id) {
    const g = await store.opId(id);
    if (!g) throw new Error('Gebruiker niet gevonden.');
    let geheim = g.totp_geheim && !g.totp_actief ? auth.ontsleutel(g.totp_geheim) : null;
    if (!geheim) {
      geheim = auth.nieuwGeheim();
      await store.update(g.id, { totp_geheim: auth.versleutel(geheim), totp_actief: false, totp_laatste_stap: null });
    }
    return { geheim, otpauth: auth.otpauthUrl(g.email, geheim) };
  }

  async function bevestig2fa(id, code, nu = Date.now()) {
    const g = await store.opId(id);
    if (!g || !g.totp_geheim) return { ok: false, fout: 'Begin opnieuw met het koppelen van de app.' };
    const r = auth.controleerTotp(auth.ontsleutel(g.totp_geheim), code, nu, null);
    if (!r.ok) return { ok: false, fout: 'De code klopt niet. Controleer de tijd op uw telefoon en probeer het opnieuw.' };
    const codes = auth.nieuweHerstelcodes();
    await store.update(g.id, { totp_actief: true, totp_laatste_stap: r.stap, herstelcodes: codes.map(auth.hashHerstelcode) });
    await store.logAuth(g.id, 'Authenticator-app gekoppeld (2FA aan), herstelcodes gemaakt.');
    return { ok: true, herstelcodes: codes };
  }

  // Stap 2: code uit de app, of een herstelcode (eenmalig). Foute codes tellen mee voor de blokkade.
  async function controleerCode(id, code, nu = Date.now()) {
    const g = await store.opId(id);
    if (!g || !g.totp_actief) return { ok: false, fout: 'Begin opnieuw met inloggen.' };
    if (auth.isGeblokkeerd(g, nu)) return { ok: false, geblokkeerd: true, tot: new Date(g.geblokkeerd_tot) };
    const totp = auth.controleerTotp(auth.ontsleutel(g.totp_geheim), code, nu, g.totp_laatste_stap);
    if (totp.ok) {
      await store.update(g.id, { totp_laatste_stap: totp.stap, foute_pogingen: 0, geblokkeerd_tot: null, laatst_ingelogd: nuDatum(nu) });
      await store.logAuth(g.id, 'Ingelogd (wachtwoord en authenticator-app).');
      return { ok: true, gebruiker: publiek(g) };
    }
    const herstel = auth.gebruikHerstelcode(g.herstelcodes, code);
    if (herstel.ok) {
      await store.update(g.id, { herstelcodes: herstel.rest, foute_pogingen: 0, geblokkeerd_tot: null, laatst_ingelogd: nuDatum(nu) });
      await store.logAuth(g.id, `Ingelogd met een herstelcode; nog ${herstel.rest.length} over.`);
      return { ok: true, gebruiker: publiek(g), herstelcode: true, over: herstel.rest.length };
    }
    const v = auth.naFoutePoging(g, nu);
    await store.update(g.id, v);
    await store.logAuth(g.id, `Mislukte inlogpoging (code)${v.geblokkeerd_tot ? '; account 15 minuten geblokkeerd' : ''}.`);
    return v.geblokkeerd_tot ? { ok: false, geblokkeerd: true, tot: v.geblokkeerd_tot } : { ok: false, fout: 'De code klopt niet.' };
  }

  // Wachtwoord vergeten: token 30 minuten geldig, eenmalig; alleen de hash staat in de database.
  async function resetAanvragen(email, nu = Date.now()) {
    const g = await store.opEmail(auth.normaliseerEmail(email));
    if (!g || g.actief === false) return null;
    const token = auth.nieuwToken();
    await store.update(g.id, { reset_token_hash: auth.hashToken(token), reset_geldig_tot: new Date(nu + auth.RESET_GELDIG_MS), reset_soort: 'reset' });
    await store.logAuth(g.id, 'Resetlink voor het wachtwoord aangevraagd.');
    return { token, gebruiker: publiek(g) };
  }

  async function metResetToken(token, nu = Date.now()) {
    if (!token || String(token).length < 20) return null;
    const g = await store.opResetHash(auth.hashToken(token));
    if (!g || !g.reset_geldig_tot || new Date(g.reset_geldig_tot).getTime() < nu || g.actief === false) return null;
    return { ...publiek(g), reset_soort: g.reset_soort || 'reset' };
  }

  async function resetMetToken(token, wachtwoord, nu = Date.now()) {
    const g = await metResetToken(token, nu);
    if (!g) return { ok: false, fout: 'Deze link is niet (meer) geldig. Vraag een nieuwe aan.' };
    const fout = auth.valideerWachtwoord(wachtwoord, g.email);
    if (fout) return { ok: false, fout, gebruiker: g };
    await store.update(g.id, { wachtwoord_hash: auth.hashWachtwoord(wachtwoord), reset_token_hash: null, reset_geldig_tot: null, reset_soort: null, foute_pogingen: 0, geblokkeerd_tot: null });
    await store.logAuth(g.id, g.reset_soort === 'uitnodiging' ? 'Account geactiveerd via de uitnodiging; wachtwoord gezet.' : 'Wachtwoord gewijzigd via de resetlink.');
    return { ok: true, gebruiker: g };
  }

  // Beheer door beheerders.
  async function nieuw({ naam, email, rol }, door = 'beheerder', nu = Date.now()) {
    const n = String(naam || '').trim().slice(0, 120);
    const e = auth.normaliseerEmail(email);
    if (n.length < 2) throw new Error('Vul de naam in.');
    if (!auth.geldigeEmail(e)) throw new Error('Vul een geldig e-mailadres in.');
    if (!auth.ROLLEN[rol]) throw new Error('Kies een rol.');
    if (await store.opEmail(e)) throw new Error('Er bestaat al een account met dit e-mailadres.');
    const id = await store.insert({ naam: n, email: e, rol, wachtwoord_hash: null, actief: true });
    await store.logAuth(id, `Account aangemaakt door ${door} met rol ${auth.ROLLEN[rol]}.`);
    return uitnodigen(id, nu);
  }

  async function uitnodigen(id, nu = Date.now()) {
    const g = await store.opId(id);
    if (!g) throw new Error('Gebruiker niet gevonden.');
    const token = auth.nieuwToken();
    await store.update(g.id, { reset_token_hash: auth.hashToken(token), reset_geldig_tot: new Date(nu + auth.UITNODIGING_GELDIG_MS), reset_soort: 'uitnodiging' });
    return { token, gebruiker: publiek(g) };
  }

  async function eersteAccount({ naam, email, wachtwoord, rol }, rollen) {
    if ((await store.aantal(rollen)) > 0) throw new Error('Er bestaat al een account; log in met uw eigen gegevens.');
    const n = String(naam || '').trim().slice(0, 120);
    const e = auth.normaliseerEmail(email);
    if (n.length < 2) throw new Error('Vul uw naam in.');
    if (!auth.geldigeEmail(e)) throw new Error('Vul een geldig e-mailadres in.');
    const fout = auth.valideerWachtwoord(wachtwoord, e);
    if (fout) throw new Error(fout);
    if (await store.opEmail(e)) throw new Error('Er bestaat al een account met dit e-mailadres.');
    const id = await store.insert({ naam: n, email: e, rol, wachtwoord_hash: auth.hashWachtwoord(wachtwoord), actief: true });
    await store.logAuth(id, `Eerste account (${auth.ROLLEN[rol]}) aangemaakt met het gedeelde wachtwoord; dat wachtwoord werkt vanaf nu niet meer.`);
    return publiek(await store.opId(id));
  }

  async function wijzig(id, { actie, rol }, door, zelfId) {
    const g = await store.opId(id);
    if (!g) throw new Error('Gebruiker niet gevonden.');
    const lijst = await store.lijst();
    const andereBeheerders = lijst.filter((x) => x.rol === 'beheerder' && x.actief !== false && x.id !== g.id).length;
    switch (actie) {
      case 'deactiveren':
        if (g.id === zelfId) throw new Error('U kunt uw eigen account niet uitzetten.');
        if (g.rol === 'beheerder' && !andereBeheerders) throw new Error('Er moet minimaal één actieve beheerder overblijven.');
        await store.update(g.id, { actief: false, reset_token_hash: null, reset_geldig_tot: null, reset_soort: null });
        await store.logAuth(g.id, `Account uitgezet door ${door}.`);
        return 'Account uitgezet; inloggen kan niet meer.';
      case 'activeren':
        await store.update(g.id, { actief: true, foute_pogingen: 0, geblokkeerd_tot: null });
        await store.logAuth(g.id, `Account weer aangezet door ${door}.`);
        return 'Account weer aan.';
      case 'ontgrendelen':
        await store.update(g.id, { foute_pogingen: 0, geblokkeerd_tot: null });
        await store.logAuth(g.id, `Blokkade opgeheven door ${door}.`);
        return 'Blokkade opgeheven.';
      case 'rol':
        if (!auth.ROLLEN[rol]) throw new Error('Kies een rol.');
        if (g.id === zelfId && rol !== 'beheerder') throw new Error('U kunt uw eigen rol beheerder niet afgeven.');
        if (g.rol === 'beheerder' && rol !== 'beheerder' && !andereBeheerders) throw new Error('Er moet minimaal één beheerder overblijven.');
        await store.update(g.id, { rol });
        await store.logAuth(g.id, `Rol gewijzigd naar ${auth.ROLLEN[rol]} door ${door}.`);
        return `Rol gewijzigd naar ${auth.ROLLEN[rol]}.`;
      case '2fa-reset':
        await store.update(g.id, { totp_geheim: null, totp_actief: false, totp_laatste_stap: null, herstelcodes: null });
        await store.logAuth(g.id, `Tweede factor gereset door ${door}; bij de volgende login wordt de app opnieuw gekoppeld.`);
        return 'Tweede factor gereset. Bij de volgende login koppelt de gebruiker de app opnieuw.';
      default:
        throw new Error('Onbekende actie.');
    }
  }

  return {
    inloggen, start2fa, bevestig2fa, controleerCode, resetAanvragen, metResetToken, resetMetToken,
    nieuw, uitnodigen, eersteAccount, wijzig,
    aantal: (rollen = auth.ADMIN_ROLLEN) => store.aantal(rollen),
    lijst: () => store.lijst(),
    opId: async (id) => publiek(await store.opId(id)),
    activiteit: (n) => store.activiteit(n),
    store,
  };
}

let standaard = null;
function instantie() {
  if (!standaard) standaard = maak(pgStore());
  return standaard;
}

module.exports = { maak, pgStore, instantie };
