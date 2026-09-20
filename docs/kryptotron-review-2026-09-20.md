# Kryptotron — kontrola 20. září 2026

## Nasazení a stav

Ověřeno přes Railway CLI (metadata nasazení a omezený výpis logů),
read-only SQL nad projektem Ocean a GET veřejného `/api/ready`.

| Služba | Zdroj | Aktivní commit | Nasazení |
| --- | --- | --- | --- |
| Ocean | `Blazebropwn/Ocean` | `55218d240b712eb5c36c0ebcff9ca5816c903a60` | 17. 9. 2026, 21:17 UTC |
| Samostatný worker | `Blazebropwn/binance-bot` | `1bafcee24bc15fac73951cd97a448d0c2be55498` | 15. 9. 2026, 07:11 UTC |

Obě Railway nasazení mají `SUCCESS`, instance `RUNNING`. Ocean readiness
vrací `{"ok":true,"issues":0}`. Nasazení Oceanu samo neaktualizuje worker
z druhého repozitáře.

Log samostatného workeru z 20. 9. 08:00 UTC pro BTC i ETH uvádí `BULL`,
ale současně `Čekám na Golden Cross`. **Režimový vstup v této službě
nasazený není.** Databázový stav `main` k tomuto cyklu uvádí:

- `entries_paused=false`, `runtime_status=waiting`, bez `last_error`;
- další kontrola 12:00 UTC (14:00 českého času);
- BTC, ETH i SOL mají `in_position=false`;
- žádná čekající objednávka ani ochranná objednávka k rekonciliaci.

Jde o stav uložený workerem, nikoli nezávislé čtení zůstatků a objednávek
přímo z Binance. Další tři řádky osobních instancí mají poslední zápis
17. září; jeden zaznamenal chybu Binance `-2015`. Samotné staré řádky
neprokazují, že mají být tyto instance nyní aktivní.

Nebyl proveden deploy, restart, změna vzdálené konfigurace ani přepnutí
pauzy. Nebyly odeslány objednávky ani Telegram zprávy.

## Shoda s backtestem

Kontrola se vztahuje ke kódu Ocean `55218d2`; rozdíly staršího samostatného
workeru nebyly plošně auditovány.

| Oblast | Worker v Oceanu | Research model |
| --- | --- | --- |
| Vstup | EMA50 > EMA200, pokud je flat a limity dovolí | Stejná podmínka, jiné EMA okno |
| Historie EMA | posledních 209 uzavřených 4h svíček | celá předaná historie |
| Velikost pozice | 25 % dostupné hotovosti, strop 50 USDC | nezávislé sleeves 50/50 |
| Risk limity | sdílené denní/týdenní limity a cooldowny | chybí |
| Ochrana | burzovní OCO, možné intrabar plnění | stop a trailing aproximované 4h OHLC |
| Cena vstupu | market po uzavření svíčky | close + fixní skluz |

Rozdíl EMA má měřitelný vliv: při vzorkování každé šesté svíčky celé
cache se býčí/medvědí klasifikace lišila v 161 z 2634 bodů BTC a 149
z 2634 bodů ETH. Jde o diagnostiku nad původní historií s mezerami,
nikoli hodnocení výnosnosti ani čistý kalendářní denní vzorek.

Dosavadní percentily z research modelu nelze považovat za validaci
produkčního workeru. Náhodné kontroly navíc mají přibližnou frekvenci,
nikoliv zaručeně stejný počet obchodů.

## Provedené lokální změny

- Data gate zastaví validaci na mezerách, duplicitách a neplatných OHLC.
  Původní cache skutečně selže: 5 mezer na každé 4h řadě a 22 na každé
  15m řadě. Největší výpadek je září 2022 až březen 2023.
- Cache nepropouští svíčku neuzavřenou v okamžiku jejího stažení.
- `validate.py --start` umožňuje explicitní volbu souvislého období;
  společné 4h/15m období této cache začíná 25. 3. 2023.
- Protokol `research/holdout-2026-09-21.json` připravuje budoucí
  90denní holdout režimového research modelu. Kalibrace náhodných vstupů
  používá pouze známou trénovací historii. Kód, runtime, parametry,
  časové hranice a trénovací data mají kontrolní otisky.
- Předčasné skórování je zakázáno; test začíná bez pozic a starší data
  pouze zahřívají indikátory. Výsledek není automatickým povolením
  produkčního obchodování.
- Opraveny popisky režimového vstupu v logu a připravených Telegram
  zprávách; obchodní rozhodování ani exekuce workeru se nemění.

Podrobný postup, omezení a zachování snapshotu jsou v
[research/README.md](../services/kryptotron/research/README.md).
Protokol je zatím lokálně připravený: před začátkem testu je nutné jej
i použitý kód uchovat ve verzovací historii; hash sám není nezávislým
důkazem data registrace. Dnes není k dispozici žádný skutečný OOS výsledek.

## Ověření a navazující práce

`npm run verify` prošel: TypeScript build, 22 testovacích souborů Node,
61 Python testů. Nové testy kontrolují časovou izolaci holdoutu, odmítnutí
změněných dat/protokolu, neúplných testovacích dat, přepsání protokolu
a nezávislost signálu na neuzavřené svíčce. Předčasné spuštění holdoutu
nad skutečným protokolem skončilo očekávaným odmítnutím.

Celá explorativní pipeline prošla nad souvislým obdobím od 25. 3. 2023;
[uložený výpis](strategy-lab-2026-09-20.txt) obsahuje všechny fáze.
Režimový vstup je v tomto období na 85. percentilu 40 náhodných kontrol
(Sharpe 0,51); původní cross na 57. percentilu. Jde o jiné období než
v původním commitu, takže to není přímá reprodukce jeho čísel. Ani tyto
nové výsledky nejsou nezávislý holdout.

Pro místní reprodukci je v ignorované cache archiv
`services/kryptotron/.backtest_cache/holdout-2026-09-21-frozen.zip`
s přesnými zdroji, protokolem a normalizovaným trénovacím snapshotem.

Další implementační krok je sjednotit model s cílovým workerem, zejména
EMA, sizing a risk limity, a ověřit exekuci v izolovaném testovacím provozu.
Následně připravit konkrétní migrační/nasazovací změnu pro samostatnou
službu `binance-bot`; pouhý deploy Oceanu tuto službu neopraví.
