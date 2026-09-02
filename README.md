# OCEAN

Ocean je společný projekt webového účtu a aplikace Kryptotron.

```text
Ocean/
├── src/                    webový server a API
├── public/                 uživatelské rozhraní
├── services/kryptotron/    Binance worker
└── data/                   lokální databáze Oceanu
```

Aktuální vertikální řez v0.1 obsahuje registraci, přihlášení pomocí username, odhlášení, změnu a obnovu hesla, chráněný profil, serverové sessions, ověření e-mailu a auditní události. E-mail ani username nejsou identita; účet má neměnné interní `usr_…` ID.

## Spuštění

```bash
npm install
npm run dev
```

Web poběží na <http://localhost:3000>. SQLite databáze vznikne v `data/ocean.db`.

## Kryptotron

Zdrojový kód existujícího Binance workeru je v `services/kryptotron`. Obchodní logika a konfigurace strategie zůstaly beze změny. Původní `.env`, Git historie, virtuální prostředí, logy a běhový stav nebyly do Oceanu zkopírovány.

```bash
cd services/kryptotron
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python bot.py
```

Lokální `.env` Kryptotronu musí obsahovat jeho vlastní Binance, Supabase a případně Telegram údaje. Aktuální produkční worker může dál běžet na Railway; Ocean čte jeho stav serverově přes proměnné `KRYPTOTRON_SUPABASE_URL` a `KRYPTOTRON_SUPABASE_KEY` v kořenovém `.env`.

Po registraci otevřete na profilu **Otevřít mailbox** a použijte poslední ověřovací odkaz. Jde o lokální vývojovou náhradu skutečného e-mailového providera; endpoint mailboxu v produkčním režimu vrací 404.

```bash
npm test
npm run typecheck
npm run build
```

## Bezpečnostní základy

- hesla jsou hashována pomocí Argon2id,
- session tokeny mají 256 bitů entropie a v databázi se ukládá pouze jejich SHA-256 hash,
- cookie je `HttpOnly`, `SameSite=Lax` a v produkci `Secure`,
- autentizační endpointy mají omezení počtu požadavků,
- login používá stejnou chybu pro neexistující účet i špatné heslo,
- zapisují se události vytvoření účtu a přihlášení,
- mutace kontrolují `Origin` proti `APP_ORIGIN`.

Před produkčním nasazením je potřeba připojit skutečný e-mailový provider, recovery, správu sessions/zařízení, mazání účtu a správu tajemství. Tyto funkce jsou záměrně další iterace v0.1, ne makety.
# Ocean Invite Alpha

Ocean je uzavřený systém. První účet získá roli `owner`; všechny další účty vyžadují jednorázovou pozvánku vytvořenou vlastníkem. Pozvánka platí sedm dní, lze ji omezit na konkrétní e-mail a před použitím ji lze zrušit. V databázi se ukládá pouze hash tokenu.

Po přihlášení otevře vlastník správu přes profil → **Pozvánky**. Pro odkazy použitelné mimo lokální počítač musí `APP_ORIGIN` obsahovat veřejnou adresu Oceanu.
