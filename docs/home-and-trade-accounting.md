# Home a ověřené náklady obchodů

Přehled obsahuje jen čtyři skutečné zůstatky z Binance Spot v pružné mřížce
2 × 2. USDC je dostupná hotovost; BTC, ETH a SOL zahrnují i množství zamčené
v objednávkách. Stejně velké karty vyplňují dostupnou výšku mezi záložkami a
spodní navigací. Layout používá dynamický viewport a safe areas; při malé
výšce nebo velkém textu se obsah přirozeně posouvá.

Na mobilu i desktopu se přepíná mezi Přehledem, Tradingem a DCA. Aktivní
záložka i rozpracované nastavení přežijí pravidelné načítání dat a změnu
velikosti okna. Souhrnné panely Trading/DCA ani spodní informační řádek
v Přehledu nejsou. Evidenci DCA a Tradingu nepřičítáme ke zůstatkům.

Trading ukazuje otevřené pozice a stav ochrany; historii s poplatky a
pravidla/riziko otevírají tlačítka. Detail patří pouze vybrané pozici:
množství, vstupní cena, aktuální hodnota a průběžný výsledek. Vysvětlení
výpočtu před poplatky je pod rozbalovacím ovládáním Výpočet, parametry
stopu a trailingu pod Ochranou pozice. Výsledky uzavřených obchodů zůstávají
v historii. Zastaralé ceny se nezobrazují jako aktuální a nepotvrzená
rekonciliace neoznačuje ochranu v detailu za ověřenou. DCA v hlavním panelu obsahuje společný
interval, tři samostatné posuvníky částek a společné uložení. Tlačítka
uložení/zrušení se zobrazí při změně plánu; neúspěšné uložení zachová návrh. Každý řádek
má vlevo kratší posuvník a vpravo investovanou částku a aktuální ocenění
evidovaných nákupů daného aktiva. Pod řádky jsou oba součty za celé DCA.
Změna částky budoucího nákupu nepřepočítává historické hodnoty. Na nejužších
telefonech se hodnoty přesunou pod posuvník. Tlačítko Historie DCA otevírá
termíny a poslední nákupy; stejné hodnoty v dialogu neduplikujeme. Rozsah
posledních nejvýše 156 nákupů je uveden v historii i v popisku hodnot. Ocenění nákupů není tvrzení o dnešním vlastnictví:
nezohledňuje poplatky, pozdější prodeje ani převody. Při chybějících nebo
zastaralých cenách je ocenění neznámé, nikoli nula.

## Inventura a umístění funkcí

| Funkce | Nové místo |
| --- | --- |
| Připojení Binance, klíče, stav, režim, aktualizace a odpojení | Profil → Nastavení účtu → Propojené účty → Binance |
| Společná pauza Tradingu a DCA | Profil → Nastavení účtu → Automatizace nákupů |
| Rozhodování, rizika, evidence ochrany | Trading → Pravidla a riziko |
| Provozní události | Trading → Pravidla a riziko → Aktivita strategie |
| Streak Governor (simulace) | Trading → Pravidla a riziko |
| Kontrola portfolia a její reporty | Vault |
| Heslo a Telegram | Nastavení účtu; původní samostatné stránky zachovány |

Přesun používá původní formuláře a endpointy. Odpojení dál vyžaduje
potvrzení, skrývá se pro legacy instanci a respektuje odmítnutí serveru.
Zamítnutí je viditelné i při skrytém formuláři připojení. Po odpojení se
zůstatky změní na neznámé a finanční ovládání se zablokuje. Chyba načítání
označí poslední zůstatky jako neaktuální přímo na kartách.

Zobrazované přezdívky sjednocuje `public/display-name.js` pomocí
`OceanNames.formatNickname`. První Unicode code point převádí na velké
písmeno a zbytek zachovává, včetně české diakritiky, kombinovaných znaků
a znaků mimo BMP. Používá se v profilu, hlavičce, žebříčku, administraci,
Genesis přehledech i Telegram propojení. Přihlašovací jména, URL, ID,
porovnání identity a přesné potvrzení resetu účtu zůstávají původní.
Neprovádí se migrace dat.

## Ovládání

Trading má přepínač Zapnuto/Vypnuto. Ovládá nové vstupy, nikoli
uzavření pozic; jeho přístupný popis tento rozsah vysvětluje.

- `POST /api/kryptotron/control` s `scope: "trading"` mění jen `trading_paused`.
  Worker jej kontroluje před novými trendovými vstupy pro konkrétní pár.
  DCA má vlastní `dca.enabled` a [samostatné plány aktiv](dca-per-asset-plans.md). Změna jednoho přepínače nemění druhý.
- Stejná cesta bez scope zachovává původní společnou pauzu `entries_paused`.
  Její ovládání je v nastavení automatizace. Bezpečnostní režim, reset, pozastavení účtu,
  rekonciliace a dosavadní rizikové limity dále blokují nákupy obou strategií.
- Povolení Tradingu neruší společnou pauzu. Stará instance bez
  `trading_paused` má stejné chování jako před aktualizací.
- Zápisy workeru zachovávají poslední uživatelské nastavení obou přepínačů.
  Pauza nových vstupů nevypíná správu otevřených pozic ani burzovní ochranu.

## Čistý výsledek

Nová SQLite migrace 011 ukládá identitu vstupní/výstupní objednávky,
podklady plnění a ověřený výpočet po instancích. Worker posílá `execution`
v durable outboxu i pro ochranné výstupy. Server jej uloží před potvrzením
přijetí a odstraní před zápisem do `bot_trades`, takže vzdálené SQL schéma
nepotřebuje změnu. Historické `pnl`, `result` a rizikové čítače zůstávají
před poplatky a nezměnily obchodní pravidla ani velikost pozic.

Při načtení snapshotu server ověřuje nejvýše jeden uzavřený obchod čtyřmi
podepsanými GET požadavky Binance (`order` a `myTrades` pro vstup i výstup).
Klíče nikdy neopustí server. Kompletnost plnění, identita, množství,
ceny a čas výstupu musí odpovídat evidenci. Úspěšný výsledek se trvale
ukládá; neúspěšné ověření se opakuje nejdříve za minutu. Souběžné požadavky
jedné instance sdílejí ověření; nejdéle neověřované obchody mají přednost.
Nedostupnost ověření nesmí skrýt přehled pozic. Nejde o hromadný backfill
celé historie; postupně se ověřuje poslední obchod a dostupné vysvětlené
uzavřené obchody ve snapshotu.

Výpočet pro jeden uzavřený cyklus:

1. Čisté získané množství = vyplněný nákup − vstupní poplatek v základním aktivu.
2. Spotřebované množství = vyplněný prodej + výstupní poplatek v základním aktivu.
3. Celkový pořizovací náklad = hodnota nákupu + vstupní poplatek v USDC.
4. Přiřazený náklad = celkový náklad × spotřebované / získané množství.
5. Čistý výsledek = hodnota prodeje − výstupní poplatek v USDC − přiřazený náklad.

Zbylé množství i jeho pořizovací náklad se evidují zvlášť a nejsou ztrátou
prodané části. UI je označuje jako zbytek při daném uzavření, nikoli dnešní
ověřený zůstatek. Poplatky v BNB/jiném aktivu bez doloženého přepočtu,
neúplná plnění a staré obchody bez identifikátorů znamenají **Neověřeno**.
Chybějící poplatek nikdy nepředstavuje nulu. Výpočet není daňové FIFO.

## Ověření 11. 10. 2026

Čtyři dostupné historické cykly ze tří mainnet instancí byly ověřeny pouze
čtením skutečných nákupních/prodejních objednávek a jejich plnění.
Nezávislý přepočet Python Decimal souhlasil s implementací:

| Vzorek | Pár | Před poplatky (USDC) | Čistě (USDC) | Zbylé množství |
| --- | --- | ---: | ---: | ---: |
| 1 | ETH/USDC | 0,026376 | 0,006859743222 | 0,00009591 ETH |
| 2 | ETH/USDC | 0,105452 | 0,086121306787 | 0,000096 ETH |
| 3 | BTC/USDC | 0,2168822 | 0,168501508217 | 0,0000097 BTC |
| 4 | ETH/USDC | 0,08432 | 0,055041002435 | 0,00009401 ETH |

Surové podklady a identifikátory účtů nejsou součástí repozitáře.
Tato kontrola potvrzuje uvedené uzavřené cykly; nepotvrzuje neověřitelnou
starší historii ani budoucí obchodní chování. Nebyla odeslána nová objednávka.

## Testování a nasazení

`PATH="$PWD/.venv/bin:$PATH" npm run verify` provádí build, Node testy a Python testy.
Kontrola Chromium ověřuje rozhraní bez chyb JavaScriptu a vodorovného přetékání.
Testy pokrývají poplatky v základním i kotovacím aktivu, zbytky, neúplná
plnění, izolaci účtů, opakované doručení, obnovení z cache, ochranné výstupy,
nezávislé přepínače a zachování společných bezpečnostních pravidel.

Volitelná kontrola Chromium: `node test/browser/home.mjs` s dostupným
balíčkem `playwright`; případně `OCEAN_PLAYWRIGHT_MODULE` určí cestu k jeho
ES modulu a `OCEAN_CHROMIUM_PATH` k prohlížeči. Všechny HTTP požadavky jsou
zachyceny a odpovědi simulované. Kontroluje desktop, 320/390/768 px,
klávesnici, ovládání, rozbalení poplatků a prázdné/zastaralé údaje.
Náhledy se ukládají do `/tmp/ocean-home-*.png` a obsahují testovací data.

Server, frontend i worker je nutné nasadit spolu a worker restartovat.
Starý worker nový přepínač Tradingu nezná; nový worker posílá metadata,
která musí přijmout nový server. SQLite migrace běží při startu.
Samotná lokální implementace ani testy nemění aktivní mainnet nastavení.
