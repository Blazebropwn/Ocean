# Kryptotron v1 — implementační report

Stav: vývojová větev `work/kryptotron-v1-validation`. Změny jsou připravené
pro kontrolu a testnet acceptance, nikoli nasazené do produkce. Produkční
úpravy vzhledu jsou samostatně zaznamenané v commitu `5446f7b` a
[release reportu](releases/ocean-ui-2026-09-27.md).

## WHAT CHANGED

- Centrální entry gate a deterministické decision snapshots.
- Kontrola balances, inventáře, pending objednávek a obou OCO větví při
  startu, před vstupem a přibližně jednou za minutu.
- Durable SELL intent; dohledání objednávky podle stejného clientOrderId;
  evidence terminal partial BUY a blokování nejasného partial SELL/OCO.
- DCA dohledává starý pending před novým během. Kumulativní součty
  zachovají dostupnou historii před ořezem seznamu na 156 záznamů.
- Durable fronta zápisu trade historie, serializace zápisů každé instance
  v brokeru a zachování uživatelských control polí při publikaci workeru.
- Stávající dashboard rozšířený o režim, EMA, důvody, risk limity,
  reconciliation a vysvětlení posledních obchodů.
- Provozní monitor kontroluje i heartbeat, SAFE_MODE a neuloženou historii;
  opakování stejného alertu zůstává hodinové, neúspěšné doručení se opakuje.

## WHY

Nejednoznačná síťová odpověď není důkaz neprovedené objednávky. Dosavadní
kód mohl zapomenout částečně vyplněný BUY, opakovat SELL po restartu nebo
provést nouzový prodej, přestože OCO vznikla. Podrobný výchozí tok a
failure modes jsou v [auditu](kryptotron-v1-audit.md).

## STRATEGY PARITY

Nový `research/production_model.py` používá stejný `get_cross_data`
(rolling 209 uzavřených svíček, pandas EWM adjust=False), sizing a risk
gate jako worker. Modeluje sdílenou hotovost a pořadí BTC/ETH, 25 % free
quote / 50 USDC cap, denní/týdenní limity, cooldowny, fixní fees/slippage
a dvě explicitní možné OHLC cesty ochrany. Signál, parametry ani alokace
produkční strategie nejsou zvýšené.

Benchmark arena používá pouze data do původního `train_end_ms`, před
holdoutem. Obsahuje B&H, DCA z téhož počátečního kapitálu, cash a 40
fixovaných random seedů se stejným trendovým risk/exit modelem. Výstup
obsahuje CAGR/return, Sharpe, Sortino, drawdown, Calmar, win rate, profit
factor, počty uzavřených obchodů, čas na trhu, turnover a fees.

Původní holdout JSON, jeho research implementace a cache zůstávají
nedotčené. `utils.py` se od zamčeného otisku lišil už ve výchozím commitu
`88d8383`; původní frozen ZIP má správné otisky všech zamčených zdrojů.
Pro vyhodnocení 20. 12. 2026 je nutný tento frozen runtime, ne aktuální
pracovní strom. Test ověřuje, že nesprávný runtime zůstává odmítnutý.

Reprodukce nové explorace (výstup se úmyslně nepřepisuje):

```bash
.venv/bin/python services/kryptotron/research/production_validate.py \
  --output /tmp/ocean-production-arena.json
```

## EXECUTION SAFETY

Invarianty platí jako fail-closed entry policy:

- Žádný nový vstup během pauzy, SAFE_MODE, unresolved pending, neuložené
  historie nebo neověřených API permissions.
- Žádný nový vstup při account check starším než 90 s nebo neplatných
  risk counters; tržní data musí být konečná, souvislá a aktuální.
- Neznámý inventář či otevřená objednávka vyvolá kontrolu, nikoliv
  automatické dorovnání prodejem.
- Neověřená ochrana není prezentovaná jako potvrzená díky lokálnímu
  `trail_active`. Chybějící či partial ochrana zablokuje vstupy a upozorní.
- Po timeoutu SELL se dohledává původní příkaz; chybějící fills se nikdy
  nenahrazují vstupní cenou.

Opravy mění bezpečnostní chování i pro mainnet: nejasné `-2013` nyní
ponechá záměr, opakovaný nejasný OCO failure nezpůsobí odhadovaný market
exit a neshoda inventáře zastaví vstupy. Nejde o změnu entry parametrů.

## RECONCILIATION

Autoritou jsou Binance account balance, open orders, order query a fills.
Scope jsou sledované BTC/ETH/SOL páry; cizí majetek není automaticky
považovaný za trendovou pozici. Pending se dohledává i po reconnectu,
který zachovává původní historii. Reconciliation neprovádí dorovnávací
obchody. U známé pozice lze obnovit chybějící ochranu pouze při jinak
ověřeném množství a bez dalších rozporů.

## EXPLAINABILITY

Reason codes pocházejí z konkrétních pravidel; uživatelský text vzniká z
whitelistu. API nepřebírá text vysvětlení z libovolného worker tracebacku.
Decision snapshot obsahuje čas, symbol, režim, cenu, EMA, pozici, rozhodnutí,
důvod, limity a další kontrolu. Trade evidence uchovává skutečné ceny,
množství, entry důvod, stop/trailing parametry a gross PnL. Cena / nominální
riziko ke stopu nejsou slib skutečného plnění při gapu.

## TESTS

`PATH="$PWD/.venv/bin:$PATH" npm run verify` prošel: TypeScript build,
30 Node testovacích souborů a 100 Python testů (včetně následné kontroly
testnet preflight). Python hlásí tři existující
deprecation warnings závislosti websockets. Prohlížečová kontrola prošla
na šesti velikostech (320 až 1440 px), včetně 18 kontrol rozložení a
posouvání, DCA/position dialogů, prázdných a stale stavů, přihlášení
a blokování resume v SAFE_MODE; bez JavaScript chyb. Vizuální kontrola
používala výhradně simulovaná data.
Reprodukovatelný postup a očekávání jsou v
[testnet validaci](kryptotron-testnet-validation.md).

Navazující místní kontrola dne 2026-09-27: `npm run testnet:preflight`
skončil očekávaně `BLOCKED` (exit 2). Místní konfigurace povoluje mainnet,
databáze obsahuje jednu připojenou mainnet instanci a žádnou testnet
instanci. Pro skutečný acceptance běh chybí samostatné testovací
připojení a izolovaná konfigurace. Kontrola nezměnila konfiguraci,
databázi ani burzovní stav; žádný worker nebyl spuštěn. Nové testy
ověřují odmítnutí mainnetu, nejasného výběru instance, legacy state,
chybějících credentials a neúplné konfigurace, absenci úniku tajemství
i to, že chybějící databáze není vytvořena a staré schéma není migrováno.

## KNOWN LIMITATIONS

- Edge není prokázaný. Citlivost výsledku na intrabar předpoklad dokonce
  mění znaménko výnosu. OHLC nemodeluje tick ordering, latency, partial
  fills, historické symbol filters ani skutečný skluz a commission asset.
- Risk limity zachovávají stávající gross-PnL pravidlo, nejsou plně net
  loss budget po všech poplatcích. DCA má vlastní schválenou částku;
  trendový 50 USDC strop není univerzální limit všech DCA objednávek.
- Strategie stále vystupuje na death-cross událost; restart může tuto
  událost minout. Přechod na trvalý BEAR exit by byl změnou strategie
  a vyžaduje vlastní validaci. Burzovní stop zůstává primární ochranou.
- Fail-closed režim není zárukou nepřetržité ochrany během výpadku burzy.
  Chybějící ochrana nebo nejednoznačný partial fill vyžaduje zásah
  operátora, ne automatický agresivní obchod.
- Inventář starší než dostupná DCA historie může vyžadovat doložené
  ruční přiřazení. Kumulativní součty neobnovují již dříve ztracená data.
  Detailní trade explanations uchovávají posledních 100 událostí;
  samostatná `bot_trades` historie se nemaže.
- Serializace brokeru odpovídá současnému jednomu serveru/supervisoru.
  Horizontální multi-server provoz vyžaduje databázové CAS/transakce.
  Deduplikace trade historie pomocí stabilního exit času a query není
  distribuovaná exactly-once záruka při opožděném commitu Supabase.
- Pause působí před dalším odesláním podle naposledy načteného příkazu;
  nemůže odvolat market order, který už burza přijala.
- Skutečné testnet acceptance obchody ani produkční deploy nebyly provedené.
  Readiness/health a původní isolation model zůstávají zachované;
  tento report nepotvrzuje současný vzdálený deployment.

## NEXT HIGHEST-PRIORITY STEP

Provést izolovaný testnet acceptance run se skutečnými fills, restartem
a reconnectem; archivovat evidence. Pro hodnocení strategie potom
zpřesnit intrabar exekuci na jemnějších datech a předem zamknout nový
experiment pro production model. Původní holdout se nevyužívá k ladění.

## EXPLORATORY BENCHMARK RESULT

Výchozí kapitál 1 000 USDC, interval 2023-04-16 až 2026-09-17,
bez vkladů a bez dat z holdoutu. Kompletní metriky, nastavení, datový hash,
zdrojové otisky a všech 40 random běhů:
[JSON report](strategy-arena-2026-09-26.json).

| Model | Výnos | Sharpe | Max drawdown | Uzavřené obchody | Fees USDC |
| --- | ---: | ---: | ---: | ---: | ---: |
| Trend · low-first OHLC | +6.62 % | 0.629 | -4.63 % | 286 | 28.80 |
| Trend · high-first OHLC | -2.70 % | -0.244 | -5.91 % | 296 | 29.71 |
| Trend · dvojnásobné náklady | +1.94 % | 0.198 | -5.86 % | 286 | 57.56 |
| Buy & Hold | +83.34 % | 0.605 | -58.23 % | 0 | 1.00 |
| DCA | +34.09 % | 0.413 | -58.99 % | 0 | 1.00 |
| Cash | +0.00 % | 0.000 | 0.00 % | 0 | 0.00 |

Random median Sharpe: 0.249. To není p-value ani OOS důkaz.
B&H a DCA mají otevřené držby, takže nula uzavřených obchodů neznamená
žádné nákupy; `order_count` je uveden zvlášť v JSON.

Trendový model má kvůli 50 USDC stropu mnohem nižší expozici než B&H.
Absolutním výnosem jej v tomto období nepřekonává. V low-first scénáři má
podobný Sharpe a nižší drawdown, ale samotná změna OHLC pořadí převrátí
výnos do ztráty. **Robustní edge není prokázaný.** Tyto výsledky nejsou
podklad ke zvýšení alokace ani k povolení mainnetu.
