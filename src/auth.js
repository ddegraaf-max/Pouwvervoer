// Accounts, wachtwoorden, tweede factor (TOTP), herstelcodes, resettokens, sessieregels, blokkade en rollen.
// Alleen pure functies en crypto; geen database. De flows met opslag staan in gebruikers.js.
const crypto = require('crypto');

// ---- Rollen en rechten ----
const ROLLEN = { beheerder: 'Beheerder', sales: 'Sales', planning: 'Planning', administratie: 'Administratie', deurwaarder: 'Deurwaarder' };
const ADMIN_ROLLEN = ['beheerder', 'sales', 'planning', 'administratie'];
const PORTAAL_ROLLEN = ['deurwaarder'];
// Handelingen die niet iedereen in de backoffice mag doen.
const PERMISSIES = {
  betalingen: ['administratie', 'beheerder'],
  creditnota: ['administratie', 'beheerder'],
  overdracht: ['administratie', 'beheerder'],
  klasse: ['beheerder'],
  gebruikers: ['beheerder'],
  afas: ['beheerder'],
};
const ACTIES = {
  betalingen: 'betalingen registreren',
  creditnota: 'creditnota\'s maken',
  overdracht: 'dossiers overdragen aan de deurwaarder',
  klasse: 'de klantklasse handmatig aanpassen',
  gebruikers: 'gebruikers beheren',
  afas: 'boekingen opnieuw naar AFAS sturen',
};
function mag(rol, actie) {
  const lijst = PERMISSIES[actie];
  if (!lijst) return false;
  return lijst.includes(rol);
}
function wieMag(actie) {
  return (PERMISSIES[actie] || []).map((r) => ROLLEN[r]).join(' en ');
}

// ---- Wachtwoorden (scrypt) ----
const SCRYPT = { N: 1 << 15, r: 8, p: 1, lengte: 64 };
function hashWachtwoord(wachtwoord) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(wachtwoord), salt, SCRYPT.lengte, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function controleerWachtwoord(wachtwoord, opgeslagen) {
  if (!opgeslagen || typeof opgeslagen !== 'string') return false;
  const [soort, N, r, p, salt, hash] = opgeslagen.split('$');
  if (soort !== 'scrypt' || !salt || !hash) return false;
  const verwacht = Buffer.from(hash, 'base64');
  const gegeven = crypto.scryptSync(String(wachtwoord), Buffer.from(salt, 'base64'), verwacht.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return gegeven.length === verwacht.length && crypto.timingSafeEqual(gegeven, verwacht);
}
const WACHTWOORD_MIN = 12;
function valideerWachtwoord(wachtwoord, email = '') {
  const w = String(wachtwoord || '');
  if (w.length < WACHTWOORD_MIN) return `Kies een wachtwoord van minimaal ${WACHTWOORD_MIN} tekens; een zin met spaties mag.`;
  if (w.length > 200) return 'Het wachtwoord is te lang (maximaal 200 tekens).';
  const lokaal = String(email || '').toLowerCase().split('@')[0];
  if (lokaal.length >= 4 && w.toLowerCase().includes(lokaal)) return 'Het wachtwoord mag niet uw e-mailadres bevatten.';
  if (/^(.)\1+$/.test(w)) return 'Kies een minder voorspelbaar wachtwoord.';
  return null;
}

// ---- Base32 en TOTP (RFC 6238, SHA-1, 6 cijfers, 30 seconden) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0;
  let waarde = 0;
  let uit = '';
  for (const b of buf) {
    waarde = (waarde << 8) | b;
    bits += 8;
    while (bits >= 5) {
      uit += B32[(waarde >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) uit += B32[(waarde << (5 - bits)) & 31];
  return uit;
}
function base32Decode(s) {
  const schoon = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let waarde = 0;
  const uit = [];
  for (const c of schoon) {
    waarde = (waarde << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      uit.push((waarde >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(uit);
}
const TOTP_STAP_S = 30;
const TOTP_CIJFERS = 6;
function nieuwGeheim() {
  return base32Encode(crypto.randomBytes(20));
}
function totpStap(tijdMs = Date.now()) {
  return Math.floor(tijdMs / 1000 / TOTP_STAP_S);
}
function totpCode(geheim, tijdMs = Date.now()) {
  return totpCodeVoorStap(geheim, totpStap(tijdMs));
}
function totpCodeVoorStap(geheim, stap) {
  const teller = Buffer.alloc(8);
  teller.writeBigUInt64BE(BigInt(stap));
  const hmac = crypto.createHmac('sha1', base32Decode(geheim)).update(teller).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binair = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binair % 10 ** TOTP_CIJFERS).padStart(TOTP_CIJFERS, '0');
}
// Accepteert de huidige stap en één stap ervoor en erna (klokverschil), maar nooit een stap die al is gebruikt (replay).
function controleerTotp(geheim, code, tijdMs = Date.now(), laatsteStap = null) {
  const schoon = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(schoon) || !geheim) return { ok: false, stap: null };
  const nu = totpStap(tijdMs);
  for (const stap of [nu, nu - 1, nu + 1]) {
    if (laatsteStap != null && stap <= Number(laatsteStap)) continue;
    const verwacht = totpCodeVoorStap(geheim, stap);
    if (verwacht.length === schoon.length && crypto.timingSafeEqual(Buffer.from(verwacht), Buffer.from(schoon))) return { ok: true, stap };
  }
  return { ok: false, stap: null };
}
function otpauthUrl(email, geheim, uitgever = 'boekpouwvervoer') {
  const label = `${encodeURIComponent(uitgever)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${geheim}&issuer=${encodeURIComponent(uitgever)}&algorithm=SHA1&digits=${TOTP_CIJFERS}&period=${TOTP_STAP_S}`;
}

// ---- Versleuteling van het TOTP-geheim in de database (AES-256-GCM, sleutel uit SESSION_SECRET) ----
function sleutel() {
  return crypto.createHash('sha256').update(`${process.env.SESSION_SECRET || 'dev-alleen-lokaal'}|totp`).digest();
}
function versleutel(tekst) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sleutel(), iv);
  const data = Buffer.concat([c.update(String(tekst), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('$');
}
function ontsleutel(opgeslagen) {
  if (!opgeslagen) return null;
  const [v, iv, tag, data] = String(opgeslagen).split('$');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', sleutel(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

// ---- Herstelcodes: 8 codes van 10 tekens, eenmalig, alleen als hash bewaard ----
const HERSTEL_AANTAL = 8;
const HERSTEL_TEKENS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nieuweHerstelcodes() {
  const codes = [];
  for (let i = 0; i < HERSTEL_AANTAL; i++) {
    const b = crypto.randomBytes(10);
    let c = '';
    for (let j = 0; j < 10; j++) c += HERSTEL_TEKENS[b[j] % HERSTEL_TEKENS.length];
    codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
  }
  return codes;
}
function normaliseerCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function hashHerstelcode(code) {
  return crypto.createHash('sha256').update(`herstel|${normaliseerCode(code)}`).digest('hex');
}
function gebruikHerstelcode(hashes, code) {
  const lijst = Array.isArray(hashes) ? hashes : [];
  const h = hashHerstelcode(code);
  const i = lijst.findIndex((x) => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  if (i < 0 || normaliseerCode(code).length !== 10) return { ok: false, rest: lijst };
  return { ok: true, rest: lijst.filter((_, j) => j !== i) };
}

// ---- Tokens voor wachtwoord-reset en uitnodigingen ----
function nieuwToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(`token|${String(token || '')}`).digest('hex');
}
const RESET_GELDIG_MS = 30 * 60e3;
const UITNODIGING_GELDIG_MS = 7 * 24 * 3600e3;

// ---- Sessie: uiterlijk 8 uur, en 60 minuten zonder activiteit ----
const SESSIE_MAX_MS = 8 * 3600e3;
const SESSIE_IDLE_MS = 60 * 60e3;
function sessieGeldig(sessie, nu = Date.now()) {
  if (!sessie || !sessie.id || !sessie.ingelogd_op) return { ok: false, reden: 'geen sessie' };
  if (nu - Number(sessie.ingelogd_op) > SESSIE_MAX_MS) return { ok: false, reden: 'U bent uitgelogd: een sessie duurt maximaal 8 uur.' };
  if (nu - Number(sessie.laatst_actief || sessie.ingelogd_op) > SESSIE_IDLE_MS) return { ok: false, reden: 'U bent uitgelogd na 60 minuten zonder activiteit.' };
  return { ok: true };
}

// ---- Blokkade per account: na 5 foute pogingen 15 minuten dicht ----
const MAX_POGINGEN = 5;
const BLOKKADE_MS = 15 * 60e3;
function isGeblokkeerd(g, nu = Date.now()) {
  return !!(g && g.geblokkeerd_tot && new Date(g.geblokkeerd_tot).getTime() > nu);
}
function naFoutePoging(g, nu = Date.now()) {
  const n = (Number(g && g.foute_pogingen) || 0) + 1;
  if (n >= MAX_POGINGEN) return { foute_pogingen: 0, geblokkeerd_tot: new Date(nu + BLOKKADE_MS) };
  return { foute_pogingen: n, geblokkeerd_tot: null };
}

function normaliseerEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function geldigeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normaliseerEmail(email));
}

module.exports = {
  ROLLEN, ADMIN_ROLLEN, PORTAAL_ROLLEN, PERMISSIES, ACTIES, mag, wieMag,
  hashWachtwoord, controleerWachtwoord, valideerWachtwoord, WACHTWOORD_MIN,
  base32Encode, base32Decode, nieuwGeheim, totpStap, totpCode, totpCodeVoorStap, controleerTotp, otpauthUrl, TOTP_STAP_S,
  versleutel, ontsleutel,
  nieuweHerstelcodes, hashHerstelcode, gebruikHerstelcode, normaliseerCode, HERSTEL_AANTAL,
  nieuwToken, hashToken, RESET_GELDIG_MS, UITNODIGING_GELDIG_MS,
  sessieGeldig, SESSIE_MAX_MS, SESSIE_IDLE_MS,
  isGeblokkeerd, naFoutePoging, MAX_POGINGEN, BLOKKADE_MS,
  normaliseerEmail, geldigeEmail,
};
