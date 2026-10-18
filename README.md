# Wallmann Leveringsapp 3.0

Chaufførapp til telefoner. Kontorsøgning kører i et separat Google Apps Script-projekt med adgang via Leveringslog-arket.

## Ændringer
- Automatisk lokal kladde: ordrenumre, billeder, modtager og signatur.
- Eksisterende offlinekø bevares; ingen sletning før serveren bekræfter upload.
- Kompakt telefonvisning og samlede leveringstal for måned/år, hentet i baggrunden.
- Chauffører administreres i arket Chauffører via kontorappens adminfunktion. Listen opdateres uden ny appversion.
- Billeder komprimeres til typisk højst 400 KiB med op til 1920 pixels. Grænse 1200 KiB, højst 10 billeder.

## Kilde og deployment
Kontor- og backendkoden vedligeholdes i de separate Google Apps Script-projekter. En lokal kildepakke indeholder backup og tests. Upload-backend 1.26 skal være implementeret på den eksisterende /exec-adresse. Kontoret kører som den besøgende Google-bruger; Sheet-adgang kontrolleres ved hvert kald. Kun OFFICE_ADMIN_EMAILS kan ændre Chauffører.

Frontendens config.js har preview=false i denne udgivelse. service-worker.js bruger leveringsapp-v300. Næste kodeudgivelse skal have en ny cacheversion; ændringer af chaufførlisten kræver ingen kodeudgivelse.

Tilbagerulning: gendan tidligere frontend med en NY cacheversion. Bevar IndexedDB-databaserne. Backendens forrige deployment er version 7.

## Kontrolleret
Automatiske tests af afbrudt upload/genforsøg, dubletbeskyttelse, 10 billeder, validering, adgang, historiske søgeresultater, måned/år og caching. Browserkontrol af kladdegendannelse, kompakt visning, piletaster og direkte download. Rigtig Google-forbindelse og optælling kontrolleret.
