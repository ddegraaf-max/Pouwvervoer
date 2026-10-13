// AI-assistent op basis van Claude. Drie taken:
//  - de reis-stap invullen uit één zin van de klant (/reis),
//  - de klantscore in twee zinnen uitleggen voor de planner,
//  - een concept-mail opstellen die de planner aanpast en verstuurt.
// Zonder ANTHROPIC_API_KEY staat de assistent uit (demo-modus); de rest van de app werkt gewoon.
// De assistent noemt nooit zelf prijzen of toezeggingen aan klanten; dat blijft bij de planner.
const Anthropic = require('@anthropic-ai/sdk');
const reis = require('./reis');
const fmt = require('./format');

const DEMO = !process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const BEDRIJF = 'Pouw Vervoer, touringcarbedrijf in Vianen';
const TELEFOON = '030 68 68 300';

class AssistentFout extends Error {}

let standaardClient = null;
function getClient() {
  if (DEMO) throw new AssistentFout('De assistent is niet ingericht: ANTHROPIC_API_KEY ontbreekt.');
  if (!standaardClient) standaardClient = new Anthropic({ timeout: 60000, maxRetries: 2 });
  return standaardClient;
}

function foutTekst(e) {
  if (e instanceof AssistentFout) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY is ongeldig.';
  if (e instanceof Anthropic.RateLimitError) return 'De assistent is even druk. Probeer het zo opnieuw.';
  if (e instanceof Anthropic.APIConnectionError) return 'Geen verbinding met de assistent. Probeer het zo opnieuw.';
  if (e instanceof Anthropic.APIError) return `De assistent gaf een fout (${e.status}). Probeer het later opnieuw.`;
  return 'Er ging iets mis bij de assistent.';
}

// Eén vraag aan Claude. Met een schema komt er JSON terug, anders tekst.
// Weigert het model (veiligheidsfilter), dan probeert de API zelf een ander model ("fallbacks").
async function vraag({ system, tekst, schema = null, effort = 'medium', client = null }) {
  const c = client || getClient();
  let res;
  try {
    res = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
      system,
      messages: [{ role: 'user', content: tekst }],
    });
  } catch (e) {
    throw new AssistentFout(foutTekst(e));
  }
  if (res.stop_reason === 'refusal') throw new AssistentFout('De assistent kon hier niets mee. Vul het formulier zelf in.');
  if (res.stop_reason === 'max_tokens') throw new AssistentFout('Het antwoord van de assistent was te lang. Probeer het korter.');
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new AssistentFout('De assistent gaf een onleesbaar antwoord. Probeer het opnieuw.');
  }
}

// ---------- Intake in één zin ----------

const STOPS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      adres: { type: 'string', description: 'adres of plaats van de tussenstop' },
      wacht_minuten: { type: ['integer', 'null'], description: 'wachttijd in minuten als die genoemd is, anders null' },
    },
    required: ['adres', 'wacht_minuten'],
  },
};

const SCHEMA_REIS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reistype: { type: 'string', enum: ['retour', 'enkel', 'onbekend'] },
    personen: { type: ['integer', 'null'], description: 'totaal aantal reizigers, kinderen en begeleiders opgeteld' },
    van: { type: ['string', 'null'], description: 'vertrekadres of -plaats van de heenreis' },
    via: STOPS,
    naar: { type: ['string', 'null'], description: 'bestemming van de heenreis' },
    datum_heen: { type: ['string', 'null'], description: 'JJJJ-MM-DD' },
    tijd_heen: { type: ['string', 'null'], description: 'UU:MM, 24-uursnotatie' },
    tijdtype_heen: { type: 'string', enum: ['vertrek', 'aankomst'] },
    datum_terug: { type: ['string', 'null'], description: 'JJJJ-MM-DD' },
    tijd_terug: { type: ['string', 'null'], description: 'UU:MM, 24-uursnotatie' },
    tijdtype_terug: { type: 'string', enum: ['vertrek', 'aankomst'] },
    andere_route: { type: 'boolean' },
    terug_van: { type: ['string', 'null'] },
    terug_via: STOPS,
    terug_naar: { type: ['string', 'null'] },
    toelichting: { type: 'string', description: 'één vriendelijke zin in de u-vorm die samenvat wat is begrepen' },
  },
  required: [
    'reistype', 'personen', 'van', 'via', 'naar', 'datum_heen', 'tijd_heen', 'tijdtype_heen',
    'datum_terug', 'tijd_terug', 'tijdtype_terug', 'andere_route', 'terug_van', 'terug_via', 'terug_naar', 'toelichting',
  ],
};

function datumTekst(nu) {
  return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' }).format(nu);
}

function systeemIntake(nu) {
  return `Je bent de intake-assistent van ${BEDRIJF}. Klanten vertellen in gewone taal welke busreis ze willen; jij zet dat om in de velden van het aanvraagformulier.

Vandaag is ${datumTekst(nu)} (${reis.vandaag(nu)}, tijdzone Europe/Amsterdam). Reken relatieve datums ("volgende week vrijdag", "over twee weken", "12 mei") om naar de eerstvolgende datum in de toekomst, als JJJJ-MM-DD. Tijden als UU:MM in 24-uursnotatie: "rond 8 uur 's ochtends" wordt 08:00, "half 6 's middags" wordt 17:30.

Regels:
- Verzin niets. Wat de klant niet noemt, laat je null. Een plaatsnaam zonder straat is prima als vertrekadres of bestemming.
- Tel reizigers op: "48 kinderen en 6 begeleiders" is 54 personen.
- reistype is "retour", tenzij de klant duidelijk alleen een enkele reis wil (alleen heen, alleen brengen, alleen ophalen). Een reis met een terugkomsttijd is retour. Twijfel je, kies "onbekend".
- tijdtype_heen: "vertrek" als de klant zegt hoe laat ze willen vertrekken, "aankomst" als ze zeggen hoe laat ze ergens moeten zijn.
- tijdtype_terug: "aankomst" als de klant zegt hoe laat ze terug of thuis willen zijn, "vertrek" als ze zeggen hoe laat de bus vanaf de bestemming vertrekt.
- Bij een retour zonder genoemde terugdatum is datum_terug gelijk aan datum_heen, tenzij uit de tekst blijkt dat het meerdere dagen zijn.
- via: alleen echte tussenstops onderweg (ophalen op een tweede plek, een bezoek onderweg), met de wachttijd in minuten als die genoemd is.
- andere_route alleen true als de terugreis op een andere plek begint of eindigt, of via andere stops loopt; vul dan terug_van, terug_naar en terug_via in. Anders false en die velden null of leeg.
- toelichting: één vriendelijke zin in de u-vorm (maximaal 25 woorden) die samenvat wat je hebt begrepen, zonder opsomming van wat ontbreekt.`;
}

function tekstOfLeeg(x, max = 200) {
  return typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : '';
}

// Zet het antwoord van het model om in de velden van de reis-stap. Alles wat niet klopt, valt weg.
function normaliseer(j, nu = new Date()) {
  const vd = reis.vandaag(nu);
  const v = {};
  const datum = (x) => {
    const d = tekstOfLeeg(x, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= vd ? d : '';
  };
  const tijd = (x) => {
    const t = tekstOfLeeg(x, 5);
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : '';
  };
  const stops = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((x) => ({ adres: tekstOfLeeg(x && x.adres), wacht: reis.dichtstbij(x && x.wacht_minuten != null ? x.wacht_minuten : 15) }))
      .filter((x) => x.adres)
      .slice(0, reis.MAX_STOPS);
  const route = (p, bron) => {
    if (tekstOfLeeg(bron[`${p}van`])) v[`${p}van`] = tekstOfLeeg(bron[`${p}van`]);
    if (tekstOfLeeg(bron[`${p}naar`])) v[`${p}naar`] = tekstOfLeeg(bron[`${p}naar`]);
    const via = stops(bron[`${p}via`]);
    if (via.length) {
      v[`${p}via`] = via.map((x) => x.adres);
      v[`${p}wacht`] = via.map((x) => x.wacht);
    }
  };

  if (j.reistype === 'retour' || j.reistype === 'enkel') v.reistype = j.reistype;
  if (Number.isInteger(j.personen) && j.personen >= 1 && j.personen <= 15000) v.personen = String(j.personen);
  route('', j);
  if (['vertrek', 'aankomst'].includes(j.tijdtype_heen)) v.tijdtype_heen = j.tijdtype_heen;
  if (datum(j.datum_heen)) v.datum_heen = datum(j.datum_heen);
  if (tijd(j.tijd_heen)) v.tijd_heen = tijd(j.tijd_heen);
  if (v.reistype !== 'enkel') {
    if (['vertrek', 'aankomst'].includes(j.tijdtype_terug)) v.tijdtype_terug = j.tijdtype_terug;
    if (datum(j.datum_terug) && (!v.datum_heen || datum(j.datum_terug) >= v.datum_heen)) v.datum_terug = datum(j.datum_terug);
    if (tijd(j.tijd_terug)) v.tijd_terug = tijd(j.tijd_terug);
    if (j.andere_route === true) {
      v.andere_route = true;
      route('terug_', j);
    }
  }
  return v;
}

// Wat nog ontbreekt voor een complete reis; de browser filtert weg wat de bezoeker al had ingevuld.
function ontbrekend(v) {
  const lijst = [];
  const retour = v.reistype !== 'enkel';
  if (!v.personen) lijst.push({ veld: 'personen', tekst: 'het aantal personen' });
  if (!v.van) lijst.push({ veld: 'van', tekst: 'het vertrekadres' });
  if (!v.naar) lijst.push({ veld: 'naar', tekst: 'de bestemming' });
  if (!v.datum_heen) lijst.push({ veld: 'datum_heen', tekst: 'de datum' });
  if (!v.tijd_heen) lijst.push({ veld: 'tijd_heen', tekst: v.tijdtype_heen === 'aankomst' ? 'de aankomsttijd' : 'de vertrektijd' });
  if (retour) {
    if (!v.datum_terug) lijst.push({ veld: 'datum_terug', tekst: 'de datum van de terugreis' });
    if (!v.tijd_terug) lijst.push({ veld: 'tijd_terug', tekst: v.tijdtype_terug === 'vertrek' ? 'de vertrektijd van de terugreis' : 'hoe laat u terug wilt zijn' });
    if (v.andere_route) {
      if (!v.terug_van) lijst.push({ veld: 'terug_van', tekst: 'het vertrekadres van de terugreis' });
      if (!v.terug_naar) lijst.push({ veld: 'terug_naar', tekst: 'de bestemming van de terugreis' });
    }
  }
  return lijst;
}

async function reisUitTekst(tekst, { nu = new Date(), client = null } = {}) {
  const t = String(tekst || '').trim().slice(0, 1500);
  if (t.length < 5) throw new AssistentFout('Vertel iets meer over uw reis: waarheen, wanneer en met hoeveel personen.');
  const j = await vraag({ system: systeemIntake(nu), tekst: t, schema: SCHEMA_REIS, client });
  const v = normaliseer(j, nu);
  return { v, ontbreekt: ontbrekend(v), toelichting: tekstOfLeeg(j.toelichting, 300) };
}

// ---------- Backoffice: uitleg bij de score ----------

const domein = (e) => (typeof e === 'string' && e.includes('@') ? e.split('@')[1].toLowerCase() : null);

function feitenDossier({ a, k, historie, plan }) {
  return {
    opdrachtgever: {
      naam: k.naam,
      type: fmt.KLANTTYPE[k.type] || k.type,
      kvk: k.kvk,
      kvk_ingeschreven: k.kvk_actief,
      kvk_sinds: k.kvk_opgericht ? fmt.iso(k.kvk_opgericht) : null,
      faillissement: !!k.kvk_faillissement,
      klasse_handmatig: k.klasse_override || null,
      reden_handmatig: k.override_reden || null,
      emaildomein_tekenbevoegde: domein(k.teken_email),
    },
    aanvraag: {
      referentie: `EPV-${a.id}`,
      status: fmt.STATUS[a.status] || a.status,
      rit_datum: fmt.iso(a.rit_datum),
      van: a.van,
      naar: a.naar,
      personen: a.personen,
      ritsoort: a.ritsoort,
      reis: reis.samenvatting(reis.vanAanvraag(a)),
      bus_blijft: !!a.bus_blijft,
      ritprijs_euro: a.ritprijs_cent != null ? a.ritprijs_cent / 100 : null,
      geschatte_nakosten_euro: a.nakosten_schatting_cent ? a.nakosten_schatting_cent / 100 : 0,
      po_nummer_opgegeven: !!a.po_nummer,
      aanvrager: a.aanvrager_naam,
      emaildomein_aanvrager: domein(a.aanvrager_email),
      geblokkeerd: !!a.geblokkeerd,
      blokkade_reden: a.blokkade_reden || null,
    },
    score: { punten: a.score, klasse: a.klasse, factoren: a.score_factoren || [] },
    aanbetaling: plan ? { omschrijving: plan.omschrijving, termijnen: plan.termijnen.map((t) => ({ label: t.label, bedrag_euro: t.bedrag / 100 })) } : null,
    betaalhistorie: historie,
  };
}

async function risicoUitleg(d, { client = null } = {}) {
  const system = `Je bent de assistent van de backoffice van ${BEDRIJF}. Je legt de planner in gewone taal uit waarom een opdrachtgever een bepaalde klantscore heeft en wat dat betekent voor de aanbetaling.

Schrijf precies twee zinnen, samen maximaal 60 woorden, in de u-vorm, zonder aanhef, kopjes of opsomming.
Zin 1: de belangrijkste factoren achter de score (de twee of drie met de meeste invloed, met cijfers waar die er zijn).
Zin 2: wat dat betekent voor de aanbetaling volgens de klasse, en waar de planner op moet letten.
Gebruik alleen de feiten die je krijgt. Verzin geen betaalgedrag, bedragen of regels. Noem de klasse en de score.`;
  const tekst = await vraag({ system, tekst: JSON.stringify(feitenDossier(d), null, 1), client });
  if (!tekst) throw new AssistentFout('De assistent gaf geen uitleg. Probeer het opnieuw.');
  return tekst.slice(0, 700);
}

// ---------- Backoffice: concept-mail ----------

function ontvanger({ a, k }, aan) {
  const lijst = {
    aanvrager: { naam: a.aanvrager_naam, email: a.aanvrager_email, rol: 'de aanvrager, die de rit regelt' },
    opdrachtgever: { naam: k.tekenbevoegde, email: k.teken_email, rol: 'de tekenbevoegde van de opdrachtgever, die de offerte goedkeurt' },
    factuur: { naam: null, email: a.factuur_email, rol: 'de factuurontvanger (administratie)' },
  };
  return lijst[aan] ? { aan, ...lijst[aan] } : null;
}

const SCHEMA_MAIL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    onderwerp: { type: 'string', description: 'korte onderwerpregel, met de referentie' },
    tekst: { type: 'string', description: 'de volledige mailtekst, platte tekst met regeleinden' },
  },
  required: ['onderwerp', 'tekst'],
};

async function conceptMail(d, { aan, vraag: instructie, client = null }) {
  const o = ontvanger(d, aan);
  if (!o) throw new AssistentFout('Kies aan wie de mail moet.');
  const opdracht = String(instructie || '').trim().slice(0, 1500);
  if (opdracht.length < 5) throw new AssistentFout('Schrijf kort wat u wilt laten weten of beantwoorden.');
  const { a, k, plan } = d;
  const feiten = {
    referentie: `EPV-${a.id}`,
    status: fmt.STATUS[a.status] || a.status,
    rit: { datum: fmt.datum(a.rit_datum), vertrektijd: a.vertrek_tijd || null, van: a.van, naar: a.naar, personen: a.personen, ritsoort: a.ritsoort, reis: reis.samenvatting(reis.vanAanvraag(a)), bus_blijft: !!a.bus_blijft, bijzonderheden: a.opmerkingen || null },
    opdrachtgever: k.naam,
    aanvrager: a.aanvrager_naam,
    tekenbevoegde: k.tekenbevoegde,
    ritprijs: a.status !== 'nieuw' && a.ritprijs_cent != null ? fmt.euro(a.ritprijs_cent) : null,
    aanbetaling: a.status !== 'nieuw' && plan ? plan.omschrijving : null,
    offerte_verstuurd_op: a.offerte_verstuurd_op ? fmt.datum(a.offerte_verstuurd_op) : null,
    akkoord_op: a.akkoord_op ? fmt.datum(a.akkoord_op) : null,
  };
  const system = `Je schrijft e-mails namens de planning van ${BEDRIJF} aan klanten. Nederlands, u-vorm, vriendelijk, concreet en kort (maximaal 150 woorden).
Begin met "Beste <voornaam of naam>," of "Beste heer/mevrouw," als de naam ontbreekt. Eindig met:
Met vriendelijke groet,
Planning Pouw Vervoer
${TELEFOON}

Gebruik alleen feiten uit het dossier en de instructie van de planner. Verzin geen prijzen, datums, kortingen of toezeggingen. Vraagt de instructie iets wat niet in het dossier staat, schrijf dan dat de planning het uitzoekt en erop terugkomt. Noem de referentie één keer. De onderwerpregel komt apart; zet die niet in de tekst.`;
  const tekst = `Dossier:\n${JSON.stringify(feiten, null, 1)}\n\nOntvanger: ${o.rol}${o.naam ? `, naam ${o.naam}` : ''}.\n\nInstructie van de planner: ${opdracht}`;
  const j = await vraag({ system, tekst, schema: SCHEMA_MAIL, client });
  const onderwerp = tekstOfLeeg(j.onderwerp, 200);
  const body = tekstOfLeeg(j.tekst, 5000);
  if (!onderwerp || !body) throw new AssistentFout('De assistent gaf geen bruikbaar concept. Probeer het opnieuw.');
  return { aan, email: o.email, onderwerp, tekst: body };
}

module.exports = { DEMO, MODEL, AssistentFout, foutTekst, normaliseer, ontbrekend, reisUitTekst, risicoUitleg, conceptMail, ontvanger, feitenDossier, SCHEMA_REIS };
