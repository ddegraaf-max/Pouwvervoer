const euro = (cent) =>
  cent == null
    ? '—'
    : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(cent / 100);

const datum = (d) =>
  d ? new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' }).format(new Date(d)) : '—';

const datumTijd = (d) =>
  d
    ? new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(d))
    : '—';

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// "1.234,56" of "1234.56" → centen
function parseEuro(s) {
  if (s == null) return null;
  let t = String(s).trim().replace(/[€\s]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const STATUS = {
  nieuw: 'Nieuw, prijs nog invullen',
  offerte_verstuurd: 'Wacht op akkoord opdrachtgever',
  wacht_op_betaling: 'Akkoord, wacht op aanbetaling',
  bevestigd: 'Bevestigd, in planning',
  gereden: 'Gereden, eindfactuur maken',
  gefactureerd: 'Gefactureerd',
  betaald: 'Betaald',
  geannuleerd: 'Geannuleerd',
};

const KLANTTYPE = {
  onderwijs: 'Onderwijs of overheid',
  bedrijf: 'Bedrijf',
  vereniging: 'Vereniging of stichting',
  particulier: 'Particulier',
};

module.exports = { euro, datum, datumTijd, iso, parseEuro, STATUS, KLANTTYPE };
