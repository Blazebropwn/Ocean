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
OCEAN_OFFSITE_BACKUP_ENABLED=false
OCEAN_OFFSITE_BACKUP_TIME=03:15
OCEAN_OFFSITE_BACKUP_TIME_ZONE=Europe/Prague
OCEAN_BACKUP_KEY=...
OCEAN_BACKUP_S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
OCEAN_BACKUP_S3_REGION=auto
OCEAN_BACKUP_S3_BUCKET=ocean-backups
OCEAN_BACKUP_S3_ACCESS_KEY_ID=...
OCEAN_BACKUP_S3_SECRET_ACCESS_KEY=...
OCEAN_BACKUP_S3_PREFIX=ocean
APP_ORIGIN=https://vase-ocean-domena
KRYPTOTRON_SUPERVISOR_ENABLED=true
KRYPTOTRON_PYTHON=/opt/venv/bin/python
KRYPTOTRON_SUPABASE_URL=...
KRYPTOTRON_SUPABASE_KEY=...
OCEAN_CREDENTIALS_KEY=...
OCEAN_TELEGRAM_BOT_TOKEN=...
OCEAN_TELEGRAM_BOT_USERNAME=...
OCEAN_MANUAL_APPROVAL_ENABLED=true
TRUST_PROXY=100.0.0.0/8
RESEND_API_KEY=...
EMAIL_FROM=Ocean <ocean@vase-domena.cz>
```

`KRYPTOTRON_SUPABASE_KEY`, `OCEAN_CREDENTIALS_KEY`, `OCEAN_BACKUP_KEY`, přístupové údaje k úložišti, Telegram token ani Binance klíče nesmí být součástí repozitáře nebo veřejných proměnných frontendu. Hodnotu `OCEAN_CREDENTIALS_KEY` po vytvoření neměňte bez řízené rotace a samostatné zálohy.

`TRUST_PROXY` je omezené na privátní proxy rozsah Railway. Nepoužívejte hodnotu `true`, která by důvěřovala libovolnému odesílateli hlaviček.

## 3. První kontrola

Po nasazení ověřte:

```text
GET https://vase-ocean-domena/api/health  -> 200
GET https://vase-ocean-domena/api/ready   -> 200
```

Potom vytvořte novou testovací pozvánku a celý onboarding proveďte pouze na Binance Testnetu. Mainnet osobních účtů zůstává automaticky zakázaný.

## 4. Zapnutí supervisoru osobních botů

Supervisor spouští osobní Kryptotrony členů jako samostatné procesy vedle Oceanu. Běží **výhradně testnetové** instance členů — vyžaduje `environment = testnet` a `remote_state_key = id` instance. Vlastnický mainnet bot (`remote_state_key = main`) se nespouští a zůstává na samostatné Railway službě beze změny, takže zapnutí se nedotkne reálného obchodování.

Před zapnutím musí být nastaveno, jinak se supervisor sám vypne a jen to zaloguje:

- `OCEAN_CREDENTIALS_KEY` — stejný klíč, jakým se šifrovaly Binance údaje členů;
- `KRYPTOTRON_SUPABASE_URL` a `KRYPTOTRON_SUPABASE_KEY`;
- `KRYPTOTRON_PYTHON=/opt/venv/bin/python` — Python s worker závislostmi je součástí runtime image;
- připojený zapisovatelný `/data` volume (adresáře `/data/instances/<id>/`).

Alespoň jeden člen musí být schválený a mít připojené testnet klíče; jinak není co spouštět a supervisor zůstává v klidu.

```text
KRYPTOTRON_SUPERVISOR_ENABLED=true
```

Po redeployi ověřte:

- v logu zmizí `Kryptotron supervisor je vypnutý`; u připojeného člena naběhne `Osobní Kryptotron se spouští` a poté `Kryptotron připraven`;
- ve správě členů (Pozvánky → Členové) přejde stav bota člena z `Připravuje se` na `Běží`;
- `GET /api/ready` → 200.

Vypnutí je okamžité a nedestruktivní: `KRYPTOTRON_SUPERVISOR_ENABLED=false` a redeploy ukončí spawnuté workery přes SIGTERM. Každý běžící člen znamená jeden Python proces navíc na replice, takže při větším počtu členů sledujte paměť. Jedna replika nad jedním SQLite souborem zůstává podmínkou.

## 5. Zálohy

Railway volume zachová data při restartu a deployi, ale nenahrazuje nezávislou zálohu. Pravidelně spouštějte `npm run backup` a kopii z `/data/backups` ukládejte mimo danou Railway službu. Obnovu je nutné vyzkoušet před prvním Mainnet pilotem.

Nedestruktivní kontrola vytvoří čerstvou zálohu, obnoví ji do dočasného adresáře a porovná její strukturu i počty řádků:

```bash
npm run restore:drill
```

Při skutečné obnově nejprve zastavte službu. Zálohu obnovte do nového souboru; příkaz záměrně nikdy nepřepisuje existující databázi:

```bash
npm run restore -- /data/backups/ocean.db.CAS.backup /data/ocean-restored.db
```

Potom nastavte `DATABASE_PATH=/data/ocean-restored.db`, službu znovu spusťte a ověřte `/api/ready`. Původní databázi ponechte beze změny pro možnost návratu. Obnovené šifrované Binance údaje jsou použitelné pouze se správnou zálohou `OCEAN_CREDENTIALS_KEY`.

### Nezávislá šifrovaná kopie

Ocean podporuje libovolné soukromé S3-kompatibilní úložiště. Pro Cloudflare R2:

1. vytvořte nový privátní bucket pouze pro Ocean;
2. vytvořte S3 API token s oprávněním Object Read & Write omezeným jen na tento bucket;
3. veřejný vývojový subdomain ani vlastní veřejnou doménu pro bucket nezapínejte;
4. nastavte lifecycle pravidlo podle požadované vzdálené retence, například 90 dní;
5. vygenerujte samostatný klíč `openssl rand -base64 32` a uložte jej také mimo Railway a mimo R2;
6. doplňte proměnné `OCEAN_BACKUP_*` a nejprve ponechte `OCEAN_OFFSITE_BACKUP_ENABLED=false`.

První end-to-end zkoušku spusťte přes Railway SSH:

```bash
npm run backup:offsite
```

Příkaz vytvoří konzistentní lokální zálohu, zašifruje ji AES-256-GCM, odešle, znovu stáhne a provede úplnou kontrolu obnovitelnosti. Po úspěchu nastavte `OCEAN_OFFSITE_BACKUP_ENABLED=true`. Ocean pak jednou denně po čase `OCEAN_OFFSITE_BACKUP_TIME` v zadané IANA zóně vytvoří a ověří vzdálenou kopii; výchozí čas je 03:15 v `Europe/Prague`. Poslední úspěšný místní den ukládá na volume, takže restart služby nevytváří opakovanou denní kopii.

Vzdálený objekt lze obnovit pouze do nového souboru:

```bash
npm run restore:offsite -- ocean/ROK/MESIC/DEN/SOUBOR.obk /data/ocean-restored.db
```

Příkaz záměrně nikdy nepřepisuje existující databázi. `OCEAN_BACKUP_KEY` není totéž co `OCEAN_CREDENTIALS_KEY`: první chrání celý backup objekt, druhý šifruje Binance údaje uvnitř databáze. Pro úplnou obnovu potřebujete oba.
