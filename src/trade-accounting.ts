/** Realized cash P/L with proportional acquisition cost; never an entry/risk rule. */
export type TradeReference = {
  symbol: string; exitedAt: string; quantity: number; entryPrice: number; exitPrice: number;
  entryOrderId: string | null; exitOrderId: string | null;
};
export type TradeCosts = {
  status: "verified" | "unverified";
  reason: "VERIFIED" | "MISSING_ORDER_IDS" | "UNAVAILABLE" | "INCOMPLETE_FILLS" | "UNVALUED_FEE_ASSET";
  netPnl: number | null; grossPnl: number | null;
  allocatedEntryCost: number | null; netProceeds: number | null;
  residualQuantity: number | null; residualCost: number | null;
  entryFees: Array<{ asset: string; amount: number }>;
  exitFees: Array<{ asset: string; amount: number }>;
  checkedAt: string | null;
};
export const unknownTradeCosts = (reason: TradeCosts["reason"] = "MISSING_ORDER_IDS"): TradeCosts => ({
  status: "unverified", reason, netPnl: null, grossPnl: null, allocatedEntryCost: null,
  netProceeds: null, residualQuantity: null, residualCost: null, entryFees: [], exitFees: [], checkedAt: null,
});
export const orderId = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value)
    : typeof value === "string" && /^\d{1,20}$/.test(value) ? value : null;
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const SCALE = 10n ** 16n;
const ATOM = SCALE / 100_000_000n;
function decimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,20}(\.\d{1,16})?$/.test(value)) throw new Error("Invalid exchange decimal");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(16, "0"));
}
const amount = (value: bigint) => Number(value) / Number(SCALE);
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);
const abs = (v: bigint) => v < 0n ? -v : v;

function execution(rawOrder: unknown, rawFills: unknown, symbol: string, id: string, side: "BUY" | "SELL") {
  const order = object(rawOrder);
  const settled = side === "SELL" ? ["FILLED"] : ["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH"];
  if (orderId(order.orderId) !== id || order.symbol !== symbol || order.side !== side || !settled.includes(String(order.status))) throw new Error("Wrong order");
  const quantity = decimal(order.executedQty), quote = decimal(order.cummulativeQuoteQty);
  if (quantity <= 0n || quote <= 0n || !Array.isArray(rawFills) || !rawFills.length) throw new Error("Missing fills");
  let fillQuantity = 0n, fillQuote = 0n;
  const ids = new Set<string>(), fees = new Map<string, bigint>();
  for (const raw of rawFills) {
    const fill = object(raw), fillId = orderId(fill.id);
    if (!fillId || ids.has(fillId) || orderId(fill.orderId) !== id || fill.symbol !== symbol || fill.isBuyer !== (side === "BUY")) throw new Error("Wrong fill");
    ids.add(fillId);
    const qty = decimal(fill.qty), quoteQty = decimal(fill.quoteQty), commission = decimal(fill.commission);
    if (qty <= 0n || quoteQty <= 0n || typeof fill.commissionAsset !== "string" || !/^[A-Z0-9]{2,20}$/.test(fill.commissionAsset)) throw new Error("Invalid fill");
    fillQuantity += qty; fillQuote += quoteQty;
    fees.set(fill.commissionAsset, (fees.get(fill.commissionAsset) ?? 0n) + commission);
  }
  // A partial page, duplicate fill or mismatched order can never imply zero fees.
  if (fillQuantity !== quantity || abs(fillQuote - quote) > ATOM * BigInt(rawFills.length)) throw new Error("Incomplete fills");
  return { quantity, quote, fees, order };
}

export function calculateTradeCosts(reference: TradeReference, entryOrder: unknown, entryFills: unknown,
  exitOrder: unknown, exitFills: unknown, now = new Date()): TradeCosts {
  const result = { ...unknownTradeCosts("INCOMPLETE_FILLS"), checkedAt: now.toISOString() };
  if (!reference.entryOrderId || !reference.exitOrderId || !/^[A-Z0-9]+USDC$/.test(reference.symbol)) return { ...result, reason: "MISSING_ORDER_IDS" };
  try {
    const buy = execution(entryOrder, entryFills, reference.symbol, reference.entryOrderId, "BUY");
    const sell = execution(exitOrder, exitFills, reference.symbol, reference.exitOrderId, "SELL");
    if (buy.order.time != null && sell.order.time != null && Number(buy.order.time) > Number(sell.order.time)) throw new Error("Reversed orders");
    const exitTime = Number(sell.order.updateTime);
    if (!Number.isFinite(exitTime) || !Number.isFinite(Date.parse(reference.exitedAt)) || Math.abs(exitTime - Date.parse(reference.exitedAt)) > 120_000
      || !close(amount(sell.quantity), reference.quantity)
      || !close(amount(buy.quote) / amount(buy.quantity), reference.entryPrice)
      || !close(amount(sell.quote) / amount(sell.quantity), reference.exitPrice)) throw new Error("Trade does not match orders");
    const fees = (values: Map<string, bigint>) => [...values].map(([asset, value]) => ({ asset, amount: amount(value) }));
    result.entryFees = fees(buy.fees); result.exitFees = fees(sell.fees);
    const base = reference.symbol.slice(0, -4);
    if ([...buy.fees, ...sell.fees].some(([asset, value]) => value > 0n && asset !== base && asset !== "USDC")) {
      return { ...result, reason: "UNVALUED_FEE_ASSET" };
    }
    const acquired = buy.quantity - (buy.fees.get(base) ?? 0n);
    const consumed = sell.quantity + (sell.fees.get(base) ?? 0n);
    if (acquired <= 0n || consumed > acquired) throw new Error("Invalid inventory");
    const totalCost = buy.quote + (buy.fees.get("USDC") ?? 0n);
    const allocated = totalCost * consumed / acquired;
    const proceeds = sell.quote - (sell.fees.get("USDC") ?? 0n);
    if (proceeds < 0n) throw new Error("Invalid proceeds");
    return { ...result, status: "verified", reason: "VERIFIED",
      netPnl: amount(proceeds - allocated), grossPnl: amount(sell.quote - buy.quote * sell.quantity / buy.quantity),
      allocatedEntryCost: amount(allocated), netProceeds: amount(proceeds),
      residualQuantity: amount(acquired - consumed), residualCost: amount(totalCost - allocated) };
  } catch { return result; }
}
