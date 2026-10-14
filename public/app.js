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

// Installeerbare app: service worker voor de vaste bestanden en een offline-pagina; knop zodra de browser installeren toestaat.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function () {});
}
var installPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  installPrompt = e;
});
// Pagina /app: toestel herkennen voor de juiste uitleg, en melden als de app al geïnstalleerd is.
(function () {
  var instructies = document.getElementById('instructies');
  if (!instructies) return;
  var ua = navigator.userAgent || '';
  var toestel = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop';
  instructies.querySelectorAll('[data-toestel]').forEach(function (el) { el.classList.toggle('actief', el.getAttribute('data-toestel') === toestel); });
  var staand = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (staand) {
    var m = document.querySelector('[data-al-geinstalleerd]');
    if (m) m.hidden = false;
    document.querySelectorAll('[data-installeer]').forEach(function (b) { b.hidden = true; });
  }
})();
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-installeer]');
  if (!b) return;
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt.userChoice.then(function (keuze) {
      var s = document.querySelector('[data-installeer-status]');
      if (s) s.textContent = keuze && keuze.outcome === 'accepted' ? 'De app wordt geïnstalleerd. U vindt hem op uw beginscherm.' : 'Niet geïnstalleerd. U kunt het later opnieuw proberen.';
    });
    installPrompt = null;
    return;
  }
  var instructies = document.getElementById('instructies');
  if (instructies) {
    instructies.classList.add('toon');
    instructies.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var s = document.querySelector('[data-installeer-status]');
    if (s) s.textContent = 'Uw browser installeert niet vanzelf; volg de stappen hieronder.';
  } else {
    window.location.href = '/app';
  }
});

// Kopieerknop: [data-kopieer="#id"] kopieert de tekst of waarde van dat element.
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-kopieer]');
  if (!b) return;
  var el = document.querySelector(b.getAttribute('data-kopieer'));
  if (!el) return;
  var tekst = el.value || el.textContent;
  var oud = b.textContent;
  function klaar(ok) { b.textContent = ok ? 'Gekopieerd' : 'Kopiëren mislukt'; setTimeout(function () { b.textContent = oud; }, 1500); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(tekst).then(function () { klaar(true); }, function () { if (el.select) el.select(); klaar(false); });
  } else {
    if (el.select) el.select();
    try { klaar(document.execCommand('copy')); } catch (err) { klaar(false); }
  }
});
