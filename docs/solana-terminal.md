# Solana Terminal — pilot PAPER

Pilot pro účet Blazebro. Samostatný TypeScript modul v `src/solana`,
API v `src/routes/solana.ts`, UI integrované v dashboardu na `/#solana`.
Na mobilu je čtvrtou záložkou Home vedle Trading/DCA. Desktop má vlastní
boční vstup a přehled tokenů, obchodů a vývoje účtu. Všech šest kroků a poslední
skutečné události jsou stále viditelné přímo v přehledu. Na mobilu jsou kroky
ve dvou řádcích po třech, tokeny a události mají vlastní posouvání. Běžící krok
se zvýrazňuje podle serveru; mimo běh karty označují průběh poslední kontroly.
Podrobné důkazy a pravidla zůstávají dostupné v detailu. Původní `/solana.html` přesměrovává.
Binance worker, jeho konfigurace, klíče, zůstatky a strategie zůstávají oddělené.
Rozpracovaný audit strategie na PR #20 není součástí této větve.

## Co skutečně funguje

Uživatel tlačítkem Spustit sledování výslovně zapne automat, nebo spustí jeden
ruční sken. Server načte skutečné nově indexované Solana pooly
z GeckoTerminal, vybere nejvýše pět kandidátů, zkontroluje report RugCheck,
určí velikost a vyžádá Jupiter nákupní i zpětnou prodejní kotaci pro konkrétní
raw množství. Pokud všechny podmínky projdou, atomicky zapíše virtuální nákup.
Neúplná data nebo chyba služby vedou k odmítnutí a důvod zůstane v evidenci.
Objevování načte jednu stránku za kolo, nejvýše 20 různých mintů. Po úspěšném
načtení střídá stránky 1 → 5 → 10 → 1; po chybě stejnou stránku zopakuje.
Evidence `sampledPages` obsahuje skutečně načtenou stránku, `pageRotation`
popisuje plán střídání. Jde o omezený vzorek, nikoli úplný seznam nových poolů.
Pooly s likviditou alespoň 10 000 USD si
pilot pamatuje v trvalém seznamu nejvýše 120 poolů, přednostně nad 50 000 USD.
Tento seznam přežije restart; platnost končí 24 hodin po vytvoření poolu,
nikoli po posledním objevení. Přijímací hranice 10 000 USD nemění nákupní
minimum 50 000 USD ani minimální stáří pěti minut.

Každé kolo nejdřív obnoví nejvýše 20 dříve objevených poolů, potom hledá nové.
Fronta střídá nejdéle nekontrolované pooly. Při naplněném seznamu jde nejvýše
o dva GeckoTerminal požadavky za kolo místo původních čtyř; dostupná kapacita
tak nemizí pouze na novinky před obnovením sledovaných trhů. Obnovení přes pevný
GeckoTerminal endpoint `pools/multi` musí vrátit nová data se stejnou adresou,
mintem, přesností a časem vytvoření. Chybějící či stará data se nepoužijí;
uložený seznam není zdrojem cen. Posuzuje se nejvýše 40 různých tokenů.
Pokud má mint více poolů, přednost dostane pool splňující základní limity,
potom vyšší likvidita. Pět podrobných kontrol se střídá podle nejstaršího
rizikového prověření, aby opakovaně odmítané tokeny neblokovaly ostatní.

Výpadek právě načítané objevovací stránky zneplatní její nový výběr. Čerstvě
obnovené sledované pooly lze přesto vyhodnotit; UI výslovně označí chybějící
část dat. Pokud žádný zdroj nevrátí použitelná data a nastala chyba, kolo selže.

Všechny požadavky na GeckoTerminal sdílejí jednu frontu s rozestupem nejméně
7 sekund. Veřejné API uvádí proměnlivý limit přibližně 10 požadavků za minutu;
ani tento rozestup nezaručuje dostupnost služby. HTTP 429 přenáší absolutní
termín z `Retry-After` (sekundy i HTTP datum). Bez použitelné hlavičky čekání
roste od 60 sekund do 15 minut; delší pokyn serveru se nezkrátí. Po 429 se
v témže kole další požadavek na GeckoTerminal neprovede.

Čekací lhůta je globální stav poskytovatele v SQLite a přežije restart,
ruční sken i Pozastavit → Spustit. Ruční sken vrací HTTP 429 se zbývajícím
čekáním. HTTP timeout běží až od skutečného požadavku, nikoli během čekání
ve frontě. Dostupné Jupiter kotace dál umožňují pravidelné ocenění a výstupy
otevřených pozic, i když objevování tokenů čeká na GeckoTerminal.

Neúspěšné kolo nesmaže poslední známé nálezy z přehledu. API je označí
`candidateFeed.stale` a `candidate.stale`; UI uvede starší data i čas načtení.
Statistika posledního kola dál patří aktuálnímu kolu, nikoli historickému feedu.
Tato historie se nikdy nevrací do obchodní smyčky jako náhrada nových dat.

Šest karet představuje deterministické kroky, nikoli šest LLM modelů:

| Krok | Vstupy a výsledek |
| --- | --- |
| Scanner | Mint, pool, stáří, likvidita a objem posledních pěti minut |
| Rug Check | Odvolání mint/freeze authority, program tokenu, největší držitel, uzamčení likvidity, varování |
| Sizer | Hotovost, počet pozic, vložený kapitál a denní brzdy |
| Executor | Obousměrné čerstvé kotace, konzervativní výstup, simulovaný nákup nebo prodej |
| Logger | Append-only rozhodnutí, vstupy, důvody, evidence kotací a nákladový model |
| Equity | Virtuální hotovost a hodnota otevřených pozic při konzervativním prodeji |

Stav karet patří poslednímu cyklu. Běžící krok se zaznamená před skutečným
asynchronním voláním API. Krok, který v něm neproběhl, nesmí vypadat
jako úspěšně provedená kontrola. Evidence v UI ukazuje posledních 50 rozhodnutí
a 30 obchodů; databáze uchovává i starší záznamy. Lehký živý přehled vrací
posledních 20 událostí bez plné evidence a 20 souhrnů kandidátů. Počítadla
ukazují skutečné zahájené skeny, kontroly záznamů poolů (nikoli unikátní
tokeny), spuštěné rizikové kontroly a simulované obchody.
Souhrn posledního kola navíc ukazuje různé minty, všechny zjištěné důvody
odmítnutí a stav obnovení sledovaných poolů. Důvody jednoho tokenu se mohou
překrývat. Neprovedené pozdější kontroly se nevydávají za vyhodnocené.
Pravidla kola jsou označená `paper-2026-11-04-v2`; starší záznamy zůstávají
označené jako starší, protože obsahují jen první tehdy uložený důvod.

## Pevná pravidla pilotu

Zdroj hodnot: `SOLANA_PAPER_LIMITS` v `src/solana/engine.ts`.

| Pravidlo | Hodnota |
| --- | --- |
| Počáteční virtuální hotovost | 100 USDC |
| Jedna pozice | nejvýše 5 USDC |
| Součet vloženého kapitálu otevřených pozic | nejvýše 15 USDC, nejvýše 3 pozice |
| Nové vstupy za posledních 24 hodin | nejvýše 10 |
| Brzda realizovaných ztrát za posledních 24 hodin | 5 USDC; zisky nevymazávají ztrátové obchody |
| Opakovaný vstup do stejného mintu | zakázaný i po uzavření |
| Stáří poolu | 5 minut až 24 hodin |
| Likvidita / objem za 5 minut | alespoň 50 000 / 1 000 USD |
| Mint a freeze authority | explicitně odvolané; chybějící pole není `null` |
| Program tokenu | původní SPL Token program; Token-2022 je odmítnutý |
| Největší nahlášený držitel | nejvýše 20 %, bez rezerv PumpSwap prokázaných na blockchainu; ostatní účty zůstávají započítané |
| Uzamčení likvidity | nejméně 95 %, minimum napříč nahlášenými trhy tokenu |
| Rizika RugCheck | žádné varování, nebezpečí ani neznámá kontrola |
| Kotace | nejvýše 30 sekund, správný směr a množství, neexpirovaná |
| Cenový dopad / poplatek trasy | nejvýše 3 % / 1 % |
| Prodejní mark | po 60 sekundách neověřený, musí se obnovit skenem |
| PAPER výstup | −10 %, +20 % nebo 30 minut od otevření, jen při skenu |
| Rozestup cyklů včetně ručního uzavření | nejméně 60 sekund |

Kandidát musí projít všemi pravidly. Přísná kombinace koncentrace a uzamčení
likvidity může odmítnout téměř všechny nové pooly. Nulový počet obchodů není
důvod automaticky snižovat limity. Zvláště Token-2022 zůstává vypnutý do
samostatného auditu rozšíření, hooků, poplatků a oprávnění.

## Účtování a důkazy

Hotovost je celé číslo v microUSDC. Tokeny mají raw množství jako desetinné
řetězce a výpočty používají BigInt, aby neztratily přesnost u levných tokenů.
Nákup drží nejvýše minimum Jupiter kotace snížené o další 1% model skluzu.
Prodej pracuje se stejným konzervativním modelem.

Poplatek Jupiter je již v kotaci a znovu se neodečítá. Navíc se účtuje pevný
**model** síťových nákladů 0,01 USDC za každou stranu. Toto není změřený náklad
živé transakce. Nahlášené chain fee položky musí být známé a v limitu enginu;
neočekávané nebo chybějící poplatky kotaci blokují. Skutečné rent, priorita,
MEV, latence a fill mohou být jiné. Výsledek pilotu proto není backtest ani
důkaz dosažitelného čistého zisku.

Před vstupem musí existovat zpětná prodejní kotace pro konzervativně koupené
množství; okamžitá modelovaná ztráta přes 10 % vstup zastaví. Tato kontrola
neprokazuje budoucí prodejnost ani vyloučení honeypotu.
Při výpadku kotace zůstává pozice otevřená. Zobrazovaná aktuální hodnota
pozice i celková equity jsou `null`, poslední známý mark je uchovaný odděleně.
Nikdy se nenahradí pořizovací cenou ani automatickým prodejem za nulu.

RugCheck poskytuje report třetí strany. Ukládá
se čas načtení reportu; `detectedAt` je čas detekce tokenu, nikoli potvrzení
čerstvosti bezpečnostní kontroly. Zámek likvidity ani report nejsou zárukou.

Výjimka pro rezervy poolu se ověřuje samostatným read-only RPC
`getMultipleAccounts` na `https://api.mainnet-beta.solana.com`. Nestačí štítek
AMM: musí souhlasit SPL účet, mint, autorita poolu, původní tokenový program,
stav účtu bez externího delegáta a binární data skutečného PumpSwap poolu
(oficiální program, discriminator, minty a přesná adresa příslušné rezervy).
Nejvýše 20 párů / 40 účtů na report. Výpadek RPC nebo neúplný důkaz rezervu
nevyřadí. Zbývající procenta se nepřepočítávají; bez zbývajících držitelů je
koncentrace neznámá. Reportové varování a uzamčení likvidity se tím neruší.

## Přístup a provoz

```text
OCEAN_SOLANA_PILOT_USER_ID=<ověřené neměnné users.id účtu Blazebro>
OCEAN_SOLANA_JUPITER_API_KEY=<volitelné>
```

Prázdné pilotní ID modul vypne všem. Kontrola je na serveru pro každý endpoint:
přihlášená relace, přesná shoda ID, schválený a nepozastavený účet.
Username, role owner ani skrytý odkaz samy přístup nedávají. Oprávnění se
znovu ověřují po asynchronních kontrolách a před zápisem obchodu.
Pilotní ID je nastavení instalace; nepřenášet ID z vývojové databáze do
produkce bez ověření. Pokud účet někdo smaže a založí znovu, přístup se
nepřenese na nové ID. Neposílat API klíče do UI ani do repozitáře.

Otevření stránky pouze načte evidenci. Automat je výchozím stavem pozastavený.
Po výslovném spuštění provádí cykly na serveru přibližně každých 60 sekund;
uložený záměr pokračuje i po zavření prohlížeče a restartu serveru. Před
každým cyklem se znovu ověří pilotní ID, schválení a pozastavení účtu.
Odebrání přístupu uložený záměr vypne. Výpadek feedu používá exponenciální
odstup až 15 minut; nejde o opakování bez omezení.

Pozastavit zastaví další automatické skeny, přecenění i výstupy. Rozpracovaný
cyklus může dokončit již zahájené ocenění nebo výstup, ale jeho nové
automatické nákupy se zablokují. Změna generace ovládání zablokuje starý
nákup i při rychlém Pozastavit → Spustit během stejného API volání.
Samostatně vyžádaný ruční sken a ruční uzavření jsou nezávislé akce.
Stop-loss a časový výstup se vyhodnocují při cyklech; nejde o čekající
burzovní ochranné objednávky. V pauze tedy jejich průběžná kontrola neběží.

UI sleduje skutečný stav serveru po 1 sekundě během práce a po 2 sekundách
při čekání. Odpočet se mění lokálně. Opuštěná záložka neprovádí polling,
serverový automat tím nekončí. Zvýraznění kroků a nálezů odpovídá skutečným
událostem, žádné tickery ani obchody se negenerují pro dojem aktivity.
Křivka equity obsahuje jen uložená ocenění dokončených cyklů; neověřené body
zůstávají `null` a graf mezi nimi nepřemosťuje ztracenou informaci.

API:

- `GET /api/solana` — stav virtuálního účtu; nezískává kotace ani neobchoduje.
- `GET /api/solana/live` — lehké aktualizace běžící práce, radaru a počítadel.
- `POST /api/solana/automation` s `{ "enabled": true | false }` — trvalé spuštění nebo pauza.
- `POST /api/solana/cycle` — ruční sken, přecenění a simulace podle pravidel.
- `POST /api/solana/positions/:id/close` — pokus o simulovaný prodej konkrétní pozice.

Sken ani uzavření nepřijímají obchodní parametry; ovládání přijímá výhradně
boolean `enabled`. Žádný POST nepřijímá cenu, mint, částku, vlastníka ani režim. Žádný
endpoint neumí LIVE. Modul nemá peněženku, podpisový klíč, signer, RPC
odesílání ani volání Jupiter `/execute`. Nepoužívá Binance credentials.
Tržní požadavky jsou GET na pevné domény; jediný externí POST je read-only
RPC `getMultipleAccounts` s pevnou metodou a adresou. Všechny mají časový
a velikostní limit; Jupiter požadavky jsou sériové a alespoň 2,1 sekundy od sebe.

Zámek cyklu a cooldown jsou v SQLite, takže přežijí restart a brání dvojímu
zápisu i ze dvou karet. Přerušený cyklus má pětiminutový lease, po kterém
další cyklus označí přerušení; starý vlastník lease už nemůže provést zápis.
Zápisy hotovosti, pozice, obchodu a auditní události jsou jedna transakce.

Migrace 12 přidává pět tabulek `solana_paper_*`. Migrace 13 přidává tabulku
ovládání automatu a do cyklů souhrny kandidátů, počítadla a ocenění.
Migrace 14 přidává sledované pooly, verzi a podrobnosti posledního vyhledávání
a index pro střídání rizikových kontrol.
Migrace 15 ukládá rozestupy a omezení GeckoTerminalu nezávisle na uživatelském
ovládání. Při upgradu převezme i dosud platné čekání na 429 ze staršího automatu.
Záloha SQLite je již zahrnuje.
Smazání uživatele kaskádově odstraní jeho pilotní data; reset Binance účtu
je neodstraňuje. Po migraci nebude fungovat starý image se schématem 11/12/13/14.
Bezpečné vypnutí je vyprázdnit pilotní ID a ponechat image s migrací 15;
při obnově starého image je nutná odpovídající záloha celé databáze.

## Zdroje a ověření

Ověřeno proti skutečným read-only API 4. 11. 2026: načtení poolů, rizikový
report a USDC→SOL kotace bez takera. Tato kontrola neprováděla PAPER nákup
na produkčním uživatelském účtu ani žádnou blockchainovou transakci.
Celý finální cyklus v izolované paměťové databázi v 11:09 UTC načetl 43
různých mintů. Žádný neprošel základními limity; zůstatek zůstal 100 USDC
a evidence správně obsahovala odmítnutí. Úspěšná cesta nákupu a prodeje
je ověřená deterministickými testy, nikoli vydávaná za skutečný on-chain fill.

- [GeckoTerminal API](https://api.geckoterminal.com/docs/index.html)
- [RugCheck OpenAPI](https://api.rugcheck.xyz/swagger/doc.json)
- [Jupiter: order bez takera vrací pouze kotaci](https://developers.jup.ag/docs/swap/order-and-execute)
- [Solana: read-only getMultipleAccounts](https://solana.com/docs/rpc/http/getmultipleaccounts)
- [PumpSwap: oficiální IDL poolu](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json)

Automatické testy v `test/solana*.test.ts` ověřují datové adaptéry, odmítnutí
neúplných reportů, neprodejných tokenů a starých kotací, nečekané poplatky,
účtování, souběh, perzistenci limitů a přístup jiného účtu.
`test/browser/solana.mjs` ověřuje mobilní i desktopové rozměry, bezpečné
zobrazení cizích tokenových textů, neověřenou equity, přístup a ruční akce.
Testy pokrývají také ověřené i podvržené rezervy, návrat sledovaného poolu
po opuštění seznamu novinek, zastaralé odpovědi, chybějící data a spravedlivé
střídání prověřovaných tokenů. Browserové scénáře Home/Solana zahrnují plný
radar dvaceti tokenů i mobilní rozměr 375 × 640. Po zpřístupnění pilotního účtu zůstává automat
pozastavený do jeho výslovného spuštění.
Další testy ověřují rozestupy požadavků, dlouhý `Retry-After`, zachování čekání
přes restart i ruční ovládání, obnovu historického feedu a Jupiter výstupy během
omezení GeckoTerminalu. Obnovení dostupnosti externího zdroje se musí ověřit
skutečným dokončeným produkčním kolem, nikoli pouze fixture testy.
Testy dále ověřují přednost obnovy sledovaných poolů, rotaci jednotlivých
objevovacích stránek a zastavení dalších požadavků po omezení obnovy.

Další milník: sběr delší historie odmítnutých i přijatých kandidátů, audit
Token-2022 a měření přesnějších nákladů. Helius stream a oddělený LIVE signer
jsou další práce. Požadavek na botí peněženku a rozpočet prvního LIVE testu
100 USDC je popsaný v [návrhu exekuce](solana-live-pilot.md).
