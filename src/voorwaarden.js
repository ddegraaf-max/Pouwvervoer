// Algemene Vervoer- en Reisvoorwaarden van KNV Busvervoer: waar ze staan en welke versie geldt.
// Standaard de meegeleverde pdf in public/documenten; met VOORWAARDEN_URL een andere (externe) link.
// Verhoog VOORWAARDEN_VERSIE als KNV nieuwe voorwaarden publiceert; de geaccepteerde versie wordt per aanvraag bewaard.
const NAAM = 'Algemene Vervoer- en Reisvoorwaarden van KNV Busvervoer';
const VERSIE = process.env.VOORWAARDEN_VERSIE || 'KNV Busvervoer 2025';
const URL = process.env.VOORWAARDEN_URL || '/documenten/knv-busvervoer-2025.pdf';

// Volledige link voor in e-mails.
function absoluut(base) {
  return /^https?:\/\//i.test(URL) ? URL : `${String(base || '').replace(/\/$/, '')}${URL}`;
}

module.exports = { NAAM, VERSIE, URL, absoluut };
