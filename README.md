# OCEAN

Ocean je společný projekt webového účtu a aplikace Kryptotron.

```text
Ocean/
├── src/                    webový server a API
├── public/                 uživatelské rozhraní
├── services/kryptotron/    Binance worker
└── data/                   lokální databáze Oceanu
```

Aktuální vertikální řez v0.1 obsahuje registraci, přihlášení pomocí username, odhlášení, změnu a obnovu hesla, chráněný profil, serverové sessions, ověření e-mailu a auditní události. E-mail ani username nejsou identita; účet má neměnné interní `usr_…` ID.

## Spuštění

```bash
npm install
npm run dev
```

Web poběží na <http://localhost:3000>. SQLite databáze vznikne v `data/ocean.db`.

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

Nové Binance připojení Ocean ověří přímo proti zvolenému Testnet/Mainnet API. Mainnet klíč přijme pouze s povoleným čtením a spotovým obchodováním a se zakázanými výběry. Údaje se ukládají samostatně zašifrované pomocí AES-256-GCM a po ověření čekají ve stavu `provisioning` na vytvoření workeru. Před prvním připojením nastavte v `.env` stabilní klíč, který je nutné bezpečně zálohovat:

```bash
openssl rand -base64 32
```

Výsledek vložte jako `OCEAN_CREDENTIALS_KEY`. Jeho ztráta znemožní rozšifrovat uložená Binance připojení; jeho změna vyžaduje řízenou rotaci klíčů.

Po registraci otevřete na profilu **Otevřít mailbox** a použijte poslední ověřovací odkaz. Jde o lokální vývojovou náhradu skutečného e-mailového providera; endpoint mailboxu v produkčním režimu vrací 404.

```bash
npm test
npm run typecheck
npm run build
npm run backup
npm run verify
```

`npm run backup` vytvoří konzistentní kopii SQLite databáze v `data/backups`. Soubory databáze, záloh, stavů a logů jsou lokálně omezené na vlastníka procesu. Umístění a retenci lze změnit pomocí `BACKUP_DIRECTORY` a `BACKUP_RETENTION_DAYS`. Šifrovací klíč `OCEAN_CREDENTIALS_KEY` zálohujte odděleně od databáze; bez obou částí nelze Binance připojení obnovit.

Provozní kontrola je dostupná na `/api/ready`. HTTP 200 znamená, že databáze prošla kontrolou integrity a povinné integrace mají konfiguraci; HTTP 503 znamená, že instance nemá přijímat provoz. `/api/health` zůstává jednoduchý liveness endpoint.

V produkci nastavte e-mailový outbox:

```text
RESEND_API_KEY=...
EMAIL_FROM=Ocean <ocean@vase-domena.cz>
```

Pro osobní Telegram propojení použijte samostatného bota, který současně neběží v Railway workeru:

```text
OCEAN_TELEGRAM_BOT_TOKEN=...
OCEAN_TELEGRAM_BOT_USERNAME=vas_ocean_bot
```

Uživatel otevře Telegram z menu účtu a použije desetiminutový jednorázový kód. Centrální bot podporuje `/status` a bezpečné `/pause`; obnovení obchodování zůstává pouze v přihlášeném dashboardu.

Pokud Ocean běží za reverzní proxy, vložte její přesnou adresu nebo CIDR do `TRUST_PROXY`. Nenechávejte aplikaci důvěřovat libovolnému proxy hopu.

## Bezpečnostní základy

- hesla jsou hashována pomocí Argon2id,
- session tokeny mají 256 bitů entropie a v databázi se ukládá pouze jejich SHA-256 hash,
- cookie je `HttpOnly`, `SameSite=Lax` a v produkci `Secure`,
- autentizační endpointy mají omezení počtu požadavků,
- login používá stejnou chybu pro neexistující účet i špatné heslo,
- zapisují se události vytvoření účtu a přihlášení,
- mutace kontrolují `Origin` proti `APP_ORIGIN`.

Před Mainnetem zůstává povinné dokončit rotaci tajemství, automatizované testy obnovy ze zálohy, oddělené omezené oprávnění každého workeru a provozní monitoring. Osobní supervisor proto automaticky spouští pouze Testnet instance. Mainnet se nesmí zpřístupnit pouhou změnou přepínače v rozhraní.

Supabase tabulky Kryptotronu `bot_state` a `bot_trades` mají zapnuté RLS bez veřejných policy a server k nim přistupuje pouze serverovým klíčem. Ve společném projektu CrackleCore existují také tabulky jiných aplikací; jejich policy upravujte odděleně, protože plošné zapnutí RLS může danou aplikaci zastavit.
# Ocean Invite Alpha

Ocean je uzavřený systém. První účet získá roli `owner`; všechny další účty vyžadují jednorázovou pozvánku vytvořenou vlastníkem. Pozvánka platí sedm dní, lze ji omezit na konkrétní e-mail a před použitím ji lze zrušit. V databázi se ukládá pouze hash tokenu.

Po přihlášení otevře vlastník správu přes profil → **Pozvánky**. Pro odkazy použitelné mimo lokální počítač musí `APP_ORIGIN` obsahovat veřejnou adresu Oceanu.
