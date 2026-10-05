# SONAR monitor

Arcade zachovává původní vzhled sonaru: tmavou mřížku, světelné body, jemný
paprsek a souvislý zelený svítící oblouk bez zvýrazněného středu.
Horní lišta obsahuje jen SONAR a skóre bez úvodních nul. Herní panel má
omezenou šířku a výšku a přizpůsobuje se dostupnému prostoru i na telefonu.
Tap / mezerník / Enter spustí pokus, další tapy zachycují paprsek v oblouku.
Běžný zásah dává 50 bodů, přesný zásah uprostřed 100; bodování se nemění.
Chybný tap ukončí pokus. Rychlost postupně roste a sektor se zužuje.
Nápověda Tap při startu zmizí; po zásahu se na 280 ms objeví pouze +50 / +100.
Herní plocha je zároveň ovládací tlačítko.

Pod hrou je jediný statický řádek: symbol koruny, nejlepší hráč a jeho skóre.
Žádné rolování ani opakování výsledků. Pozastavené a neschválené účty se
nezobrazují; při shodě rozhoduje čas dosažení. Pokud nejsou výsledky dostupné,
řádek zůstane prázdný. API nadále poskytuje nejlepších deset účtů.

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

Při vývoji používej `npm run dev` (`tsx watch`), aby se při změně serverových
rout znovu načetl také backend. Samostatný dlouho běžící `node --import tsx
src/server.ts` může obsluhovat nová statická aktiva, ale stále staré API. Při
404 herního API už rozhraní ukáže informaci o čekající aktualizaci serveru.
