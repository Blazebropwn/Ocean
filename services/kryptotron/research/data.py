"""Stahovani a cachovani klines z Binance REST API (bez API klice)."""
import json
import math
import time
import urllib.request
from pathlib import Path

CACHE_DIR = Path(__file__).parent.parent / ".backtest_cache"
BINANCE_REST = "https://api.binance.com/api/v3/klines"


def fetch_klines(symbol, interval):
    cache_file = CACHE_DIR / f"{symbol}_{interval}.json"
    if cache_file.exists():
        # A candle unfinished when cached stays unfinished in that snapshot,
        # even if wall-clock time has since passed its nominal close time.
        return closed_klines(json.loads(cache_file.read_text()), cache_file.stat().st_mtime * 1000)

    CACHE_DIR.mkdir(exist_ok=True)
    klines = []
    start_time = 0
    while True:
        url = f"{BINANCE_REST}?symbol={symbol}&interval={interval}&startTime={start_time}&limit=1000"
        with urllib.request.urlopen(url, timeout=20) as resp:
            batch = json.loads(resp.read().decode())
        if not batch:
            break
        klines.extend(batch)
        if len(batch) < 1000:
            break
        start_time = batch[-1][0] + 1
        time.sleep(0.25)

    klines = closed_klines(klines, time.time() * 1000)
    cache_file.write_text(json.dumps(klines))
    return klines


def closed_klines(klines, observed_at_ms):
    return [k for k in klines if k[6] < observed_at_ms]


def to_bars(klines):
    return [
        {"t": k[0], "open": float(k[1]), "high": float(k[2]),
         "low": float(k[3]), "close": float(k[4])}
        for k in klines
    ]


def load_bars(symbol, interval):
    return to_bars(fetch_klines(symbol, interval))


def validate_bars(symbol, interval, bars):
    """Data gate: co nejlevneji odhalit spatna vstupni data drive, nez jim verime."""
    problems = []
    if len(bars) < 200:
        problems.append(f"{symbol} {interval}: jen {len(bars)} svicek, malo na EMA200 warmup")

    step_ms = {"15m": 15 * 60_000, "4h": 4 * 60 * 60_000}.get(interval)
    gaps = 0
    dupes = 0
    bad_ohlc = 0
    prev_t = None
    for b in bars:
        if prev_t is not None:
            delta = b["t"] - prev_t
            if delta == 0:
                dupes += 1
            elif step_ms and delta != step_ms:
                gaps += 1
        if not (all(math.isfinite(b[k]) and b[k] > 0 for k in ("open", "high", "low", "close"))
                and b["low"] <= b["open"] <= b["high"] and b["low"] <= b["close"] <= b["high"]):
            bad_ohlc += 1
        prev_t = b["t"]

    if dupes:
        problems.append(f"{symbol} {interval}: {dupes} duplicitnich timestampu")
    if gaps:
        problems.append(f"{symbol} {interval}: {gaps} mezer v casove rade (chybejici svicky)")
    if bad_ohlc:
        problems.append(f"{symbol} {interval}: {bad_ohlc} svicek s nekonzistentnim OHLC (low/high poruseno)")

    return problems
