# SONAR monitor

Arcade obsahuje jediný monitor: SONAR, SCORE, herní plochu a spodní žebříček.
Tap / mezerník / Enter spustí pokus, další tapy zachycují paprsek ve vyznačeném
sektoru. Běžný zásah dává 50 bodů, užší Perfect Zone 100. Chybný tap ukončí pokus.
Rychlost postupně roste a sektor se zužuje. Nápověda Tap při startu zmizí;
zpětná vazba zásahu trvá 280 ms. Herní plocha je zároveň ovládací tlačítko.

Ticker opakuje skutečné nejlepší výsledky až deseti různých účtů. Pozastavené
a neschválené účty v něm nejsou. Shodné skóre řadí čas dosažení. Bez výsledků
zobrazí prázdný stav, při chybě stručnou informaci; neobsahuje ukázkové hráče.
Posun se zastaví při najetí nebo zaměření klávesnicí. Při reduced motion se
žebříček neposouvá automaticky a lze jej procházet vodorovně.

## Výsledky

Migrace 008 přidává `sonar_runs` a `sonar_records`. Start vydá kurz se serverem
vygenerovanými sektory. Klient odevzdává časy tapů; server vypočítá skóre znovu,
ověří pořadí, délku pokusu a vlastnictví. Odeslání výsledku je idempotentní.
Současně je povolen jeden pokus na účet. Odchod ze sekce nebo skrytí stránky
ukončí pokus a odešle dosavadní výsledek; serverový rekord vzniká až po potvrzení.
Pokus má limit 10 minut / 256 zásahů, detaily starší 7 dnů se při dalším startu
odstraňují, osobní rekord zůstává. Smazání účtu odstraní jeho skóre i pokusy.

API: GET `/api/arcade/sonar/leaderboard`, POST `/api/arcade/sonar/runs`,
POST `/api/arcade/sonar/runs/:id/finish`. Vyžaduje přihlášení a schválený aktivní
účet; zápisy také Origin aplikace. Nikde se neodečítají ani neudělují TIDE.
Starý rekord z localStorage se nepřenáší: stará hra měla jiné bodování a záznam
nebyl spojený s účtem ani ověřený serverem.

Ověření průběhu brání odeslání libovolného skóre a opakovanému zápisu. Není to
ochrana proti automatickému hráči, který zná kurz a vytvoří platné časy tapů.
Před zavedením hodnotných odměn by bylo nutné řešit anti-cheat samostatně.

`test/sonar.test.ts` ověřuje bodování, oprávnění, izolaci uživatelů, opakování,
časové limity a leaderboard. `test/sonar-browser-state.test.ts` kontroluje
skutečný JS ovladač s virtuálním časem, vstupy a shodou klientského bodování.
Tyto testy nenahrazují vizuální kontrolu skutečného mobilního prohlížeče.
