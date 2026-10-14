// Ritpagina voor de chauffeur: checklist meteen opslaan, foto's op de telefoon verkleinen en het rapport versturen.
(function () {
  var main = document.querySelector('[data-rit]');
  if (!main) return;
  var token = main.getAttribute('data-token');
  var SOORTEN = JSON.parse(main.getAttribute('data-soorten') || '{}');
  var MAX = Number(main.getAttribute('data-max-fotos')) || 4;
  var csrf = (document.querySelector('input[name=_csrf]') || {}).value || '';

  function post(pad, body) {
    return fetch('/rit/' + token + pad, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(Object.assign({ _csrf: csrf }, body)),
    });
  }
  function tijd() { return new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }); }

  // ---- Checklist: elk vinkje direct opslaan ----
  var check = document.getElementById('checklist-form');
  if (check) {
    var checkStatus = check.querySelector('[data-status]');
    check.querySelector('[type=submit]').hidden = true;
    check.addEventListener('change', function () {
      var items = Array.prototype.map.call(check.querySelectorAll('input[name=items]:checked'), function (i) { return i.value; });
      checkStatus.textContent = 'Opslaan…';
      post('/checklist', { items: items }).then(function (r) {
        checkStatus.textContent = r.ok ? 'Opgeslagen ' + tijd() : 'Opslaan mislukt. Ververs de pagina en probeer het opnieuw.';
      }).catch(function () {
        checkStatus.textContent = 'Geen verbinding. Probeer het straks opnieuw.';
      });
    });
  }

  // ---- Rapport: soort bepaalt de velden, foto's worden verkleind en als data-url meegestuurd ----
  var form = document.getElementById('rapport-form');
  if (!form) return;
  var soort = form.querySelector('[name=soort]');
  var bedragVeld = form.querySelector('[data-bedrag]');
  var hint = form.querySelector('[data-hint]');
  var fotos = form.querySelector('[name=fotos]');
  var fotoInfo = form.querySelector('[data-foto-info]');
  var status = form.querySelector('[data-status]');
  var knop = form.querySelector('[type=submit]');

  function toonSoort() {
    var s = SOORTEN[soort.value] || {};
    bedragVeld.hidden = !s.bedrag;
    hint.textContent = s.hint || '';
  }
  soort.addEventListener('change', toonSoort);
  toonSoort();

  fotos.addEventListener('change', function () {
    var n = fotos.files ? fotos.files.length : 0;
    fotoInfo.textContent = !n ? 'Tik om de camera te openen of foto\'s te kiezen.' : n + (n === 1 ? ' foto gekozen' : ' foto\'s gekozen') + (n > MAX ? ', de eerste ' + MAX + ' gaan mee' : '') + '.';
  });

  // Verkleinen tot maximaal 1400 pixels en opslaan als jpeg: scherp genoeg als bewijs, klein genoeg voor mobiel internet.
  function verklein(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var max = 1400;
          var schaal = Math.min(1, max / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * schaal));
          c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * schaal));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.8));
        } catch (e) { resolve(null); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    knop.disabled = true;
    var files = Array.prototype.slice.call(fotos.files || []).slice(0, MAX);
    status.textContent = files.length ? 'Foto\'s verkleinen…' : 'Versturen…';
    Promise.all(files.map(verklein)).then(function (lijst) {
      status.textContent = 'Versturen…';
      return post('/melding', {
        soort: soort.value,
        omschrijving: form.omschrijving.value,
        locatie: form.locatie.value,
        bedrag: bedragVeld.hidden ? '' : form.bedrag.value,
        fotos: lijst.filter(Boolean),
      });
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, fouten: ['Sessie verlopen. Ververs de pagina en probeer het opnieuw.'] }; }).then(function (j) {
        if (!r.ok || !j.ok) throw new Error((j.fouten || ['Versturen mislukt.']).join(' '));
        window.location.href = '/rit/' + token + '#rapport';
        window.location.reload();
      });
    }).catch(function (err) {
      status.textContent = (err && err.message) || 'Versturen mislukt.';
      knop.disabled = false;
    });
  });
})();
