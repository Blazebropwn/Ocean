# Evidence zbytků při vytváření ochrany

Při vytvoření OCO se `position_qty` zmenšovalo na množství povolené burzovním
krokem. Rozdíl proti čistému nákupu po poplatku nebyl evidován. Po více
uzavřeních se zbytky nasčítaly nad toleranci rekonciliace a vznikl
`UNATTRIBUTED_BALANCE`, přestože samotné ochranné příkazy mohly být aktivní.

`store_protection` nyní ukládá tento rozdíl do `strategy_residuals` zároveň
se zmenšením pozice. Opakované potvrzení téže ochrany už znovu nic nepřičítá.
Zbytky se nepřidávají k další obchodované pozici. Existující kontroly účtu,
limity a blokace nákupů zůstávají zachované.

Starší evidence vyžaduje samostatnou opravu podle potvrzených burzovních
plnění. Samotný rozdíl proti aktuálnímu zůstatku není důkaz původu prostředků.
Před opravou uložit zdrojové identifikátory plnění a zálohu stavu, zabránit
souběžnému zápisu workeru, zachovat uživatelskou pauzu a provést kontrolu
verze při zápisu. Znovu ověřit účet běžnou rekonciliací. Drobné neprokázané
rozdíly nepřipisovat strategii; používat původní toleranci burzovního kroku.
Starší částečně známou nákladovou bázi nelze vydávat za úplnou.

Zrušení ochranných objednávek je samostatná událost. Oprava evidence je
neobnovuje a nesmí automaticky rušit uživatelskou pauzu nebo bezpečnostní
režim. Stav ochrany musí potvrdit burza.

Telegram nyní odpovídá i na blokovaný `/resume`, uvádí všechny otevřené
pozice a stav ochrany v `/status`. Odpověď na `/pause` již neslibuje
ověřenou ochranu bez její kontroly.

Ověření: build, 197 Node testů, 135 Python testů. Regrese zahrnují opakované
zaokrouhlení a uzavření, neplatné množství, ztracenou odpověď při ukládání
OCO a restart bez druhého příkazu nebo dvojího zaúčtování zbytku.

## Výslovné obnovení zrušené ochrany

Po ručním zrušení OCO se zachovává původní identita a parametry. Běžná smyčka
ji automaticky neobnovuje. Home nabídne vlastníkovi pozice `Obnovit ochranu`
a dialog s množstvím, stopem a trailing parametry. POST vyžaduje autentizaci,
schválený účet, přesný Origin, potvrzení a identitu pozice i původní ochrany.

Požadavek lze přijmout pouze při pozastavených nákupech, aktuálním heartbeat,
bez čekajících exekucí a s rekonciliací, kde zbývají výhradně chybějící
ochrany. Worker znovu ověří zůstatky, původní zrušenou OCO, burzovní filtry,
volné množství a cenu mezi původním stopem a aktivací. Ostatní mince ani
parametry strategie nepřebírá z HTTP těla. Požadavek expiruje po 10 minutách
před odesláním; již odeslaný příkaz se dále ověřuje pod stejným ID.

Záměr i nové ID ochrany se uloží před burzovním voláním. Nejasná odpověď
nikdy nespustí opakované odeslání. Souběžná starší kopie workeru nemůže
smazat, přesměrovat nebo vrátit dokončený požadavek. Obnova ponechá pauzu
nových nákupů; bezpečnostní režim zruší až běžná úplná kontrola účtu.
K obnovení obchodování je potom potřeba samostatné rozhodnutí vlastníka.

Regrese zahrnují autorizační a Origin kontroly, vazbu na instanci,
souběh/deduplicitu, zastaralý stav, neznámé zůstatky a objednávky, změnu ceny,
ztracenou odpověď burzy, neúspěšný zápis záměru a zákaz automatického
obnovení zrušených příkazů. Prohlížeč používá výhradně falešná data.
