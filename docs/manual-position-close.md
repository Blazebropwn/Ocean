# Ruční uzavření trendové pozice

Funkce je připravená pro produkční release z větve `main`; původně byla
ověřena na `work/kryptotron-v1-validation`. Rozsah, preflight a postup rollout
jsou v [release záznamu](releases/manual-close-2026-09-29.md).

## Chování

U otevřené BTC/ETH pozice je tlačítko **Uzavřít**. Dialog obsahuje množství,
odhad výnosu a výsledku před poplatky, prostředí a výslovné potvrzení prodeje.
Poplatky a skluz nejsou známé před plněním; čistý výsledek zatím dialog
neodhaduje. DCA ani externí inventář se nezahrnují do prodávaného množství.

Po úplném potvrzeném prodeji běží pro daný pár **60 minut** pauzy. Čas se
ukládá do brokeru a přežije restart. Po vypršení se obnoví způsobilost k
posouzení při pravidelné kontrole 4h strategie, nikoli okamžitý nákup.
Uživatelská globální pauza, limity ztrát a přestávka po sérii ztrát mají
nadále platnost. Ziskový ruční prodej nezavádí běžnou globální pauzu po výhře.
DCA se řídí vlastním plánem a nepodléhá této pauze trendového páru.

## Protokol a obnova

- Přihlášený uživatel posílá `symbol`, `positionId`, `confirmed: true` na
  `POST /api/kryptotron/positions/close`. Instanci vybírá server z vlastníka
  relace; požadavek nemůže zadat cizí instanci ani množství prodeje.
- Endpoint vyžaduje schválený účet, podporující worker, čerstvý heartbeat,
  reconciliation OK, aktivní ochranu a žádné nedořešené objednávky.
  Starý worker bez `manual_close_version: 1` funkci nenabízí.
- Jediný aktivní požadavek instance postupuje přes
  `queued → cancelling → ready → selling → completed`.
  Nezpracovaný požadavek po pěti minutách končí `rejected`; nová explicitní
  konfirmace může založit další. Zaniklá nebo nahrazená původní pozice končí
  `superseded`. Stejný požadavek z více karet nebo opakování po timeoutu
  vrací původní identifikátor a nevytváří další objednávku.
- Worker nejprve obnoví známé pending objednávky. Každou fázi zapisuje před
  další akcí na burze. Původní OCO identita přežije timeout zrušení. Plnění
  ochrany má přednost před market prodejem. Po zrušení se znovu kontroluje
  inventář a cizí objednávky.
- SELL intent s jedním `clientOrderId` se uloží před odesláním. Nejasná
  odpověď nebo restart vedou jen k query tohoto příkazu. Částečné plnění,
  nepotvrzená objednávka či nesoulad se nepovažují za úspěch; nové vstupy
  zůstávají blokované a operátor musí zkontrolovat skutečný stav burzy.
  Worker v této situaci neodhaduje opravný prodej ani nové množství ochrany.
- `pair_cooldowns[symbol]` vzniká až po potvrzení úplného prodeje.
  Při opožděné obnově plnění začíná pauza okamžikem potvrzení workerem,
  tedy konzervativně později. Zápis pozice, dokončení a pauzy je společný.
  Historie používá `MANUAL_CLOSE` a dosavadní durable outbox.
- Broker serializuje zápisy v jednom procesu a zachovává novější ovládací
  požadavky při opožděném zápisu workeru. Ztracená odpověď po uloženém
  dokončení nesmí obnovit prodanou pozici; broker odmítne starší fázi a
  worker načte potvrzený stav včetně pauzy a historie. Pro jednu instanci/účet musí nadále
  existovat pouze jeden worker; horizontální vícezapisovací provoz není
  tímto protokolem zaveden.

## Ověření 2026-09-29

```bash
PATH="$PWD/.venv/bin:$PATH" npm run verify
```

Build, 31 souborů Node testů a 114 Python testů prošlo.

Node testy ověřují autorizaci, origin, vlastnictví instance, potvrzení,
identitu pozice, deduplikaci, zápisy starého workeru, dostupnost a cooldown
v uživatelském výkladu. Python testy pokrývají OCO fill při rušení, timeout
cancel/SELL, obnovu stavu, výpadek zápisu, částečný SELL, změnu inventáře,
pořadí obnovy pending ochrany, expiraci a respektování pauzy/risk limitů.

Chromium: 18 kontrol rozložení a dostupnosti obsahu v šesti velikostech
(320–1440 px), potvrzovací dialog, dvojí kliknutí (jeden HTTP požadavek),
stav čekání, dokončení, globální pauza a nedostupnost funkce. Bez
JavaScript chyb. Zkontrolován také mobilní snímek dialogu.

### Skutečný Binance Spot Testnet

Izolovaný účet, vlastní SQLite a port 3101, mainnet vypnutý. Běžný lokální
worker byl pro řízený test zastaven, produkce zůstala nedotčená.

- Virtuální BTC vstup s rozpočtem 10 USDC, skutečné plnění 0,00011 BTC.
- Aktivní burzovní OCO; reconciliation OK.
- Samostatný nový testovací proces obnovil pozici z brokeru.
- Dvě volání skutečného přihlášeného HTTP endpointu vrátila stejné ID.
- OCO zrušeno, pozice prodána, historie uložena, žádné zbývající BTC
  objednávky. Opakované zpracování nevytvořilo další objednávku.
- Potvrzeno **2026-09-29 12:23:41 UTC**, pauza do **13:23:41 UTC**.
- Reconciliation OK, globální pauza zachována, DCA a externí inventář
  beze změny. Obnovení ze stavu i restart běžného supervisorovaného workeru
  zachovaly dokončení a pauzu; žádná otevřená pozice ani čekající historie.

Soukromé důkazy a izolovaný testovací runner jsou v ignorovaném
`data/testnet-acceptance/`. Tento test ověřuje ruční výstup; nevydává se za
přirozený EMA vstup, ziskovost strategie, čekání na skutečný death cross
ani úplné dokončení širšího mainnet release checklistu.

Binance popisuje nejednoznačné timeouty a doporučené query objednávek v
[oficiální REST dokumentaci](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#general-api-information).
