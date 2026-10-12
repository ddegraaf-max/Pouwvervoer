// KvK-check. Met KVK_API_KEY wordt het Basisprofiel van de KvK API opgevraagd;
// zonder sleutel draait een demo-simulatie met vaste testnummers.

const DEMO = !process.env.KVK_API_KEY;

function geldigNummer(kvk) {
  return /^\d{8}$/.test(String(kvk || '').trim());
}

function demoLookup(kvk, nu = new Date()) {
  if (kvk.endsWith('9999')) return { gevonden: false, bron: 'demo' };
  if (kvk.endsWith('0001')) {
    const d = new Date(nu);
    d.setMonth(d.getMonth() - 8);
    return { gevonden: true, actief: true, opgericht: d, faillissement: false, naam: null, bron: 'demo' };
  }
  if (kvk.endsWith('0002')) {
    return { gevonden: true, actief: true, opgericht: new Date('2012-03-01'), faillissement: true, naam: null, bron: 'demo' };
  }
  if (kvk.endsWith('0003')) {
    return { gevonden: true, actief: true, opgericht: new Date('2009-05-01'), faillissement: false, naam: null, bron: 'demo' };
  }
  // Overige nummers: actief, oprichtingsdatum onbekend (geen leeftijdspunten).
  return { gevonden: true, actief: true, opgericht: null, faillissement: false, naam: null, bron: 'demo' };
}

function parseKvkDatum(s) {
  if (!s || !/^\d{8}$/.test(s)) return null;
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
}

async function lookup(kvk) {
  kvk = String(kvk || '').trim();
  if (!geldigNummer(kvk)) return { gevonden: false, bron: DEMO ? 'demo' : 'kvk', fout: 'ongeldig nummer' };
  if (DEMO) return demoLookup(kvk);
  try {
    const res = await fetch(`https://api.kvk.nl/api/v1/basisprofielen/${kvk}`, {
      headers: { apikey: process.env.KVK_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return { gevonden: false, bron: 'kvk' };
    if (!res.ok) return { gevonden: false, bron: 'kvk', fout: `KvK API ${res.status}` };
    const data = await res.json();
    return {
      gevonden: true,
      actief: true, // Basisprofiel geeft alleen ingeschreven ondernemingen terug.
      opgericht: parseKvkDatum(data.formeleRegistratiedatum),
      faillissement: false, // Basisprofiel geeft dit niet; aanvullen via insolventieregister indien gewenst.
      naam: data.naam || null,
      bron: 'kvk',
    };
  } catch (e) {
    return { gevonden: false, bron: 'kvk', fout: e.message };
  }
}

module.exports = { lookup, geldigNummer, DEMO, demoLookup };
