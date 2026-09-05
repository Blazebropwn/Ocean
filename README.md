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

Zdrojový kód existujícího Binance workeru je v `services/kryptotron`. Obchodní logika a konfigurace strategie zůstaly beze změny. Původní `.env`, Git historie, virtuální prostředí, logy a běhový stav nebyly do Oceanu zkopírovány.

```bash
cd services/kryptotron
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python bot.py
```

Lokální `.env` Kryptotronu musí obsahovat jeho vlastní Binance, Supabase a případně Telegram údaje. Aktuální produkční worker může dál běžet na Railway; Ocean čte jeho stav serverově přes proměnné `KRYPTOTRON_SUPABASE_URL` a `KRYPTOTRON_SUPABASE_KEY` v kořenovém `.env`.

Každý Ocean účet má vlastní záznam v `kryptotron_instances`. Původní Supabase stav `main` se při migraci přiřadí pouze vlastníkovi a zachová tak současného Kryptotrona beze změny. Noví členové začínají ve stavu `unconfigured`; dokud nemají přidělenou samostatnou vzdálenou instanci, nemohou číst ani ovládat Kryptotron jiného uživatele.

Supabase používá `bot_state.key` jako identifikátor instance a `bot_trades.instance_id` pro oddělenou historii. Worker čte `KRYPTOTRON_INSTANCE_ID` a bez jeho nastavení zachová kompatibilní hodnotu `main`. Ocean vždy filtruje stav i poslední obchod podle instance přiřazené přihlášenému účtu.

Osobní Testnet workery nedostávají globální Supabase serverový klíč. Komunikují přes interní state broker Oceanu pomocí tokenu kryptograficky svázaného s jediným ID instance. Původní samostatný Railway worker může dál používat přímé Supabase připojení kvůli zpětné kompatibilitě.

Po ověření Testnet klíčů supervisor nejpozději během deseti sekund spustí osobní worker. Sleduje jeho heartbeat, při výpadku jej restartuje s omezeným exponenciálním odstupem a po vyřazení instance proces ukončí. Automatické spouštění je omezené na izolované Testnet instance; původní vlastnický Mainnet worker zůstává samostatný.

Kryptotron ukládá stav a historii do samostatného Supabase projektu Ocean. Tabulky `bot_state` a `bot_trades` mají zapnuté RLS bez veřejných policy a přístup k nim má pouze serverová část aplikace. CrackleCore používá vlastní oddělený projekt a jeho data ani oprávnění Ocean nesdílí.

## Binance připojení

Nové osobní Binance připojení Ocean přijímá pouze z Testnetu. Údaje se ukládají samostatně zašifrované pomocí AES-256-GCM a po ověření čekají ve stavu `provisioning` na vytvoření workeru. Původní vlastnický Mainnet worker zůstává samostatný; při startu a před každým obchodním cyklem znovu kontroluje čtení, spotové obchodování a zakázané výběry. Před prvním připojením nastavte v `.env` stabilní klíč, který je nutné bezpečně zálohovat:

```bash
openssl rand -base64 32
```

Výsledek vložte jako `OCEAN_CREDENTIALS_KEY`. Jeho ztráta znemožní rozšifrovat uložená Binance připojení; jeho změna vyžaduje řízenou rotaci klíčů.

Člen může své Testnet Binance připojení odpojit přímo v Přehledu. Ocean odstraní šifrované API údaje, zneplatní přístup osobního workeru a vrátí instanci do stavu `unconfigured`. Nové připojení pak slouží jako bezpečná výměna klíčů. Zpětně kompatibilní vlastnická instance `main` je před tímto postupem chráněná.

## Telegram

Pro osobní Telegram propojení použijte samostatného bota, který současně neběží v Railway workeru:

```text
OCEAN_TELEGRAM_BOT_TOKEN=...
OCEAN_TELEGRAM_BOT_USERNAME=vas_ocean_bot
```

Uživatel otevře Telegram z menu účtu a použije desetiminutový jednorázový 128bitový kód. Centrální bot podporuje `/status` a bezpečné `/pause`; obnovení obchodování zůstává pouze v přihlášeném dashboardu.

## Provoz

Pokud Ocean běží za reverzní proxy, vložte její přesnou adresu nebo CIDR do `TRUST_PROXY`. Nenechávejte aplikaci důvěřovat libovolnému proxy hopu.

Produkční Docker/Railway postup je v [docs/deploy-railway.md](docs/deploy-railway.md). Kontejner obsahuje Ocean server i Python runtime pro osobní Testnet workery; stavová data patří na připojený volume `/data`.

`npm run backup` vytvoří konzistentní a zkontrolovanou kopii SQLite databáze v `data/backups`. `npm run restore:drill` vytvoří novou zálohu, obnoví ji do dočasné databáze a ověří integritu, vazby, tabulky i počty řádků bez zásahu do běžícího Oceanu. Soubory databáze, záloh, stavů a logů jsou lokálně omezené na vlastníka procesu. Umístění a retenci lze změnit pomocí `BACKUP_DIRECTORY` a `BACKUP_RETENTION_DAYS`.

Volitelné vzdálené zálohy se před odesláním šifrují samostatným klíčem AES-256-GCM. Po uploadu Ocean objekt znovu stáhne, ověří kontrolní součet, autentizaci, SQLite integritu, vazby a počty řádků. Nastavení S3-kompatibilního úložiště, automatického plánu a obnovy je v [docs/deploy-railway.md](docs/deploy-railway.md). Klíče `OCEAN_CREDENTIALS_KEY` a `OCEAN_BACKUP_KEY` uchovávejte odděleně od databáze i od sebe; ke kompletní obnově jsou potřeba oba.

Provozní kontrola je dostupná na `/api/ready`. HTTP 200 znamená, že databáze prošla kontrolou integrity a povinné integrace mají konfiguraci; HTTP 503 znamená, že instance nemá přijímat provoz. `/api/health` zůstává jednoduchý liveness endpoint.

## Bezpečnostní základy

- hesla jsou hashována pomocí Argon2id,
- session tokeny mají 256 bitů entropie a v databázi se ukládá pouze jejich SHA-256 hash,
- cookie je `HttpOnly`, `SameSite=Lax` a v produkci `Secure`,
- autentizační endpointy mají omezení počtu požadavků,
- login používá stejnou chybu pro neexistující účet i špatné heslo,
- zapisují se události vytvoření účtu a přihlášení,
- mutace kontrolují `Origin` proti `APP_ORIGIN`.

Před Mainnetem zůstává povinné dokončit rotaci tajemství, automatizované testy obnovy ze zálohy, oddělené omezené oprávnění každého workeru a provozní monitoring. Osobní supervisor proto automaticky spouští pouze Testnet instance. Mainnet se nesmí zpřístupnit pouhou změnou přepínače v rozhraní.
