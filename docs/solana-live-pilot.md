# LIVE pilot — požadavek a chybějící exekuce

Uživatel 4. 11. 2026 zvolil samostatnou botí peněženku, automatické
podepisování a celkový rozpočet prvního testu **100 USDC**. Pilot má být
dostupný pouze neměnnému ID účtu Blazebro. Tento dokument popisuje další
milník; současná implementace zůstává PAPER a žádný z níže popsaných kroků
neprovedla. Přepnutí štítku v UI by nevytvořilo ostrou exekuci.

## Navazující implementace

1. Připojit oddělenou botí peněženku a izolovaný signer. Soukromý klíč nesmí
   vstoupit do chatu, logů, repozitáře ani běžného snapshotu API. Binance
   credentials a PAPER ledger se nepoužijí pro podepisování ani účtování.
2. Ověřit RPC, vlastní adresu, síť, skutečné USDC a rezervu SOL pro poplatky.
   Rozpočet 100 USDC se musí kontrolovat kumulativně včetně nákladů;
   neznámé ocenění SOL nebo neúplné zůstatky nový vstup zastaví. Dosavadní
   stropy 5 USDC na pozici a 15 USDC vloženého kapitálu není důvod navyšovat.
3. Doplnit skutečnou objednávku Jupiter s takerem, kontrolu sestavené
   transakce a jejích oprávnění, simulaci, omezený podpis a odeslání.
   Kontrolovat skutečné input/output minty, směry, částky, příjemce,
   odchozí převody, platnost a maximální skluz; neprůhledná transakce
   z externího API sama o sobě není dostatečné oprávnění k podpisu.
4. Zapsat trvalý záměr a identifikátory před odesláním. Při timeoutu nebo
   restartu zjišťovat stav původního podpisu a skutečné změny zůstatků,
   nikoli poslat další nákup naslepo. Nejasný stav znamená zastavení
   nových vstupů a smíření evidence s řetězcem.
5. Samostatný LIVE ledger účtuje až potvrzené změny tokenových zůstatků,
   rent a síťové poplatky; nenahrazuje je pevnou PAPER rezervou 0,01 USDC.
   Ověřit celý kontrolovaný nákup i návrat do USDC před automatickým během.

Risk Gate musí nadále odmítat chybějící data a neprodejné nebo nepodporované
tokeny. Token-2022 vyžaduje samostatný audit rozšíření a zatím se nepovoluje.
Výsledek reportu RugCheck ani dostupná zpětná kotace nezaručují budoucí
prodejnost. Marketingová čísla z referenčních obrázků nejsou validační data
naší strategie.

## Co dnes chybí

Není připojená ani ověřená botí peněženka, signer, LIVE ledger, validace
a simulace podepisovaných swapů, potvrzování a restartová rekonsiliace.
Žádný prostředek z rozpočtu 100 USDC nebyl převeden ani použit. Aktuální
PAPER automat nemůže LIVE spustit ani přijetím parametru `mode: "LIVE"`.

Primární technické podklady:

- [Jupiter Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute):
  bez takera pouze kotace, s takerem sestavení transakce, následně podpis a execute.
- [Solana simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction):
  simulace bez broadcastu; ověření podpisu je samostatná volba.
- [Solana getSignatureStatuses](https://solana.com/docs/rpc/http/getsignaturestatuses):
  zjišťování potvrzení existujícího podpisu včetně vyhledání historie.
