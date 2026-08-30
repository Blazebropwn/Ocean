# Binance EMA Crossover Bot

Jednoduchý trading bot pro Binance s EMA 9/21 crossover strategií.

---

## ⚠️ Varování

- Začni **vždy na Testnetu** (`TESTNET = True` v `config/settings.py`)
- Tento bot je **vzdělávací základ** — není záruka zisku
- Trading na crypto trzích nese vysoké riziko ztráty

---

## Instalace

```bash
# 1. Vytvoř virtuální prostředí
python -m venv venv
source venv/bin/activate   # Linux/Mac
venv\Scripts\activate      # Windows

# 2. Nainstaluj závislosti
pip install -r requirements.txt
```

---

## Konfigurace

Otevři `config/settings.py` a vyplň:

```python
API_KEY    = "TVUJ_API_KEY"
API_SECRET = "TVUJ_API_SECRET"
TESTNET    = True        # přepni na False až po testování!
SYMBOL     = "BTCUSDT"
TRADE_QUANTITY = 0.001
```

### Kde vzít API klíče?
- **Testnet:** https://testnet.binance.vision → Log in with GitHub → API Management
- **Reálný účet:** https://www.binance.com → Settings → API Management

---

## Spuštění

```bash
python bot.py
```

Logy se ukládají do `logs/bot.log`.

---

## Struktura

```
binance-bot/
├── bot.py              # hlavní smyčka
├── strategy.py         # EMA crossover logika
├── utils.py            # pomocné funkce (klines, EMA, balance)
├── requirements.txt
├── config/
│   └── settings.py     # API klíče a parametry ← NEVERZOVAT!
└── logs/
    └── bot.log         # automaticky generováno
```

---

## .gitignore (pokud dáš do Gitu)

```
config/settings.py
logs/
venv/
__pycache__/
*.pyc
```

---

## Jak to funguje

1. Každých 60 sekund stáhne posledních 100 svíček (`INTERVAL`)
2. Vypočítá EMA9 a EMA21 z close cen
3. Pokud EMA9 překříží EMA21 zdola → **BUY** (market order)
4. Pokud EMA9 klesne pod EMA21 → **SELL** (market order)
5. Zapíše výsledek do logu

## Týdenní DCA

DCA je samostatná automatizace, která v neděli od 08:00 českého času před týdenním reportem nakoupí zvolené páry. Výchozí konfigurace je bezpečně vypnutá.

```env
DCA_ENABLED=false
DCA_AMOUNT_USDC=5
DCA_SYMBOLS=BTCUSDC,ETHUSDC,SOLUSDC
```

`DCA_AMOUNT_USDC` je částka pro každý symbol, tedy při výchozím nastavení celkem 15 USDC týdně. Před aktivací ověřte nákupy na Testnetu. Modul kontroluje minimální hodnotu příkazu a ukládá stabilní ID objednávky, aby restart workeru nevytvořil druhý nákup.

---

## Možná rozšíření

- Stop-loss / take-profit logika
- Telegram notifikace při obchodu
- Backtest modul na historických datech
- Více párů současně
- Web dashboard (Flask/FastAPI)
