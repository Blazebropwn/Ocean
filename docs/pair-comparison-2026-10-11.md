# BTC/USDC versus SOL/USDC — 11. října 2026

Závěr: tento průzkumný model nedává přesvědčivý důvod nahradit BTC za SOL.
SOL má jemnější krok množství pro malé objednávky, ale v modelu obchoduje
častěji, platí více poplatků a při kapitálu 100 USDC má kombinace SOL + ETH
ve všech čtyřech scénářích hlubší maximální propad než BTC + ETH.
V jednom ze čtyř scénářů má SOL + ETH mírně lepší výnos, ve třech horší.
Výsledek tedy není univerzální vítězství BTC ani důkaz budoucí výkonnosti.

Mainnet, obchodní parametry, otevřené pozice a původní zamčený holdout
nebyly změněny. Jde o lokální výzkum nad veřejnými cenovými daty.

## Co jsme porovnali

- Primárně stávající pořadí BTC/USDC → ETH/USDC proti SOL/USDC → ETH/USDC,
  se sdílenou hotovostí a rizikovými limity. Doplňkově BTC a SOL samostatně.
- Kapitál 100 USDC pro malý účet a 1 000 USDC pro citlivost na strop velikosti pozice.
  Bez vkladů, souběžného DCA a počátečních pozic.
- Stejné rolling EMA50/200 na 4h datech, vstup v BULL režimu,
  25 % volné hotovosti / maximálně 50 USDC, stop −10 %, aktivace trailing +3 %,
  vzdálenost trailing 1,5 %, původní denní/týdenní limity a pauzy.
- Základní náklady: 0,1 % poplatek a 0,05 % nepříznivý skluz na každé straně.
  Zátěžový scénář: 0,2 % a 0,1 % na každé straně. Jde o pevné předpoklady,
  nikoli rekonstrukci konkrétních historických sazeb účtů.
- Dvě aproximace pořadí cen ve svíčce: open → low → high → close
  a open → high → low → close. Nejde o zaručenou spodní a horní mez výsledků.
- Žádné ladění parametrů podle výsledku. Celkem 32 kombinací.

SOL/USDC má v získané historii souvislá 4h data od **28. 12. 2023 08:00 UTC**.
BTC a ETH byly omezeny na stejný úsek: 5 965 svíček na pár.
Po 209 svíčkách pro zahřátí EMA začíná vyhodnocení **1. 2. 2024 04:00 UTC**
a končí **17. 9. 2026 12:00 UTC, výlučně**. Žádné svíčky ze zamčeného
holdoutu začínajícího 21. 9. 2026 nevstoupily do indikátorů ani výsledků.
Vnitřní mezery, duplicity a neplatné OHLC jsou odmítány, nikoli vyplňovány.

## Primární srovnání: účet 100 USDC

Výnosy jsou za celé období, nikoli roční. Zahrnují modelované poplatky
a skluz. Propad se měří na 4h koncových hodnotách portfolia.

| Průběh svíčky / náklady | BTC + ETH: výnos | SOL + ETH: výnos | BTC + ETH: max. propad | SOL + ETH: max. propad |
| --- | ---: | ---: | ---: | ---: |
| Low-first / základní | +27,48 % | +5,70 % | −17,77 % | −26,99 % |
| High-first / základní | −12,70 % | −11,66 % | −28,89 % | −32,18 % |
| Low-first / dvojnásobné | +8,37 % | −15,30 % | −21,12 % | −33,52 % |
| High-first / dvojnásobné | −22,40 % | −29,70 % | −34,72 % | −43,73 % |

Při základních nákladech měl BTC + ETH 233 / 244 uzavřených obchodů
(low-first / high-first), SOL + ETH 330 / 360. Poplatky činily
11,38 / 9,50 USDC proti 14,85 / 14,85 USDC. Skluz je navíc již obsažený
v modelovaných cenách plnění. Častější obchody tedy nejsou automaticky výhoda.

## Citlivost na velikost účtu: 1 000 USDC

| Průběh svíčky / náklady | BTC + ETH: výnos | SOL + ETH: výnos | BTC + ETH: max. propad | SOL + ETH: max. propad |
| --- | ---: | ---: | ---: | ---: |
| Low-first / základní | +6,61 % | +4,51 % | −4,63 % | −5,77 % |
| High-first / základní | −1,25 % | +0,87 % | −5,82 % | −5,50 % |
| Low-first / dvojnásobné | +2,51 % | −0,61 % | −5,83 % | −7,43 % |
| High-first / dvojnásobné | −3,99 % | −4,51 % | −7,85 % | −9,12 % |

Strop 50 USDC snižuje relativní expozici většího účtu. Výsledky proto nelze
lineárně násobit ani interpretovat jako stejnou úroveň rizika obou velikostí účtu.

## Samostatné páry: 100 USDC, základní náklady

| Pár | Výnos low-first | Výnos high-first | Max. propad low-first | Max. propad high-first |
| --- | ---: | ---: | ---: | ---: |
| BTC/USDC | +20,51 % | +1,03 % | −9,06 % | −11,43 % |
| SOL/USDC | +6,16 % | +3,91 % | −18,79 % | −20,64 % |

Také samostatně se pořadí výnosů mění podle intrabar předpokladu.
Kompletní výstup včetně dílčích kalendářních let, šesti časových úseků,
počtů obchodů, poplatků, Sharpe a otisků vstupů je v
[JSON reportu](pair-comparison-2026-10-11.json).

## Co říká zaokrouhlování a co tento model neřeší

Při čtecí kontrole Binance 11. 10. 2026 kolem 07:33 UTC měly oba páry
minimum hodnoty objednávky 5 USDC a podporovaly OCO i trailing.
BTC krok 0,00001 BTC představoval přibližně 0,83 USDC; SOL krok 0,001 SOL
přibližně 0,11 USDC. Podmínky množství a hodnoty objednávky popisují
[Binance filtry](https://developers.binance.com/en/docs/products/spot/filters).
Jde o tehdejší snapshot, ne historické filtry pro celý backtest.

**Model nezaokrouhluje množství a nesimuluje akumulaci reziduí.** Neměří
tedy ekonomickou výhodu jemnějšího kroku SOL. Reziduum není okamžitě ztracený
poplatek: je to zbývající aktivum, které může vázat hotovost a měnit hodnotu.
Z této studie nelze tvrdit, že jemnější zaokrouhlení SOL vykompenzuje nebo
nevykompenzuje slabší výsledky některých scénářů.

Další omezení: chybí tiková data, skutečné spready/hloubka trhu, historické
filtry, poplatky v base asset, minimální hodnota výstupu, zamítnutí ochranných
příkazů, síťové chyby, restarty a ruční zásahy. Otevřené pozice na konci jsou
oceněny trhem bez hypotetického výstupního poplatku. Rizikové limity používají
stejně jako současný worker hrubé P/L, zatímco výsledky této studie zahrnují
modelované náklady. Intrabar maximální propad může být hlubší než vykázaný.

## Reprodukce a další rozhodnutí

Runner používá existující `production_model.py`; původní model ani zdroje
zamčeného holdoutu se kvůli tomuto srovnání neupravovaly. Historie BTC/ETH
zůstala v původní cache, nový SOL snapshot je odděleně v ignorovaném `data/`.
Skript kontroluje časovou souvislost a používá pouze předholdoutové období.
Report obsahuje SHA-256 zdrojů, vstupních souborů, vybraných dat a protokolu.
Nově stažená historie může být burzou revidovaná; porovnejte otisky.

```bash
# Opakování nad stejným lokálním SOL snapshotem; výstup se nepřepisuje:
.venv/bin/python services/kryptotron/research/compare_pairs.py \
  --sol-data data/research/pair-comparison-2026-10-11/SOLUSDC_4h.json \
  --output /tmp/ocean-pair-comparison-repeat.json

# Stažení do NOVÉHO souboru, pouze veřejný GET /api/v3/klines:
.venv/bin/python services/kryptotron/research/compare_pairs.py \
  --download-sol --sol-data /tmp/ocean-sol-fresh/SOLUSDC_4h.json \
  --output /tmp/ocean-pair-comparison-fresh.json

.venv/bin/python -m pytest -q services/kryptotron/tests
```

Další výzkumný krok má smysl zaměřit na přesnější model plnění, zaokrouhlení
a reziduí na jemnějších datech, se stejnými předem stanovenými pravidly pro
oba páry. Prosté přepnutí mainnetu podle jednotkové ceny mince tato studie
nepodporuje. Případná implementace SOL musí současně rozšířit ruční uzavírání,
obnovu ochrany a zachovat správu již otevřených BTC pozic; tyto změny zde nejsou.
