# Wijzigingen

Elke update krijgt een versienummer (zie README, kopje Versies). Nieuwste bovenaan. De git-tag `vX.Y.Z` staat op de commit van die versie.

## 0.14.3 · 14 oktober 2026
- Beschrijving voor Pouw als pdf (`docs/Zo werkt boekpouwvervoer.pdf`, 17 pagina's): wat er is gebouwd en hoe het werkt, van aanvraag tot betaalde rit, met de backoffice, klantscore, herinneringen en meldingen, incasso, voorwaarden en beleid, techniek en de openstaande keuzes. Bron in `docs/handleiding/`.

## 0.14.2 · 14 oktober 2026
- README: domein is live. Stap 1 beschrijft nu wat er in de praktijk gebeurde: het nameserverpaar is per Cloudflare-zone verschillend en moet exact bij Mijndomein staan, de .nl-registry publiceert met vertraging, en de door Cloudflare overgenomen parkeerrecords moeten weg om een 522 te voorkomen.

## 0.14.1 · 14 oktober 2026
- README: stappenplan voor het domein bijgewerkt nu boekpouwvervoer.nl is geregistreerd met Cloudflare als DNS: wachten op de delegatie, in Railway zowel het CNAME- als het TXT-record zetten (zonder TXT blijft het 404), kaal domein als CNAME in Cloudflare, www naar het kale domein, proxy aan met SSL-modus Full (niet Flexible of Full strict) en Universal SSL aan.

## 0.14.0 · 13 oktober 2026
- Het busje op de kopjes Heenreis en Terugreis is nu een voortgangsmeter: het rijdt precies zover als de velden van dat reisdeel goed zijn ingevuld (adressen, tussenstops, datum en tijd) en staat bij 100% bij de bestemming, die dan groen kleurt. Bij de terugreis staat het huisje links en komt de bus thuis aan; zonder "andere route terug" tellen de adressen van de heenreis mee. Rookwolkjes alleen terwijl de bus rijdt; de muisaanwijzer boven het weggetje toont "3 van 5 velden ingevuld (60%)".

## 0.13.1 · 13 oktober 2026
- Hotfix: de agenda en de tijdkiezer openen weer, met één klik ergens in het veld (het kiezericoontje van de browser is weer zichtbaar). Een datum in het verleden, of een terugreis vóór de heenreis, geeft direct een melding in plaats van pas bij het versturen; de agenda biedt alleen vandaag en later aan.

## 0.13.0 · 13 oktober 2026
- Pagina `/app`: het app-icoon, een grote knop "Installeer de app", uitleg per toestel (iPhone, Android, computer, het eigen toestel vooraan) en een QR-code om de app te delen. Op elke pagina onderin de link "App op uw telefoon"; op de reis-stap en de bedanktpagina een tip met het icoon.

## 0.12.1 · 13 oktober 2026
- Hotfix: de doorverwijzing naar `BASE_URL` werkt pas als dat adres aantoonbaar deze app serveert (gecontroleerd via `/health`, elke vijf minuten) en is tijdelijk (302). Een verkeerde of nog niet werkende `BASE_URL` maakt de site niet meer onbereikbaar.

## 0.12.0 · 13 oktober 2026
- Installeerbare app: manifest, app-iconen, service worker met offline-pagina en de knop "App installeren op uw telefoon". De app start op de reis-stap. Basis voor een latere Google Play- en App Store-versie.

## 0.11.1 · 13 oktober 2026
- Klaar voor het eigen domein: staat `BASE_URL`, dan gaat verkeer op elk ander adres (railway.app, www) met een 301 naar dat adres; `/health` toont het ingestelde adres. Stappenplan voor het activeren van boekpouwvervoer.nl in de README.

## 0.11.0 · 13 oktober 2026
- Chauffeursbriefing per rit in de backoffice: printbare pagina met tijden, route en tussenstops, kaart, contactpersoon tijdens de rit, afspraken, bijzonderheden en een checklist.

## 0.10.0 · 13 oktober 2026
- Incassokosten en rente volgens de KNV-voorwaarden: zakelijke opdrachtgevers 15% van de hoofdsom met een minimum van € 150 (artikel 4.7b) en 1,5% rente per begonnen maand (artikel 4.6); particulieren de wettelijke staffel en wettelijke rente. De aanmaning en de 14-dagenbrief noemen het bedrag. Het dossier voor Armaere bevat kosten, rente en de grondslag.

## 0.9.1 · 13 oktober 2026
- Kopjes Heenreis en Terugreis op de reis-stap: een weggetje met gele markering waarover een busje met rookwolkjes rijdt, naar een bestemmingsspeld (heen) of gespiegeld terug naar een huisje (terug). Bij "verminderde beweging" staat het busje stil.

## 0.9.0 · 13 oktober 2026
- Backoffice volgens de input van Pouw (Bas): afspraken van sales vastleggen en meesturen (offerte, bevestiging, export voor trip, akkoordpagina); meldingen per dossier met soort, eigenaar en deadline (afspraak, planning, uitvoering, klacht, creditnota, Trip, betaling); herinneringen en overdracht aan Armaere staan stil zolang een melding open staat; creditnota op de factuur met e-mail aan de klant; klant dient zelf een klacht in via de akkoordpagina; werklijst bovenaan `/admin` met alles wat open staat en een telling per eigenaar.

## 0.8.2 · 13 oktober 2026
- Adressuggesties sneller: Nederlandse adressen van PDOK komen direct, op Photon (bestemmingen en buitenland) wordt hooguit een halve seconde gewacht als PDOK al genoeg heeft.
- Zoekindicator: zolang er gezocht wordt, rijdt er een busje met rookwolkjes in het adresveld.

## 0.8.1 · 13 oktober 2026
- Kaart dekt nu heel Europa en de wereld: MapLibre GL met de gratis kaartstijl van OpenFreeMap in plaats van Leaflet met PDOK (alleen Nederland). Instelbaar met `KAART_STIJL_URL`.

## 0.8.0 · 13 oktober 2026
- Beleid van Pouw overgenomen van de huidige offertetool: 24 uur bedenktijd met 0% annuleringskosten, tot 7 dagen voor vertrek kosteloos wijzigen, betaling na afloop tenzij aanbetaling, en het voorbehoud dat Pouw de bereikbaarheid van locaties bepaalt. Staat op de aanvraagpagina, de akkoordpagina, in alle mails en op `/voorwaarden`; alles instelbaar in `.env`.
- Klant annuleert zelf binnen de bedenktijd op de akkoordpagina (kosteloos, met bevestiging per e-mail) en geeft wijzigingen door; de planning krijgt een e-mail en het dossier een badge tot de wijziging is afgehandeld.
- Prijs geldig t/m: offertes hebben een geldigheidsdatum (standaard 14 dagen); verlopen offertes kunnen niet meer worden geaccordeerd. Opnieuw versturen verlengt.
- Backoffice: annuleren binnen de bedenktijd rekent automatisch 0%.

## 0.7.1 · 13 oktober 2026
- Kaarttegels komen van de BRT Achtergrondkaart van het Kadaster (PDOK) in plaats van OpenStreetMap, dat vanaf sommige netwerken "Access blocked" toonde. De tegelbron is instelbaar met `KAART_TEGELS_URL` en `KAART_ATTRIBUTIE`.

## 0.7.0 · 13 oktober 2026
- Adressuggesties in alle adresvelden van de reis-stap (PDOK voor Nederlandse adressen, Photon voor bestemmingen en buitenland), met plaats en postcode; de plaats hoort er nu altijd bij.
- Kaart op de reis-stap die meegroeit met wat de klant invult: vertrek, tussenstops, bestemming en de route over de weg, met afstand en reistijd (OSRM, Leaflet, OpenStreetMap). Andere route terug in een tweede kleur.
- Kaart en afstand ook op de gegevenspagina, de bedanktpagina, de akkoordpagina en in de backoffice; afstand en reistijd in de export voor trip en in de database.
- Alle aanroepen naar de kaartdiensten lopen via de eigen server, met cache.

## 0.6.0 · 13 oktober 2026
- Voorwaarden echt ter hand gesteld: de pdf gaat als bijlage mee met de bevestigingsmail van de aanvraag, de offertemail en de nieuwe bevestiging na het akkoord; de SHA-256 van de pdf wordt per aanvraag bewaard.
- Bevestiging van de bestelling na het akkoord, per e-mail aan de tekenbevoegde met de aanvrager in cc: reis, prijs, betaling, annuleringsregeling, vervoerder, klachtenregeling en de voorwaarden als pdf.
- Akkoordpagina als bestelmoment voor consumenten: annuleringsstaffel met bedragen, geen wettelijke bedenktijd, meerkosten, gegevens van de vervoerder (`BEDRIJF_KVK`, `BEDRIJF_BTW`), klachtenregeling, en een knop "Akkoord: bestelling met betalingsverplichting".
- Aanvraagpagina en `/voorwaarden` tonen de kernpunten uit de voorwaarden (annuleren, aanbetaling, hoofdelijke aansprakelijkheid, meerkosten, weer en overmacht, klachten).
- Annuleren in de backoffice volgens artikel 5.1: kosten per kalenderdag vóór vertrek (30% min. € 125, 40%, 50%, 75%, 100%), annuleringsfactuur met verrekening van aanbetalingen, schriftelijke bevestiging per e-mail, vastgelegd in dossier en portaal. Een betaling op een annuleringsfactuur zet de aanvraag niet meer op "betaald".
- E-mails ondersteunen bijlagen en cc.

## 0.5.0 · 13 oktober 2026
- Voorwaarden: de Algemene Vervoer- en Reisvoorwaarden van KNV Busvervoer (pdf) staan in de app op `/voorwaarden` en in de voet. De aanvrager accepteert ze verplicht bij de aanvraag (stap 2) en de tekenbevoegde bij het akkoord, telkens met link. Versie, tijdstip en IP worden bewaard en staan in het logboek, het dossier en het portaal van Armaere, zodat Pouw er aanspraak op kan maken. De bevestigings- en offertemail bevatten de link.

## 0.4.0 · 13 oktober 2026
- Boekingsvelden compleet: terugdatum en -tijd, vertrek of aankomst per richting, tussenstops met wachttijd, andere route terug en "bus blijft bij de groep" worden apart opgeslagen (nieuwe kolommen in `aanvragen`). Ze staan in de backoffice, op de akkoordpagina, in de mails, bij de assistent en in de export voor trip.
- Stap 2 (`/`) vraagt de rit niet meer opnieuw, maar toont de samengestelde reis met een link om te wijzigen. Zonder reis stuurt `/` door naar `/reis`; de knop "Prijs aanvragen" wijst direct naar `/reis`.
- Ritsoort wordt afgeleid: enkele reis, retour op dezelfde dag of meerdaags (aantal dagen).

## 0.3.0 · 13 oktober 2026
- AI-assistent op basis van Claude: intake in één zin op `/reis` (typen of inspreken, het formulier vult zich), uitleg bij de klantscore in twee zinnen en concept-mails in de backoffice. Werkt met `ANTHROPIC_API_KEY`; zonder sleutel staat hij uit.
- Nieuwe kolom `assistent_risico` in `aanvragen` (wordt automatisch aangemaakt).
- Versienummers: nummer in de voet van elke pagina en op `/health`, dit logboek en git-tags.

## 0.2.1 · 13 oktober 2026
- Domeinnaam boekpouwvervoer.nl in README, `.env.example` en de pakketnaam. Het voorvoegsel `EPV-` van referenties en factuurnummers blijft.

## 0.2.0 · 13 oktober 2026
- Reis-stap `/reis` zoals de offertetool van Pouw, in de huisstijl van de app: retour of enkele reis, aantal personen, route met maximaal 5 tussenstops en wachttijd, datum en tijd (vertrek of aankomst) per richting, andere route terug. Wordt in de sessie bewaard en vult stap 1 van de aanvraag.
- Ritsoort "Enkele reis" toegevoegd aan formulier, backoffice en akkoordpagina.

## 0.1.1 · 13 oktober 2026
- Opmaak: het echte Pouw-logo, huisstijl van pouwvervoer.nl (navy menubalk, gele en groene knoppen, Open Sans) en de busfoto in de titelbalk.

## 0.1.0 · 12 oktober 2026
- Eerste versie: aanvraag met aanvrager, opdrachtgever en factuurontvanger, klantscore en aanbetaling, backoffice, akkoord met iDEAL, eindfactuur en herinneringen.
- Huisstijl Pouw Vervoer en duidelijkere klantpagina's.
- Incasso via Armaere: overdracht, wettelijke incassokosten en een eigen portaal voor de deurwaarder.
