# OCEAN

Ocean je společný projekt webového účtu a aplikace Kryptotron.

```text
Ocean/
├── src/                    webový server a API
├── public/                 uživatelské rozhraní
├── services/kryptotron/    Binance worker
└── data/                   lokální databáze Oceanu
```

Aktuální vertikální řez v0.1 obsahuje registraci, přihlášení pomocí username, odhlášení, změnu a obnovu hesla, chráněný profil, serverové sessions, vlastnické schvalování členů a auditní události. E-mail ani username nejsou identita; účet má neměnné interní `usr_…` ID.

## Spuštění

SQLite schéma se při startu aktualizuje pomocí očíslovaných migrací v `src/database/migrations`. Každá migrace proběhne právě jednou a atomicky; databáze s neznámou novější verzí je odmítnuta, aby ji starší aplikace nemohla poškodit.

```bash
npm install
npm run dev
```

Web poběží na <http://localhost:3000>. SQLite databáze vznikne v `data/ocean.db`.

```bash
npm test
npm run typecheck
npm run build
npm run backup
npm run restore:drill
npm run backup:offsite
npm run verify
```

## Uzavřený systém a pozvánky

Ocean je uzavřený systém. První účet získá roli `owner`; všechny další účty vyžadují jednorázovou pozvánku vytvořenou vlastníkem. Pozvánka platí sedm dní, lze ji omezit na konkrétní e-mail a před použitím ji lze zrušit. V databázi se ukládá pouze hash tokenu.

Po přihlášení otevře vlastník správu přes profil → **Pozvánky**. Pro odkazy použitelné mimo lokální počítač musí `APP_ORIGIN` obsahovat veřejnou adresu Oceanu.

Při `OCEAN_MANUAL_APPROVAL_ENABLED=true` je první vlastnický účet schválen automaticky. Každý další pozvaný člen čeká na ruční schválení v profilu vlastníka pod **Pozvánky** a do té doby nemůže připojit Binance ani Telegram. V tomto režimu se registrační ani pozvánkové e-maily neposílají; vlastník sdílí jednorázový odkaz a nového člena následně schválí. E-mailové ověření zůstává dostupné pro instalace, které ruční režim nepoužívají.

```text
OCEAN_MANUAL_APPROVAL_ENABLED=true
```

V produkci nastavte místo ručního schvalování e-mailový outbox:

```text
RESEND_API_KEY=...
EMAIL_FROM=Ocean <ocean@vase-domena.cz>
```

Zapomenuté heslo člena řeší vlastník v seznamu členů vytvořením jednorázového odkazu s platností 30 minut. Odkaz neobsahuje heslo, v databázi se ukládá pouze jeho hash a po změně hesla se ukončí všechny staré relace člena. Jediný vlastnický účet si zachovává nouzovou e-mailovou obnovu, pokud je e-mailový provider nastavený.

## Kryptotron

Kryptotron je součást Oceanu v `services/kryptotron`. Jediným zdrojem kódu
je tento repozitář; nasazení se provádí kořenovým `Dockerfile`. Ocean
spouští Python worker pro každý připojený účet a sleduje jeho heartbeat.
Při výpadku jej restartuje s omezeným exponenciálním odstupem.

Vlastník i členové mají stejný životní cyklus: účet začíná bez připojení,
ověřené Binance klíče se uloží šifrovaně a supervisor připraví instanci
s pozastavenými vstupy. Testnet je dostupný vždy; Mainnet vyžaduje
serverové `KRYPTOTRON_MAINNET_ENABLED=true`.

Worker má vlastní `kry_…` ID a token omezený na tuto instanci. Stav,
historii i notifikace předává internímu API Oceanu. Nedostává Supabase
ani Telegram klíč a bez brokeru se nespustí. Supabase `bot_state.key`
a `bot_trades.instance_id` oddělují účty; přístup má jen server Oceanu.

Všichni workeři nicméně běží pod stejným OS uživatelem ve stejném
kontejneru. `KRYPTOTRON_SANDBOX_ENABLED=true` každého z nich navíc
spustí v `bubblewrap` sandboxu (vlastní PID namespace, vlastní
`/tmp`, a filesystem omezený jen na Python runtime, kód Kryptotronu
a jeho vlastní pracovní adresář) — worker tak nemůže přečíst
adresář jiné instance ani vidět ostatní procesy. Síť zůstává sdílená
s hostitelem, protože worker potřebuje dosáhnout na `127.0.0.1`
(interní API Oceanu) i na Binance. Vyžaduje balíček `bubblewrap` a
jádro s podporou unprivileged user namespaces (výchozí na Debianu,
ne nutně na všech hostovaných platformách) — před nasazením na
ostrý účet ověřte na testnet instanci, že se workeři s tímto
přepínačem vůbec spustí.

Původní `main` je pouze migrační identifikátor. Převod na osobní instanci
popisuje [sjednocení Kryptotronu](docs/kryptotron-consolidation.md).
Neprovádějte ho prostým připojením stejného Binance účtu podruhé.

Výzkumné testování popisuje [Strategy Lab](services/kryptotron/research/README.md).

## Binance připojení

Binance údaje se ukládají pomocí AES-256-GCM. Worker při startu a před
obchodním cyklem kontroluje čtení, spot trading a zakázané výběry.
Před prvním připojením nastavte stabilní šifrovací klíč a bezpečně jej zálohujte:

```bash
openssl rand -base64 32
```

Výsledek vložte jako `OCEAN_CREDENTIALS_KEY`. Jeho ztráta znemožní rozšifrovat uložená Binance připojení; jeho změna vyžaduje řízenou rotaci klíčů.

**Rotace `OCEAN_CREDENTIALS_KEY`:**

1. Vygenerujte nový klíč (`openssl rand -base64 32`).
2. Nastavte `OCEAN_CREDENTIALS_KEY` na novou hodnotu a `OCEAN_CREDENTIALS_KEY_PREVIOUS` na starou, a nasaďte. Server i workeři nově čtou přednostně nový klíč a starý používají jen jako záložní pro dosud nepřešifrovaná připojení — provoz se nepřeruší.
3. Spusťte `npm run rotate:credentials-key` ve stejném prostředí. Přešifruje všechna uložená Binance připojení na nový klíč a vypíše přehled; lze bezpečně spustit opakovaně, dosud přešifrovaná připojení přeskočí.
4. Po potvrzení, že výstup neobsahuje žádné selhání, odeberte `OCEAN_CREDENTIALS_KEY_PREVIOUS` a znovu nasaďte. Starý klíč bezpečně zahoďte.

Člen může své Testnet Binance připojení odpojit přímo v Přehledu. Ocean odstraní šifrované API údaje, zneplatní přístup osobního workeru a vrátí instanci do stavu `unconfigured`. Nové připojení pak slouží jako bezpečná výměna klíčů. Zpětně kompatibilní vlastnická instance `main` je před tímto postupem chráněná.

## Telegram

Propojený Telegram dostane po automatickém denním běhu Risk Agenta stručný výsledek. Oznámení neobsahuje přístupové údaje a jeho případné selhání nemění výsledek ani auditní stopu agentního runu.

Ocean používá jediného Telegram bota pro všechny propojené účty:

```text
OCEAN_TELEGRAM_BOT_TOKEN=...
OCEAN_TELEGRAM_BOT_USERNAME=vas_ocean_bot
OCEAN_TELEGRAM_POLLING_ENABLED=false
```

Jeden Telegram bot může mít pouze jeden aktivní long polling proces. Na produkci nastavte přepínač na `true`; lokálně jej při sdíleném tokenu ponechte vypnutý.

Uživatel otevře Telegram z menu účtu a použije desetiminutový jednorázový 128bitový kód. Centrální bot podporuje `/status`, `/report`, `/pause`, `/resume`, `/dca` a `/streak`. Zapnutí DCA a paper strategie vyžaduje jednorázové potvrzení. Obchodní a provozní zprávy workerů přijímá trvalá fronta Oceanu; odesílání probíhá pouze do chatu připojeného k příslušnému účtu.

## Provoz

Pokud Ocean běží za reverzní proxy, vložte její přesnou adresu nebo CIDR do `TRUST_PROXY`. Nenechávejte aplikaci důvěřovat libovolnému proxy hopu.

Produkční Docker/Railway postup je v [docs/deploy-railway.md](docs/deploy-railway.md). Kontejner obsahuje Ocean server i Python runtime pro osobní Testnet workery; stavová data patří na připojený volume `/data`.

Risk Agent může jednou denně samostatně vytvořit simulation-only report koncentrace portfolia. Spouští pouze existující aktivní agenty schválených uživatelů s připojeným Kryptotronem; nemá cestu k obchodování ani k převodu prostředků. Výchozích `10:02` navazuje na kontrolu trhu v 10:00 a používá české časové pásmo včetně letního času.

```text
OCEAN_AGENT_SCHEDULER_ENABLED=true
OCEAN_AGENT_DAILY_RUN_TIME=10:02
OCEAN_AGENT_DAILY_RUN_TIME_ZONE=Europe/Prague
```

Neúspěšný naplánovaný run zůstává v Proof Ledgeru a tentýž den se automaticky neopakuje. Ruční spuštění z Agent Card zůstává dostupné nezávisle na denním plánu.

`npm run backup` vytvoří konzistentní a zkontrolovanou kopii SQLite databáze v `data/backups`. `npm run restore:drill` vytvoří novou zálohu, obnoví ji do dočasné databáze a ověří integritu, vazby, tabulky i počty řádků bez zásahu do běžícího Oceanu. Soubory databáze, záloh, stavů a logů jsou lokálně omezené na vlastníka procesu. Umístění a retenci lze změnit pomocí `BACKUP_DIRECTORY` a `BACKUP_RETENTION_DAYS`.

Volitelné vzdálené zálohy se před odesláním šifrují samostatným klíčem AES-256-GCM. Po uploadu Ocean objekt znovu stáhne, ověří kontrolní součet, autentizaci, SQLite integritu, vazby a počty řádků. Nastavení S3-kompatibilního úložiště, automatického plánu a obnovy je v [docs/deploy-railway.md](docs/deploy-railway.md). Klíče `OCEAN_CREDENTIALS_KEY` a `OCEAN_BACKUP_KEY` uchovávejte odděleně od databáze i od sebe; ke kompletní obnově jsou potřeba oba.

Provozní kontrola je dostupná na `/api/ready`. HTTP 200 znamená, že databáze prošla kontrolou integrity a povinné integrace mají konfiguraci; HTTP 503 znamená, že instance nemá přijímat provoz. `/api/health` zůstává jednoduchý liveness endpoint.

### Provozní monitoring

`OCEAN_OPS_MONITOR_ENABLED=true` zapne vnitřní kontrolu (každých 15 minut): stejné problémy jako `/api/ready`, plus Kryptotron instance zaseklé ve stavu `error` déle než 30 minut (supervisor je zkouší restartovat, ale sám o tom nikoho neinformuje). Při nálezu pošle vlastníkovi zprávu na Telegram — ihned při vzniku problému, pak nejvýš jednou za hodinu dokud trvá, a zprávu o vyřešení, jakmile zmizí. Vyžaduje nastaveného `OCEAN_TELEGRAM_BOT_TOKEN` a vlastníka propojeného s Telegramem.

Tahle kontrola běží uvnitř Oceanu, takže nic nezjistí, pokud proces nebo celý kontejner úplně spadne. Na to je potřeba nezávislá vnější kontrola: bezplatná uptime služba (např. UptimeRobot, Healthchecks.io) namířená na veřejné `/api/health` s upozorněním na e-mail nebo webhook.

## Bezpečnostní základy

- hesla jsou hashována pomocí Argon2id,
- session tokeny mají 256 bitů entropie a v databázi se ukládá pouze jejich SHA-256 hash,
- cookie je `HttpOnly`, `SameSite=Lax` a v produkci `Secure`,
- autentizační endpointy mají omezení počtu požadavků,
- login používá stejnou chybu pro neexistující účet i špatné heslo,
- zapisují se události vytvoření účtu a přihlášení,
- mutace kontrolují `Origin` proti `APP_ORIGIN`.

Před Mainnetem zůstává povinné dokončit rotaci tajemství, automatizované testy obnovy ze zálohy, oddělené omezené oprávnění každého workeru a provozní monitoring. Mainnet vyžaduje výslovné serverové povolení a ověřené Binance připojení; nestačí změna přepínače v rozhraní.
