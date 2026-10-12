// Draai na scripts/e2e.mjs, tegen dezelfde server en database.
// Nodig: ADMIN_PASSWORD=test, DEURWAARDER_PASSWORD=dw, DATABASE_URL gezet.
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const BASE = process.env.BASE || 'http://localhost:3000';

function client() {
  let cookie = '';
  async function req(path, { method = 'GET', form } = {}) {
    const res = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, v] = kv.split(/=(.*)/s);
      const jar = Object.fromEntries(cookie.split('; ').filter(Boolean).map((x) => x.split(/=(.*)/s).slice(0, 2)));
      jar[k] = v;
      cookie = Object.entries(jar).map(([a, b]) => `${a}=${b}`).join('; ');
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async function csrf(path) {
    const r = await req(path);
    const m = r.text.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(m, `geen csrf op ${path} (${r.status})`);
    return { token: m[1], page: r };
  }
  return { req, csrf };
}

const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
const school = (await pg.query("SELECT a.id, f.id fid FROM aanvragen a JOIN facturen f ON f.aanvraag_id=a.id WHERE f.betaald_op IS NULL ORDER BY a.id LIMIT 1")).rows[0];
assert.ok(school, 'geen open factuur gevonden; draai eerst scripts/e2e.mjs');

const adm = client();
let { token } = await adm.csrf('/admin/login');
await adm.req('/admin/login', { method: 'POST', form: { _csrf: token, wachtwoord: 'test' } });

// Vóór de aanmaning: overdragen niet mogelijk
let d = await adm.csrf(`/admin/aanvraag/${school.id}`);
assert.match(d.page.text, /Nog niet mogelijk: Eerst moet de aanmaning/);

// Tijdreis: factuur 20 dagen vervallen, herinneringen draaien → aanmaning
await pg.query("UPDATE facturen SET vervaldatum = CURRENT_DATE - 20 WHERE id=$1", [school.fid]);
await adm.req('/admin/herinneringen', { method: 'POST', form: { _csrf: d.token } });
d = await adm.csrf(`/admin/aanvraag/${school.id}`);
assert.match(d.page.text, /Overdragen aan Armaere/);
assert.match(d.page.text, /Wettelijke incassokosten: €\s192,83/); // 15% van € 1.285,50

let r = await adm.req(`/admin/aanvraag/${school.id}/incasso`, { method: 'POST', form: { _csrf: d.token, notitie: 'Administratie reageert niet.' } });
assert.equal(r.status, 303);
d = await adm.csrf(`/admin/aanvraag/${school.id}`);
assert.match(d.page.text, /Dossier D-\d+ bij Armaere/);
assert.match(d.page.text, /nog niet geopend/);

// Deurwaarder: zonder login geen toegang, admin-pagina's ook niet
const dw = client();
r = await dw.req('/deurwaarder');
assert.equal(r.status, 302);
({ token } = await dw.csrf('/deurwaarder/login'));
r = await dw.req('/deurwaarder/login', { method: 'POST', form: { _csrf: token, wachtwoord: 'fout' } });
assert.equal(r.status, 401);
r = await dw.req('/deurwaarder/login', { method: 'POST', form: { _csrf: token, wachtwoord: 'dw' } });
assert.equal(r.status, 302);
r = await dw.req('/admin');
assert.equal(r.status, 302, 'deurwaarder mag niet in de backoffice');

r = await dw.req('/deurwaarder');
assert.match(r.text, /Nieuw, nog niet geopend/);
const dossierId = r.text.match(/\/deurwaarder\/dossier\/(\d+)/)[1];

// Openen zet status op in behandeling
r = await dw.req(`/deurwaarder/dossier/${dossierId}`);
assert.equal(r.status, 303);
let p = await dw.csrf(`/deurwaarder/dossier/${dossierId}`);
assert.match(p.page.text, /In behandeling/);
assert.match(p.page.text, /Akkoord/);
assert.match(p.page.text, /M\. de Vries/); // wie akkoord gaf
assert.match(p.page.text, /Aanmaning: factuur/); // correspondentie zichtbaar
assert.match(p.page.text, /Administratie reageert niet/); // notitie van Pouw

// Bericht, nummer, deelbetaling
await dw.req(`/deurwaarder/dossier/${dossierId}/referentie`, { method: 'POST', form: { _csrf: p.token, referentie: 'ARM-2026-1234' } });
await dw.req(`/deurwaarder/dossier/${dossierId}/bericht`, { method: 'POST', form: { _csrf: p.token, tekst: 'Sommatie verstuurd.' } });
await dw.req(`/deurwaarder/dossier/${dossierId}/betaling`, { method: 'POST', form: { _csrf: p.token, bedrag: '500,00', datum: new Date().toISOString().slice(0, 10) } });
d = await adm.csrf(`/admin/aanvraag/${school.id}`);
assert.match(d.page.text, /Sommatie verstuurd/);
assert.match(d.page.text, /ARM-2026-1234/);
assert.match(d.page.text, /Bij Armaere/);

// Rest van hoofdsom + kosten → factuur betaald en dossier gesloten
await dw.req(`/deurwaarder/dossier/${dossierId}/betaling`, { method: 'POST', form: { _csrf: p.token, bedrag: '978,33', datum: new Date().toISOString().slice(0, 10) } });
p = await dw.csrf(`/deurwaarder/dossier/${dossierId}`);
assert.match(p.page.text, /Volledig betaald/);
d = await adm.csrf(`/admin/aanvraag/${school.id}`);
assert.match(d.page.text, /Betaald op/);

// De klant heeft nu een incassoverleden: klasse D bij een nieuwe aanvraag
const h = (await pg.query("SELECT count(*)::int n FROM facturen WHERE incasso=true")).rows[0].n;
assert.equal(h, 1);

await pg.end();
console.log('E2E incasso OK', { dossierId });
