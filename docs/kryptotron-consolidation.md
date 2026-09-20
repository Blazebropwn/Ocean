# Převod původního Kryptotronu do Oceanu

Cílem je jedna služba Ocean, jeden zdroj kódu a jeden Telegram bot.
Supervisor spravuje i účet vlastníka stejně jako ostatní účty. Původní
Railway služba nesmí běžet současně s jeho novou osobní instancí.

## Předpoklady

- Zelené `npm run verify`, nasazený aktuální Ocean a schéma 4.
- Původní worker bez strategických pozic, otevřených Binance objednávek,
  nedokončené ochrany a nedokončeného DCA nákupu. Kontrola pouze stavu
  v databázi nestačí: je nutné ověřit i `GET /api/v3/openOrders`.
- Vlastník má propojený centrální Ocean Telegram.
- V produkci jsou aktivní supervisor a serverové povolení Mainnetu.
- Připravený šifrovaný paket s Binance klíči. Formát:
  `{instanceId, encrypted}`; `encrypted` vytvoří `encryptCredential`
  pod `OCEAN_CREDENTIALS_KEY` s AAD `ocean-consolidation:<instanceId>`.
  Obsah je `{apiKey, apiSecret}`. Přístupové údaje se nevypisují do logu
  ani neposílají jako parametry příkazové řádky.

## Postup

1. Nasadit sjednocený Ocean. Existující mapování `main` se zatím zachová
   a supervisor ho nespustí. Ověřit readiness a registraci Telegram bota.
2. V kontejneru provést `node scripts/consolidate-kryptotron.mjs check <packet>`.
   Ověří Binance oprávnění ze sítě Oceanu, nulové otevřené objednávky,
   čistý stav, chybějící cílový záznam a propojený Telegram.
3. Odpojit zdroj staré Railway služby, zastavit její deployment a ověřit,
   že neběží. Zachovat možnost obnovy ze zálohy do dokončení přechodu.
4. Spustit `node scripts/consolidate-kryptotron.mjs stage <packet> --legacy-stopped`.
   Provede nové kontroly, ověřenou SQLite zálohu, šifrovanou zálohu
   vzdáleného stavu a obchodů, uloží šifrované Binance připojení a přepne
   instanci na `suspended`. Worker se ještě nespustí.
5. V jediné Postgres transakci přejmenovat `bot_state.key` z `main` na
   existující `kry_…` vlastníka a `bot_trades.instance_id` na totéž ID.
   Použít připravený stav: `entries_paused=true`, `dca.enabled=false`,
   `environment=mainnet`, `runtime_status=provisioning`, bez starých
   Telegram potvrzení; ponechat všechny nákupy, pozice a risk historii.
   Přidat `consolidation.from=main` a zaznamenat původní hodnoty ovládání.
   Před zápisem zamknout zdrojový řádek a ověřit, že cílový neexistuje.
6. Spustit `node scripts/consolidate-kryptotron.mjs activate`.
   Odmítne aktivaci při existenci `main`, chybějících klíčích nebo
   nepřipraveném cíli. Transakčně nastaví osobní mapování a zapíše audit.
7. Ověřit jediný běžící worker, nový heartbeat, historii, Binance spojení,
   pozastavené vstupy, vypnuté DCA a příjem zpráv do centrální fronty.
   Odesílání vybírá příjemce podle účtu, ne podle údajů dodaných workerem.
8. Po úspěchu odstranit dočasný paket, vyřadit starou Railway službu a
   archivovat původní repozitář. Starého Telegram bota zruší jeho vlastník
   v BotFather; nepatří do nového runtime. Zálohy zůstávají mimo aktivní
   provoz a nejsou druhou instancí aplikace.

Převod sám neobnovuje obchodování. Připravené nové vstupy a DCA aktivuje
uživatel až po ověření. Při selhání mezi kroky 4–6 zůstává účet zastavený;
nejdřív se porovná SQLite a vzdálený stav se zálohami. Starý worker se
nesmí znovu spustit, dokud je nová instance aktivní.

## Provozní omezení

Notifikace mají trvalou frontu, ID omezené na instanci, deduplikaci při
opakovaném přijetí a nejvýše pět pokusů o doručení. Po nejistém síťovém
výsledku odeslání na Telegram nelze garantovat přesně jedno doručení;
fronta nezaručuje přesnost, kterou samotné Telegram API neposkytuje.
Záznamy fronty se uchovávají 30 dní. Klíč bota má pouze Ocean server.

Migrační kompatibilita s `main` zůstává v historických SQLite migracích
a čtecích cestách pro starší instalace. Nové registrace ji nevytvářejí.
