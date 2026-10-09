import { z } from "zod";
import type { OceanDatabase } from "./db.js";
import { loadKryptotronState, withStateLock } from "./kryptotron.js";
import { pausedAutomation } from "./account-pause.js";
import { record } from "./manual-close.js";
import { assertResetIdle, resetPending, resetErrors, resetView } from "./account-reset.js";

const decimal = z.string().regex(/^\d+(\.\d+)?$/).refine(v => Number.isFinite(Number(v)) && Number(v) >= 0);
export const resetReportSchema = z.object({
  id: z.string().uuid(), epoch: z.string().nullable(),
  errorCode: z.enum(["OPEN_ORDERS", "LOCKED_BALANCE", "NON_DUST_BALANCE", "UNSETTLED", "EXCHANGE_UNAVAILABLE"]).optional(),
  checkedAt: z.string().datetime({ offset: true }).optional(),
  balances: z.record(z.string().regex(/^[A-Z0-9]{1,20}$/), decimal).optional(),
}).strict();

async function write(url: string, key: string, instance: string, data: Record<string, unknown>) {
  const response = await fetch(`${url}/rest/v1/bot_state?key=eq.${encodeURIComponent(instance)}`, {
    method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Uložení resetu se nepodařilo potvrdit. Obnov stav před dalším pokusem.");
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Zápis resetu nebyl potvrzen pro jediný účet.");
}

export function requestAccountReset(url: string, key: string, instance: string, actor: string, id: string, epoch: string | null) {
  return withStateLock(url, instance, async () => {
    const state = await loadKryptotronState(url, key, instance);
    if (!state) throw new Error("Stav účtu není dostupný.");
    if (record(state.account_reset).id === id || resetPending(state)) return resetView(state);
    if ((state.state_epoch ?? null) !== epoch) throw new Error("Období účtu se změnilo. Obnov detail před potvrzením.");
    assertResetIdle(state);
    const age = Date.now() - Date.parse(String(state.last_heartbeat_at));
    if (!Number.isFinite(age) || age < -30_000 || age > 180_000) throw new Error("Worker není aktuálně dostupný. Reset nelze bezpečně zahájit.");
    const next = { ...pausedAutomation(state), account_reset: { id, actor, status: "queued", requested_at: new Date().toISOString() } };
    await write(url, key, instance, next);
    return resetView(next);
  });
}

export function completeAccountReset(db: OceanDatabase, url: string, key: string, instance: string, report: z.infer<typeof resetReportSchema>): Promise<Record<string, unknown>> {
  return withStateLock(url, instance, async () => {
    const state = await loadKryptotronState(url, key, instance);
    if (!state) throw new Error("Stav účtu není dostupný.");
    const request = record(state.account_reset);
    if (request.id === report.id && request.status === "completed" && state.state_epoch === report.id) return state;
    if (request.id !== report.id || !resetPending(state) || (state.state_epoch ?? null) !== report.epoch) throw new Error("Požadavek již není platný.");
    let error = report.errorCode as string | undefined;
    if (Date.now() - Date.parse(String(request.requested_at)) > 600_000) error = "EXPIRED";
    try { assertResetIdle(state); } catch { error = "UNSETTLED"; }
    if (error) {
      const next = { ...pausedAutomation(state), account_reset: { ...request, status: "rejected", error_code: error } };
      await write(url, key, instance, next);
      return next;
    }
    const age = Date.now() - Date.parse(report.checkedAt ?? "");
    if (!report.balances || !Object.hasOwn(report.balances, "USDC") || !Number.isFinite(age) || age < -5_000 || age > 30_000) throw new Error(resetErrors.EXCHANGE_UNAVAILABLE);
    const at = new Date().toISOString();
    // Archive first. A lost remote PATCH response can be retried without losing the old period.
    db.prepare("INSERT OR IGNORE INTO account_reset_archives (id,instance_id,actor_user_id,created_at,state_json) VALUES (?,?,?,?,?)")
      .run(report.id, instance, String(request.actor), at, JSON.stringify(state));
    const next = { ...pausedAutomation(state), state_epoch: report.id, history_started_at: at,
      account_reset: { ...request, status: "completed", completed_at: at },
      positions: {}, strategy_residuals: {}, unmanaged_inventory: Object.fromEntries(Object.entries(report.balances).filter(([asset]) => asset !== "USDC")),
      pending_order: null, pending_protection: null, manual_close: null, protection_restore: null,
      decisions: {}, trade_explanations: [], events: [{ type: "CONTROL", at, message: "Nové období účtu. Automatizace zůstává pozastavená." }],
      dca: { enabled: false, amount: record(state.dca).amount ?? 5, symbols: record(state.dca).symbols ?? [], purchases: [], recorded_totals: {} },
      streak: { ...record(state.streak), enabled: false, session: {} },
      safe_mode: true, reconciliation: { status: "UNRESOLVED", checked_at: null, issues: [{ code: "RECONCILIATION_REQUIRED" }] },
      quote_asset: "USDC", account_balance: Number(report.balances.USDC), account_balance_at: report.checkedAt, account_balance_error: null,
      portfolio_snapshot: {}, last_error: null,
    };
    await write(url, key, instance, next);
    return next;
  });
}
