// Klantscore en aanbetalingsregels (zie functioneel ontwerp).
// Pure functies: geen database, zodat ze los te testen zijn.

const START = 40;

const KLASSEN = [
  { klasse: 'A', min: 70 },
  { klasse: 'B', min: 50 },
  { klasse: 'C', min: 30 },
  { klasse: 'D', min: -Infinity },
];

const DAG = 24 * 60 * 60 * 1000;

function dagenTussen(van, tot) {
  return Math.floor((startVanDag(tot) - startVanDag(van)) / DAG);
}

function startVanDag(d) {
  const x = new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}

/**
 * Berekent de score.
 * @param {object} input
 *   klanttype: 'onderwijs' | 'bedrijf' | 'vereniging' | 'particulier'
 *   kvk: { actief: bool, opgericht: Date|null, faillissement: bool } | null
 *   emailDomeinKlopt: bool
 *   poNummer: string|null
 *   historie: { betaaldOpTijd, betaaldTeLaat1tot30, ooitTeLaat30Plus, incasso, openVervallen } (aantallen)
 *   ritwaarde: number (incl. btw, euro) | null
 *   vertrek: Date, aanvraag: Date
 * @returns {{ score, klasse, factoren: [{label, bron, punten}], geblokkeerd, blokkadeReden }}
 */
function berekenScore(input, nu = new Date()) {
  const f = [];
  const add = (label, bron, punten) => f.push({ label, bron, punten });
  let geblokkeerd = false;
  let blokkadeReden = null;

  add('Startwaarde', 'Standaard', START);

  const kvk = input.kvk;
  switch (input.klanttype) {
    case 'onderwijs':
      add('Klanttype: onderwijs of overheid', 'Formulier + KvK', 25);
      break;
    case 'bedrijf':
      if (kvk && kvk.actief) add('Bedrijf met actieve KvK-inschrijving', 'KvK', 15);
      break;
    case 'vereniging':
      if (kvk && kvk.actief) add('Vereniging of stichting', 'KvK', 5);
      break;
    default:
      break;
  }

  if (kvk && kvk.opgericht && input.klanttype !== 'particulier') {
    const jaren = (nu - new Date(kvk.opgericht)) / (365.25 * DAG);
    if (jaren > 3) add('Onderneming ouder dan 3 jaar', 'KvK', 10);
    else if (jaren < 1) add('Onderneming jonger dan 1 jaar', 'KvK', -10);
  }

  if (kvk && kvk.faillissement) {
    geblokkeerd = true;
    blokkadeReden = 'Faillissement of surseance in het KvK-register';
  }

  if (input.emailDomeinKlopt) add('E-maildomein hoort bij de organisatie', 'Automatische check', 5);
  if (input.poNummer && String(input.poNummer).trim()) add('PO- of referentienummer opgegeven', 'Formulier', 5);

  const h = input.historie || {};
  if (h.ooitTeLaat30Plus > 0 || h.incasso > 0) {
    add('Ooit meer dan 30 dagen te laat of naar incasso', 'Betaalhistorie', -30);
  } else if (h.betaaldTeLaat1tot30 > 0) {
    add('Eerder 1 tot 30 dagen te laat betaald', 'Betaalhistorie', -10);
  } else if (h.betaaldOpTijd > 0) {
    add('Eerdere facturen steeds binnen termijn betaald', 'Betaalhistorie', 25);
  }
  if (h.openVervallen > 0) {
    geblokkeerd = true;
    blokkadeReden = blokkadeReden || 'Openstaande, vervallen factuur bij deze opdrachtgever';
  }

  if (input.ritwaarde != null && Number(input.ritwaarde) > 5000) {
    add('Ritwaarde boven € 5.000', 'Offerte', -10);
  }

  if (input.vertrek && input.aanvraag && dagenTussen(input.aanvraag, input.vertrek) < 7) {
    add('Vertrek binnen 7 dagen na aanvraag', 'Formulier', -5);
  }

  const score = Math.max(0, Math.min(100, f.reduce((s, x) => s + x.punten, 0)));
  return { score, klasse: klasseVoorScore(score), factoren: f, geblokkeerd, blokkadeReden };
}

function klasseVoorScore(score) {
  return KLASSEN.find((k) => score >= k.min).klasse;
}

/**
 * Aanbetalingsplan per klasse.
 * Bedragen in centen om afrondingsfouten te vermijden.
 */
function aanbetalingsplan(klasse, ritprijsCent, vertrek, nakostenSchattingCent = 0, vandaag = new Date()) {
  const v = new Date(vertrek);
  // Een uiterste datum die al voorbij is (late boeking) wordt "bij akkoord".
  const dagenVoor = (n) => {
    const d = new Date(startVanDag(v) - n * DAG);
    return d.getTime() < startVanDag(vandaag) ? null : d;
  };
  switch (klasse) {
    case 'A':
      return { termijnen: [], omschrijving: 'Geen aanbetaling. Eindfactuur na de rit, 14 dagen.' };
    case 'B': {
      const aanbet = Math.round(ritprijsCent * 0.3);
      return {
        termijnen: [{ soort: 'aanbetaling', bedrag: aanbet, uiterlijk: dagenVoor(14), label: 'Aanbetaling 30%' }],
        omschrijving: '30% uiterlijk 14 dagen voor vertrek. Rest en nakosten op de eindfactuur.',
      };
    }
    case 'C': {
      const totaal = ritprijsCent + nakostenSchattingCent;
      const eerste = Math.round(ritprijsCent * 0.5);
      return {
        termijnen: [
          { soort: 'aanbetaling', bedrag: eerste, uiterlijk: null, label: 'Aanbetaling 50% bij akkoord' },
          { soort: 'restant', bedrag: totaal - eerste, uiterlijk: dagenVoor(7), label: 'Restant incl. geschatte nakosten' },
        ],
        omschrijving: '50% bij akkoord, rest (incl. geschatte nakosten) uiterlijk 7 dagen voor vertrek.',
      };
    }
    default:
      return {
        termijnen: [
          { soort: 'aanbetaling', bedrag: ritprijsCent + nakostenSchattingCent, uiterlijk: null, label: 'Volledige betaling bij akkoord' },
        ],
        omschrijving: '100% plus geschatte nakosten bij akkoord.',
      };
  }
}

module.exports = { berekenScore, klasseVoorScore, aanbetalingsplan, dagenTussen, START };
