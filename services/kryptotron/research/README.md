# Ocean Strategy Lab

Výsledky `validate.py` jsou explorace na známé historii. Výběr režimového
vstupu podle těchto výsledků už je výběrem strategie na datech, i když se
číselné parametry nemění. Percentil mezi 40 náhodnými běhy není důkaz OOS
výkonnosti ani statistická pravděpodobnost budoucího úspěchu.

## Data a běžná validace

Z kořene repozitáře:

```bash
python3 services/kryptotron/research/validate.py --start 2023-03-25
```

Datum je explicitně zvolený začátek souvislé historie současné cache.
Celá cache od roku 2018 obsahuje mimo jiné mezeru od září 2022 do března
2023; 15m data mají navíc výpadek 24. března 2023. Data gate teď při
mezerách, duplicitách či neplatných OHLC skončí
s nenulovým kódem. Mezery se automaticky nevyplňují. Svíčka neuzavřená
v okamžiku stažení se nepočítá; u staré cache se okamžik pořízení odvozuje
z mtime souboru. Zachovejte tedy mtime starých snapshotů.

## Předem zamčený forward holdout

```bash
python3 services/kryptotron/research/holdout.py lock \
  --train-start 2023-03-13 --test-start 2026-09-21 --test-end 2026-12-20 \
  --output services/kryptotron/research/holdout-2026-09-21.json
```

Tento konkrétní protokol byl připraven 20. září 2026. Pro nový experiment
zvolte budoucí datum a jiný soubor. Interval je UTC, konec je výlučný.
Holdout používá pouze 4h data, která jsou souvislá už od 13. března 2023.
Příkaz nikdy nepřepíše existující soubor. Protokol ukládá hash trénovacích
dat, zdrojů a verze Pythonu/pandas, fixní parametry, testovací období
alespoň 90 dní a seznam náhodných seedů. Frekvence náhodných vstupů se
kalibruje pouze na trénovací části; v testu se již neladí. Počty obchodů
náhodných kontrol jsou přibližné, report uvádí jejich skutečný rozsah.

Po konci intervalu spusťte pod uloženými verzemi kódu a runtime:

```bash
python3 services/kryptotron/research/holdout.py evaluate \
  --lock services/kryptotron/research/holdout-2026-09-21.json \
  --output /tmp/ocean-holdout-result.json
```

Před vyhodnocením je nutné obnovit data: zálohujte `.backtest_cache`
včetně mtime, odstraňte pouze pracovní `BTCUSDC_4h.json` a
`ETHUSDC_4h.json` a spusťte příkaz znovu. Chybějící cache se stáhne
z veřejného Binance API. Původní snapshot potřebujete pro kontrolu
reprodukovatelnosti. Pokud Binance změnila historické ceny, vyhodnocení
odmítne změněný hash; historická data ani protokol nepřepisujte jen proto,
aby kontrola prošla. Snapshoty chraňte před změnami mimo Git.

Vyhodnocení odmítne předčasný běh, změnu protokolu/kódu/runtime/trénovacích
dat i chybějící svíčky. Historie před testem slouží pouze pro zahřátí EMA;
test začne s hotovostí bez přenesených pozic a nikdy nepoužívá data za
koncem intervalu. Report porovná režimový vstup, původní cross, buy & hold,
dvojnásobné náklady a fixované náhodné kontroly. Testy s umělými daty
ověřují izolaci časových hranic, nikoli výkonnost strategie.

Hash chrání proti neúmyslné změně, není nezávislým časovým razítkem.
Protokol a použitý kód je potřeba uchovat ve verzovací historii před
začátkem testu. Žádný dosud viděný úsek historie nelze zpětně označit za
nedotčený holdout. Skutečný výsledek tohoto testu bude dostupný nejdříve
20. prosince 2026 v 00:00 UTC.

## Omezení vůči workeru

- Worker počítá EMA z posledních 209 uzavřených svíček při výchozím
  `ema_slow=200`; research je počítá z celé předané historie.
- Research model používá nezávislé sleeves 50/50; worker používá 25 %
  dostupné hotovosti se stropem 50 USDC na objednávku a sdílené limity.
- Research nemodeluje provozní cooldowny, denní/týdenní limity ani
  asynchronní plnění a rekonciliaci objednávek.
- Research aplikuje trailing z high až na další svíčku. Ocean worker
  používá burzovní OCO, které může plnit uvnitř svíčky. Samotná 4h OHLC
  data neobsahují jednoznačné pořadí cen uvnitř svíčky.
- Simulované vstupy na close s pevným skluzem nejsou skutečná market
  plnění po uzavření svíčky. Otevřené pozice na konci se oceňují trhem,
  bez vynucené likvidace.

Proto ani úspěšný holdout tohoto modelu automaticky nepovoluje produkční
obchodování. Nejdřív je nutné sjednotit model s cílovým workerem a ověřit
provedení v izolovaném testovacím provozu.
