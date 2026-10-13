# boekpouwvervoer

Boekings- en betaalplatform voor Pouw Vervoer. Legt bij elke aanvraag vast wie de aanvrager, de opdrachtgever en de factuurontvanger is, berekent een klantscore en laat die de aanbetaling bepalen. Ritten gaan pas naar de planning (trip) na akkoord van de opdrachtgever en, waar nodig, de aanbetaling.

Stack: Node 20+, Express, EJS, PostgreSQL. Geen buildstap.

## Flow

0. **Reis** (`/reis`): dezelfde opbouw als de offertetool op aanvragen.pouwvervoer.nl, in de huisstijl van deze app: retour of enkele reis, aantal personen, route met maximaal 5 tussenstops en wachttijd, datum en tijd (vertrek of aankomst) per richting, eventueel een andere route terug. Wordt in de sessie bewaard en vult stap 1 van de aanvraag; de details staan in Bijzonderheden.
1. **Aanvraag** (`/`): rit, aanvrager, opdrachtgever (soort, KvK, tekenbevoegde), factuurontvanger (PO-nummer verplicht voor onderwijs en overheid), reisleider.
2. **Backoffice** (`/admin`): ritprijs en geschatte nakosten invullen, score wordt herberekend, offerte versturen.
3. **Akkoord** (`/akkoord/:token`): de tekenbevoegde geeft akkoord en betaalt meteen wat bij akkoord verschuldigd is.
4. **Bevestigd**: rit staat in de export voor trip (`/admin/trip.csv`, puntkomma-gescheiden, UTF-8).
5. **Na de rit**: nakosten invoeren, één eindfactuur met verrekening van wat al betaald is.
6. **Herinneringen** (elk uur, of met de knop in de backoffice): termijnen, signaal aan de planner 48 uur na een herinnering, facturen op dag 0, 3, 10 (cc aanvrager) en 17 (aanmaning, bij particulieren als 14-dagenbrief).

## AI-assistent

Met `ANTHROPIC_API_KEY` (Claude, model instelbaar met `ANTHROPIC_MODEL`, standaard `claude-opus-5-5`) helpt een assistent op drie plekken. Zonder sleutel staat hij uit: de intake-kaart verdwijnt en de backoffice toont een melding.

- **Intake in één zin** (`/reis`): de klant typt of spreekt in wat hij wil ("schoolreis naar de Efteling op 12 mei met 48 kinderen en 6 begeleiders, om 17:00 terug"). De assistent vult ritsoort, personen, route, tussenstops, datums en tijden in; de bestaande validatie in `src/reis.js` controleert. Wat ontbreekt, staat erbij. Inspreken werkt in browsers met spraakherkenning (Chrome, Edge, Safari).
- **Uitleg bij de score** (backoffice): twee zinnen over de belangrijkste factoren en wat dat betekent voor de aanbetaling. Wordt bij het dossier bewaard.
- **Mail opstellen** (backoffice): de planner schrijft in één regel wat hij wil laten weten; de assistent maakt een concept op basis van het dossier. De planner past aan en verstuurt; de mail komt in het logboek.

De assistent noemt nooit zelf prijzen of toezeggingen aan klanten en verzint geen feiten die niet in het dossier staan. Weigert het model een vraag, dan probeert de API automatisch een ander model. Persoonsgegevens gaan naar Anthropic: regel een verwerkersovereenkomst voordat dit live gaat.

## Incasso via Armaere

Blijft een factuur onbetaald, dan draagt de backoffice hem over aan gerechtsdeurwaarder Armaere (naam instelbaar met `DEURWAARDER_NAAM`).

- Overdragen kan pas na de aanmaning. Bij particulieren daarnaast pas 15 dagen na de 14-dagenbrief.
- Het dossier rekent de wettelijke incassokosten uit volgens de staffel (15/10/5/1/0,5%, minimaal € 40, maximaal € 6.775).
- Armaere logt in op `/deurwaarder` met `DEURWAARDER_PASSWORD` en ziet alleen overgedragen dossiers, met het volledige bewijs: wie akkoord gaf en wanneer, de factuur met nakosten en verrekening, en alle e-mails aan de debiteur.
- Armaere zet de status, registreert ontvangsten en stuurt berichten; Pouw ziet dat direct in het dossier en kan terugschrijven of het dossier terugtrekken. Is de hoofdsom ontvangen, dan staat de factuur op betaald.
- Een incassoverleden telt mee in de klantscore (−30 punten).

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
- **AI-assistent** (`ANTHROPIC_API_KEY` ontbreekt): staat uit; zie hierboven.

## Railway

1. Nieuw project → Deploy from GitHub repo → deze repo.
2. Add → Database → PostgreSQL. Zet bij de app `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Variabelen: `ADMIN_PASSWORD`, `DEURWAARDER_PASSWORD`, `SESSION_SECRET`, `NODE_ENV=production`, `BASE_URL`.
4. Settings → Networking → Custom domain `boekpouwvervoer.nl` en zet het CNAME-record dat Railway toont bij de domeinregistrar.

De tabellen worden bij de start automatisch aangemaakt.

## Testen

```
npm test                  # scoremodel, incasso, reis-stap en assistent (zonder API-aanroepen)
node scripts/e2e.mjs           # volledige flow tegen een draaiende server (ADMIN_PASSWORD=test)
node scripts/e2e-incasso.mjs   # daarna: overdracht en portaal (DEURWAARDER_PASSWORD=dw, DATABASE_URL)
```
