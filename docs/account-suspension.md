# Pozastavení členského účtu

Vlastník ve **Správa → Pozvánky a členové** vybere **Pozastavit účet** nebo
**Odblokovat účet**. Každou změnu potvrdí. Vlastní účet ani jiného vlastníka takto
pozastavit nelze. Nasazení této funkce samo žádný účet nepozastaví.

Pozastavený člen se může přihlásit, odhlásit a změnit nebo obnovit heslo. Vidí
zámečky a informaci, že má kontaktovat správce. Home, Arcade, Gamble, Vault,
redeem a jejich API jsou zamčené. Zůstatek TIDE se může dále zobrazovat v hlavičce.
Aktivní stránka kontroluje stav účtu každých 15 sekund a při návratu do okna;
server odmítá zakázané požadavky ihned po uložení blokace. Telegram člena také
nemůže znovu spustit nákupy nebo potvrdit starý požadavek.

## Automatizace a otevřené pozice

Blokace nastaví pauzu nových vstupů a vypne DCA i streak. Nezahájený testovací
DCA požadavek odmítne. Již odeslané objednávky, rozpracované vypořádání,
otevřené pozice a ochranné objednávky zachová. Worker zůstává spuštěný pro
kontrolu účtu, ochranu a vypořádání; blokace sama neruší objednávky na Binance.
Již odeslaný obchod může být dokončen i po pozastavení účtu.

Pauza se vynucuje na čtení i zápisu worker brokeru. Pokud vzdálené úložiště
neodpovídá, místní blokace zůstává platná a správce dostane upozornění na
nedokončené uložení pauzy. Odblokování instance se vzdáleným stavem vyžaduje
úspěšné uložení pauzy; při výpadku vrátí 503 a účet zůstane zamčený.

**Odblokování obnoví přístup do aplikace, ale samo znovu nezapne nákupy.**
Uživatel následně obnoví strategii, DCA či streak samostatně. TIDE, historie,
schválení účtu a přihlašovací údaje se nemění.

## Oprávnění a evidence

`POST /api/members/:id/suspension` přijímá pouze `{ "suspended": true | false }`.
Vyžaduje relaci vlastníka a přesný Origin aplikace. Opakovaný požadavek na stejný
stav nic nemění. Souběžná změna stejného účtu vrátí 409.

Migrace 007 přidává `users.suspended_at` a `users.suspended_by`. Změny se ukládají
do existujícího `admin_audit_log` jako `MEMBER_SUSPENDED` a `MEMBER_UNSUSPENDED`
včetně správce, člena, času a metadat požadavku. Staré Telegram potvrzovací a
párovací tokeny se při změně zneplatní.

Ověření: `test/account-suspension.test.ts` pokrývá oprávnění, audit, existující
relace, oba režimy schvalování, Telegram, výpadek úložiště, zastaralý zápis workeru
a zachování ochrany i již zahájených operací. Žádný test neposílá skutečné
objednávky ani nepozastavuje produkčního člena.
