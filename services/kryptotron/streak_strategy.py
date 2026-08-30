from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class PaperSetup:
    symbol: str
    entry_price: float
    stop_price: float
    target_price: float
    quantity: float
    quote_size: float
    risk_usdc: float
    target_net_usdc: float

    def to_dict(self):
        return asdict(self)


def ema(values, period):
    if len(values) < period:
        raise ValueError(f"EMA{period} vyžaduje alespoň {period} hodnot")
    multiplier = 2 / (period + 1)
    result = [float(values[0])]
    for value in values[1:]:
        result.append((float(value) - result[-1]) * multiplier + result[-1])
    return result


def trend_pullback_signal(closes, lows):
    if len(closes) < 55 or len(lows) != len(closes):
        return None, "INSUFFICIENT_DATA"
    fast = ema(closes, 20)
    slow = ema(closes, 50)
    if fast[-1] <= slow[-1]:
        return None, "NO_UPTREND"
    if not (closes[-2] <= fast[-2] and closes[-1] > fast[-1]):
        return None, "NO_PULLBACK_RECLAIM"
    entry = float(closes[-1])
    stop = float(min(lows[-6:]))
    distance = (entry - stop) / entry
    if distance < 0.002:
        return None, "STOP_TOO_TIGHT"
    if distance > 0.02:
        return None, "STOP_TOO_WIDE"
    return {"entry_price": entry, "stop_price": stop}, "SIGNAL"


def size_paper_setup(symbol, entry_price, stop_price, available_quote, risk_usdc=1.0,
                     fee_rate=0.001, slippage_rate=0.0005, max_capital_fraction=0.5,
                     min_notional=5.0):
    if stop_price >= entry_price or entry_price <= 0:
        raise ValueError("Stop musí být pod vstupní cenou")
    cost_rate = fee_rate + slippage_rate
    loss_fraction = (entry_price - stop_price) / entry_price
    stop_exit_fraction = (stop_price / entry_price) * cost_rate
    risk_fraction = loss_fraction + cost_rate + stop_exit_fraction
    desired_quote = risk_usdc / risk_fraction
    quote_size = min(desired_quote, available_quote * max_capital_fraction)
    if quote_size < min_notional:
        return None, "BELOW_MIN_NOTIONAL"
    quantity = quote_size / entry_price
    entry_cost = quote_size * cost_rate
    target_price = (risk_usdc + quantity * entry_price + entry_cost) / (quantity * (1 - cost_rate))
    actual_risk = quote_size * risk_fraction
    return PaperSetup(
        symbol=symbol, entry_price=entry_price, stop_price=stop_price,
        target_price=target_price, quantity=quantity, quote_size=quote_size,
        risk_usdc=actual_risk, target_net_usdc=risk_usdc,
    ), "READY"


def paper_close_result(setup, exit_price, fee_rate=0.001, slippage_rate=0.0005):
    cost_rate = fee_rate + slippage_rate
    gross = setup.quantity * (exit_price - setup.entry_price)
    fees = setup.quote_size * cost_rate + setup.quantity * exit_price * cost_rate
    return {"gross_pnl": gross, "fees": fees, "slippage": 0.0, "net_pnl": gross - fees}
