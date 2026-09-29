# Kryptotron v1 — audit před implementací

Výchozí commit: `88d8383` (23. 9. 2026). Audit 26. 9. 2026 je kontrola
zdrojů a lokálních testů, nikoliv potvrzení aktuálního produkčního deploye.
`ocean-showcase` podle svého README zachycuje starší single-user verzi;
aktuální architektura je v tomto repozitáři Ocean. Rozpracované změny
čitelnosti Přehledu z předchozího úkolu jsou zachované.

## Současný tok

1. Supervisor spustí osobní Python worker s vlastními Binance credentials,
   instance-scoped broker tokenem a pracovním adresářem. Server drží
   Supabase service key; worker jej nedostává. SQLite spravuje účty a
   instance, Supabase `bot_state` a `bot_trades` ekonomický stav.
2. Worker načte vzdálený stav. Lokální `state.json` není fallback.
   Na startu dohledá pending BUY a OCO; obnoví balance.
3. Po hranici 4h + 30 s načte 210 svíček, poslední zahodí. Z 209 close
   počítá pandas EWM `adjust=False`, EMA50/200. Testnet používá veřejná
   mainnet data pro signál, testnet účet pro exekuci.
4. Flat + EMA50 > EMA200 → kontrola pauzy, pending objednávek, sdílených
   ztrát, četnosti a cooldownů → `min(free USDC * .25, 50)`.
5. Před BUY uloží intent s clientOrderId, potom odesílá market order.
   Potvrzené FILLED uloží, vytvoří a uloží OCO: stop -10 %, trailing
   aktivace +3 %, trailing delta 150 BIPS.
6. V pozici kontroluje OCO; death cross vyvolá ověřené zrušení OCO a
   market sell. Historie uzavření jde samostatným požadavkem do brokeru.
7. Vzdálený stav → API snapshot → dashboard. Události mají limit 20,
   DCA historie 156 nákupů. Heartbeat běží po minutě, přehled zůstatků
   se obnovuje průběžně, kontrola ochrany dosud hlavně po 4h.

## Strategy Lab versus worker

| Oblast | Worker | Zamčený research | Význam |
| --- | --- | --- | --- |
| Entry | bull režim, flat | bull režim; cross jako kontrola | Stejné pravidlo, jiné indikátory |
| EMA | rolling 209 uzavřených svíček | celá historie | Mění signály; zásadní |
| Timing | market po uzavření, start i mimo hranici | close + fixní skluz | Aproximace plnění |
| Sizing | 25 % free quote, nejvýše 50 USDC, pořadí BTC/ETH | nezávislé sleeves 50/50 | Zásadní |
| Limity | den 5 USDC / 3 vstupy; týden 15 USDC / 9 vstupů | nemodelované | Zásadní |
| Cooldown | po 2 ztrátách 24 h; po výhře 6 h | nemodelovaný | Zásadní |
| Exit | death cross událost nebo exchange OCO | death cross a OHLC stop model | Restart může minout death cross |
| OCO | intrabar burzovní spouštění a partial fills | trailing z high až od další svíčky | OHLC nezná pořadí ticků |
| Fees | fills obsahují commission, PnL dosud gross | fixní 0,1 % | Risk evidence není net |
| Slippage | skutečné VWAP fills; sell fallback na entry je chybný | fixní 0,05 % | Zásadní pro evidenci |
| Account | jeden sdílený účet s DCA / externími aktivy | virtuální oddělené sleeves | Nelze z balance odvodit vlastnictví strategie |

Výsledky explorace nejsou důkaz edge produkční implementace. Existující
forward holdout končí 20. 12. 2026 UTC a záměrně měří původní research
model. Jeho JSON, zdroje uvedené v hashi, cache a hranice musí zůstat
beze změny. Nový model parity musí být vedle něj, nikdy dodatečná úprava
zamčeného experimentu. Nový benchmark používá jen před-holdout historii.

## Kritické failure modes

- Terminal BUY s `executedQty > 0` dosud vymaže pending bez evidence pozice.
- Jediné `-2013` dosud maže intent; po timeoutu jde o nejednoznačný stav,
  ne nezávislý důkaz, že žádné plnění nenastalo.
- SELL nemá durable intent / clientOrderId; chybějící fills dokonce vrací
  entry cenu. Restart po prodeji může vést k opakovanému prodeji.
- Po chybě ukládání FILLED může lokální paměť ztratit pending, ač broker
  stále drží starý stav. Neúspěšné zápisy se na více cestách ignorují.
- Dva neúspěchy OCO vyvolávají nouzový sell i při nejednoznačné odpovědi.
  Je nutné nejdřív určit, zda ochrana skutečně vznikla.
- OCO parser ignoruje částečná plnění. Neověřuje celkové držené množství,
  jiné otevřené objednávky ani pokrytí ochrany.
- Připojení jiných credentials zachová původní stav (správně), ale chybí
  nezávislé ověření souladu s novým účtem.
- DCA pending může zůstat po minulém týdnu a být přepsán novým během.
  Dostupný balance se kontroluje před dohledáním již odeslaného nákupu.
- Pause/control a worker ukládají celé JSON: souběžný read-modify-write
  může ztratit příkaz nebo novější exekuční stav. Vyžaduje serializaci
  a zachování vlastnictví polí, nikoliv pouze další čtení ve workeru.
- Trade log není idempotentní a jeho chyba se zahodí. Limit historie DCA
  zahazuje starší ekonomické události; UI již přiznává omezený rozsah.

Binance výslovně označuje timeout / 5xx jako neznámý výsledek exekuce:
[REST API](https://developers.binance.com/en/docs/products/spot/rest-api).
Trailing OCO má vlastní tickovou sémantiku:
[oficiální FAQ](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/trailing-stop-faq.md).

## Nejmenší sada změn s největším dopadem

1. Centrální deterministické risk důvody a safety gate; read-only účetní
   reconciliation před vstupem, na startu a průběžně. Nejednoznačný stav
   blokuje nové příkazy; žádné agresivní automatické dorovnávání účtu.
2. Zachovat pending při nejistotě / částečném plnění, durable SELL,
   provázat persistence a kontrolu ochrany. Opravy exekuční bezpečnosti
   popsat jako změnu mainnet chování; neměnit signál ani sizing.
3. Strukturované decision snapshots a trade evidence, explicitní stav
   reconciliation/rizika v API a stávajícím dashboardu. Oddělit lidský
   důvod od diagnostiky; kritickou chybu vždy ukázat.
4. Samostatný production-model benchmark s rolling EMA, sdílenou cash,
   limity, cooldowny, náklady a označenou intrabar aproximací; B&H, DCA,
   cash a random se stejným trendovým risk/exit modelem.
5. Regresní fault-injection testy a reprodukovatelný testnet scénář,
   zachovat supervisor/readiness/izolaci a existující testy.

## Výchozí ověření

`npm run verify` prošel build a Node testy, ale systémový Python nemá
`python-binance`; lokální `.venv` potřebné závislosti obsahuje. Další
ověření použije `.venv/bin` v PATH. Žádné burzovní příkazy, nasazení,
produkční změny ani odesílání zpráv tento audit neprovádí.
