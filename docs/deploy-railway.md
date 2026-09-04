# Ocean na Railway

Ocean se nasazuje jako jediná služba z kořenového `Dockerfile`. Původní Blazebro Railway worker zůstává samostatný a jeho nastavení se při tomto postupu nemění.

## 1. Služba a disk

1. V Railway vytvořte nový service z repozitáře Ocean.
2. Ponechte jednu repliku v jednom regionu.
3. Připojte volume s mount path `/data`.
4. V Networking vygenerujte HTTPS doménu.
5. Healthcheck nastavte na `/api/ready` s timeoutem 300 sekund.
6. Restart policy nastavte na `ON_FAILURE`.

SQLite databáze, zálohy a adresáře osobních workerů musí zůstat na `/data`. Více replik nad jedním SQLite souborem není podporováno.

## 2. Proměnné

```text
NODE_ENV=production
HOST=0.0.0.0
DATABASE_PATH=/data/ocean.db
BACKUP_DIRECTORY=/data/backups
BACKUP_RETENTION_DAYS=30
APP_ORIGIN=https://vase-ocean-domena
KRYPTOTRON_SUPERVISOR_ENABLED=true
KRYPTOTRON_PYTHON=/opt/venv/bin/python
KRYPTOTRON_SUPABASE_URL=...
KRYPTOTRON_SUPABASE_KEY=...
OCEAN_CREDENTIALS_KEY=...
OCEAN_TELEGRAM_BOT_TOKEN=...
OCEAN_TELEGRAM_BOT_USERNAME=...
OCEAN_MANUAL_APPROVAL_ENABLED=true
RESEND_API_KEY=...
EMAIL_FROM=Ocean <ocean@vase-domena.cz>
```

`KRYPTOTRON_SUPABASE_KEY`, `OCEAN_CREDENTIALS_KEY`, Telegram token ani Binance klíče nesmí být součástí repozitáře nebo veřejných proměnných frontendu. Hodnotu `OCEAN_CREDENTIALS_KEY` po vytvoření neměňte bez řízené rotace a samostatné zálohy.

## 3. První kontrola

Po nasazení ověřte:

```text
GET https://vase-ocean-domena/api/health  -> 200
GET https://vase-ocean-domena/api/ready   -> 200
```

Potom vytvořte novou testovací pozvánku a celý onboarding proveďte pouze na Binance Testnetu. Mainnet osobních účtů zůstává automaticky zakázaný.

## 4. Zálohy

Railway volume zachová data při restartu a deployi, ale nenahrazuje nezávislou zálohu. Pravidelně spouštějte `npm run backup` a kopii z `/data/backups` ukládejte mimo danou Railway službu. Obnovu je nutné vyzkoušet před prvním Mainnet pilotem.
