const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL ontbreekt. Voeg in Railway een Postgres-database toe aan dit project.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
});

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS klanten (
  id SERIAL PRIMARY KEY,
  sleutel TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  naam TEXT NOT NULL,
  kvk TEXT,
  kvk_actief BOOLEAN,
  kvk_opgericht DATE,
  kvk_faillissement BOOLEAN DEFAULT FALSE,
  kvk_bron TEXT,
  tekenbevoegde TEXT,
  teken_email TEXT,
  klasse_override TEXT,
  override_reden TEXT,
  override_op TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aanvragen (
  id SERIAL PRIMARY KEY,
  klant_id INT NOT NULL REFERENCES klanten(id),
  status TEXT NOT NULL DEFAULT 'nieuw',
  aanvrager_naam TEXT NOT NULL,
  aanvrager_tel TEXT NOT NULL,
  aanvrager_email TEXT NOT NULL,
  aanvrager_rol TEXT,
  factuur_email TEXT NOT NULL,
  factuur_adres TEXT,
  po_nummer TEXT,
  reisleider_naam TEXT,
  reisleider_tel TEXT,
  rit_datum DATE NOT NULL,
  vertrek_tijd TEXT,
  van TEXT NOT NULL,
  naar TEXT NOT NULL,
  personen INT NOT NULL,
  ritsoort TEXT NOT NULL,
  opmerkingen TEXT,
  ritprijs_cent INT,
  nakosten_schatting_cent INT DEFAULT 0,
  score INT,
  klasse TEXT,
  score_factoren JSONB,
  geblokkeerd BOOLEAN DEFAULT FALSE,
  blokkade_reden TEXT,
  akkoord_token TEXT UNIQUE NOT NULL,
  offerte_verstuurd_op TIMESTAMPTZ,
  akkoord_naam TEXT,
  akkoord_op TIMESTAMPTZ,
  akkoord_ip TEXT,
  signaal_planner BOOLEAN DEFAULT FALSE,
  trip_export_op TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS termijnen (
  id SERIAL PRIMARY KEY,
  aanvraag_id INT NOT NULL REFERENCES aanvragen(id) ON DELETE CASCADE,
  soort TEXT NOT NULL,
  label TEXT NOT NULL,
  bedrag_cent INT NOT NULL,
  uiterlijk DATE,
  token TEXT UNIQUE NOT NULL,
  betaald_op TIMESTAMPTZ,
  betaalwijze TEXT,
  herinnering_op TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS nakosten (
  id SERIAL PRIMARY KEY,
  aanvraag_id INT NOT NULL REFERENCES aanvragen(id) ON DELETE CASCADE,
  omschrijving TEXT NOT NULL,
  bedrag_cent INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facturen (
  id SERIAL PRIMARY KEY,
  aanvraag_id INT UNIQUE NOT NULL REFERENCES aanvragen(id),
  klant_id INT NOT NULL REFERENCES klanten(id),
  nummer TEXT UNIQUE NOT NULL,
  totaal_cent INT NOT NULL,
  reeds_betaald_cent INT NOT NULL,
  te_betalen_cent INT NOT NULL,
  factuurdatum DATE NOT NULL,
  vervaldatum DATE NOT NULL,
  betaald_op DATE,
  herinnering_niveau INT DEFAULT 0,
  incasso BOOLEAN DEFAULT FALSE,
  token TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  aanvraag_id INT REFERENCES aanvragen(id) ON DELETE CASCADE,
  klant_id INT REFERENCES klanten(id),
  type TEXT NOT NULL,
  tekst TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE facturen ADD COLUMN IF NOT EXISTS laatste_herinnering_op TIMESTAMPTZ;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS assistent_risico TEXT;
-- Complete reis: terugreis, tijdtype per richting, tussenstops, andere route terug, bus blijft bij de groep
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS reistype TEXT;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS tijdtype_heen TEXT;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS via JSONB;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS datum_terug DATE;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS tijd_terug TEXT;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS tijdtype_terug TEXT;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS andere_route BOOLEAN DEFAULT FALSE;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS terug_van TEXT;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS terug_naar TEXT;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS terug_via JSONB;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS bus_blijft BOOLEAN DEFAULT FALSE;
-- Voorwaarden: welke versie ter hand is gesteld en wanneer die is geaccepteerd (aanvraag en akkoord)
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS voorwaarden_versie TEXT;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS voorwaarden_akkoord_op TIMESTAMPTZ;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS voorwaarden_ip TEXT;
ALTER TABLE aanvragen ADD COLUMN IF NOT EXISTS akkoord_voorwaarden_versie TEXT;

-- Incassodossiers bij de deurwaarder
CREATE TABLE IF NOT EXISTS dossiers (
  id SERIAL PRIMARY KEY,
  factuur_id INT UNIQUE NOT NULL REFERENCES facturen(id),
  aanvraag_id INT NOT NULL REFERENCES aanvragen(id),
  klant_id INT NOT NULL REFERENCES klanten(id),
  status TEXT NOT NULL DEFAULT 'nieuw',
  hoofdsom_cent INT NOT NULL,
  incassokosten_cent INT NOT NULL,
  ontvangen_cent INT NOT NULL DEFAULT 0,
  overgedragen_op TIMESTAMPTZ DEFAULT now(),
  geopend_op TIMESTAMPTZ,
  gesloten_op TIMESTAMPTZ,
  referentie_deurwaarder TEXT
);

CREATE TABLE IF NOT EXISTS dossier_berichten (
  id SERIAL PRIMARY KEY,
  dossier_id INT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  van TEXT NOT NULL,
  tekst TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dossier_betalingen (
  id SERIAL PRIMARY KEY,
  dossier_id INT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  bedrag_cent INT NOT NULL,
  datum DATE NOT NULL,
  omschrijving TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aanvragen_klant ON aanvragen(klant_id);
CREATE INDEX IF NOT EXISTS idx_facturen_klant ON facturen(klant_id);
CREATE INDEX IF NOT EXISTS idx_events_aanvraag ON events(aanvraag_id);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { pool, q, one, all, tx, migrate };
