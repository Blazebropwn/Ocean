# Kryptotron pro Ocean

Python worker řízený supervisorem Oceanu. Nemá vlastní nasazení ani
Telegram bota. Zdroj kódu, konfiguraci a životní cyklus spravuje Ocean.

## Provoz

Supervisor přidělí `KRYPTOTRON_INSTANCE_ID`, Binance připojení,
`OCEAN_STATE_URL` a `OCEAN_STATE_TOKEN`. Každá instance má vlastní
pracovní adresář. Bez platného brokeru a vzdáleného stavu se worker
nespustí; nepoužije prázdný lokální stav jako náhradu.

Stav, historii a zprávy předává internímu API Oceanu. Jediný Telegram
polling a jediné odesílání zpráv běží v serveru Oceanu. Worker nikdy
nedostává Telegram ani globální Supabase klíč.

## Strategie a automatizace

- Trendový vstup: EMA50 > EMA200 na uzavřených 4h svíčkách.
- Výstup: death cross nebo burzovní ochranná OCO objednávka.
- Nouzový stop: 10 %, trailing aktivace: 3 %, vzdálenost: 1,5 %.
- Týdenní DCA: neděle od 08:00 Europe/Prague; částka je za každý symbol.
- Streak Governor je pouze paper trading.

Nastavení a aktivaci provádí uživatel v Oceanu nebo přes jeho centrálního
Telegram bota. Připojené účty začínají s pozastavenými vstupy a vypnutým DCA.

## Vývoj a ověření

```bash
npm run verify
```

Nasazení: [Ocean na Railway](../../docs/deploy-railway.md).
Migrace původní instance: [sjednocení](../../docs/kryptotron-consolidation.md).
Výzkum: [Strategy Lab](research/README.md). Backtest není shodný model
produkční exekuce; jeho omezení jsou uvedena v dokumentaci výzkumu.
