import { closeActive, positionId, record } from "./manual-close.js";
const stages = ["queued", "submitting", "completed", "superseded", "rejected"];
export const restoreActive = (value: unknown) => stages.slice(0, 2).includes(String(record(value).status));
export const restoreWouldRewind = (next: unknown, saved: unknown) => {
  const a = record(next), b = record(saved);
  return b.status === "completed" && a.id === b.id && a.status !== "completed";
};
export function mergeProtectionRestore(incoming: unknown, saved: unknown) {
  const a = record(incoming), b = record(saved);
  if (!b.id) return undefined;
  if (a.id !== b.id || !stages.includes(String(a.status)) || stages.indexOf(String(a.status)) < stages.indexOf(String(b.status))) return b;
  const pinned = ["id", "symbol", "position_id", "protection_id", "quantity", "stop_price", "activation_price", "trailing_bips", "requested_at"];
  return { ...a, ...Object.fromEntries(pinned.map(k => [k, b[k]])) };
}
export function protectionRestoreView(data: Record<string, unknown>, now = Date.now()) {
  const request = record(data.protection_restore), check = record(data.reconciliation), positions = record(data.positions);
  const fresh = (v: unknown) => typeof v === "string" && now - Date.parse(v) >= -30_000 && now - Date.parse(v) <= 90_000;
  const issues = Array.isArray(check.issues) ? check.issues.map(record) : [];
  const validIssues = check.status === "UNRESOLVED" && issues.length > 0 && issues.every(i =>
    i.code === "PROTECTION_ERROR" && ["BTCUSDC", "ETHUSDC"].includes(String(i.symbol)) && record(positions[String(i.symbol)]).in_position === true);
  const available = data.protection_restore_version === 1 && data.entries_paused === true && data.api_permissions_safe === true
    && fresh(data.last_heartbeat_at) && fresh(check.checked_at) && validIssues
    && !data.pending_order && !data.pending_protection && !record(data.dca).pending && !closeActive(data.manual_close) && !restoreActive(request)
    && !(Array.isArray(data.pending_trade_logs) && data.pending_trade_logs.length);
  const targets = Object.entries(positions).flatMap(([symbol, raw]) => {
    const p = record(raw);
    if (!["BTCUSDC", "ETHUSDC"].includes(symbol) || p.in_position !== true || p.protection_status !== "CANCELLED" || !positionId(p)
      || typeof p.protection_client_id !== "string" || !p.protection_client_id.startsWith("ocean-protect-")) return [];
    const values = [p.position_qty, p.entry_price, p.protection_stop_price, p.protection_activation_price, p.protection_trailing_bips];
    if (!values.every(v => typeof v === "number" && Number.isFinite(v) && v > 0) || !Number.isInteger(p.protection_trailing_bips)
      || Number(p.protection_stop_price) >= Number(p.entry_price) || Number(p.protection_activation_price) <= Number(p.entry_price)) return [];
    return [{ symbol, positionId: positionId(p)!, protectionId: p.protection_client_id, quantity: Number(p.position_qty), stopPrice: Number(p.protection_stop_price), activationPrice: Number(p.protection_activation_price), trailingBips: Number(p.protection_trailing_bips) }];
  });
  return { available, targets, request: typeof request.id === "string" && stages.includes(String(request.status))
    ? { id: request.id, symbol: String(request.symbol), protectionId: String(request.protection_id), status: String(request.status) } : null };
}
export function queueProtectionRestore(data: Record<string, unknown>, symbol: string, id: string, protection: string, now = new Date()) {
  const previous = record(data.protection_restore);
  if (previous.symbol === symbol && previous.position_id === id && previous.protection_id === protection && previous.status !== "rejected") return previous;
  const view = protectionRestoreView(data, now.getTime());
  const target = view.targets.find(p => p.symbol === symbol && p.positionId === id && p.protectionId === protection);
  if (!view.available || !target) throw new Error("Obnovení ochrany vyžaduje čerstvě ověřenou evidenci, pozastavené nákupy a potvrzené zrušení původních příkazů.");
  return data.protection_restore = { id: crypto.randomUUID(), symbol, position_id: id, protection_id: protection, status: "queued", requested_at: now.toISOString(),
    quantity: target.quantity, stop_price: target.stopPrice, activation_price: target.activationPrice, trailing_bips: target.trailingBips };
}
