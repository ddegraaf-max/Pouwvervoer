// End-to-end: draai tegen een lopende server (BASE, standaard http://localhost:3000, ADMIN_PASSWORD=test).
// Gebruik: node scripts/e2e.mjs   (staat buiten `npm test`, want het heeft een database nodig)
import assert from 'node:assert';

const BASE = process.env.BASE || 'http://localhost:3000';

function client() {
  let cookie = '';
  async function req(path, { method = 'GET', form } = {}) {
    const res = await fetch(BASE + path, {
      method,
      redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const sc = res.headers.getSetCookie();
    if (sc.length) {
      const jar = Object.fromEntries(cookie.split('; ').filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2)));
      for (const c of sc) {
        const [kv] = c.split(';');
        const [k, v] = kv.split(/=(.*)/s);
        jar[k] = v;
      }
      cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  }
  async function csrf(path) {
    const r = await req(path);
    const m = r.text.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(m, `geen csrf op ${path} (${r.status})`);
    return { token: m[1], page: r };
  }
  return { req, csrf };
}

const dagen = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// Stap 1: de reis (sessie), daarna stap 2: de gegevens.
async function reisStap(c, extra = {}) {
  const { token } = await c.csrf('/reis');
  const r = await c.req('/reis', {
    method: 'POST',
    form: {
      _csrf: token, reistype: 'retour', personen: '48', van: 'Vianen', naar: 'Efteling', via: 'Utrecht Centraal', wacht: '30',
      tijdtype_heen: 'vertrek', datum_heen: dagen(60), tijd_heen: '08:30', tijdtype_terug: 'aankomst', datum_terug: dagen(60), tijd_terug: '17:30', ...extra,
    },
  });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(r.location, '/');
}

async function aanvraag(c, extra) {
  await reisStap(c, extra.naar ? { naar: extra.naar } : {});
  const { token } = await c.csrf('/');
  return c.req('/aanvraag', {
    method: 'POST',
    form: {
      _csrf: token, aanvrager_naam: 'Sanne Jansen', aanvrager_tel: '0612345678', aanvrager_email: 'sanne@example.nl',
      tekenbevoegde: 'M. de Vries', teken_email: 'directie@obsvoorbeeld.nl', factuur_email: 'facturen@bestuur.nl', bus_blijft: 'on', voorwaarden: 'on', ...extra,
    },
  });
}

const pub = client();
const adm = client();

// 0. Zonder reis stuurt de gegevenspagina door naar de reis-stap
let r = await pub.req('/');
assert.equal(r.status, 302);
assert.equal(r.location, '/reis');

// 1. Validatie
r = await aanvraag(pub, { klanttype: 'onderwijs', org_naam: 'OBS Voorbeeld', kvk: '123', voorwaarden: '' });
assert.equal(r.status, 422);
assert.match(r.text, /KvK-nummer van 8 cijfers/);
assert.match(r.text, /Vervoer- en Reisvoorwaarden van KNV Busvervoer heeft gelezen/);
assert.match(r.text, /inkoop- of referentienummer/);

// 2. Onderwijs → klasse A (geen aanbetaling)
r = await aanvraag(pub, { klanttype: 'onderwijs', org_naam: 'OBS Voorbeeld', kvk: '12340003', po_nummer: 'PO-2026-1' });
assert.equal(r.status, 200, r.text.slice(0, 300));
assert.match(r.text, /Aanvraag ontvangen/);

// 3. Particulier → klasse C
r = await aanvraag(pub, { klanttype: 'particulier', tekenbevoegde: 'Lisa Bakker', teken_email: 'lisa@gmail.com', factuur_zelfde: 'on', naar: 'Kasteel de Haar' });
assert.equal(r.status, 200);

// 4. Bedrijf failliet → geblokkeerd
r = await aanvraag(pub, { klanttype: 'bedrijf', org_naam: 'Failliet BV', kvk: '55550002' });
assert.equal(r.status, 200);

// CSRF ontbreekt → 403
r = await pub.req('/aanvraag', { method: 'POST', form: { klanttype: 'bedrijf' } });
assert.equal(r.status, 403);

// Backoffice dicht zonder login
r = await adm.req('/admin');
assert.equal(r.status, 302);
let { token } = await adm.csrf('/admin/login');
r = await adm.req('/admin/login', { method: 'POST', form: { _csrf: token, wachtwoord: 'fout' } });
assert.equal(r.status, 401);
r = await adm.req('/admin/login', { method: 'POST', form: { _csrf: token, wachtwoord: 'test' } });
assert.equal(r.status, 302);

r = await adm.req('/admin');
const ids = [...r.text.matchAll(/\/admin\/aanvraag\/(\d+)/g)].map((m) => Number(m[1]));
const [failliet, particulier, school] = [...new Set(ids)].sort((a, b) => b - a);

// --- School: klasse A
let d = await adm.csrf(`/admin/aanvraag/${school}`);
assert.match(d.page.text, /Klasse A/);
r = await adm.req(`/admin/aanvraag/${school}/prijs`, { method: 'POST', form: { _csrf: d.token, ritprijs: '1.250,00', nakosten_schatting: '' } });
r = await adm.req(`/admin/aanvraag/${school}/offerte`, { method: 'POST', form: { _csrf: d.token } });
d = await adm.csrf(`/admin/aanvraag/${school}`);
assert.match(d.page.text, /score 85|>85</);
const schoolLink = d.page.text.match(/\/akkoord\/([A-Za-z0-9_-]+)/)[1];
let p = await pub.csrf(`/akkoord/${schoolLink}`);
assert.match(p.page.text, /Geen aanbetaling nodig/);
r = await pub.req(`/akkoord/${schoolLink}`, { method: 'POST', form: { _csrf: p.token, naam: 'M. de Vries', voorwaarden: 'on' } });
assert.equal(r.status, 303);
p = await pub.req(`/akkoord/${schoolLink}`);
assert.match(p.text, /De rit is bevestigd/);

// trip-export bevat de school
r = await adm.req('/admin/trip.csv');
assert.match(r.text, /Efteling/);

// gereden, nakosten, eindfactuur
d = await adm.csrf(`/admin/aanvraag/${school}`);
await adm.req(`/admin/aanvraag/${school}/gereden`, { method: 'POST', form: { _csrf: d.token } });
await adm.req(`/admin/aanvraag/${school}/nakosten`, { method: 'POST', form: { _csrf: d.token, omschrijving: 'Parkeergeld', bedrag: '35,50' } });
await adm.req(`/admin/aanvraag/${school}/factuur`, { method: 'POST', form: { _csrf: d.token } });
d = await adm.csrf(`/admin/aanvraag/${school}`);
assert.match(d.page.text, /EPV-\d{4}-0001/);
assert.match(d.page.text, /1\.285,50/); // 1250 + 35,50

// --- Particulier: klasse C, 50% bij akkoord
d = await adm.csrf(`/admin/aanvraag/${particulier}`);
assert.match(d.page.text, /Klasse C/);
await adm.req(`/admin/aanvraag/${particulier}/prijs`, { method: 'POST', form: { _csrf: d.token, ritprijs: '2400', nakosten_schatting: '60' } });
await adm.req(`/admin/aanvraag/${particulier}/offerte`, { method: 'POST', form: { _csrf: d.token } });
d = await adm.csrf(`/admin/aanvraag/${particulier}`);
const partLink = d.page.text.match(/\/akkoord\/([A-Za-z0-9_-]+)/)[1];
p = await pub.csrf(`/akkoord/${partLink}`);
assert.match(p.page.text, /Goedkeuren en €\s1\.200,00 betalen met iDEAL/);
// zonder vinkje → 422
r = await pub.req(`/akkoord/${partLink}`, { method: 'POST', form: { _csrf: p.token, naam: 'Lisa Bakker' } });
assert.equal(r.status, 422);
r = await pub.req(`/akkoord/${partLink}`, { method: 'POST', form: { _csrf: p.token, naam: 'Lisa Bakker', voorwaarden: 'on' } });
assert.equal(r.status, 303);
assert.match(r.location, /^\/betalen\//);
p = await pub.req(`/akkoord/${partLink}`);
assert.match(p.text, /wacht|aanbetaling binnen is/i);
// niet in trip-export zolang niet betaald
r = await adm.req('/admin/trip.csv');
assert.doesNotMatch(r.text, /Kasteel de Haar/);
// betalen
const betaalPad = p.text.match(/\/betalen\/[A-Za-z0-9_-]+/)[0];
const b = await pub.csrf(betaalPad);
r = await pub.req(betaalPad, { method: 'POST', form: { _csrf: b.token } });
assert.equal(r.status, 303);
p = await pub.req(`/akkoord/${partLink}`);
assert.match(p.text, /De rit is bevestigd/);
r = await adm.req('/admin/trip.csv');
assert.match(r.text, /Kasteel de Haar/);

// --- Failliet: geblokkeerd
d = await adm.csrf(`/admin/aanvraag/${failliet}`);
assert.match(d.page.text, /Geblokkeerd/);
await adm.req(`/admin/aanvraag/${failliet}/prijs`, { method: 'POST', form: { _csrf: d.token, ritprijs: '900' } });
await adm.req(`/admin/aanvraag/${failliet}/offerte`, { method: 'POST', form: { _csrf: d.token } });
d = await adm.csrf(`/admin/aanvraag/${failliet}`);
assert.doesNotMatch(d.page.text, /Akkoordlink/);

// Klasse handmatig: zonder reden geweigerd, met reden toegepast
await adm.req(`/admin/aanvraag/${failliet}/klasse`, { method: 'POST', form: { _csrf: d.token, klasse: 'A', reden: '' } });
d = await adm.csrf(`/admin/aanvraag/${failliet}`);
assert.match(d.page.text, /Kies een klasse en vul de reden in/);

console.log('E2E OK', { school, particulier, failliet });
