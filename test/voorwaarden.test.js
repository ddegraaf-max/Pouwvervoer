const test = require('node:test');
const assert = require('node:assert');
const voorwaarden = require('../src/voorwaarden');

test('link naar de voorwaarden wordt absoluut voor in e-mails', () => {
  assert.equal(voorwaarden.absoluut('https://boekpouwvervoer.nl'), 'https://boekpouwvervoer.nl/documenten/knv-busvervoer-2025.pdf');
  assert.equal(voorwaarden.absoluut('https://boekpouwvervoer.nl/'), 'https://boekpouwvervoer.nl/documenten/knv-busvervoer-2025.pdf');
  assert.equal(voorwaarden.VERSIE, 'KNV Busvervoer 2025');
  assert.match(voorwaarden.NAAM, /KNV Busvervoer/);
});
