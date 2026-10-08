# SONAR – Arcade a TOP 5

Hra v `public/app.js` zachovává původní radar, ovládání a bodování.
Arcade nemá samostatný nadpis stránky ani indikátor spojení. Skóre, radar,
tlačítko a osobní rekord mají vyhrazené místo pro všechny stavy hry.
Desktop zobrazuje vedle hry TOP 5 různých hráčů, každého s nejlepším výsledkem.
Na mobilu žebříček otevírá tlačítko s pohárem; dialog pozastaví pohyb paprsku
a zavření vrátí hru do stejného stavu. Nízké displeje mohou obsah posouvat.

Úvodní radar používá stejnou kresbu a velikost jako rozehraná hra.
Tlačítko Spustit začne hru a během hraní je skryté se zachováním místa.
Tap / kliknutí na radar nebo mezerník zachytává paprsek při stisku;
držení mezerníku nevytváří další zásahy. Po skončení se vrátí tlačítko dalšího pokusu.
Zásah dává `round(100 + přesnost * 100 + (počet zásahů - 1) * 10)` bodů.
Chybný zásah ukončí hru. Server vydává sektory a ověřuje výsledek z časů
zásahů přes `/api/arcade/sonar/runs`; klient neposílá důvěryhodné skóre.
Čas hry sleduje vykreslený pohyb a stojí při otevřeném žebříčku nebo skryté
kartě. Platí serverový limit 256 zásahů a 10 minut herního času; pokus starší
než 11 minut skutečného času server odmítne i po dlouhém pozastavení.
Při síťové chybě nabízí tlačítko opakované uložení stejného pokusu.
Osobní rekord se načítá z účtu, nikoliv ze sdíleného úložiště prohlížeče.
Starý `ocean-sonar-best` zůstává nedotčený, ale do žebříčku ani osobního
serverového rekordu se nepřenáší, protože jeho průběh nelze ověřit.

## Zachovaná data novějších variant

Databázové migrace 008 a 009 se nevracejí zpět a serverové rekordy se nemažou.
API `/api/arcade/sonar/*` zůstává kompatibilní s dosud otevřenými novějšími
klienty. Výsledky `sonar-v2` a `sonar-classic-v1` jsou oddělené podle pravidel.
Aktuální rozhraní používá `sonar-classic-v1`. Žebříček vrací nejvýše pět
schválených, nepozastavených hráčů; při shodě skóre vyhrává dřívější rekord.

Testy `test/sonar.test.ts` a `test/migrations.test.ts` dále ověřují zachované
serverové API a data. Při změně původní hry ověř také skutečný prohlížeč.
