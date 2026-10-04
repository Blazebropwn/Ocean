import { record } from "./manual-close.js";

// Keep positions, pending settlements and exchange protection intact.
export function pausedAutomation(data: Record<string, unknown>): Record<string, unknown> & { entries_paused: boolean; dca: Record<string, unknown>; streak: Record<string, unknown> } {
  const dca = record(data.dca), test = record(dca.test_request);
  return { ...data, entries_paused: true,
    dca: { ...dca, enabled: false, ...(test.status === "pending" ? { test_request: { ...test, status: "rejected", error: "Účet byl pozastaven správcem." } } : {}) },
    streak: { ...record(data.streak), enabled: false } };
}
