# Nové období Kryptotronu

Ve správě členů je u připojeného osobního Kryptotronu dostupné **Znovu nastavit účet**.
Správce načte aktuální instanci a období a potvrdí přesné uživatelské jméno.
Požadavek má vlastní ID, platí deset minut a je zaznamenaný v administrátorském auditu.

## Podmínky

- Worker musí mít čerstvý heartbeat. Pozice a nevyřízené exekuce musí být uzavřené.
- Reset nesmí zahodit nepotvrzenou historii, ruční uzavření ani obnovu ochrany.
- Worker pouze čte Binance. Jakákoli otevřená objednávka nebo uzamčený zůstatek reset odmítne.
- BTC, ETH a SOL musí být pod minimální hodnotou objednávky podle filtrů a aktuální ceny.
- Zůstatky a objednávky se kontrolují podruhé; změna během měření znamená odmítnutí.

Požadavek vypne nové vstupy, DCA a Streak. Žádný reset neprodává ani neruší objednávky.
Při odmítnutí zůstává dosavadní evidence i pauza zachovaná. UI uvádí konkrétní důvod.

## Archiv a nové období

Před nahrazením vzdáleného stavu se původní stav uloží do SQLite tabulky
`account_reset_archives`, tedy i do existujících databázových záloh. Správce může
stáhnout JSON ze stejného dialogu. Potvrzené historické řádky `bot_trades` v Supabase
se nemažou; běžný přehled po resetu ukazuje pouze obchody nového období.
DCA historie, rezidua a vysvětlení předchozího období zůstávají v archivu.

Aktuální mince se evidují jako `unmanaged_inventory`, nikoli jako obchodovaná pozice.
Nákladová báze se neodhaduje. Denní a týdenní ztráty, počty vstupů, cooldowny a ostatní
riziková omezení se nevynulují. Nové období má vlastní `state_epoch`; starší worker
nesmí jeho stav přepsat. Všechny změny probíhají pod existujícím zámkem instance
v jediném serverovém procesu. Nasazení s více replikami tento model nepodporuje.

Po dokončení zůstávají všechny nákupy vypnuté a `safe_mode` aktivní, dokud běžná
rekonciliace nepotvrdí účet. Obnovení obchodování je až následné samostatné rozhodnutí.
Ztracená odpověď na dokončení dovoluje opakovat stejné ID bez druhého resetu.

Při výpadku úložiště ověřit stav stejným dialogem, nikoli ručně odmazávat bezpečnostní
příznaky. Záloha může existovat i po neúspěšném pokusu o zápis nového období.
