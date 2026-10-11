export const DCA_SYMBOLS = ["BTCUSDC", "ETHUSDC", "SOLUSDC"] as const;
export const DCA_AMOUNTS = [5, 10, 20, 50, 100] as const;
export type DcaFrequency = "daily" | "weekly" | "monthly";
export type DcaPlan = { symbol: string; amount: number; frequency: DcaFrequency; configuredAt: string | null };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function readDcaPlans(dca: Record<string, unknown>): DcaPlan[] {
  const plans = record(dca.plans);
  return DCA_SYMBOLS.map(symbol => {
    const plan = record(plans[symbol]);
    const amount = typeof plan.amount === "number" ? plan.amount : typeof dca.amount === "number" ? dca.amount : 5;
    return { symbol, amount, frequency: ["daily", "weekly", "monthly"].includes(String(dca.frequency ?? plan.frequency)) ? (dca.frequency ?? plan.frequency) as DcaFrequency : "weekly",
      configuredAt: typeof plan.configured_at === "string" ? plan.configured_at : null };
  });
}
