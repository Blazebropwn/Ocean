# Kryptotron v1 — reprodukovatelná validace

## 1. Deterministické ověření bez burzovních příkazů

Z kořene repozitáře s nainstalovanými projektovými závislostmi:

```bash
PATH="$PWD/.venv/bin:$PATH" npm run verify
.venv/bin/python -m pytest -v services/kryptotron/tests/test_execution_invariants.py
node --import tsx --test test/kryptotron-transparency.test.ts
```

Test `test_entry_protection_restart_pause_resume_and_exit_lifecycle` používá
izolovaný broker snapshot a simulovanou burzu. Ověřuje postup:

1. Prázdný účet, 100 USDC, povolené vstupy → reconciliation OK.
2. Uložený BUY intent → plnění 0,001 BTC za 10 USDC → evidovaná pozice.
3. OCO ID uložené, dvě otevřené ochranné větve → množství odpovídá účtu.
4. Obnova pouze z uloženého broker stavu → žádný další BUY ani druhé OCO.
5. Pauza → entry gate zavřený; resume po ověření → gate otevřený.
6. Potvrzený SELL → pozice uzavřená, historie v durable outboxu.
7. Dokud historie není doručená, další vstup zůstává blokovaný.

Samostatné fault-injection testy ověřují:

| Situace | Očekávaný výsledek |
| --- | --- |
| BUY timeout + následné `-2013` | intent zůstává, žádný nový BUY |
| Terminal BUY s částečným plněním | vyplněná část zůstane evidovaná |
| Commission v base asset | ochrana používá čisté dostupné množství |
| SELL timeout + restart | query stejným clientOrderId, žádný druhý SELL |
| Částečný SELL | pozice se neoznačí za plně uzavřenou |
| OCO timeout nebo opakovaná chyba | SAFE_MODE a alert; žádný odhadovaný market exit |
| Chybějící větev / částečné OCO plnění | účet není označený za zdravý |
| Změněný účet po reconnectu | mismatch množství zablokuje vstupy |
| Starý pending DCA | dohledá se před novým týdnem i před kontrolou balance |
| Broker write failure | pending zachovaný; další vstup blokovaný |
| Pozdní zápis workeru po pauze | pauza zůstává, pozice se neztratí |
| Zastaralý heartbeat / fronta historie | provozní problém viditelný monitoru |

Tento průchod dokládá chování testovacích adaptérů, nikoliv reálné Binance
filtry, latenci nebo dostupnost burzy.

## 2. Skutečný testnet acceptance run

### Místní kontrola před spuštěním

```bash
npm run testnet:preflight
# Při více testnet instancích:
npm run testnet:preflight -- --instance kry_TESTOVACI_ID
```

Příkaz čte konfiguraci testovacího procesu a existující SQLite databázi
v read-only režimu. Nespouští server, workery, migrace ani síťová volání.
Nevypisuje klíče, identitu uživatele ani připojovací adresy. Návratový kód
`2` a stav `BLOCKED` znamenají chybějící podmínky; `0` a `CONFIGURED`
potvrzují pouze místní konfiguraci, ne funkční připojení či úspěšné obchody.
Platnost a dešifrovatelnost Binance klíčů se tímto příkazem neověřují.

Acceptance proces potřebuje samostatnou databázi bez mainnet instancí,
`KRYPTOTRON_MAINNET_ENABLED=false`, vlastní port a testovací účet připojený
přes běžný formulář. Konfiguraci předej tomuto procesu přes prostředí;
neupravuj kvůli testu konfiguraci běžícího ostrého procesu. Nekopíruj do
testovací databáze ostré credentials ani trading state. Více procesů nesmí
obsluhovat stejnou instanci nebo stejný Binance účet. `CONFIGURED` samo
neprokazuje, že jiný proces nepoužívá stejné Binance credentials.

### Živý průchod

Celý přirozený strategický průchod zatím není dokončený. Startup a obnova
izolované instance byly ověřené; dne 2026-09-29 navíc proběhl skutečný
[řízený test ručního výstupu](manual-position-close.md) včetně OCO a pauzy.
Následující širší průchod vyžaduje samostatný testovací Ocean účet/instanci
a Binance Spot Testnet credentials. Zachovej
`KRYPTOTRON_MAINNET_ENABLED=false`. Použij stávající supervisor a broker;
nespouštěj druhého workera na stejném účtu. Testnet se resetuje — takový
reset je mismatch k prověření, nikoliv důvod smazat interní historii.

Před každým během zaznamenej commit, instance ID, prostředí, čas UTC,
počáteční balances, open orders, aktivní symbol filters a hodnoty limitů.
Při čistém účtu nesmí být žádné cizí objednávky ani neoznačené BTC/ETH/SOL.
Pro každou fázi archivuj broker snapshot a odpovídající Binance query;
do Git nepatří credentials ani osobní produkční data.

| Krok | Akce v izolovaném testnet prostředí | Očekávání / důkaz |
| --- | --- | --- |
| Startup | Připoj testnet přes stávající formulář | Vstupy pozastavené; účet zkontrolovaný; žádná objednávka |
| Entry | Obnov vstupy s prostředky alespoň pro symbol minimum | První platný bull check otevře nejvýše `min(25 % free quote, 50 USDC)`; pokud není BULL, očekává se BEAR_REGIME, neladí se EMA |
| Protection | Query order list + obě větve | Stop -10 %, aktivace +3 %, 150 BIPS podle filtrů; chráněné množství odpovídá net fill |
| Restart | Restartuj pouze testovací Ocean proces během pozice | Stejné order/client/list ID, žádný duplicitní BUY/SELL/OCO; reconciliation OK |
| Reconnect | Obnov credentials stejného testnet účtu | Broker historie zůstane; burzovní stav se znovu ověří |
| Pause | Pozastav v Přehledu, počkej na nový check | ENTRIES_PAUSED, žádný nový nákup; existující ochrana zůstává |
| Resume | Obnov po úspěšném ověření účtu | Vstupy pouze pokud dovolí stejná risk pravidla |
| Unavailable | Krátce omez přístup testovacího workeru k burze | SAFE_MODE / UNVERIFIED, žádné nové příkazy, deduplikovaný alert |
| Recovery | Obnov přístup | Nejdřív query existujících intentů, balances a open orders; teprve potom nové vstupy |
| Exit | Počkej na burzovní OCO nebo řádný death cross | Evidence odpovídá skutečnému order fill; historie se uloží jednou při běžných opakováních doručení |

Reject/partial-fill/OCO-failure scénáře jsou deterministicky pokryté v
první části. Živé acceptance testy nesmějí vytvářet nechráněnou pozici
jen pro demonstraci chyby. Pokud burza nevrátí požadovaný scénář, zaznamenej
jej jako neprovedený, nikoliv úspěšný. Skutečná ochrana a network failure
semantics musí být před mainnet nasazením ověřené na testnetu.

## 3. Postup při SAFE_MODE

1. Zkontroluj `reconciliation.issues`, pending záměry a skutečné Binance
   orders/trades/balances. Uživatelská hláška je stručná; přesná příčina
   a traceback zůstávají v diagnostickém logu.
2. Nedávej nový BUY/SELL jen proto, že poslední request skončil timeoutem.
   Dohledávej podle uloženého clientOrderId a exchange orderId.
3. Při nejasném částečném plnění nebo nechráněné pozici musí operátor
   vyhodnotit skutečně dostupné množství. Worker nehádá opravný obchod.
4. U `UNATTRIBUTED_BALANCE` odděl skutečné trendové pozice, DCA a cizí
   majetek. Externí inventář lze evidovat v `unmanaged_inventory`
   (`{"BTC": 0.01}`), ale pouze po nezávislém ověření a se zastaveným
   workerem. Neslouží k zamaskování ztraceného trading state.
5. Pro ruční opravu nejdřív archivuj stav a zastav konkrétního workera.
   Nevynulovávej pozice, pending ani historii naslepo. Změnu zaznamenej
   s konkrétními order IDs, množstvím a důkazem. Po restartu musí znovu
   projít reconciliation. Pauza uživatele se sama nemění.

V této verzi není automatické schvalování nejasného inventáře ani UI pro
ruční opravu účetnictví. Dokud nelze prokázat soulad, vstupy zůstávají
blokované. To je záměrný bezpečný výsledek, nikoliv úspěšné vypořádání.
