# DCA: tři částky a společný interval

Každé aktivum má v Home → DCA vlastní posuvník s pěti body
**5 / 10 / 20 / 50 / 100 USDC za jeden nákup**. Nad nimi je jeden společný
přepínač Denně / Týdně / Měsíčně. Tlačítko Uložit nastavení uloží všechny
tři částky a společný interval najednou.
Posuvník funguje i klávesnicí; částky lze vybrat kliknutím na jednotlivé body.
Neuložené změny přežijí pravidelné obnovení dat a lze je zrušit.
Vedle každého posuvníku je investovaná a aktuální hodnota evidovaných
nákupů aktiva; součty jsou pod třemi řádky. Historie je v samostatném dialogu.

Termíny schválené uživatelem:

- denně v 08:00;
- týdně v neděli v 08:00;
- měsíčně prvního dne měsíce v 08:00;
- vždy Europe/Prague, včetně změn letního a zimního času.

Změna částky nebo intervalu není pokyn k okamžitému nákupu. Server uloží
čas změny; nový plán je způsobilý až pro termín, který nastane po tomto čase.
Samotné opakované uložení stejných hodnot čas neposouvá. Povolení/vypnutí
DCA je dál společné pro všechny DCA plány a nemění Trading.

Worker termín zpracuje při první pravidelné kontrole po 08:00 daného dne,
pokud to dovolí společná pauza, dostupné prostředky a dosavadní rizikové
kontroly. Nedohání starší kalendářní dny hromadnými nákupy. Přeskočení pro
nedostatek prostředků nebo minimum objednávky daný termín ukončí; další
pokus je až v dalším termínu. Nejasný výsledek odeslané objednávky se napřed
ověří na burze, nikdy se slepě neopakuje.

## Uložení a zpětná kompatibilita

`POST /api/kryptotron/dca/settings` přijímá
`{amounts: {BTCUSDC, ETHUSDC, SOLUSDC}, frequency}`. Všechny tři částky
jsou povinné, každá jeden z pěti bodů; interval je `daily`/`weekly`/`monthly`.
Identitu instance určuje přihlášený účet. Jeden zápis mění `dca.frequency`
a všechny tři položky `dca.plans` pod stávajícím zámkem instance.
Nezměněná aktiva si zachovávají čas účinnosti. Worker nemůže starším
snapshotem přepsat uložené částky ani společný interval.

Ve vzdáleném JSON stavu přibylo:

```json
{
  "dca": {
    "frequency": "daily",
    "plans": {
      "BTCUSDC": {"amount": 10, "frequency": "daily", "configured_at": "2026-10-11T12:00:00.000Z"},
      "ETHUSDC": {"amount": 5, "frequency": "daily", "configured_at": "2026-10-11T12:00:00.000Z"},
      "SOLUSDC": {"amount": 20, "frequency": "daily", "configured_at": "2026-10-11T12:00:00.000Z"}
    },
    "completed_periods": {"BTCUSDC": {"daily": "2026-10-12"}}
  }
}
```

Aktiva bez individuálního plánu zachovávají původní částku a nedělní
termín. Starší individuální intervaly se zachovají do prvního uložení
společného nastavení; společný interval má potom přednost. Starší částky
200/500/1000 se nesnižují automaticky: UI ukáže uloženou hodnotu;
před novým uložením je potřeba zvolit částky z pěti nabízených bodů. Původní týdenní checkpointy,
pending objednávky a historie zůstávají platné. Staré API pro společnou
částku odmítne přepis, pokud už existuje individuální plán.

Dokončení se eviduje odděleně pro aktivum a interval, nezávisle na ořezu
posledních 156 nákupů v UI. Klientská ID objednávek jsou stabilní pro daný
termín; nové období účtu je zohledněné v ID. Reset zachová nastavení plánů,
vyprázdní jejich historii a nechá automatizaci vypnutou.

Nasazení musí zahrnovat server, frontend i restart workeru. Vzdálené SQL
schéma se nemění. Lokální implementace nemění běžící mainnet plány.

## Ověření

`test/dca-plans.test.ts` pokrývá validaci, izolaci účtů, atomické uložení všech
částek a společného intervalu, idempotentní uložení a ochranu před starším zápisem workeru.
`services/kryptotron/tests/test_dca_plans.py` ověřuje rozdílné částky,
intervaly, změny času, restart, ztracenou odpověď burzy, budoucí účinnost
změn, ořez historie, neplatné nastavení a neúspěšné uložení záměru.
`test/browser/home.mjs` ověřuje posuvníky, společné uložení, zachování
rozpracované změny i fokusu při obnově a chybu uložení na simulovaných API.
Kontroluje také klikání na všech pět bodů, tažení posuvníku, zarovnání bodů,
hodnoty jednotlivých aktiv i součty a chybějící ceny. Celá stránka byla
ověřena i v lokálním Firefoxu se simulovaným API a skutečnými událostmi myši.

Závěrečné ověření: build úspěšný, **245 Node testů a 188 Python testů prošlo**.
Chromium kontroluje desktop 1920×1080, 1440×900, 1366×768, 1280×720
a 1024×768 bez posouvání a tři mobilní záložky Home / Trading / DCA
při šířkách 320, 390 a 768 px.
