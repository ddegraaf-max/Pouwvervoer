# easypouwvervoer

Boekings- en betaalplatform voor Pouw Vervoer. Legt bij elke aanvraag vast wie de aanvrager, de opdrachtgever en de factuurontvanger is, berekent een klantscore en laat die de aanbetaling bepalen. Ritten gaan pas naar de planning (trip) na akkoord van de opdrachtgever en, waar nodig, de aanbetaling.

Stack: Node 20+, Express, EJS, PostgreSQL. Geen buildstap.

## Flow

1. **Aanvraag** (`/`): rit, aanvrager, opdrachtgever (soort, KvK, tekenbevoegde), factuurontvanger (PO-nummer verplicht voor onderwijs en overheid), reisleider.
2. **Backoffice** (`/admin`): ritprijs en geschatte nakosten invullen, score wordt herberekend, offerte versturen.
3. **Akkoord** (`/akkoord/:token`): de tekenbevoegde geeft akkoord en betaalt meteen wat bij akkoord verschuldigd is.
4. **Bevestigd**: rit staat in de export voor trip (`/admin/trip.csv`, puntkomma-gescheiden, UTF-8).
5. **Na de rit**: nakosten invoeren, één eindfactuur met verrekening van wat al betaald is.
6. **Herinneringen** (elk uur, of met de knop in de backoffice): termijnen, signaal aan de planner 48 uur na een herinnering, facturen op dag 0, 3, 10 (cc aanvrager) en 17 (aanmaning, bij particulieren als 14-dagenbrief).

## Klantscore

Start 40 punten. Zie `src/score.js` en de tests in `test/score.test.js`.

| Klasse | Score | Vooraf |
| --- | --- | --- |
| A | 70+ | niets |
| B | 50–69 | 30% uiterlijk 14 dagen voor vertrek |
| C | 30–49 | 50% bij akkoord, rest + geschatte nakosten 7 dagen voor vertrek |
| D | < 30 | 100% + geschatte nakosten bij akkoord |

Geblokkeerd (geen offerte mogelijk): open vervallen factuur bij dezelfde opdrachtgever, of faillissement. De backoffice kan de klasse per opdrachtgever handmatig aanpassen, met verplichte reden.

## Demo-modus

Zonder sleutels draait elk onderdeel apart in demo:

- **KvK** (`KVK_API_KEY` ontbreekt): elk 8-cijferig nummer telt als ingeschreven, oprichtingsdatum onbekend. Testnummers: eindigend op `0001` = 8 maanden oud, `0002` = faillissement, `0003` = opgericht 2009, `9999` = niet gevonden.
- **E-mail** (`RESEND_API_KEY`/`MAIL_FROM` ontbreken): mails worden niet verstuurd maar staan in het logboek van het dossier. De akkoordlink staat in het dossier.
- **Betalen** (`MOLLIE_API_KEY` ontbreekt): de betaalpagina simuleert een geslaagde iDEAL-betaling. Mollie is nog niet aangesloten; dat is de volgende stap.

## Railway

1. Nieuw project → Deploy from GitHub repo → deze repo.
2. Add → Database → PostgreSQL. Zet bij de app `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Variabelen: `ADMIN_PASSWORD`, `SESSION_SECRET`, `NODE_ENV=production`, `BASE_URL`.
4. Settings → Networking → Custom domain `easypouwvervoer.nl` en zet het CNAME-record dat Railway toont bij de domeinregistrar.

De tabellen worden bij de start automatisch aangemaakt.

## Testen

```
npm test                  # scoremodel
node test/e2e.mjs         # volledige flow tegen een draaiende server (ADMIN_PASSWORD=test)
```
