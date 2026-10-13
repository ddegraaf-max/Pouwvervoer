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
      var lat = rij.querySelector('[data-lat]');
      var lon = rij.querySelector('[data-lon]');
      if (lat) lat.name = p + 'via_lat';
      if (lon) lon.name = p + 'via_lon';
    });
    var toevoegen = $('[data-toevoegen]', route);
    var max = Number(toevoegen.querySelector('.btn-stop').getAttribute('data-max')) || 5;
    toevoegen.hidden = rijen.length >= max;
    var lijstFout = toevoegen.querySelector('.fout');
    if (lijstFout) lijstFout.textContent = '';
  }

  function coordVelden(el) {
    var w = el.closest('.invoer') || el.closest('.veld') || el.parentElement;
    return [w && w.querySelector('[data-lat]'), w && w.querySelector('[data-lon]')];
  }
  function zetCoord(el, c) {
    var cv = coordVelden(el);
    if (cv[0]) cv[0].value = c && c[0] != null ? c[0] : '';
    if (cv[1]) cv[1].value = c && c[1] != null ? c[1] : '';
    el.dispatchEvent(new CustomEvent('adres:coord', { bubbles: true }));
  }
  function leesCoord(el) {
    var cv = coordVelden(el);
    return cv[0] && cv[0].value && cv[1] && cv[1].value ? [cv[0].value, cv[1].value] : null;
  }

  function voegToe(route, waarde, wacht, coord) {
    var rij = tpl.content.cloneNode(true).querySelector('[data-stop]');
    if (waarde) rij.querySelector('input').value = waarde;
    if (wacht) rij.querySelector('select').value = String(wacht);
    if (coord) { var cv = coordVelden(rij.querySelector('input')); if (cv[0]) cv[0].value = coord[0]; if (cv[1]) cv[1].value = coord[1]; }
    route.insertBefore(rij, $('[data-toevoegen]', route));
    hernummer(route);
    return rij;
  }

  function leegRoute(route) {
    stops(route).forEach(function (rij) { rij.remove(); });
    $$('input[type=text]', route).forEach(function (i) { i.value = ''; });
    $$('input[data-lat],input[data-lon]', route).forEach(function (i) { i.value = ''; });
    hernummer(route);
    route.dispatchEvent(new CustomEvent('adres:coord', { bubbles: true }));
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
      zetCoord($('#terug_van'), leesCoord($('#naar')));
      $('#terug_naar').value = $('#van').value;
      zetCoord($('#terug_naar'), leesCoord($('#van')));
      stops(heenRoute).reverse().forEach(function (rij) {
        voegToe(terugRoute, rij.querySelector('input').value, rij.querySelector('select').value, leesCoord(rij.querySelector('input')));
      });
      terugRoute.dispatchEvent(new CustomEvent('adres:coord', { bubbles: true }));
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

  // ---- Assistent: intake in één zin (typen of inspreken), vult het formulier ----
  var intake = document.querySelector('[data-intake]');
  if (intake) {
    var invoer = intake.querySelector('#intake-tekst');
    var intakeKnop = intake.querySelector('[data-intake-knop]');
    var intakeStatus = intake.querySelector('[data-intake-status]');
    var intakeResultaat = intake.querySelector('[data-intake-resultaat]');
    var mic = intake.querySelector('[data-mic]');
    var csrf = (form.querySelector('input[name=_csrf]') || {}).value || '';
    var bezig = false;

    function ontsnap(s) {
      return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }
    function zetWaarde(id, waarde) {
      if (waarde == null || waarde === '') return;
      var el = $('#' + id);
      if (el) el.value = waarde;
    }
    function kiesRadio(naam, waarde) {
      if (!waarde) return;
      var el = $('input[name=' + naam + '][value=' + waarde + ']');
      if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    function vulRoute(route, v, p) {
      if (v[p + 'via'] && v[p + 'via'].length) {
        stops(route).forEach(function (rij) { rij.remove(); });
        v[p + 'via'].forEach(function (adres, i) { voegToe(route, adres, v[p + 'wacht'] ? v[p + 'wacht'][i] : 15); });
      }
      if (v[p + 'van']) { zetWaarde(p + 'van', v[p + 'van']); zetCoord($('#' + p + 'van'), null); }
      if (v[p + 'naar']) { zetWaarde(p + 'naar', v[p + 'naar']); zetCoord($('#' + p + 'naar'), null); }
    }
    function pasToe(v) {
      kiesRadio('reistype', v.reistype);
      zetWaarde('personen', v.personen);
      vulRoute(heenRoute, v, '');
      kiesRadio('tijdtype_heen', v.tijdtype_heen);
      zetWaarde('datum_heen', v.datum_heen);
      zetWaarde('tijd_heen', v.tijd_heen);
      if (v.datum_heen) {
        datumTerug.min = v.datum_heen;
        if (!eigenTerugdatum && !v.datum_terug) datumTerug.value = v.datum_heen;
      }
      kiesRadio('tijdtype_terug', v.tijdtype_terug);
      if (v.datum_terug) { datumTerug.value = v.datum_terug; eigenTerugdatum = v.datum_terug !== datumHeen.value; }
      zetWaarde('tijd_terug', v.tijd_terug);
      if (v.andere_route) {
        schakel.checked = true;
        terugRoute.hidden = false;
        vulRoute(terugRoute, v, 'terug_');
      }
    }
    function isLeeg(id) { var el = $('#' + id); return !el || !el.value; }
    function toonResultaat(data) {
      var nog = (data.ontbreekt || []).filter(function (o) { return !o.veld || isLeeg(o.veld); });
      var html = '<strong>' + ontsnap(data.toelichting || 'Het formulier is ingevuld.') + '</strong>';
      html += nog.length ? ' Vul nog aan: ' + nog.map(function (o) { return ontsnap(o.tekst); }).join(', ') + '.' : ' Controleer de gegevens en klik op Verder.';
      intakeResultaat.innerHTML = html;
      intakeResultaat.hidden = false;
      var eerste = nog.length && nog[0].veld ? $('#' + nog[0].veld) : null;
      (eerste || form).scrollIntoView({ block: eerste ? 'center' : 'start', behavior: 'smooth' });
      if (eerste) eerste.focus({ preventScroll: true });
    }
    function vulIn() {
      var t = invoer.value.trim();
      if (bezig) return;
      if (t.length < 5) {
        intakeStatus.textContent = 'Vertel iets meer over uw reis: waarheen, wanneer en met hoeveel personen.';
        invoer.focus();
        return;
      }
      bezig = true;
      intakeKnop.disabled = true;
      intakeResultaat.hidden = true;
      intakeStatus.textContent = 'Even geduld, de assistent leest uw reis…';
      fetch('/reis/assistent', { method: 'POST', body: new URLSearchParams({ _csrf: csrf, tekst: t }), headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.fout) { intakeStatus.textContent = data.fout; return; }
          intakeStatus.textContent = '';
          pasToe(data.v || {});
          toonResultaat(data);
          form.dispatchEvent(new CustomEvent('reis:ingevuld'));
        })
        .catch(function () { intakeStatus.textContent = 'De assistent is even niet bereikbaar. Vul het formulier zelf in.'; })
        .then(function () { bezig = false; intakeKnop.disabled = false; });
    }
    intakeKnop.addEventListener('click', vulIn);
    invoer.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); vulIn(); }
    });

    var Spraak = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Spraak && mic) {
      mic.hidden = false;
      var herkenning = null;
      mic.addEventListener('click', function () {
        if (herkenning) { herkenning.stop(); return; }
        var mislukt = false;
        herkenning = new Spraak();
        herkenning.lang = 'nl-NL';
        herkenning.interimResults = true;
        herkenning.onresult = function (e) {
          var s = '';
          for (var i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
          invoer.value = s;
        };
        herkenning.onerror = function () { mislukt = true; intakeStatus.textContent = 'Inspreken lukte niet. Typ uw reis hierboven.'; };
        herkenning.onend = function () {
          herkenning = null;
          mic.classList.remove('aan');
          mic.setAttribute('aria-pressed', 'false');
          if (mislukt) return;
          if (invoer.value.trim().length >= 5) vulIn(); else intakeStatus.textContent = '';
        };
        intakeStatus.textContent = 'Luisteren… spreek uw reis in.';
        mic.classList.add('aan');
        mic.setAttribute('aria-pressed', 'true');
        herkenning.start();
      });
    }
  }
})();
