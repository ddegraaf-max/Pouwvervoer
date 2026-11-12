// Wie doet dit? AsyncLocalStorage draagt de ingelogde gebruiker mee door een request, zodat elke regel in het
// logboek (events.gebruiker_id) en elke "door …"-tekst zijn naam krijgt zonder dat elke functie hem hoeft door te geven.
const { AsyncLocalStorage } = require('async_hooks');

const opslag = new AsyncLocalStorage();

function met(gebruiker, fn) {
  return opslag.run({ gebruiker: gebruiker || null }, fn);
}
function gebruiker() {
  const s = opslag.getStore();
  return s && s.gebruiker ? s.gebruiker : null;
}
function gebruikerId() {
  const g = gebruiker();
  return g ? g.id : null;
}
function naam(standaard = 'backoffice') {
  const g = gebruiker();
  return g && g.naam ? g.naam : standaard;
}

module.exports = { met, gebruiker, gebruikerId, naam };
