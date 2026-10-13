# Wijzigingen

Elke update krijgt een versienummer (zie README, kopje Versies). Nieuwste bovenaan. De git-tag `vX.Y.Z` staat op de commit van die versie.

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
