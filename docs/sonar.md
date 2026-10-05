# SONAR – původní hra

Herní rozhraní, ovládání i bodování jsou obnovené přesně z commitu `a5e9f69`,
před předěláváním Arcade v PR #9–11. Původní hra je opět součástí `public/app.js`,
s původním HTML a styly. Nepoužívá retro rám, ticker ani samostatný modul SONAR.

Tlačítko Spustit začne hru, PING / tap na radar / mezerník zachytává paprsek.
Zásah dává `round(100 + přesnost * 100 + (počet zásahů - 1) * 10)` bodů.
Chybný zásah ukončí hru a tlačítko nabídne Hrát znovu. Osobní rekord se jako
původně ukládá do localStorage pod `ocean-sonar-best` v konkrétním prohlížeči.
Starý lokální rekord zůstává dostupný, pokud uživatel nesmazal data prohlížeče.

## Zachovaná data novějších variant

Databázové migrace 008 a 009 se nevracejí zpět a serverové rekordy se nemažou.
API `/api/arcade/sonar/*` zůstává kompatibilní s dosud otevřenými novějšími
klienty. Výsledky `sonar-v2` a `sonar-classic-v1` jsou oddělené podle pravidel.
Obnovené původní rozhraní toto API ani společný žebříček nepoužívá.

Testy `test/sonar.test.ts` a `test/migrations.test.ts` dále ověřují zachované
serverové API a data. Při změně původní hry ověř také skutečný prohlížeč.
