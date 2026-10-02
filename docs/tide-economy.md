# Genesis Supply #1 → TIDE → OCEAN Slot

## Architektura

Fastify, SQLite a session cookie `zero_session` zůstávají společné se zbytkem
OCEANu. TIDE balance je součet neměnného `tide_ledger`; samostatná editovatelná
balance neexistuje. Proof Ledger Risk Agenta zůstává oddělený audit analýz.
Kryptotron, DCA, Vault ani Binance nejsou zdrojem TIDE. TIDE nelze koupit,
převést, směnit ani vybrat; nejde o blockchain token.

Emise vzniká pouze explicitním CLI příkazem. Start aplikace aplikuje schéma,
ale negeneruje kódy a nepřipisuje správci žádné TIDE.

## Genesis Supply #1

`GENESIS_001` má 100 000 TIDE: 75 000 je rezervováno kódům a 25 000 jednorázově
připsáno schválenému vlastníkovi podle stabilního `users.id`. Část rezervy za
neaktivované kódy není zůstatkem žádného uživatele.

| Počet | Odměna za kód | Alokace |
| ---: | ---: | ---: |
| 40 | 300 | 12 000 |
| 30 | 500 | 15 000 |
| 15 | 800 | 12 000 |
| 8 | 1 000 | 8 000 |
| 4 | 2 000 | 8 000 |
| 2 | 5 000 | 10 000 |
| 1 | 10 000 | 10 000 |
| **100** | | **75 000** |

Pool se nejprve sestaví a promíchá pomocí Fisher–Yates a `crypto.randomInt`.
Kódy mají 20 náhodných znaků z bezpečné abecedy a formát
`OCN-XXXXX-XXXXX-XXXXX-XXXXX`; jejich text nekóduje číslo, hodnotu ani rarity.
Databáze uchovává pouze HMAC-SHA256 s dedikovaným 32bytovým tajemstvím
`GENESIS_CODE_HMAC_KEY`. Tajemství není v DB, API ani exportu. Fingerprint
klíče v metadatech brání tichému použití nesprávného klíče.

Generování, 100 vložených digestů, alokace správci, dokončení emise i auditní
událost běží v jedné `BEGIN IMMEDIATE` transakci. Před commitem se zapíše a
fsyncne nový soukromý export. Opakované vydání stejné emise se odmítne.
Dokončení emise ověřuje databázový trigger: počty, všechny reward tiery,
celkovou rezervu a skutečný účetní zápis alokace správci. Vydaná emise je
neměnná a nelze k ní přidat další kódy.

Po celou dobu platí:

- `admin allocation + code allocation = 100 000`
- `redeemed amount + unclaimed amount = 75 000`

Jde o původní Genesis alokaci. Aktuální součet hráčských zůstatků se dále mění
sázkami a výhrami slotu; tato změna není další Genesis emisí. Přehled správce
proto tyto dva významy nezaměňuje.

## Databáze a migrace

Migrace 005 založila původní TIDE ledger, Genesis kódy a `slot_spins`.
Migrace **006 `genesis_waves`** přidává metadata emisí a převádí existující
kódy, aktivace a ledger na schéma podporující proměnlivé odměny:

- `genesis_waves`: ID, druh, stav draft/issued, počet kódů, alokace a supply,
  admin user ID, reward distribution, fingerprint HMAC klíče a čas.
- `genesis_codes`: interní UUID, wave, evidenční číslo, unique digest,
  digest scheme, reward a čas. Neobsahuje plaintext.
- `genesis_redemptions`: neměnná vazba kódu na uživatele, wave a čas.
  Stav kódu se odvozuje z existence aktivace, neduplikuje se v další kolonce.
- `tide_ledger`: zachovává sequence, ID, reference, částky a historii; nově
  přijímá `GENESIS_ADMIN_ALLOCATION` se zdrojem `genesis_admin`. Kredity musí
  odkazovat na skutečnou aktivaci nebo správnou alokaci wave a souhlasit částkou.

Původní kódy se zachovají jako `LEGACY_300`, se SHA-256 digesty a odměnou 300.
Nemění se jejich čerpání, zůstatky ani trvalé identity. **Pokud legacy emise
existuje, CLI odmítne vydat `GENESIS_001`**: živá starší ekonomika vyžaduje
samostatný migrační plán. Automaticky se nemaže, nepřepisuje ani nepřičítá
nových 100 000 TIDE. Prázdná databáze nemá žádnou legacy emisi.

Schéma i redeem podporují další waves bez změny mechanismu. Druh `promo`
umožňuje uživateli jednu aktivaci v každé budoucí wave; jeho Genesis identita
zůstává stejná. Genesis identitu lze získat pouze jednou, také napříč legacy
emisí a novou Genesis. Současné CLI úmyslně vydává pouze `GENESIS_001`.

## Redeem a bezpečnost

Server normalizuje velikost písmen, mezery a pomlčky. Uvnitř SQLite IMMEDIATE
transakce vyhledá digest, ověří emisi a aktivaci, zapíše claim a kredit ledgeru.
Dva procesy nemohou odměnu připsat dvakrát. Opakování vlastního dokončeného
požadavku vrací původní reward s `replayed: true`, bez dalšího připsání.
Neplatný, cizím účtem použitý nebo pro uživatele nepřípustný kód vrací stejný
`400 {error: "Invalid code", code: "INVALID_CODE"}`; před aktivací se reward
běžnému uživateli nezpřístupňuje. Neplatný či chybějící serverový HMAC klíč
způsobí 503 a žádný zápis.

Autentizace a schválení účtu používají současný model. Origin kontrola je
sdílená s ostatními zápisy. Redeem má dva nezávislé limity přes existující
Fastify rate-limit: 10 pokusů/min/IP a 10 pokusů/min/uživatel. Hlavička
X-Forwarded-For se respektuje jen při správně nastaveném důvěryhodném proxy.
Limity jsou v paměti procesu stejně jako ostatní limity aplikace.

Audit aktivace tvoří immutable redemption a navázaný ledger: uživatel, wave,
interní ID kódu, čas a skutečná odměna. CLI navíc ukládá `GENESIS_WAVE_ISSUED`
do současného `admin_audit_log`. Žádný z těchto záznamů neobsahuje plaintext.

## API a rozhraní

| Endpoint | Účel |
| --- | --- |
| `GET /api/tide` | Vlastní balance a Genesis identita |
| `GET /api/tide/ledger?before=<sequence>` | Stránkovaná vlastní účetní historie |
| `POST /api/genesis/redeem` | `{code}` → genesis, reward, balance, replayed |
| `GET /api/admin/genesis?wave=GENESIS_001` | Pouze schválený owner: emise, účetní součty a metadata všech kódů zvolené wave |
| `GET /api/slot` | Verze, sázka, strips a paytable |
| `POST /api/slot/spins` | `{idempotencyKey}` → uložený výsledek, balance a replayed |

Všechny ekonomické odpovědi mají `Cache-Control: no-store`. Admin API má
explicitní seznam vracených polí; nevrací plaintext kódy, jejich digests ani
fingerprint klíče. Přehled ve Správě obsahuje odměny, stav, kdo/kdy aktivoval,
filtr emise/stavu a hledání čísla kódu nebo uživatele. Evidenční číslo + wave
odpovídají soukromému exportu. Vydávání kódů přes webový formulář neexistuje.

Navigace: Home · Arcade · Gamble · Vault. Redeem je pouze v profilu a na
`#redeem`, také původní `#gift` funguje. Stránka má jeden vstup a ACTIVATE,
krátký error/success a podporuje Enter, normalizaci i blokaci dvojího submitu.
Odměna se čte ze serveru. TIDE mince v hlavičce je neinteraktivní zůstatek;
profil neobsahuje množství ani historii TIDE.

Slot zachovává cenu 10 TIDE, 3×25 stops, 15 625 kombinací, RTP 95,1808 %, hit
7,264 % a jackpot 1/15 625. Výsledek i bet/payout se vypořádají na serveru před
animací. Retry po ztrátě odpovědi používá stejný key ze sessionStorage; RNG se
neopakuje. SVG a animace vycházejí z prototypu, jeho klientská ekonomika ne.

Tlačítko používá pouze ikonu; přístupný název a tooltip rozlišují spin,
ověření (čekající idempotency key) a obnovení
(opakování načtení hry bez POST sázky). Při nedostupném zůstatku se zobrazí
pomlčka, nikoli poslední částka. Načítání a probíhající spin blokují další
kliknutí. Klient ověřuje i soulad payoutu se symboly; poškozená odpověď
zachová čekající key. Starší načítání peněženky nepřepisuje novější výsledek.
Mince s částkou a ikonové ovládání jsou vedle sebe, výherní řádek se zvýrazní.
Výplatní tabulka používá logo TIDE místo názvu tokenu. Válce nemají středovou
čáru; klidový stav je bez vysvětlujících textů, chyby a výsledky zůstávají viditelné. Válce respektují
omezený pohyb a zachovají polohu i při přepnutí sekce během animace.

Browser kontrola 2026-10-01 na izolované syntetické databázi: šířky
320/390/768/1440/1920 px, nulový zůstatek, výhra bez animace, ovládání Enter,
výpadek načítání a obnovení bez sázky. Skutečný testovací spin byl vypořádán,
jeho odpověď zahozena a stránka obnovena: retry použil původní key a zůstatek
se podruhé nezměnil. Ověřeno také odmítnutí nesouladného payoutu, blokování
dvojkliku a přepnutí sekce se změnou rozlišení během animace. Produkční účty
ani emise nejsou součástí těchto kontrol.


## Inicializace prostředí

1. Nasadit aplikaci s migrací 006; před migrací zálohovat SQLite. Ověřit health
   a schváleného vlastníka. Samotný deploy emisi nevytvoří.
2. V secret manageru nastavit dedikovaný `GENESIS_CODE_HMAC_KEY` (64 hex znaků
   z kryptografického generátoru) a `GENESIS_ADMIN_USER_ID` na skutečné stabilní
   `users.id` vlastníka. Klíč bezpečně zálohovat; nezaměňovat s Binance ani
   `OCEAN_CREDENTIALS_KEY`. Restartovat aplikaci s touto konfigurací.
3. Připravit soukromý adresář mimo veřejné soubory, např. `data/genesis-exports`
   s oprávněním 0700. Ověřit správný DATABASE_PATH. Vydat jedinou sadu:

```sh
npm run build
npm run genesis:issue -- --output data/genesis-exports/genesis-codes-GENESIS_001.csv
```

Výsledkem je CSV `index,code,reward_tide,wave`, 100 řádků, režim **0600**.
Soubor se vytváří výhradně jako nový (`wx`), nepřepisuje se. Cesty přes symlink
se vyhodnotí před kontrolou. Uvnitř projektu je povolen jen soukromý `data/`;
exporty `genesis-codes-*.csv` jsou navíc v `.gitignore` i `.dockerignore`.
CLI nevypisuje kódy. Secret a export nesmí do logů, ticketů ani veřejných příloh.

4. Ve Správě ověřit `GENESIS_001`: 100 kódů, supply 100 000, alokace správci
   25 000, code pool 75 000, redeemed 0, unclaimed 75 000 a správného příjemce.
5. Soukromě zálohovat export a HMAC klíč; udělat novou zálohu DB. Kódy
   distribuovat bezpečným soukromým kanálem, ne z administračního API.

Při chybě exportu/DB se transakce vrátí a nově vytvořený export odstraní.
Při pádu procesu mezi exportem a commitem může zůstat soubor bez emise: před
jakýmkoli opakováním porovnat DB a soubor, nepřepisovat ho naslepo.
Plaintext nelze z digestů obnovit. Ztráta HMAC klíče znemožní nové aktivace;
klíč nelze svévolně rotovat. Obnova starší DB může znovu otevřít použitý kód,
proto nikdy nevracet ekonomickou historii zpět za běžícího provozu.

## Ověření a změněné části

Testy pokrývají přesnou distribuci, všechny slot kombinace, oba procesové
závody (redeem i issuance), idempotenci, reálnou výši všech tier odměn,
rollback kreditu/issuance/exportu, legacy migraci s historií, promo wave,
HMAC bez plaintextu, auth/owner/Origin, limity přes účty/IP a CLI export 0600.
Ověřeno: build, 190 Node testů, 132 Python testů a restore drill 24 tabulek.
Prohlížeč ověřuje skutečné API/DB při aktivaci a změně admin součtů, filtry,
nezpřístupnění dat členům a mobilní rozložení. Restore drill zahrnuje emisi,
aktivace a slot ledger.

- `src/database/migrations/006_genesis_waves.ts`, registr migrací: schéma,
  kompatibilita a DB invarianty.
- `src/genesis/service.ts`, `issue.ts`, `admin.ts`, `src/tide/ledger.ts`:
  emise, bezpečný export, redeem, účetnictví a read-only report.
- `src/config.ts`, `.env.example`, `.gitignore`, `.dockerignore`: konfigurace
  HMAC/owner a ochrana exportů.
- `src/routes/economy.ts`: admin endpoint, nové kódy a dvojí limit pokusů.
- `public/invites.html`, `invites.js`, `genesis-admin.css`: administrační přehled.
- `public/index.html`, `economy.js`, `economy.css`: nový formát a skutečná odměna.
- `test/genesis-waves.test.ts` a existující ekonomické/migrační testy: nové
  invarianty i zachování stávajících cest.
