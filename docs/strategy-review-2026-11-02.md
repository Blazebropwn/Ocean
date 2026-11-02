# Strategie Kryptotron — opravy a srovnání 2. listopadu 2026

Připravené opravy řeší validaci trailingu a výstup po zmeškaném překřížení.
Čistý vstup při novém golden cross je kandidát pro další paper ověření;
není automaticky nasazenou náhradou produkčního režimového vstupu.
Práce neodesílala obchodní příkazy a neměnila produkční nastavení ani OCO.

## Potvrzené nesrovnalosti a opravy

1. `TAKE_PROFIT SELL` s `aboveTrailingDelta` musí ověřovat
   `minTrailingAboveDelta` / `maxTrailingAboveDelta`. Původní helper četl
   `Below`. Nový helper čte správnou dvojici a odmítá neúplné, necelé,
   nekladné, obrácené a nefinite meze místo tichého převodu.
   Regresní testy používají rozdílné Above/Below rozsahy a ověřují nový
   vstup i explicitní obnovení ochrany.
   [Binance trailing FAQ](https://developers.binance.com/en/docs/products/spot/faqs/trailing-stop-faq).
   Veřejná kontrola `exchangeInfo` 2. 11. 2026 v 00:03 UTC vrátila pro
   BTCUSDC i ETHUSDC stejné obě dvojice 10–2000 BIPS. Chyba tedy v tomto
   snapshotu nemění přijetí stávajících 150 BIPS; oprava řeší nesprávnou
   validaci při rozdílných nebo neplatných filtrech.
2. Worker původně prodával pouze při `death_cross=True`, tedy právě na
   svíčce překřížení. Po výpadku přes tuto svíčku mohla pozice zůstat
   držená v medvědím režimu. Sdílené `trend_exit_reason` nyní požaduje
   výstup i při EMA50 < EMA200 bez nového crossu. Rovnost EMA není výstup.
   Neplatná EMA blokuje vyhodnocení; nevytváří prodejní signál.
3. Nový důvod `BEAR_REGIME_EXIT` je rozlišen od `BEAR_REGIME`, který dál
   znamená čekání na vstup. Server poskytuje správné vysvětlení rozhodnutí
   i uzavřeného obchodu; uživateli nepopisuje provedený výstup jako čekání.

Trendový výstup dál používá existující ověřenou cestu zrušení OCO a
trvalého SELL intentu. Neověřený účet, nevyřešené objednávky a souběžné
ruční uzavření nebo obnova ochrany tuto cestu nepřeskakují. Nejasné zrušení
OCO ani její souběžné plnění nesmí vést k druhému market prodeji.

**Provozní dopad při případném nasazení:** při nejbližší platné kontrole
může dojít k uzavření dříve otevřené pozice, pokud je EMA50 už pod EMA200,
i když k překřížení došlo během výpadku. Proto opravy nejsou publikované
na automaticky nasazovanou `main`. Server a worker je nutné vydat spolu.
EMA periody, sizing, stop −10 %, trailing +3 % / 1,5 % i režimový vstup
zůstávají v produkční konfiguraci stejné.

## Návrhy vstupů a metoda porovnání

Nový izolovaný `research/strategy_review.py` porovnává:

- `regime`: současný vstup kdykoliv jsme bez pozice a EMA50 > EMA200;
- `fresh_cross`: vstup pouze při novém překřížení EMA50 nad EMA200;
- `above_fast`: současný režim navíc vyžaduje close nad EMA50;
- `rising_fast`: předchozí podmínka navíc vyžaduje rostoucí EMA50.

Varianty byly stanoveny před spuštěním, bez hledání kombinací parametrů.
Stejné sizingy, limity, cooldowny a výstupy se používají pro všechny vstupy.
Výstup je zde pro srovnání původní nepřerušovaný death-cross; obnova po
výpadku je ověřena samostatnými regresními testy, nikoli simulována jako výnos.

Signály používají přesný rolling výpočet workeru na uzavřených 4h svíčkách.
Exekuce používá dostupné 15minutové svíčky a dva předpoklady pořadí cen
(open–low–high–close a open–high–low–close). Ochrana při opening gapu se
vyhodnotí před novým 4h rozhodnutím; budoucí intrabar pohyb až po něm.
Všechny 15m svíčky musí přesně agregovat na odpovídající 4h OHLC.
Vnitřní mezery nebo nesoulad vyvolají chybu, nikoli tichou interpolaci.

Obě měny mají 7 635 společných 4h svíček a 122 160 svíček 15m před cutoffem.
Indikátorový warmup začíná 25. 3. 2023; hodnocené části jsou:

- vývojová: 28. 4. 2023 20:00 UTC až 1. 1. 2025, výlučně;
- pozdější historická: 1. 1. 2025 až 17. 9. 2026 12:00 UTC, výlučně.

Jde o již dříve zkoumanou historii, **nikoli nedotčený OOS test**.
Původní forward holdout od 21. 9. do 20. 12. 2026 nebyl vyhodnocen,
změněn ani použit k ladění. Zachované jsou zdrojové soubory protokolu,
původní cache včetně mtime a archiv. Již existující drift `utils.py`
vůči historickému protokolu nebyl touto prací měněn.

Výpočet obsahuje 96 scénářů: dvě části, kapitál 100/1 000 USDC, dvě
nákladové varianty, dvě OHLC cesty, čtyři aktivní varianty a dvě kontroly
(buy & hold a hotovost). Základní náklady jsou 0,1 % poplatek a 0,05 %
nepříznivý skluz na každé straně; zátěžové náklady jsou dvojnásobné.
Každá část začíná samostatně s hotovostí a bez pozic.

## Výsledky pro účet 100 USDC

Čísla jsou výnosy za celou danou část, po modelovaných nákladech, nikoli
roční výnos ani prognóza. Interval ukazuje dvě OHLC cesty, nejde o statistický
interval spolehlivosti nebo garantované meze plnění. Propad je nejhorší
z obou cest při základních nákladech, měřený na 15m koncových hodnotách.

| Část / vstup | Výnos: základní náklady | Výnos: dvojnásobné náklady | Max. propad při základu | Uzavřené obchody při základu |
| --- | ---: | ---: | ---: | ---: |
| Vývojová: současný režim | −3,27 až +8,62 % | −13,86 až −6,70 % | −20,76 % | 159–161 |
| Vývojová: nový cross | +1,47 až +1,68 % | +0,40 až +0,60 % | −5,96 % | 15 |
| Vývojová: close nad EMA50 | +3,32 až +10,40 % | −8,70 až −3,06 % | −17,38 % | 138–139 |
| Pozdější: současný režim | −0,76 až +10,10 % | −8,79 až +1,49 % | −16,05 % | 126 |
| Pozdější: nový cross | +10,24 až +12,80 % | +9,14 až +11,66 % | −2,00 % | 14 |
| Pozdější: close nad EMA50 | −4,26 až +4,44 % | −10,38 až −2,41 % | −15,12 % | 109 |

Dodatečná podmínka rostoucí EMA50 neměla v této simulaci jiný výsledek
než samotný filtr close nad EMA50; není to důvod přidávat další pravidlo.

Při kapitálu 1 000 USDC byl v pozdější části základní výnos nového crossu
+2,05 až +2,52 %, současného režimu +0,39 až +2,71 %. Strop 50 USDC mění
relativní expozici, proto výsledky malého účtu nelze lineárně škálovat.
Buy & hold se základními náklady dosáhlo ve vývojové části +146,70 %
a v pozdější −22,56 %, s propady −38,80 % / −60,82 %. Tato kontrola je plně
investovaná 50/50 a má jinou expozici než aktivní strategie.

**Doporučení:** nový cross je rozumný kandidát pro paralelní paper sledování,
protože zde omezil opakované vstupy, poplatky i propady. Nejde o důkaz
budoucího výnosu: pozdější část obsahuje pouze 14 uzavřených obchodů a
vývojová část ukazuje i cenu za méně účasti na růstu. Cenový filtr nad EMA50
nemá přesvědčivě stabilní přínos. Bez dalšího forward ověření neměnit vstup
v produkci podle vítěze tohoto srovnání.

## Zbývající omezení

15m OHLC pořád neurčuje tickové pořadí, latenci, hloubku trhu ani spread.
Nákup na open aproximuje skutečné plnění po hranici 4h + 30 s.
Chybí historické LOT_SIZE/tick filtry, zaokrouhlení množství, minimální výstup,
rezidua, částečná plnění a výpadky. Minimum objednávky je modelových 5 USDC.
Případné koncové otevřené pozice jsou oceněny bez hypotetického exit poplatku.
Model neobsahuje souběžné DCA vklady a externí držby.

Worker dál používá **hrubé P/L pro rizikové limity a cooldowny**, kdežto
výsledky studie jsou po modelovaných nákladech. Tato vlastnost je ponechána
shodně u všech variant. Přechod živých limitů na čisté P/L by vyžadoval
úplnou evidenci poplatků včetně BNB/base aktiv, konzistentní ocenění a
řešení neznámých nákladů; tato práce jej nepředstírá jako hotový.

## Ověření a reprodukce

Nové testy ověřují rozdílné Binance filtry, neplatné meze, obnovu ochrany,
zmeškaný cross, rovnost EMA, blokaci při neověřeném stavu, nejasné zrušení
OCO a souběžné plnění. Research testy ověřují zákaz lookahead, konzistenci
15m/4h dat, známé náklady, rozdíl vstupních pravidel a neměnnost dat.
API test rozlišuje medvědí čekání na vstup od výstupu existující pozice.
Kompletní `npm run verify` prošel: build, 250 Node testů a 212 Python testů.
Porovnání otisků i mtime před a po práci potvrdilo neměnnost původních
experimentálních zdrojů, protokolu a cache. Otisky zdrojů v JSON reportu
odpovídají finální implementaci studie.

```bash
.venv/bin/python -m pytest -q services/kryptotron/tests
PATH="$PWD/.venv/bin:$PATH" npm run verify
.venv/bin/python services/kryptotron/research/strategy_review.py \
  --output /tmp/ocean-strategy-review-reproduced.json
```

Program výstup záměrně nepřepisuje. Kompletní metriky, konfigurace a otisky
zdrojů/dat jsou v [JSON reportu](strategy-review-2026-11-02.json).
