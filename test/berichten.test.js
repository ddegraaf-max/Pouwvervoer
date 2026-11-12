const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://niet-gebruikt@localhost/x';
const berichten = require('../src/berichten');

test('telefoonnummers naar internationaal formaat zonder plus', () => {
  assert.equal(berichten.normaliseerNummer('06 12345678'), '31612345678');
  assert.equal(berichten.normaliseerNummer('+31 6 12345678'), '31612345678');
  assert.equal(berichten.normaliseerNummer('0031612345678'), '31612345678');
  assert.equal(berichten.normaliseerNummer('030-6868300'), '31306868300');
  assert.equal(berichten.normaliseerNummer('+32 478 12 34 56'), '32478123456');
  assert.equal(berichten.normaliseerNummer('12345'), null);
  assert.equal(berichten.normaliseerNummer(''), null);
  assert.equal(berichten.isMobielNl('31612345678'), true);
  assert.equal(berichten.isMobielNl('31306868300'), false);
});

test('stille uren: tussen 21:00 en 08:00 Amsterdam wordt het 08:00', () => {
  // 12 november 2026 (wintertijd, UTC+1)
  const overdag = new Date('2026-11-12T13:30:00Z'); // 14:30 lokaal
  assert.equal(berichten.verzendMoment(overdag).getTime(), overdag.getTime());
  const laat = new Date('2026-11-12T21:30:00Z'); // 22:30 lokaal → morgen 08:00 = 07:00Z
  assert.equal(berichten.verzendMoment(laat).toISOString(), '2026-11-13T07:00:00.000Z');
  const vroeg = new Date('2026-11-12T05:10:00Z'); // 06:10 lokaal → vandaag 08:00
  assert.equal(berichten.verzendMoment(vroeg).toISOString(), '2026-11-12T07:00:00.000Z');
  const rand = new Date('2026-11-12T20:00:00Z'); // precies 21:00 lokaal → morgen
  assert.equal(berichten.verzendMoment(rand).toISOString(), '2026-11-13T07:00:00.000Z');
  // zomertijd (UTC+2): 22:30 lokaal op 1 juli = 20:30Z → 2 juli 08:00 lokaal = 06:00Z
  assert.equal(berichten.verzendMoment(new Date('2026-07-01T20:30:00Z')).toISOString(), '2026-07-02T06:00:00.000Z');
  assert.equal(berichten.datumTijd(new Date('2026-11-13T07:00:00Z')), '13-11-2026 08:00');
});

test('berichten per soort: template met genummerde variabelen, knopvariabele en sms-terugval met link', () => {
  const o = berichten.bouwBericht('offerte', { 1: 'Piet de Vries', 2: '12 november 2026', 3: '26 november 2026', knop: 'tok123', link: 'https://boekpouwvervoer.nl/akkoord/tok123' });
  assert.equal(o.whatsapp.template_name, 'pouw_offerte');
  assert.deepEqual(o.whatsapp.variabelen, { 1: 'Piet de Vries', 2: '12 november 2026', 3: '26 november 2026' });
  assert.equal(o.whatsapp.knopVariabele, 'tok123');
  assert.match(o.tekst, /^Beste Piet de Vries, de offerte van Pouw Vervoer voor uw busrit op 12 november 2026/);
  assert.match(o.sms, /akkoord\/tok123$/);
  const f = berichten.bouwBericht('factuur', { 1: 'Piet', 2: 'EPV-2026-0005', 3: '€ 2.500,00', 4: 'is verlopen op 1 november 2026', knop: 'ft', link: 'https://x/factuur/ft' });
  assert.match(f.tekst, /factuur EPV-2026-0005 van Pouw Vervoer \(€ 2.500,00\) is verlopen op 1 november 2026\./);
  const r = berichten.bouwBericht('rit_morgen', { 1: 'Sanne', 2: '13 november 2026', 3: '08:30', 4: 'Hagenweg 3c, Vianen', 5: 'Henk de Boer' });
  assert.equal(r.whatsapp.knopVariabele, null);
  assert.match(r.sms, /Chauffeur: Henk de Boer/);
  assert.ok(r.sms.length <= 160, 'sms-terugval kort houden');
  assert.throws(() => berichten.bouwBericht('onzin', {}), /Onbekend/);
  for (const t of Object.values(berichten.TEMPLATES)) assert.ok(t.tekst.length <= 1024);
});

test('webhook-handtekening (HMAC-SHA256 over t.body) en STOP-herkenning', () => {
  const crypto = require('crypto');
  const secret = 'whsec_test';
  const body = JSON.stringify({ webhook_type: 'inbox_message', message: { sender: '31612345678', content: 'STOP' } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(berichten.controleerHandtekening(`t=${t},v1=${sig}`, body, secret).ok, true);
  assert.equal(berichten.controleerHandtekening(`t=${t},v1=${sig}`, body + ' ', secret).ok, false);
  assert.equal(berichten.controleerHandtekening(`t=${t - 400},v1=${sig}`, body, secret).ok, false);
  assert.equal(berichten.controleerHandtekening('', body, secret).ok, false);
  assert.equal(berichten.controleerHandtekening('', body, '').ok, true, 'zonder secret geen controle (demo)');
  assert.equal(berichten.isStop('STOP'), true);
  assert.equal(berichten.isStop('  stop alsjeblieft'), true);
  assert.equal(berichten.isStop('Afmelden'), true);
  assert.equal(berichten.isStop('Bedankt, tot morgen!'), false);
  assert.equal(berichten.AFLEVERCODES[1], 'afgeleverd');
  assert.equal(berichten.AFLEVERCODES[2], 'mislukt');
});
