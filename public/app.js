// Kleine hulp voor het aanvraagformulier: velden tonen/verbergen op basis van keuzes.
(function () {
  var form = document.querySelector('form[data-aanvraag]');
  if (!form) return;

  function toon(sel, aan) {
    form.querySelectorAll(sel).forEach(function (el) {
      el.classList.toggle('verborgen', !aan);
      el.querySelectorAll('input,select,textarea').forEach(function (i) { i.disabled = !aan; });
    });
  }

  function update() {
    var type = (form.querySelector('input[name=klanttype]:checked') || {}).value;
    var particulier = type === 'particulier';
    toon('[data-zakelijk]', !particulier);
    var label = form.querySelector('[data-teken-label]');
    if (label) label.textContent = particulier ? 'Uw naam' : 'Naam van wie mag tekenen';
    var labelMail = form.querySelector('[data-teken-mail-label]');
    if (labelMail) labelMail.textContent = particulier ? 'Uw e-mailadres' : 'E-mailadres van wie mag tekenen';
    var po = form.querySelector('[data-po-hint]');
    if (po) po.textContent = type === 'onderwijs' ? 'Verplicht. Vraag het nummer bij uw administratie.' : 'Alleen als uw organisatie dit gebruikt.';
    var zelfde = form.querySelector('#factuur_zelfde');
    toon('[data-factuur-mail]', !(zelfde && zelfde.checked));
  }

  form.addEventListener('change', update);
  update();
})();

// Printknop op de chauffeursbriefing: de Content-Security-Policy staat geen inline onclick toe.
document.addEventListener('click', function (e) {
  if (e.target.closest('[data-print]')) window.print();
});
