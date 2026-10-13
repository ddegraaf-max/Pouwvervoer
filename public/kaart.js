// Adressuggesties en kaart. Twee rollen:
//  - invoervelden met data-adres krijgen suggesties (via /api/adres) en bewaren de coördinaten in verborgen velden;
//  - elke div.kaart toont de route: live op de reis-stap (uit de velden) of vast (uit data-punten) op andere pagina's.
(function () {
  var NAVY = '#263680';
  var GEEL = '#EDAA00';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function duur(s) { var m = Math.round(s / 60); var u = Math.floor(m / 60); m = m % 60; return u ? u + ' uur' + (m ? ' ' + m + ' min' : '') : m + ' min'; }
  function km(m) { return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km'; }

  // ---------- Suggesties ----------
  function wrapper(input) { return input.closest('.inp') || input.parentElement; }
  function coordVelden(input) {
    var w = input.closest('.invoer') || input.closest('.veld') || input.parentElement;
    return { lat: w && w.querySelector('input[data-lat]'), lon: w && w.querySelector('input[data-lon]') };
  }
  function zetCoord(input, lat, lon) {
    var c = coordVelden(input);
    if (c.lat) c.lat.value = lat == null ? '' : lat;
    if (c.lon) c.lon.value = lon == null ? '' : lon;
    input.dispatchEvent(new CustomEvent('adres:coord', { bubbles: true }));
  }
  function heeftCoord(input) { var c = coordVelden(input); return !!(c.lat && c.lat.value && c.lon && c.lon.value); }

  var open = null;
  function sluit() { if (open) { open.lijst.remove(); open.input.removeAttribute('aria-expanded'); open = null; } }
  function toon(input, items) {
    sluit();
    if (!items.length) return;
    var ul = document.createElement('ul');
    ul.className = 'suggesties';
    ul.setAttribute('role', 'listbox');
    items.forEach(function (it, i) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.id = input.id + '-opt-' + i;
      li.innerHTML = '<span class="s-type">' + { adres: 'adres', straat: 'straat', plaats: 'plaats', poi: 'locatie' }[it.type] + '</span>' + ontsnap(it.label);
      li.addEventListener('mousedown', function (e) { e.preventDefault(); kies(input, it); });
      ul.appendChild(li);
    });
    wrapper(input).appendChild(ul);
    input.setAttribute('aria-expanded', 'true');
    open = { input: input, lijst: ul, items: items, actief: -1 };
  }
  function ontsnap(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function kies(input, it) {
    input.value = it.label;
    zetCoord(input, it.lat, it.lon);
    input.setAttribute('data-gekozen', '1');
    sluit();
  }
  function markeer(n) {
    if (!open) return;
    var lis = $$('li', open.lijst);
    open.actief = (n + lis.length) % lis.length;
    lis.forEach(function (li, i) { li.classList.toggle('actief', i === open.actief); });
    input_aria(open.input, lis[open.actief].id);
  }
  function input_aria(input, id) { input.setAttribute('aria-activedescendant', id); }

  var zoekTimers = new WeakMap();
  function zoek(input) {
    var q = input.value.trim();
    if (q.length < 3) { sluit(); return; }
    var mijn = (zoekTimers.get(input) || 0) + 1;
    zoekTimers.set(input, mijn);
    fetch('/api/adres?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (items) { if (zoekTimers.get(input) === mijn && document.activeElement === input) toon(input, items); })
      .catch(function () {});
  }
  var zoekLater = debounce(zoek, 250);

  // Zonder keuze uit de lijst: stilletjes de beste match als coördinaat gebruiken, alleen voor de kaart.
  function stilGeocoderen(input, done) {
    var q = input.value.trim();
    if (q.length < 3 || heeftCoord(input)) { if (done) done(); return; }
    fetch('/api/adres?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (items) { if (items.length && input.value.trim() === q) zetCoord(input, items[0].lat, items[0].lon); })
      .catch(function () {})
      .then(function () { if (done) done(); });
  }

  document.addEventListener('input', function (e) {
    var input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-adres')) return;
    if (input.getAttribute('data-gekozen')) input.removeAttribute('data-gekozen');
    zetCoord(input, null, null);
    zoekLater(input);
  });
  document.addEventListener('keydown', function (e) {
    if (!open || e.target !== open.input) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); markeer(open.actief + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); markeer(open.actief - 1); }
    else if (e.key === 'Enter') { if (open.actief >= 0) { e.preventDefault(); kies(open.input, open.items[open.actief]); } else if (open.items.length) { e.preventDefault(); kies(open.input, open.items[0]); } }
    else if (e.key === 'Escape') { sluit(); }
  });
  document.addEventListener('focusout', function (e) {
    var input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-adres')) return;
    setTimeout(function () { if (open && open.input === input) sluit(); }, 120);
    stilGeocoderen(input);
  });
  $$('input[data-adres]').forEach(function (i) { i.setAttribute('autocomplete', 'off'); i.setAttribute('role', 'combobox'); i.setAttribute('aria-autocomplete', 'list'); });

  // ---------- Kaart ----------
  function meta(naam) { var m = document.querySelector('meta[name="' + naam + '"]'); return m ? m.getAttribute('content') : ''; }
  // MapLibre GL met de wereldwijde, gratis kaartstijl van OpenFreeMap (instelbaar via de meta kaart-stijl).
  var STIJL = meta('kaart-stijl') || 'https://tiles.openfreemap.org/styles/liberty';
  // MapLibre (1 MB) wordt pas geladen als er echt een kaart nodig is; de suggesties werken meteen.
  var maplibrePromise = null;
  function laadMaplibre() {
    if (!maplibrePromise) maplibrePromise = import('/vendor/maplibre/maplibre-gl.mjs').then(function (m) { return m.default || m; });
    return maplibrePromise;
  }
  var PIN = '<svg viewBox="0 0 24 24" width="28" height="34" aria-hidden="true"><path fill="' + NAVY + '" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

  function maakKaart(el) {
    var k = { kaart: null, gl: null, markers: [], klaar: false, wachtrij: [] };
    laadMaplibre().then(function (maplibregl) {
      k.gl = maplibregl;
      var kaart = new maplibregl.Map({
        container: el,
        style: STIJL,
        center: [5.3, 52.1],
        zoom: 6,
        scrollZoom: false,
        attributionControl: { compact: true },
      });
      kaart.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
      k.kaart = kaart;
      kaart.on('load', function () {
        ['heen', 'terug'].forEach(function (naam) {
          kaart.addSource('route-' + naam, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          kaart.addLayer({
            id: 'route-' + naam, type: 'line', source: 'route-' + naam,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: naam === 'heen' ? { 'line-color': NAVY, 'line-width': 5, 'line-opacity': 0.85 } : { 'line-color': GEEL, 'line-width': 4, 'line-opacity': 0.95, 'line-dasharray': [2, 2] },
          });
        });
        k.klaar = true;
        k.wachtrij.splice(0).forEach(function (fn) { fn(); });
      });
    }).catch(function (e) { console.error('Kaart laden mislukt', e); });
    return k;
  }
  function alsKlaar(k, fn) { if (k.klaar) fn(); else k.wachtrij.push(fn); }
  function markerElement(soort) {
    var d = document.createElement('div');
    d.className = 'kaart-marker ' + soort;
    if (soort === 'naar') d.innerHTML = PIN;
    return d;
  }
  function marker(k, p, soort) {
    var m = new k.gl.Marker({ element: markerElement(soort), anchor: soort === 'naar' ? 'bottom' : 'center' }).setLngLat([p.lon, p.lat]);
    if (p.label) m.getElement().title = p.label;
    m.addTo(k.kaart);
    k.markers.push(m);
  }
  function zetLijn(k, naam, coords) {
    var bron = k.kaart.getSource('route-' + naam);
    if (bron) bron.setData({ type: 'FeatureCollection', features: coords.length ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords.map(function (c) { return [c[1], c[0]]; }) } }] : [] });
  }
  function pasBounds(k, latlons) {
    if (!latlons.length) return;
    var b = new k.gl.LngLatBounds([latlons[0][1], latlons[0][0]], [latlons[0][1], latlons[0][0]]);
    latlons.forEach(function (c) { b.extend([c[1], c[0]]); });
    k.kaart.fitBounds(b, { padding: 44, maxZoom: 14, duration: 0 });
  }
  var routeCache = {};
  function haalRoute(punten) {
    var key = punten.map(function (p) { return p.lat + ',' + p.lon; }).join(';');
    if (routeCache[key]) return Promise.resolve(routeCache[key]);
    return fetch('/api/route?p=' + encodeURIComponent(key), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.lijn) routeCache[key] = j; return j; })
      .catch(function () { return null; });
  }
  // Tekent één of twee trajecten en zet de afstanden in het bijschrift.
  function teken(k, heen, terug, info) {
    alsKlaar(k, function () {
      k.markers.splice(0).forEach(function (m) { m.remove(); });
      var alle = heen.concat(terug || []);
      zetLijn(k, 'heen', []);
      zetLijn(k, 'terug', []);
      if (!alle.length) return;
      heen.forEach(function (p, i) { marker(k, p, i === 0 ? 'van' : i === heen.length - 1 ? 'naar' : 'via'); });
      (terug || []).forEach(function (p, i) { if (i > 0 && i < terug.length - 1) marker(k, p, 'via'); });
      pasBounds(k, alle.map(function (p) { return [p.lat, p.lon]; }));
      var teksten = [];
      var lijnen = [];
      function lijn(punten, naam, titel) {
        if (punten.length < 2) return Promise.resolve();
        return haalRoute(punten).then(function (r) {
          var coords = r && r.lijn ? r.lijn : punten.map(function (p) { return [p.lat, p.lon]; });
          zetLijn(k, naam, coords);
          lijnen = lijnen.concat(coords);
          if (r && r.afstand_m) teksten.push(titel + ' ± ' + km(r.afstand_m) + ', ' + duur(r.duur_s));
        });
      }
      lijn(heen, 'heen', 'Heenreis')
        .then(function () { return lijn(terug || [], 'terug', 'Terugreis'); })
        .then(function () {
          if (lijnen.length) pasBounds(k, lijnen);
          if (info) info.textContent = teksten.join(' · ');
        });
    });
  }

  // Vaste kaarten (samenvatting, akkoord, backoffice)
  $$('.kaart[data-punten]').forEach(function (el) {
    try {
      var heen = JSON.parse(el.getAttribute('data-punten') || '[]');
      var terug = JSON.parse(el.getAttribute('data-terug') || '[]');
      if (heen.length < 1) return;
      var k = maakKaart(el);
      var info = el.nextElementSibling && el.nextElementSibling.hasAttribute('data-kaart-info') ? el.nextElementSibling : null;
      teken(k, heen, terug, info);
    } catch (e) {}
  });

  // Live kaart op de reis-stap
  var live = $('.kaart[data-kaart-live]');
  var form = $('form[data-reis]');
  if (live && form) {
    var k = null;
    var info = $('[data-kaart-info]');
    function punten(route) {
      var uit = [];
      $$('input[data-adres]', route).forEach(function (input) {
        var c = coordVelden(input);
        if (c.lat && c.lat.value && c.lon && c.lon.value) uit.push({ lat: Number(c.lat.value), lon: Number(c.lon.value), label: input.value });
      });
      return uit;
    }
    var bijwerken = debounce(function () {
      var heenRoute = $('[data-route=""]', form);
      var terugRoute = $('[data-route="terug_"]', form);
      var heen = punten(heenRoute);
      var andere = $('#andere_route', form);
      var terug = andere && andere.checked && !terugRoute.hidden ? punten(terugRoute) : [];
      if (!heen.length && !terug.length) { live.hidden = true; if (info) info.textContent = ''; return; }
      live.hidden = false;
      if (!k) k = maakKaart(live); else if (k.kaart) k.kaart.resize();
      teken(k, heen, terug, info);
    }, 200);
    form.addEventListener('adres:coord', bijwerken);
    form.addEventListener('change', function (e) { if (e.target.name === 'andere_route' || e.target.name === 'reistype') bijwerken(); });
    // Na de assistent of bij een bewaarde reis: velden zonder coördinaat alsnog opzoeken.
    function geocodeerAlles() {
      var wachtend = $$('input[data-adres]', form).filter(function (i) { return i.value.trim().length >= 3 && !heeftCoord(i); });
      if (!wachtend.length) { bijwerken(); return; }
      var n = wachtend.length;
      wachtend.forEach(function (i) { stilGeocoderen(i, function () { if (--n === 0) bijwerken(); }); });
    }
    form.addEventListener('reis:ingevuld', geocodeerAlles);
    geocodeerAlles();
  }
})();
