# Genesis → TIDE → OCEAN Slot

## Integrace a rozhodnutí

Používá se existující Fastify, session cookie `zero_session`, schvalování účtů,
kontrola Origin, rate limiting a SQLite s verzovanými migracemi. Proof Ledger
Risk Agenta je audit analýz, nikoliv účetnictví: zůstává samostatný. Kryptotron,
Vault, Sonar a jejich zůstatky nejsou zdrojem TIDE.

Migrace 005 přidává `genesis_codes`, `genesis_redemptions`, `slot_spins`
a `tide_ledger`. Genesis identita žije v redemptions, nezávisle na zůstatku.
Jeden účet může mít právě jedno Genesis číslo. Balance je součet immutable
ledgeru, ne editovatelná kolonka uživatele. Částky jsou celočíselné TIDE.
Změny existujících záznamů ekonomiky zakazují SQLite triggery; vazby a
jedinečnost chrání i databáze. Ekonomické transakce používají BEGIN IMMEDIATE.

API: `GET /api/tide`, stránkované `GET /api/tide/ledger`,
`POST /api/genesis/redeem` (`code`), `GET /api/slot`,
`POST /api/slot/spins` (`idempotencyKey`). Vše je svázané s přihlášeným účtem;
zápisy vyžadují také schválení dle současných pravidel OCEANu. Klient neposílá
userId, výhru, sázku ani výsledek. Stejný spin key vrací tentýž uložený spin.
Redeem stejného kódu stejným uživatelem vrací jeho existující aktivaci bez
dalšího připsání. Jiný uživatel použitý kód aktivovat nemůže.

Hlavní navigace je Home · Arcade · Gamble · Vault. Arcade obsahuje Sonar,
Gamble samostatný slot. Redeem code je v profilu. TIDE zůstatek je v hlavičce vedle profilu,
s ikonou mince jako neinteraktivní informace o stavu. Staré odkazy #dashboard,
#gift a #slot zůstávají funkční.
Profil zobrazuje Genesis a vstup Redeem code; neopakuje zůstatek ani nenabízí
historii TIDE. Účetní ledger zůstává na serveru. SVG symboly a mechanická animace vycházejí
z dodaného prototypu; jeho lokální ekonomika ani RNG se nepoužívají.

## Hranice a rizika

TIDE nelze koupit, převést, vybrat ani směnit. Nemá peněžní kurz. Neexistuje
propojení s burzovním účtem. Model výher má zápornou dlouhodobou návratnost
pro hráče, žádný slib výdělku. Nevytváří se autoplay ani placené doplňování.
Matematika se ověřuje vyčerpávajícím testem všech 15 625 kombinací, ne vzorkem.

Největší provozní rizika: ztráta exportu promo kódů, neopatrné zveřejnění
kódů, ztráta SQLite volume a nekompatibilní rollback migrace. Kódy jsou
bearer tajemství; v DB jsou jen SHA-256 hashe náhodných kódů. Nejsou v logu,
Gitu ani veřejném API. Výdej přes CLI vytváří přesně 100 kódů jednou, export
je nový soubor s oprávněním 0600. Záloha DB musí zachovat ledger i výsledky.
V jedné transakci není síť ani animace. SQLite zůstává jediný zapisující
zdroj pravdy; horizontální replikace není podporovaná současnou architekturou.

Idempotency key se v prohlížeči uchovává pouze pro zotavení požadavku;
balance je vždy načtený ze serveru. Při nejasném síťovém výsledku se nesmí
vytvořit nový key. Zavření stránky neruší již vypořádaný spin. Klientská
animace není doklad provedení; dokladem je uložený spin a ledger.

## API a provoz

| Endpoint | Výsledek |
| --- | --- |
| `GET /api/tide` | Aktuální balance a samostatná Genesis identita |
| `GET /api/tide/ledger?before=<sequence>` | 25 vlastních záznamů a nextCursor |
| `POST /api/genesis/redeem` | `{code}` → identita, reward, aktuální balance, replayed |
| `GET /api/slot` | Verze hry, sázka, immutable reel strips a paytable |
| `POST /api/slot/spins` | `{idempotencyKey}` → immutable spin, aktuální balance, replayed |

Nová aktivace/spin vrací 201, opakování 200. Neplatný vstup 400,
nepřihlášený účet 401, neschválený účet nebo cizí Origin 403,
neexistující kód 404, obsazený kód/identita či nedostatek TIDE 409.
POST limit je 10 redeem / 30 spin požadavků za minutu na IP, navíc platí
současný globální limit. Ledger ani promo kódy nemají veřejné administrační
write endpointy. Uživatelská data mají `Cache-Control: no-store`.

### Výdej první dávky

Po záloze SQLite a nasazení migrace spusť se správným `DATABASE_PATH`:

```sh
npm run build
npm run genesis:issue -- --output /soukroma/cesta/genesis.csv
```

Cílový adresář musí existovat a být soukromý. CLI odmítá výstup v `public/`
a nepřepisuje existující soubor. Soubor se fsyncne před commitnutím dávky.
Při chybě zápisu se rollbackne i databáze. Při jakémkoli již vydaném kódu
se nová dávka odmítne; žádná automatická regenerace čísel 001–100.
Export bezpečně zálohuj a distribuuj mimo veřejný repozitář. Nikdy nevydávej
lokální testovací kódy jako produkční: každá databáze má vlastní dávku.

### Ověření

`npm run verify` zahrnuje přesnou enumeraci matematiky, rollback ekonomiky,
replay po restartu SQLite, odmítnutí kreditů bez sázky/reference, append-only
pravidla, scoped API, auth/approval/Origin a dva skutečné procesy soutěžící
o tentýž kód, stejný spin key i poslední sázku.

Lokální integrační náhled ověřil skutečný redeem, zúčtování, dvojklik,
ztracenou HTTP odpověď po commitu, reload a obnovení stejného výsledku,
ledger, nedostatek TIDE a desktop/mobil. SVG assety jsou odvozené z dodaného
`OCEAN_Slot_Prototype.html`; runtime neobsahuje jeho Kč, demo balance,
reset, lab, statistiky ani klientský RNG.

Výsledek před předáním: build, 182 Node testů a 132 Python testů prošly.
Ověřená obnova SQLite s 23 tabulkami zahrnuje i aktivace, spiny a ledger.
Vydána a zkontrolována lokální testovací dávka 100 kódů s exportem 0600.
Produkční kódy zatím vydané nejsou.

### Změněné části

- `src/database/migrations/005_tide_economy.ts` a registr migrací: čtyři
  ekonomické tabulky, omezení, indexy a immutable triggery.
- `src/tide/ledger.ts`, `src/genesis/*`, `src/slot/*`: účetnictví, výdej
  a aktivace kódů, samostatná matematika a vypořádání hry.
- `src/routes/economy.ts`, `src/app.ts`: pět endpointů nad stávající auth.
- `public/economy.js`, `public/economy.css`, `public/slot/*.svg`: Redeem code,
  slot, animace a TIDE zůstatek; `public/app.js` / `index.html` integrují
  routing, profil, TIDE zůstatek v hlavičce a samostatná sekce Gamble.
- `test/tide-economy.test.ts`, `test/economy-routes.test.ts`, procesový
  helper a migrační testy: kritické účetní a autorizační scénáře.
- `package.json`: provozní příkaz `genesis:issue`.

## Omezení MVP

Promo kódy mají jednorázový neveřejný export, nikoli administrátorské UI.
Ztracený export neumíme odvodit zpět z hashů. Účet s ekonomickou historií
nelze smazat kaskádou; budoucí anonymizace musí zachovat audit. Zůstatek
počítáme ze SUM ledgeru s indexem podle uživatele; případná budoucí cache
musí zůstat účetně ověřitelná. První verze nemá zvuk ani autoplay.

Obnova starší zálohy nesmí znovu zpřístupnit použité promo kódy nebo vymazat
spiny, které už klient potvrdil. Pro obnovu použij konzistentní zálohu celé
SQLite a provoz během obnovy zastav. Idempotency klíče a záznamy se v MVP
nepročišťují. Při nejasném síťovém výsledku UI vyžaduje sessionStorage;
bez něj novou sázku neodesílá. Vymazání tohoto úložiště nemění historii na
serveru, ale odstraní automatickou návaznost na poslední nepotvrzený požadavek.
