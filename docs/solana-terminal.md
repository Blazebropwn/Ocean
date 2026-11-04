# Solana Terminal — pilot PAPER

První funkční milník pro účet Blazebro. Samostatný TypeScript modul v
`src/solana`, API v `src/routes/solana.ts`, UI `/solana.html`.
Binance worker, jeho konfigurace, klíče, zůstatky a strategie zůstávají oddělené.
Rozpracovaný audit strategie na PR #20 není součástí této větve.

## Co skutečně funguje

Uživatel ručně spustí sken. Server načte skutečné nově indexované Solana pooly
z GeckoTerminal, vybere nejvýše pět kandidátů, zkontroluje report RugCheck,
určí velikost a vyžádá Jupiter nákupní i zpětnou prodejní kotaci pro konkrétní
raw množství. Pokud všechny podmínky projdou, atomicky zapíše virtuální nákup.
Neúplná data nebo chyba služby vedou k odmítnutí a důvod zůstane v evidenci.
Feed používá pevný vzorek stránek 1, 5 a 10, nejvýše 60 různých mintů;
nejde o úplný seznam nových poolů. Starší stránky umožňují dodržet minimální
stáří pěti minut. Před limitem pěti podrobných kontrol mají přednost tokeny,
které splňují základní limity a dosud nebyly obchodované. Jejich pořadí
zůstává podle nahlášené likvidity. Výpadek kterékoliv stránky zneplatní sken.

Šest karet představuje deterministické kroky, nikoli šest LLM modelů:

| Krok | Vstupy a výsledek |
| --- | --- |
| Scanner | Mint, pool, stáří, likvidita a objem posledních pěti minut |
| Rug Check | Odvolání mint/freeze authority, program tokenu, největší držitel, uzamčení likvidity, varování |
| Sizer | Hotovost, počet pozic, vložený kapitál a denní brzdy |
| Executor | Obousměrné čerstvé kotace, konzervativní výstup, simulovaný nákup nebo prodej |
| Logger | Append-only rozhodnutí, vstupy, důvody, evidence kotací a nákladový model |
| Equity | Virtuální hotovost a hodnota otevřených pozic při konzervativním prodeji |

Stav karet patří poslednímu cyklu. Krok, který v něm neproběhl, nesmí vypadat
jako úspěšně provedená kontrola. Evidence v UI ukazuje posledních 50 rozhodnutí
a 30 obchodů; databáze uchovává i starší záznamy.

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
| Největší nahlášený držitel | nejvýše 20 %, konzervativně včetně vaultů poolů |
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

RugCheck poskytuje report třetí strany, nikoli vlastní audit řetězce. Ukládá
se čas načtení reportu; `detectedAt` je čas detekce tokenu, nikoli potvrzení
čerstvosti bezpečnostní kontroly. Zámek likvidity ani report nejsou zárukou.

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

Otevření stránky pouze načte evidenci. Na pozadí neběží automatický obchodník.
Když uživatel neskenuje, neprobíhá oceňování ani stop-loss/časový výstup.
Tyto hranice jsou pravidla simulace, nikoli burzovní ochranné objednávky.

API:

- `GET /api/solana` — stav virtuálního účtu; nezískává kotace ani neobchoduje.
- `POST /api/solana/cycle` — ruční sken, přecenění a simulace podle pravidel.
- `POST /api/solana/positions/:id/close` — pokus o simulovaný prodej konkrétní pozice.

POST nepřijímá parametry mint, cenu, částku, vlastníka ani režim. Žádný
endpoint neumí LIVE. Modul nemá peněženku, podpisový klíč, signer, RPC
odesílání ani volání Jupiter `/execute`. Nepoužívá Binance credentials.
Všechny vnější požadavky jsou GET na pevné domény, s časovým a velikostním
limitem; Jupiter požadavky jsou sériové a alespoň 2,1 sekundy od sebe.

Zámek cyklu a cooldown jsou v SQLite, takže přežijí restart a brání dvojímu
zápisu i ze dvou karet. Přerušený cyklus má pětiminutový lease, po kterém
další cyklus označí přerušení; starý vlastník lease už nemůže provést zápis.
Zápisy hotovosti, pozice, obchodu a auditní události jsou jedna transakce.

Migrace 12 přidává pět tabulek `solana_paper_*`. Záloha SQLite je již zahrnuje.
Smazání uživatele kaskádově odstraní jeho pilotní data; reset Binance účtu
je neodstraňuje. Po migraci nebude fungovat starý image se schématem 11.
Bezpečné vypnutí je vyprázdnit pilotní ID a ponechat image s migrací 12;
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

Automatické testy v `test/solana*.test.ts` ověřují datové adaptéry, odmítnutí
neúplných reportů, neprodejných tokenů a starých kotací, nečekané poplatky,
účtování, souběh, perzistenci limitů a přístup jiného účtu.
`test/browser/solana.mjs` ověřuje mobilní i desktopové rozměry, bezpečné
zobrazení cizích tokenových textů, neověřenou equity, přístup a ruční akce.
Před předáním prošlo 281 TypeScript testů, 190 Python testů, oba browserové
scénáře Home/Solana a restore drill s 33 tabulkami. Produkční pilot zatím
není zapnutý; změna je připravená na samostatné větvi k revizi.

Další milník: sběr delší historie odmítnutých i přijatých kandidátů, audit
Token-2022 a měření přesnějších nákladů. Helius stream, automatický scheduler
a oddělený live signer jsou další práce, nikoli skryté funkce tohoto pilotu.
