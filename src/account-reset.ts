import { record } from "./manual-close.js";

export const resetErrors: Record<string, string> = {
  OPEN_ORDERS: "Na Binance zůstávají otevřené objednávky. Reset je nezrušil.",
  LOCKED_BALANCE: "Část zůstatku je na Binance uzamčená. Reset nebyl proveden.",
  NON_DUST_BALANCE: "Na účtu zůstává obchodovatelné BTC, ETH nebo SOL. Tento reset je určen pouze pro účet po uzavření pozic.",
  UNSETTLED: "Zůstává otevřená pozice nebo nedokončený obchod. Nejprve je nutné ověřit jeho výsledek.",
  EXCHANGE_UNAVAILABLE: "Stav Binance se nepodařilo bezpečně ověřit. Reset nebyl proveden.",
  EXPIRED: "Požadavek vypršel. Obnov stav a potvrď nový reset.",
};

export function resetPending(data: Record<string, unknown>) { return record(data.account_reset).status === "queued"; }
export function assertNoReset(data: Record<string, unknown>) {
  if (resetPending(data)) throw new Error("Probíhá nové nastavení účtu. Automatizace musí zůstat pozastavená.");
}
export function assertResetIdle(data: Record<string, unknown>) {
  const active = (value: unknown, terminal: string[]) => {
    const request = record(value);
    return Object.keys(request).length > 0 && !terminal.includes(String(request.status));
  };
  if (data.pending_order || data.pending_protection || record(data.dca).pending
      || (Array.isArray(data.pending_trade_logs) && data.pending_trade_logs.length)
      || Object.values(record(data.positions)).some(p => record(p).in_position === true)
      || active(data.manual_close, ["completed", "rejected", "failed", "expired"])
      || active(data.protection_restore, ["completed", "rejected", "failed", "expired"])
      || active(record(data.dca).test_request, ["completed", "rejected", "failed", "expired"])
      || record(record(data.streak).session).position) {
    throw new Error(resetErrors.UNSETTLED);
  }
}

export function resetView(data: Record<string, unknown>) {
  const reset = record(data.account_reset);
  return { epoch: typeof data.state_epoch === "string" ? data.state_epoch : null,
    request: reset.id ? { id: reset.id, status: reset.status, requestedAt: reset.requested_at,
      completedAt: reset.completed_at ?? null, error: resetErrors[String(reset.error_code)] ?? null } : null };
}
