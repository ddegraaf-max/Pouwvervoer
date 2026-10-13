// Eigen beleid van Pouw Vervoer bovenop de KNV-voorwaarden, zoals de huidige offertetool het hanteert:
// bedenktijd na het akkoord, kosteloos wijzigen tot kort voor vertrek, betaling na afloop (tenzij aanbetaling),
// voorbehoud voor de bereikbaarheid van locaties, en een geldigheidsdatum op de prijs. Alles instelbaar via .env.
const BEDENKTIJD_UREN = Number(process.env.BEDENKTIJD_UREN || 24);
const WIJZIGEN_TOT_DAGEN = Number(process.env.WIJZIGEN_TOT_DAGEN || 7);
const OFFERTE_GELDIG_DAGEN = Number(process.env.OFFERTE_GELDIG_DAGEN || 14);
const MAIL_PLANNING = process.env.MAIL_PLANNING || 'info@pouwvervoer.nl';

const WIJZIGING_CATEGORIEEN = {
  vertrektijd: 'Vertrektijd',
  datum: 'Datum',
  personen: 'Aantal personen',
  opstapplaats: 'Opstapplaats',
  bestemming: 'Bestemming',
  anders: 'Anders',
};

const PUNTEN = [
  `${BEDENKTIJD_UREN} uur bedenktijd: binnen ${BEDENKTIJD_UREN} uur na uw akkoord annuleert u kosteloos (0% annuleringskosten).`,
  `Tot ${WIJZIGEN_TOT_DAGEN} dagen voor vertrek wijzigt u uw boeking kosteloos.`,
  'Betaling vindt pas plaats na afloop van de reis, tenzij de offerte een aanbetaling vermeldt.',
  'Pouw Vervoer bepaalt of de opgegeven locaties bereikbaar zijn voor een (touring)bus; zo nodig wordt een alternatieve locatie voorgelegd.',
];

const isoDatum = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const amsterdamDatum = (d) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

function bedenktijdTot(akkoordOp) {
  return akkoordOp ? new Date(new Date(akkoordOp).getTime() + BEDENKTIJD_UREN * 3600e3) : null;
}
function binnenBedenktijd(akkoordOp, nu = new Date()) {
  const t = bedenktijdTot(akkoordOp);
  return !!t && nu.getTime() < t.getTime();
}

// Kosteloos wijzigen tot en met de dag vóór de grens: ritdatum min N dagen, in Nederlandse tijd.
function wijzigenTot(ritDatum) {
  return new Date(Date.parse(`${isoDatum(ritDatum)}T00:00:00Z`) - WIJZIGEN_TOT_DAGEN * 864e5);
}
function wijzigenKosteloos(ritDatum, nu = new Date()) {
  return Date.parse(`${amsterdamDatum(nu)}T00:00:00Z`) < wijzigenTot(ritDatum).getTime();
}

function offerteGeldigTot(nu = new Date()) {
  return `${amsterdamDatum(new Date(nu.getTime() + OFFERTE_GELDIG_DAGEN * 864e5))}`;
}
function offerteVerlopen(geldigTot, nu = new Date()) {
  if (!geldigTot) return false;
  return amsterdamDatum(nu) > isoDatum(geldigTot);
}

module.exports = {
  BEDENKTIJD_UREN, WIJZIGEN_TOT_DAGEN, OFFERTE_GELDIG_DAGEN, MAIL_PLANNING, WIJZIGING_CATEGORIEEN, PUNTEN,
  bedenktijdTot, binnenBedenktijd, wijzigenTot, wijzigenKosteloos, offerteGeldigTot, offerteVerlopen,
};
