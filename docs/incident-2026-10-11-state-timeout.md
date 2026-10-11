# Krátké bezpečnostní režimy při ukládání kontroly účtu

Kontrola provedena 11. 10. 2026 pouze čtením produkčních záznamů.
Identita účtu byla ověřena propojením instance a uživatelského jména v SQLite;
osobní identifikátory ani surové produkční záznamy nejsou součástí repozitáře.

## Zjištění

Ve 19:36:04 a 21:21:47 Europe/Prague (17:36:04 a 19:21:47 UTC) worker
zalogoval timeout při `PUT /internal/kryptotron/state` na lokální Ocean
broker. Klient čekal 8 sekund. Následoval obecný `RECONCILIATION_REQUIRED`
s diagnostikou „Výsledek rekonciliace se nepodařilo uložit“.

Serverový záznam druhého výskytu potvrzuje požadavek od 19:21:39 UTC,
timeout a HTTP 500 po přibližně 8004 ms. Následující zápis stavu prošel
s HTTP 204 za přibližně 199 ms. Uložení stavu na serveru používá vzdálené
úložiště s osmivteřinovými timeouty. Log nerozlišuje, který z jeho požadavků
se zdržel, ani proč úložiště nebo spojení neodpovědělo včas.

Jde o potvrzené selhání uložení výsledku kontroly. Tyto záznamy nedokládají
chybějící zůstatek či nesoulad objednávek na Binance. Samotný krátký čas
do obnovení není důkazem správnosti účtu.

Při následné kontrole ve 21:42:47 Europe/Prague byl stav `OK`, bezpečnostní
režim vypnutý, worker `waiting`, žádný pending order ani pending protection
a počet otevřených objednávek byl 2. Uživatelský screenshot dokládá oznámení
o obnovení v 19:37 a 21:23.

## Úprava upozornění

- Administrátorská kontrola dohledává uživatelské jméno a prostředí ze
  serverové databáze. Platí i pro nedostupný stav a neaktuální heartbeat.
- Důvody uvádějí bezpečný kód a případný symbol; surové výjimky ani
  autorizační údaje se do Telegramu nepřenášejí.
- Neúspěšné uložení výsledku rekonciliace má kód `STATE_SAVE_FAILED`.
  Bezpečnostní režim nadále blokuje nové nákupy a následující úspěšná
  kontrola se potvrzeným uložením jej může ukončit.
- Zpráva o obnovení obsahuje vyřešená upozornění včetně účtu. Částečné
  obnovení jednoho účtu neoznamuje, že je celá služba v pořádku.

Timeouty, opakování objednávek a obchodní pravidla se touto úpravou nemění.
Podkladová příčina krátké nedostupnosti úložiště zůstává neurčená.

## Ověření

Node testy pokrývají přiřazení jmen k účtům, oddělení prostředí, skrytí
surové diagnostiky, kódy příčin, potlačení duplicit a částečné i úplné
obnovení. Python testy simulují úspěšnou kontrolu s neúspěšným uložením,
zablokování nákupů a zotavení při další kontrole; zvlášť ověřují, že skutečná
výjimka při kontrole účtu není označena jako chyba uložení.
