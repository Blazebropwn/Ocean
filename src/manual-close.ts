// The server queues intent; only the owning worker can submit exchange orders.
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stages = ["queued", "cancelling", "ready", "selling", "completed", "superseded", "rejected"];
export const closeActive = (value: unknown) => stages.slice(0, 4).includes(String(record(value).status));
export function completedCloseWouldRewind(incoming: unknown, saved: unknown) {
  const next = record(incoming), previous = record(saved);
  return previous.status === "completed" && previous.id === next.id && next.status !== "completed";
}
export const positionId = (position: Record<string, unknown>) =>
  typeof position.entry_order_client_id === "string" ? position.entry_order_client_id
    : typeof position.entry_time === "string" ? position.entry_time : null;

export function mergeManualClose(incoming: unknown, saved: unknown) {
  const next = record(incoming), previous = record(saved);
  if (!previous.id) return undefined; // Workers cannot originate user commands.
  if (next.id !== previous.id || stages.indexOf(String(next.status)) < stages.indexOf(String(previous.status))) return previous;
  return { ...next, id: previous.id, symbol: previous.symbol, position_id: previous.position_id, requested_at: previous.requested_at };
}

export function manualCloseView(data: Record<string, unknown>, now = Date.now()) {
  const request = record(data.manual_close), check = record(data.reconciliation);
  const fresh = (value: unknown, max: number) => typeof value === "string" && now - Date.parse(value) >= -30_000 && now - Date.parse(value) <= max;
  return {
    available: data.manual_close_version === 1 && data.api_permissions_safe === true && data.safe_mode === false
      && check.status === "OK" && fresh(check.checked_at, 90_000) && fresh(data.last_heartbeat_at, 90_000)
      && !data.pending_order && !data.pending_protection && !record(data.dca).pending && !closeActive(request),
    request: typeof request.id === "string" && stages.includes(String(request.status)) ? {
      id: request.id, symbol: String(request.symbol), positionId: String(request.position_id), status: String(request.status),
      requestedAt: request.requested_at, completedAt: request.completed_at, cooldownUntil: request.cooldown_until,
      soldQuantity: typeof request.sold_quantity === "number" && Number.isFinite(request.sold_quantity) ? request.sold_quantity : null,
      residualQuantity: typeof request.residual_quantity === "number" && Number.isFinite(request.residual_quantity) ? request.residual_quantity : null,
    } : null,
    residuals: Object.entries(record(data.strategy_residuals)).flatMap(([symbol, value]) => {
      const quantity = Number(record(value).quantity);
      return ["BTCUSDC", "ETHUSDC"].includes(symbol) && Number.isFinite(quantity) && quantity > 0 ? [{ symbol, quantity }] : [];
    }),
    cooldowns: Object.entries(record(data.pair_cooldowns)).flatMap(([symbol, until]) =>
      ["BTCUSDC", "ETHUSDC"].includes(symbol) && typeof until === "string" && Date.parse(until) > now ? [{ symbol, until }] : []),
  };
}

export function queueManualClose(data: Record<string, unknown>, symbol: string, id: string, now = new Date()) {
  if (!["BTCUSDC", "ETHUSDC"].includes(symbol)) throw new Error("Tento pár nelze ručně uzavřít.");
  const existing = record(data.manual_close);
  // A retry from another tab or after a lost response returns the same command.
  if (existing.symbol === symbol && existing.position_id === id && existing.status !== "rejected") return existing;
  if (!manualCloseView(data, now.getTime()).available) throw new Error("Uzavření teď není dostupné. Obnovte stav a ověřte připojení i ochranu.");
  const position = record(record(data.positions)[symbol]);
  if (position.in_position !== true || positionId(position) !== id || position.protection_status !== "ACTIVE") {
    throw new Error("Pozice se změnila. Obnovte přehled a zkontrolujte ji.");
  }
  const request = { id: crypto.randomUUID(), symbol, position_id: id, status: "queued", requested_at: now.toISOString() };
  data.manual_close = request;
  return request;
}
