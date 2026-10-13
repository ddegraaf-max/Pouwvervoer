const test = require('node:test');
const assert = require('node:assert');
const assistent = require('../src/assistent');

const nu = new Date('2026-10-13T10:00:00Z');

// Nepclient: geeft een vast antwoord terug en onthoudt wat er is gevraagd.
function nepClient(antwoord, stop = 'end_turn') {
  const gezien = [];
  return {
    gezien,
    beta: {
      messages: {
        create: async (params) => {
          gezien.push(params);
          return { stop_reason: stop, content: [{ type: 'text', text: typeof antwoord === 'string' ? antwoord : JSON.stringify(antwoord) }] };
        },
      },
    },
  };
}

const efteling = {
  reistype: 'retour', personen: 54, van: 'Mariaschool, Vianen', via: [], naar: 'De Efteling, Kaatsheuvel',
  datum_heen: '2027-05-12', tijd_heen: '08:30', tijdtype_heen: 'vertrek',
  datum_terug: '2027-05-12', tijd_terug: '17:00', tijdtype_terug: 'aankomst',
  andere_route: false, terug_van: null, terug_via: [], terug_naar: null,
  toelichting: 'Een schoolreis naar de Efteling op 12 mei met 54 personen, om 17:00 weer terug in Vianen.',
};

test('normaliseer: volledige reis', () => {
  const v = assistent.normaliseer(efteling, nu);
  assert.deepEqual(v, {
    reistype: 'retour', personen: '54', van: 'Mariaschool, Vianen', naar: 'De Efteling, Kaatsheuvel',
    tijdtype_heen: 'vertrek', datum_heen: '2027-05-12', tijd_heen: '08:30',
    tijdtype_terug: 'aankomst', datum_terug: '2027-05-12', tijd_terug: '17:00',
  });
  assert.deepEqual(assistent.ontbrekend(v), []);
});

test('normaliseer: onzin valt weg, wachttijd naar een kwartier, maximaal 5 stops', () => {
  const v = assistent.normaliseer({
    reistype: 'onbekend', personen: 2.5, van: '  ', naar: 'Amsterdam',
    via: [{ adres: 'Utrecht', wacht_minuten: 50 }, { adres: '', wacht_minuten: 10 }, { adres: 'A' }, { adres: 'B' }, { adres: 'C' }, { adres: 'D' }, { adres: 'E' }],
    datum_heen: '2026-10-12', tijd_heen: '25:00', tijdtype_heen: 'later',
    datum_terug: '2026-10-11', tijd_terug: '9:00', tijdtype_terug: 'aankomst', andere_route: false, terug_van: null, terug_via: [], terug_naar: null, toelichting: '',
  }, nu);
  assert.equal(v.reistype, undefined);
  assert.equal(v.personen, undefined);
  assert.equal(v.van, undefined);
  assert.equal(v.naar, 'Amsterdam');
  assert.deepEqual(v.via, ['Utrecht', 'A', 'B', 'C', 'D']);
  assert.deepEqual(v.wacht, [45, 15, 15, 15, 15]);
  assert.equal(v.datum_heen, undefined, 'datum in het verleden');
  assert.equal(v.tijd_heen, undefined);
  assert.equal(v.tijdtype_heen, undefined);
  assert.equal(v.datum_terug, undefined);
  assert.equal(v.tijd_terug, undefined);
  const ontbreekt = assistent.ontbrekend(v).map((o) => o.veld);
  assert.deepEqual(ontbreekt, ['personen', 'van', 'datum_heen', 'tijd_heen', 'datum_terug', 'tijd_terug']);
});

test('normaliseer: enkele reis negeert de terugreis, andere route neemt terugroute mee', () => {
  const enkel = assistent.normaliseer({ ...efteling, reistype: 'enkel', andere_route: true, terug_van: 'X', terug_naar: 'Y' }, nu);
  assert.equal(enkel.andere_route, undefined);
  assert.equal(enkel.datum_terug, undefined);
  assert.deepEqual(assistent.ontbrekend(enkel), []);

  const anders = assistent.normaliseer({ ...efteling, andere_route: true, terug_van: 'De Efteling', terug_via: [{ adres: 'Breda', wacht_minuten: 60 }], terug_naar: null }, nu);
  assert.equal(anders.andere_route, true);
  assert.equal(anders.terug_van, 'De Efteling');
  assert.deepEqual(anders.terug_via, ['Breda']);
  assert.deepEqual(anders.terug_wacht, [60]);
  assert.deepEqual(assistent.ontbrekend(anders).map((o) => o.veld), ['terug_naar']);
});

test('reisUitTekst: vraagt om JSON volgens schema met fallback, en geeft velden terug', async () => {
  const client = nepClient(efteling);
  const r = await assistent.reisUitTekst('Schoolreis naar de Efteling op 12 mei met 48 kinderen en 6 begeleiders vanaf de Mariaschool in Vianen, om 17:00 terug', { nu, client });
  assert.equal(client.gezien.length, 1);
  const p = client.gezien[0];
  assert.equal(p.model, assistent.MODEL);
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.equal(p.output_config.format.schema, assistent.SCHEMA_REIS);
  assert.match(p.system, /dinsdag 13 oktober 2026/);
  assert.match(p.system, /2026-10-13/);
  assert.equal(p.messages[0].role, 'user');
  assert.equal(r.v.personen, '54');
  assert.deepEqual(r.ontbreekt, []);
  assert.match(r.toelichting, /Efteling/);
});

test('reisUitTekst: te korte tekst, weigering en onleesbaar antwoord geven een nette fout', async () => {
  await assert.rejects(assistent.reisUitTekst('hoi', { nu, client: nepClient(efteling) }), assistent.AssistentFout);
  await assert.rejects(assistent.reisUitTekst('Busreis naar Parijs', { nu, client: nepClient(efteling, 'refusal') }), /kon hier niets mee/);
  await assert.rejects(assistent.reisUitTekst('Busreis naar Parijs', { nu, client: nepClient('dit is geen json') }), /onleesbaar/);
});

const dossier = {
  a: {
    id: 12, status: 'offerte_verstuurd', rit_datum: '2026-11-02', vertrek_tijd: '08:00', van: 'Vianen', naar: 'Efteling', personen: 54, ritsoort: 'brengen_halen',
    opmerkingen: null, ritprijs_cent: 240000, nakosten_schatting_cent: 0, po_nummer: null, aanvrager_naam: 'Sanne Jansen', aanvrager_email: 'sanne@mariaschool.nl',
    factuur_email: 'administratie@mariaschool.nl', score: 55, klasse: 'B', score_factoren: [{ label: 'Startwaarde', bron: '-', punten: 40 }],
    geblokkeerd: false, blokkade_reden: null, offerte_verstuurd_op: '2026-10-13', akkoord_op: null,
  },
  k: { naam: 'Mariaschool', type: 'onderwijs', kvk: '12345678', kvk_actief: true, kvk_opgericht: '2001-01-01', kvk_faillissement: false, tekenbevoegde: 'Piet de Vries', teken_email: 'directie@mariaschool.nl', klasse_override: null, override_reden: null },
  historie: { betaaldOpTijd: 2, betaaldTeLaat1tot30: 0, ooitTeLaat30Plus: 0, incasso: 0, openVervallen: 0, open: 0 },
  plan: { omschrijving: '30% uiterlijk 14 dagen voor vertrek', termijnen: [{ label: 'Aanbetaling', bedrag: 72000 }] },
};

test('risicoUitleg: stuurt de feiten en geeft de tekst terug', async () => {
  const client = nepClient('De score van 55 (klasse B) komt vooral door de startwaarde. Vraag 30% aanbetaling.');
  const uitleg = await assistent.risicoUitleg(dossier, { client });
  assert.match(uitleg, /klasse B/);
  const p = client.gezien[0];
  assert.equal(p.output_config.format, undefined, 'geen schema: platte tekst');
  assert.match(p.messages[0].content, /"referentie": "EPV-12"/);
  assert.match(p.messages[0].content, /"emaildomein_tekenbevoegde": "mariaschool.nl"/);
  assert.match(p.messages[0].content, /"bedrag_euro": 720/);
});

test('conceptMail: ontvanger, instructie en concept', async () => {
  assert.equal(assistent.ontvanger(dossier, 'opdrachtgever').email, 'directie@mariaschool.nl');
  assert.equal(assistent.ontvanger(dossier, 'factuur').email, 'administratie@mariaschool.nl');
  assert.equal(assistent.ontvanger(dossier, 'iemand'), null);

  const client = nepClient({ onderwerp: 'Uw busreis op 2 november (EPV-12)', tekst: 'Beste Sanne,\n\nDe bus kan een kwartier later vertrekken.\n\nMet vriendelijke groet,\nPlanning Pouw Vervoer\n030 68 68 300' });
  const c = await assistent.conceptMail(dossier, { aan: 'aanvrager', vraag: 'De klant vraagt of de bus een kwartier later kan vertrekken; dat kan zonder meerkosten.', client });
  assert.equal(c.email, 'sanne@mariaschool.nl');
  assert.equal(c.aan, 'aanvrager');
  assert.match(c.onderwerp, /EPV-12/);
  assert.match(c.tekst, /^Beste Sanne,/);
  const p = client.gezien[0];
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.match(p.messages[0].content, /Instructie van de planner: De klant vraagt/);
  assert.match(p.messages[0].content, /"ritprijs": "€\s2\.400,00"/);

  await assert.rejects(assistent.conceptMail(dossier, { aan: 'aanvrager', vraag: '', client }), /Schrijf kort/);
  await assert.rejects(assistent.conceptMail(dossier, { aan: 'niemand', vraag: 'test test', client }), /aan wie/);
});

test('zonder ANTHROPIC_API_KEY staat de assistent uit met een duidelijke melding', async (t) => {
  if (!assistent.DEMO) return t.skip('sleutel aanwezig');
  await assert.rejects(assistent.reisUitTekst('Busreis naar Parijs met 50 man', { nu }), /niet ingericht/);
});
