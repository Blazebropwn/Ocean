# Oprava zaokrouhlení a dokončení ručního prodeje — 2026-09-29

## Incident a příčina

Po ručním uzavření BTC pozice 0,00031 BTC starý `round_step` použil
`floor(qty / step)` nad binárními floaty. Podíl pro krok 0,00001 vyšel
těsně pod 31, takže záměr i skutečný plně vyplněný příkaz prodaly pouze
0,00030 BTC. Na burze zůstalo 0,00001 BTC. Následné float odečtení
navíc vyhodnotilo rozdíl jako větší než jeden krok a finalizaci odmítalo.
Bezpečnostní režim správně blokoval nové nákupy při rozporu v evidenci.

U druhého účtu šlo o samostatný krátký timeout lokálního state brokeru;
následující kontrola účet ověřila. Před opravou byly jeho obě otevřené
pozice kryté původními aktivními OCO objednávkami.

## Změna

- Množství se zaokrouhluje přes `Decimal` směrem dolů na přesný krok.
- Obnova ověřuje původní pending příkaz přes jeho client ID. Přijímá jen
  `FILLED` s množstvím odpovídajícím uloženému záměru. Neodesílá nový prodej.
- Zbytek nejvýše jednoho kroku se uloží zvlášť do `strategy_residuals`
  včetně pořizovací hodnoty; reconciliation jej zahrne do inventáře.
  Větší rozpor zůstává blokovaný. Zbytek se neslučuje s DCA ani externím
  inventářem a nepředstírá otevřenou chráněnou pozici.
- Historie a hrubý výsledek používají skutečně prodané množství a čas
  burzovního plnění. Poplatky nadále nejsou odečtené od zobrazovaného P/L.
- Hodinová pauza daného páru začíná potvrzením obnovy. Uživatelská globální
  pauza, ztrátové limity, parametry strategie a pravidla DCA se nemění.
- Přehled ukazuje evidovaný zbytek. Detail strategie se přesunul do dialogu
  **O strategii**; bezpečnostní stav a čekání na ověření zůstávají na přehledu.

## Ověření před nasazením

- `npm run verify`: build, 31 souborů Node testů, 132 Python testů.
- Regresní případy pro přesný lot, historický potvrzený prodej, restart,
  selhání zápisu, zbytek v inventáři a odmítnutí většího nesouladu.
- Binance Spot Testnet: nákup přesně 0,00031 BTC, OCO, ruční HTTP uzavření,
  dva shodné požadavky, jeden prodej celého množství, nulový nový zbytek,
  obnovení stavu, zachované DCA/externí zůstatky a globální pauza.
- Chromium: šest rozměrů obrazovky, 18 kontrol rozložení, informační dialog,
  klávesnice/focus, potvrzení prodeje i zobrazení zbytku; bez JS chyb.

Při pushi odhaleno dřívější selhávání CI: bubblewrap na Ubuntu runneru
nemohl vytvořit mapování uživatele (`setting up uid map: Permission denied`).
Workflow nyní nastaví aplikační AppArmor výjimku pro `/usr/bin/bwrap`, když
runner omezuje neprivilegované user namespaces, podle
[dokumentace Ubuntu](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions).
Test izolace se nepřeskakuje. Změna se týká jen dočasného CI runneru.

## Nasazení a následná kontrola

Výchozí produkční commit: `d869d6bfcb73ab540f08eff6fe3c624e03f5ee35`.
Incidentní snímky stavu a odpovědí burzy jsou uložené mimo Git na chráněném
produkčním volume `/data/incidents/manual-close-20260929/`.

Po nasazení ověřit oba čerstvé workery, shodu inventáře s Binance, původní
OCO u nedotčeného účtu a finalizaci původního SELL u dotčeného účtu:
žádný pending záměr, historie uložena jednou, zbytek 0,00001 BTC a pauza.
Kontrola produkce je čtecí; ruční opravný prodej ani reset stavu se neprovádí.
Ověřit také veřejné assety, health a readiness endpointy.

Starý worker neumí nový residual ledger: návrat na původní image bez
kompatibilní reconciliation není bezpečný postup. Nepřepisovat stav starou
zálohou a neopakovat vyplněný prodej. Případná další oprava musí zachovat
evidenci skutečného plnění a zbytku.

## Stav nasazení: blokováno platformou

K 2026-09-29 17:43 UTC je oprava commitnutá a pushnutá na `main`:
`ee58b51` (funkční oprava) a `7907ef4` (CI runner). Kompletní
[GitHub CI včetně restore drill](https://github.com/Blazebropwn/Ocean/actions/runs/36606211344)
pro `7907ef4` prošlo. Lokální testnet po návratu běžného workeru:
reconciliation OK, žádná pozice ani čekající historie, prodáno 0,00031 BTC,
nový zbytek nula, uživatelská globální pauza zachovaná.

Produkční nasazení **dosud neproběhlo**. Railway odmítlo explicitní
`serviceInstanceDeployV2` pro ověřený commit zprávou
`Deploys have been paused temporarily`. Provozovatel hlásí
[incident API / deployments](https://status.railway.com/incident/YYTG8I10).

Nasazení a produkční ověření zůstávají nedokončené.

Po obnovení Railway zbývá nasadit ověřený commit a provést výše uvedenou
čtecí kontrolu obnovy. Nebyl spuštěný žádný automatický opakovací deploy job.
