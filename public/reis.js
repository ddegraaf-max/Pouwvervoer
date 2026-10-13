// Reis-stap: tussenstops toevoegen en verwijderen, terugreis tonen, andere route terug,
// terugdatum meebewegen met de heendatum en controle vóór het versturen.
(function () {
  var form = document.querySelector('form[data-reis]');
  if (!form) return;
  var tpl = document.getElementById('tpl-stop');
  var vandaag = form.getAttribute('data-vandaag') || '';

  function $(sel, root) { return (root || form).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || form).querySelectorAll(sel)); }
  function stops(route) { return $$('[data-stop]', route); }

  // ---- Tussenstops ----
  function hernummer(route) {
    var p = route.getAttribute('data-prefix');
    var rijen = stops(route);
    rijen.forEach(function (rij, i) {
      var input = rij.querySelector('input');
      var select = rij.querySelector('select');
      var fout = rij.querySelector('.fout');
      input.id = p + 'via_' + i;
      input.name = p + 'via';
      rij.querySelector('.invoer label').htmlFor = input.id;
      rij.querySelector('[data-nr]').textContent = i + 1;
      fout.id = input.id + '-fout';
      if (input.getAttribute('aria-describedby')) input.setAttribute('aria-describedby', fout.id);
      select.id = p + 'wacht_' + i;
      select.name = p + 'wacht';
      rij.querySelector('.wacht label').htmlFor = select.id;
      rij.querySelector('.weg').setAttribute('aria-label', 'Tussenstop ' + (i + 1) + ' verwijderen');
    });
    var toevoegen = $('[data-toevoegen]', route);
    var max = Number(toevoegen.querySelector('.btn-stop').getAttribute('data-max')) || 5;
    toevoegen.hidden = rijen.length >= max;
    var lijstFout = toevoegen.querySelector('.fout');
    if (lijstFout) lijstFout.textContent = '';
  }

  function voegToe(route, waarde, wacht) {
    var rij = tpl.content.cloneNode(true).querySelector('[data-stop]');
    if (waarde) rij.querySelector('input').value = waarde;
    if (wacht) rij.querySelector('select').value = String(wacht);
    route.insertBefore(rij, $('[data-toevoegen]', route));
    hernummer(route);
    return rij;
  }

  function leegRoute(route) {
    stops(route).forEach(function (rij) { rij.remove(); });
    $$('input[type=text]', route).forEach(function (i) { i.value = ''; });
    hernummer(route);
  }

  form.addEventListener('click', function (e) {
    var knop = e.target.closest('.btn-stop');
    if (knop) {
      var rij = voegToe(knop.closest('[data-route]'));
      rij.querySelector('input').focus();
      return;
    }
    var weg = e.target.closest('.weg');
    if (weg) {
      var route = weg.closest('[data-route]');
      weg.closest('[data-stop]').remove();
      hernummer(route);
      $('.btn-stop', route).focus();
    }
  });

  // ---- Retour of enkele reis ----
  var terug = $('[data-terug]');
  function retour() {
    var el = $('input[name=reistype]:checked');
    return !el || el.value !== 'enkel';
  }
  $$('input[name=reistype]').forEach(function (r) {
    r.addEventListener('change', function () { terug.hidden = !retour(); });
  });

  // ---- Andere route terug ----
  var schakel = $('#andere_route');
  var heenRoute = $('[data-route=""]');
  var terugRoute = $('[data-route="terug_"]');
  schakel.addEventListener('change', function () {
    terugRoute.hidden = !schakel.checked;
    if (schakel.checked) {
      // Standaard dezelfde route in omgekeerde volgorde, zoals de offertetool doet.
      leegRoute(terugRoute);
      $('#terug_van').value = $('#naar').value;
      $('#terug_naar').value = $('#van').value;
      stops(heenRoute).reverse().forEach(function (rij) {
        voegToe(terugRoute, rij.querySelector('input').value, rij.querySelector('select').value);
      });
      $('#terug_van').focus();
    } else {
      leegRoute(terugRoute);
    }
  });

  var info = $('.info-knop');
  info.addEventListener('click', function () {
    var open = info.getAttribute('aria-expanded') === 'true';
    info.setAttribute('aria-expanded', open ? 'false' : 'true');
    document.getElementById(info.getAttribute('aria-controls')).hidden = open;
  });

  // ---- Terugdatum volgt de heendatum tot de bezoeker zelf een terugdatum kiest ----
  var datumHeen = $('#datum_heen');
  var datumTerug = $('#datum_terug');
  var eigenTerugdatum = !!datumTerug.value && datumTerug.value !== datumHeen.value;
  datumTerug.addEventListener('change', function () { eigenTerugdatum = !!datumTerug.value; });
  datumHeen.addEventListener('change', function () {
    if (!eigenTerugdatum) datumTerug.value = datumHeen.value;
    datumTerug.min = datumHeen.value || vandaag;
  });

  // ---- Controle vóór het versturen ----
  function wisFouten() {
    $$('.fout').forEach(function (p) { p.textContent = ''; });
    $$('[aria-invalid]').forEach(function (el) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    });
    var samenvatting = $('.alert.bad');
    if (samenvatting) samenvatting.remove();
  }

  function zetFout(el, tekst) {
    var p = document.getElementById(el.id + '-fout');
    if (p) p.textContent = tekst;
    el.setAttribute('aria-invalid', 'true');
    if (p) el.setAttribute('aria-describedby', p.id);
  }

  function controleerRoute(route, fouten, richting) {
    var van = $('input[name$="van"]', route);
    var naar = $('input[name$="naar"]', route);
    if (!van.value.trim()) fouten.push([van, 'Vul het vertrekadres' + richting + ' in.']);
    stops(route).forEach(function (rij, i) {
      var input = rij.querySelector('input');
      if (!input.value.trim()) fouten.push([input, 'Vul tussenstop ' + (i + 1) + richting + ' in of verwijder deze.']);
    });
    if (!naar.value.trim()) fouten.push([naar, 'Vul de bestemming' + richting + ' in.']);
  }

  form.addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.hasAttribute('formnovalidate')) return;
    wisFouten();
    var fouten = [];
    var personen = $('#personen');
    var n = Number(personen.value);
    if (!/^\d+$/.test(personen.value.trim()) || n < 1 || n > 15000) fouten.push([personen, 'Vul het aantal personen in.']);

    controleerRoute(heenRoute, fouten, '');

    var tijdHeen = $('#tijd_heen');
    if (!datumHeen.value) fouten.push([datumHeen, 'Kies een datum.']);
    else if (vandaag && datumHeen.value < vandaag) fouten.push([datumHeen, 'De datum ligt in het verleden.']);
    if (!tijdHeen.value) fouten.push([tijdHeen, 'Kies een tijd.']);

    if (retour()) {
      if (schakel.checked) controleerRoute(terugRoute, fouten, ' van de terugreis');
      var tijdTerug = $('#tijd_terug');
      var datumOk = true;
      if (!datumTerug.value) { fouten.push([datumTerug, 'Kies een datum voor de terugreis.']); datumOk = false; }
      else if (datumHeen.value && datumTerug.value < datumHeen.value) { fouten.push([datumTerug, 'De terugreis kan niet vóór de heenreis zijn.']); datumOk = false; }
      if (!tijdTerug.value) fouten.push([tijdTerug, 'Kies een tijd voor de terugreis.']);
      else if (datumOk && datumHeen.value && tijdHeen.value && datumTerug.value === datumHeen.value && tijdTerug.value <= tijdHeen.value) {
        fouten.push([tijdTerug, 'De tijd van de terugreis moet na die van de heenreis liggen.']);
      }
    }

    if (!fouten.length) return;
    e.preventDefault();
    fouten.forEach(function (f) { zetFout(f[0], f[1]); });
    fouten[0][0].focus();
    fouten[0][0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
})();
