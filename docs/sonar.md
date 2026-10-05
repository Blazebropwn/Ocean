# SONAR · Classic

SONAR je zasazený do jednoduché tmavé retro bedny s hlubším rámem obrazovky,
tlumenou zelenou kresbou a statickými řádky CRT. Žádné blikání ani další panely.
Nahoře je SONAR a malé číselné skóre, dole jediný nejlepší hráč se skóre.
Rám se vejde do dostupného prostoru na počítači i telefonu.

Tap / mezerník / Enter spustí pokus. Další tapy zachycují paprsek v souvislém
oblouku, bez viditelné Perfect Zone. Původní bodování je obnoveno přesně:
`round(100 + přesnost * 100 + (počet zásahů - 1) * 10)`, kde přesnost je
`1 - úhlová vzdálenost od středu / polovina šířky oblouku`.
První zásah tedy dává 100–200 bodů, další mají bonus +10, +20, …
Chybný tap ukončí pokus. Rychlost začíná na 1,45 rad/s a roste o 0,14 až na 3,5;
šířka začíná na 0,72 rad a klesá o 0,025 až na 0,3. Tap po startu zmizí,
po zásahu se na 280 ms objeví pouze přidané body.

Pod hrou je jediný statický řádek. Pozastavené a neschválené účty se nezobrazují;
při shodě rozhoduje čas dosažení. Bez výsledků zůstane řádek prázdný.

## Výsledky

Aktuální pravidla mají verzi `sonar-classic-v1`. Migrace 009 zachovává existující
rekordy pod `sonar-v2` a odděluje rekordy podle verze bodování. Starý rozehraný
pokus lze dokončit s původními pravidly 50/100; nový pokus vyžaduje aktuální
verzi v POST těle. Starý klient dostane pokyn k obnovení stránky. Žebříček
zobrazuje jen aktuální pravidla, historické rekordy se nemažou.

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

Při vývoji používej `npm run dev` (`tsx watch`), aby se při změně serverových
rout znovu načetl také backend. Samostatný dlouho běžící `node --import tsx
src/server.ts` může obsluhovat nová statická aktiva, ale stále staré API. Při
404 herního API už rozhraní ukáže informaci o čekající aktualizaci serveru.
