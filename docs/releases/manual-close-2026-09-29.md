# Produkční balíček: ruční uzavření pozic — 2026-09-29

Funkční základ: `3213b12725e99e75898d78a63b5067a1206d5a93`.
Předchozí produkční commit: `5446f7bb52d608960ee2ec62454eb1d71bfc0e7d`.
Předchozí Railway deployment: `54f6efe7-ea9c-4504-a03c-9500b4c9c4da`.
Nasazení je určeno pro stávající jedinou službu Ocean a její supervisor.

## Rozsah

Tlačítko **Uzavřít** u trendových BTC/ETH pozic, potvrzovací dialog,
bezpečné zrušení příslušné OCO a ruční prodej evidovaného množství.
Po potvrzení prodeje běží 60minutová pauza pro daný pár; pak jej
strategie posoudí při další kontrole. Globální pauza a risk limity platí dál.

Funkce závisí na kontrolách účtu a exekucí z Kryptotron v1: reconciliation
při startu a za běhu, blokování nejasných pending objednávek, durable SELL
intent a historie, ochrana uživatelských příkazů před starým zápisem workeru.
Součástí balíčku jsou také deterministická vysvětlení strategie a monitoring
neověřeného stavu. Research dokumenty nejsou běžící obchodní strategií.

EMA50/200 na uzavřených 4h svíčkách, BULL entry, sizing, alokační strop,
stop/trailing parametry a denní/týdenní limity nejsou přeladěné. Nové kontroly
mohou zastavit vstupy při neověřeném stavu, neplatných cenách či mezeře v
historii svíček. Manuální WIN používá pauzu konkrétního páru místo globální
pauzy po automatickém ziskovém výstupu; ochrana po sérii ztrát zůstává.
Schéma databáze, izolace uživatelů a šifrování credentials se nemění.

## Ověření před nasazením

- Build, všech 31 souborů Node testů a 114 Python testů prošlo.
- Chromium: 18 kontrol rozložení v šesti velikostech, dialog a jeden požadavek
  při dvojím kliknutí; bez JavaScript chyb.
- Skutečný Binance Spot Testnet: malý virtuální BUY, aktivní OCO, nový proces
  obnovil stav, dva stejné HTTP požadavky, jeden ruční výstup, uložená pauza,
  zachovaný DCA/externí inventář i uživatelská globální pauza. Po restartu
  běžného workeru reconciliation OK, nula pozic a nula čekající historie.
- Produkční čtecí preflight: oba připojené účty mají reconciliation OK podle
  nového algoritmu; každý dvě otevřené pozice a čtyři aktivní OCO větve.
  Žádné pending záměry. Identifikátory stávajících vstupů jsou kompatibilní
  s potvrzením ručního výstupu.
- Konzistentní SQLite záloha a snímky brokeru, zůstatků a objednávek jsou na
  produkčním chráněném volume v `/data/releases/manual-close-20260929/`.
  Credentials ani osobní snímky nejsou v Gitu.

## Kontrola rollout / návrat

Po úspěšném Railway buildu ověřit `/api/health`, `/api/ready`, otisk assetů,
oba čerstvé workery, reconciliation OK, zachované OCO identifikátory a
`manualClose.available` v autentizovaném snapshotu. Ověření produkce je
čtecí; testovací prodej na mainnetu se neprovádí.

Railway má jednu repliku, overlap 0 a připojený `/data` volume. Při návratu
na předchozí image se nesmí přepsat obchodní stav starou zálohou. Nejprve
ověřit, že není aktivní ruční požadavek nebo pending SELL a že jeho plnění
je vypořádané. Starý worker ruční protokol nepodporuje; rollback s aktivním
ručním výstupem vyžaduje dokončení/reconciliation novým workerem. Záloha
slouží k řízené obnově, nikoli automatickému resetu burzovní evidence.

Celý dlouhodobý strategický experiment není tímto releasem dokončený.
Výsledky research nedokládají robustní edge; frozen holdout zůstává beze změny.
Podrobnosti funkce a omezení: [Ruční uzavření](../manual-position-close.md).
