export function readHoldings(value: unknown, now = Date.now()) {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const capturedAt = typeof raw.captured_at === "string" ? raw.captured_at : null;
  const time = capturedAt ? Date.parse(capturedAt) : NaN;
  const valid = raw.schema_version === "ocean.worker-portfolio.v1" && raw.quote_currency === "USDC" && Array.isArray(raw.assets) && Number.isFinite(time);
  const stale = !valid || now - time > 12 * 60_000 || time > now + 60_000;
  const rows = valid ? raw.assets as Array<Record<string, unknown>> : [];
  const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    capturedAt,
    stale,
    assets: ["USDC", "BTC", "ETH", "SOL"].map((asset) => {
      const row = rows.find((item) => item && item.asset === asset);
      const quantity = !valid ? null : row ? nonnegative(row.quantity) : 0;
      const price = asset === "USDC" ? 1 : row ? nonnegative(row.price_usdc) : null;
      return { asset, quantity, price, value: quantity !== null && price !== null ? quantity * price : null };
    }),
  };
}
