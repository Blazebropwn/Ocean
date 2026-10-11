from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from order_safety import classify_order, with_execution_fills
import math
import copy
import hashlib


PRAGUE = ZoneInfo("Europe/Prague")


def week_key(now=None):
    current = (now or datetime.now(timezone.utc)).astimezone(PRAGUE)
    iso = current.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def dca_due(state, now=None):
    current = (now or datetime.now(timezone.utc)).astimezone(PRAGUE)
    dca = state.setdefault("dca", {})
    return current.weekday() == 6 and current.hour >= 8 and dca.get("completed_week") != week_key(now)


def client_order_id(symbol, current_week):
    return f"ocean-dca-{symbol.lower()}-{current_week.lower()}"


def order_outcome(order):
    return classify_order(order)


def purchase_record(symbol, amount, order, current_week):
    quantity = float(order.get("executedQty", 0))
    base_fee = sum(float(fill.get("commission", 0)) for fill in order.get("fills", [])
                   if fill.get("commissionAsset") == symbol.removesuffix("USDC"))
    quantity -= base_fee
    spent = float(order.get("cummulativeQuoteQty", amount))
    if not all(math.isfinite(value) and value > 0 for value in (quantity, spent)):
        raise RuntimeError("DCA plnění nemá platné množství a cenu")
    return {
        "week": current_week,
        "symbol": symbol,
        "amount": spent,
        "quantity": quantity,
        "average_price": spent / quantity if quantity else None,
        "order_id": order.get("orderId"),
        "at": datetime.now(timezone.utc).isoformat(),
    }


def settle_pending_dca(client, state, save_state, order=None):
    """Resolve the durable intent before checking schedule, balance or settings."""
    dca = state.setdefault("dca", {})
    pending = dca.get("pending")
    if not pending:
        return None
    if order is None:
        order = client.get_order(symbol=pending["symbol"], origClientOrderId=pending["client_order_id"])
        order = with_execution_fills(client, pending["symbol"], order)
    outcome = order_outcome(order)
    if outcome in {"pending", "partial"}:
        raise RuntimeError("DCA objednávka čeká na úplné ověření")
    record = None
    if outcome in {"filled", "settled_partial"}:
        record = purchase_record(pending["symbol"], pending["amount"], order, pending["week"])
        record["client_order_id"] = pending["client_order_id"]
        if not any(p.get("client_order_id") == pending["client_order_id"] for p in dca.setdefault("purchases", [])):
            # Keep cumulative economic totals before trimming the UI history.
            if "recorded_totals" not in dca:
                totals = dca["recorded_totals"] = {}
                for previous in dca["purchases"]:
                    item = totals.setdefault(previous["symbol"], {"quantity": 0, "spent": 0, "count": 0})
                    item["quantity"] += previous["quantity"]
                    item["spent"] += previous["amount"]
                    item["count"] += 1
                dca["totals_scope"] = "available_history_at_upgrade_plus_future_fills"
            totals = dca["recorded_totals"]
            dca["purchases"].append(record)
            item = totals.setdefault(pending["symbol"], {"quantity": 0, "spent": 0, "count": 0})
            item["quantity"] += record["quantity"]
            item["spent"] += record["amount"]
            item["count"] += 1
            dca["purchases"] = dca["purchases"][-156:]
    if pending.get("period") and pending.get("frequency"):
        dca.setdefault("completed_periods", {}).setdefault(pending["symbol"], {})[pending["frequency"]] = pending["period"]
        if record:
            record["period"] = pending["period"]
            record["frequency"] = pending["frequency"]
    dca["pending"] = None
    if not save_state(state):
        dca["pending"] = pending
        raise RuntimeError("Výsledek DCA není bezpečně uložený")
    return {"symbol": pending["symbol"], "status": "filled", **record} if record else {
        "symbol": pending["symbol"], "status": "failed", "reason": order.get("status", "unknown")}


def run_weekly_dca(client, state, symbols, amount, min_notionals, save_state, get_balance, now=None, run_key=None, before_order=None):
    recovered = settle_pending_dca(client, state, save_state)
    manual_run = run_key is not None
    if not manual_run and not dca_due(state, now):
        return []
    current_week = run_key or week_key(now)
    dca = state.setdefault("dca", {})
    dca.setdefault("purchases", [])
    completed = {item["symbol"] for item in dca["purchases"] if item.get("week") == current_week}
    results = [recovered] if recovered else []

    for symbol in symbols:
        if symbol in completed:
            continue
        minimum = min_notionals[symbol]
        if amount < minimum:
            results.append({"symbol": symbol, "status": "skipped", "reason": f"minimum {minimum:.2f}"})
            continue
        if get_balance(client) < amount:
            results.append({"symbol": symbol, "status": "skipped", "reason": "nedostatečný balance"})
            continue

        order_id = client_order_id(symbol, current_week)
        if before_order is not None and not before_order():
            raise RuntimeError("Nový DCA příkaz blokuje pauza nebo bezpečnostní kontrola")
        dca["pending"] = {"week": current_week, "symbol": symbol, "client_order_id": order_id, "amount": amount}
        if not save_state(state):
            raise RuntimeError("DCA záměr se nepodařilo bezpečně uložit")
        order = client.order_market_buy(symbol=symbol, quoteOrderQty=f"{amount:.2f}", newClientOrderId=order_id)
        results.append(settle_pending_dca(client, state, save_state, order))

    if not manual_run:
        dca["completed_week"] = current_week
    dca["last_results"] = results
    if not save_state(state):
        raise RuntimeError("Dokončení DCA týdne se nepodařilo uložit")
    return results


AMOUNTS = (5, 10, 20, 50, 100)
FREQUENCIES = ("daily", "weekly", "monthly")


def asset_plan(dca, symbol):
    plans = dca.get("plans") or {}
    if not isinstance(plans, dict):
        raise ValueError("Neplatné plány DCA")
    shared_frequency = dca.get("frequency")
    if shared_frequency is not None and shared_frequency not in FREQUENCIES:
        raise ValueError("Neplatný společný interval DCA")
    if symbol not in plans:
        amount = dca.get("amount", 5)
        if amount not in (5, 10, 20, 50, 100, 200, 500, 1000):
            raise ValueError("Neplatná původní částka DCA")
        return {"amount": amount, "frequency": shared_frequency or "weekly"}
    plan = copy.deepcopy(plans[symbol])
    if isinstance(plan, dict) and shared_frequency:
        plan["frequency"] = shared_frequency
    if not isinstance(plan, dict) or plan.get("amount") not in AMOUNTS or plan.get("frequency") not in FREQUENCIES:
        raise ValueError("Neplatný plán DCA")
    return copy.deepcopy(plan)


def due_period(dca, symbol, plan, now):
    current = now.astimezone(PRAGUE)
    frequency = plan["frequency"]
    if current.hour < 8 or (frequency == "weekly" and current.weekday() != 6) or (frequency == "monthly" and current.day != 1):
        return None
    slot = current.replace(hour=8, minute=0, second=0, microsecond=0)
    if plan.get("configured_at"):
        configured = datetime.fromisoformat(plan["configured_at"])
        if configured.tzinfo is None:
            raise ValueError("Plán nemá časové pásmo")
        if slot <= configured:
            return None
    period = current.strftime("%Y-%m-%d") if frequency == "daily" else week_key(now) if frequency == "weekly" else current.strftime("%Y-%m")
    if dca.get("completed_periods", {}).get(symbol, {}).get(frequency) == period:
        return None
    # Honor the old weekly checkpoint and purchases on upgrade.
    if frequency == "weekly" and dca.get("completed_week") == period:
        return None
    if any(p.get("symbol") == symbol and ((p.get("frequency") == frequency and p.get("period") == period)
           or (frequency == "weekly" and p.get("week") == period)) for p in dca.get("purchases", [])):
        return None
    return period


def run_scheduled_dca(client, state, symbols, min_notionals, save_state, get_balance, now=None, before_order=None, run_key=None):
    recovered = settle_pending_dca(client, state, save_state)
    results = [recovered] if recovered else []
    dca = state.setdefault("dca", {})
    if not run_key and dca.get("enabled") is not True:
        return results
    now = now or datetime.now(timezone.utc)
    for symbol in symbols:
        plan = asset_plan(dca, symbol)
        frequency, amount = plan["frequency"], plan["amount"]
        period = run_key or due_period(dca, symbol, plan, now)
        if not period:
            continue
        if run_key and any(p.get("symbol") == symbol and p.get("week") == run_key for p in dca.get("purchases", [])):
            continue
        if before_order is not None and not before_order(symbol, plan):
            # A concurrent user edit or pause must not count as a completed slot.
            break
        if not run_key and dca.get("enabled") is not True:
            break
        if asset_plan(dca, symbol) != plan:
            break
        minimum = min_notionals[symbol]
        balance = get_balance(client)
        if not isinstance(balance, (int, float)) or not math.isfinite(balance) or balance < 0:
            raise RuntimeError("Dostupný zůstatek DCA není ověřený")
        if amount < minimum or balance < amount:
            result = {"symbol": symbol, "status": "skipped", "reason": f"minimum {minimum:.2f}" if amount < minimum else "nedostatečný balance"}
            previous = copy.deepcopy(dca.get("completed_periods", {}))
            if not run_key:
                dca.setdefault("completed_periods", {}).setdefault(symbol, {})[frequency] = period
            dca["last_results"] = [*results, result]
            if not save_state(state):
                dca["completed_periods"] = previous
                raise RuntimeError("Přeskočení DCA není uložené")
            results.append(result)
            continue
        # A weekly ID matches pre-upgrade IDs; daily/monthly IDs are short and stable.
        epoch = state.get("state_epoch")
        key = f"{frequency}:{period}:{epoch}" if epoch else f"{frequency}:{period}"
        order_id = client_order_id(symbol, period) if frequency == "weekly" and not epoch else f"oc-dca-{symbol.lower()}-{hashlib.sha256(key.encode()).hexdigest()[:12]}"
        pending = {"symbol": symbol, "amount": amount, "week": period, "client_order_id": order_id}
        if not run_key:
            pending.update(period=period, frequency=frequency)
        dca["pending"] = pending
        if not save_state(state):
            # Keep the unresolved intent. Never blindly resend after an ambiguous write.
            raise RuntimeError("DCA záměr se nepodařilo bezpečně uložit")
        order = client.order_market_buy(symbol=symbol, quoteOrderQty=f"{amount:.2f}", newClientOrderId=order_id)
        results.append(settle_pending_dca(client, state, save_state, order))
    if results:
        dca["last_results"] = results
        if not save_state(state):
            raise RuntimeError("Výsledky DCA se nepodařilo uložit")
    return results
