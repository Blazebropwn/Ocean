# strategy.py
from utils import calculate_ema


def get_cross_data(client, symbol, ema_fast=50, ema_slow=200):
    """Vrátí 4h EMA data pro Golden/Death Cross detekci."""
    klines = client.get_klines(symbol=symbol, interval="4h", limit=ema_slow + 10)
    klines = klines[:-1]  # pouze uzavřené svíčky
    closes = [float(k[4]) for k in klines]
    highs  = [float(k[2]) for k in klines]
    lows   = [float(k[3]) for k in klines]

    ema_f = calculate_ema(closes, ema_fast)
    ema_s = calculate_ema(closes, ema_slow)

    return {
        "close":        closes[-1],
        "high":         highs[-1],
        "low":          lows[-1],
        "ema_fast":     ema_f[-1],
        "ema_slow":     ema_s[-1],
        "bull":         ema_f[-1] > ema_s[-1],
        "golden_cross": ema_f[-2] <= ema_s[-2] and ema_f[-1] > ema_s[-1],
        "death_cross":  ema_f[-2] >= ema_s[-2] and ema_f[-1] < ema_s[-1],
    }

