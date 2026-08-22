# config/settings.py
import os
from dotenv import load_dotenv
load_dotenv()
_e = os.environ.get

# --- API ---
API_KEY    = _e("BINANCE_API_KEY",    "")
API_SECRET = _e("BINANCE_API_SECRET", "")
TESTNET    = _e("TESTNET", "true").lower() == "true"

# --- Telegram ---
TELEGRAM_TOKEN   = _e("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = _e("TELEGRAM_CHAT_ID", "")

# --- Páry ---
PAIRS = [
    {"symbol": "BTCUSDC", "base": "BTC"},
    {"symbol": "ETHUSDC", "base": "ETH"},
]
QUOTE_ASSET = "USDC"

# --- Timeframes ---
TIMEFRAME_1H = "1h"
TIMEFRAME_4H = "4h"

# --- Kapitál ---
MAX_POSITION_USDT = 50.0   # absolutní strop na jeden obchod
POSITION_PCT      = 25.0   # % z balance použité na jeden obchod

# --- Indikátory (Golden Cross strategie) ---
EMA_FAST_PERIOD    = 50    # Golden Cross
EMA_SLOW_PERIOD    = 200   # Death Cross
MAX_SL_PCT         = 10.0  # Nouzový stop loss (cena klesne o 10% od vstupu)
PRE_CROSS_PCT      = 1.0   # Alert když EMA50 je do X% od EMA200
TRAIL_ACTIVATE_PCT = 3.0   # Trailing stop se aktivuje při zisku +3%
TRAIL_DISTANCE_PCT = 1.5   # Trailing stop sleduje 1.5% pod maximem

# --- Risk limity (sdílené napříč všemi páry) ---
MAX_DAILY_LOSS_USDT     = 5.0
MAX_WEEKLY_LOSS_USDT    = 15.0
MAX_CONSECUTIVE_LOSSES  = 2
MAX_TRADES_PER_DAY      = 3
MAX_TRADES_PER_WEEK     = 9
COOLDOWN_AFTER_LOSS_HRS = 24
COOLDOWN_AFTER_WIN_HRS  = 6

