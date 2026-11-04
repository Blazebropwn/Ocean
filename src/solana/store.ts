import { randomUUID } from "node:crypto";
import type { OceanDatabase } from "../db.js";
import type { Evidence, SolanaQuote, SolanaStage } from "./types.js";

export const INITIAL_MICROS = 100_000_000;
export const NETWORK_FEE_MICROS = 10_000;
export const CYCLE_COOLDOWN_MS = 60_000;
export const CYCLE_LEASE_MS = 5 * 60_000;

export type PaperAccount = { user_id: string; cash_micros: number; initial_micros: number; last_cycle_at: number | null; active_cycle_id: string | null; lease_until: number | null };
export type PaperPosition = { id: string; user_id: string; mint: string; symbol: string; token_amount: string; cost_micros: number; entry_fee_micros: number; opened_at: number; closed_at: number | null; proceeds_micros: number | null; mark_micros: number | null; marked_at: number | null; mark_error: string | null };
export class PaperBusyError extends Error {
  constructor(public readonly reason: "running" | "cooldown", public readonly retryAt: number) { super(reason); }
}

function boundedJson(value: unknown) {
  const json = JSON.stringify(value);
  return json.length <= 48_000 ? json : JSON.stringify({ truncated: true, preview: json.slice(0, 40_000) });
}

export class SolanaPaperStore {
  constructor(readonly db: OceanDatabase) {}

  ensureAccount(userId: string, now: number) {
    this.db.prepare("INSERT OR IGNORE INTO solana_paper_accounts (user_id,initial_micros,cash_micros,created_at) VALUES (?,?,?,?)").run(userId, INITIAL_MICROS, INITIAL_MICROS, now);
    return this.account(userId);
  }

  account(userId: string) { return this.db.prepare("SELECT * FROM solana_paper_accounts WHERE user_id = ?").get(userId) as PaperAccount; }
  positions(userId: string) { return this.db.prepare("SELECT * FROM solana_paper_positions WHERE user_id = ? AND closed_at IS NULL ORDER BY opened_at,id").all(userId) as PaperPosition[]; }
  everTraded(userId: string, mint: string) { return Boolean(this.db.prepare("SELECT 1 FROM solana_paper_positions WHERE user_id = ? AND mint = ?").get(userId, mint)); }

  dailyBraked(userId: string, now: number) {
    const since = now - 24 * 60 * 60_000;
    const entries = this.db.prepare("SELECT count(*) AS count FROM solana_paper_trades WHERE user_id=? AND side='BUY' AND occurred_at>=?").get(userId, since) as { count: number };
    const losses = this.db.prepare("SELECT COALESCE(SUM(MIN(0,proceeds_micros-cost_micros-entry_fee_micros)),0) AS loss FROM solana_paper_positions WHERE user_id=? AND closed_at>=?").get(userId, since) as { loss: number };
    return entries.count >= 10 || losses.loss <= -5_000_000;
  }

  acquire(userId: string, now: number) {
    return this.db.transaction(() => {
      const account = this.ensureAccount(userId, now);
      if (account.active_cycle_id && (account.lease_until ?? 0) > now) throw new PaperBusyError("running", account.lease_until!);
      if (account.last_cycle_at !== null && now < account.last_cycle_at + CYCLE_COOLDOWN_MS) throw new PaperBusyError("cooldown", account.last_cycle_at + CYCLE_COOLDOWN_MS);
      if (account.active_cycle_id) {
        this.db.prepare("UPDATE solana_paper_cycles SET status='interrupted',completed_at=? WHERE id=? AND status='running'").run(now, account.active_cycle_id);
        this.event(userId, account.active_cycle_id, "logger", "error", null, "Předchozí cyklus byl přerušen; jeho záznamy zůstaly zachované.", {}, now);
      }
      const id = `solc_${randomUUID().replaceAll("-", "")}`;
      this.db.prepare("INSERT INTO solana_paper_cycles (id,user_id,started_at,status) VALUES (?,?,?,'running')").run(id, userId, now);
      this.db.prepare("UPDATE solana_paper_accounts SET active_cycle_id=?,lease_until=?,last_cycle_at=? WHERE user_id=?").run(id, now + CYCLE_LEASE_MS, now, userId);
      return id;
    }).immediate();
  }

  ownsLease(userId: string, cycleId: string, now: number) {
    const account = this.account(userId);
    return Boolean(account && account.active_cycle_id === cycleId && (account.lease_until ?? 0) > now);
  }

  finish(userId: string, cycleId: string, now: number, failed = false) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE solana_paper_cycles SET status=?,completed_at=? WHERE id=? AND user_id=? AND status='running'").run(failed ? "failed" : "completed", now, cycleId, userId);
      this.db.prepare("UPDATE solana_paper_accounts SET active_cycle_id=NULL,lease_until=NULL WHERE user_id=? AND active_cycle_id=?").run(userId, cycleId);
    })();
  }

  event(userId: string, cycleId: string | null, stage: SolanaStage["id"], status: SolanaStage["status"], mint: string | null, reason: string, evidence: Evidence, now: number) {
    this.db.prepare("INSERT INTO solana_paper_events (user_id,cycle_id,stage,status,mint,reason,evidence_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(userId, cycleId, stage, status, mint, reason.slice(0, 1_000), boundedJson(evidence), now);
  }

  mark(userId: string, positionId: string, grossMicros: number | null, error: string | null, now: number) {
    if (grossMicros === null) this.db.prepare("UPDATE solana_paper_positions SET mark_error=? WHERE id=? AND user_id=? AND closed_at IS NULL").run(error, positionId, userId);
    else this.db.prepare("UPDATE solana_paper_positions SET mark_micros=?,marked_at=?,mark_error=NULL WHERE id=? AND user_id=? AND closed_at IS NULL").run(grossMicros, now, positionId, userId);
  }

  buy(input: { userId: string; cycleId: string; mint: string; symbol: string; amount: string; costMicros: number; markMicros: number; buyQuote: SolanaQuote; sellQuote: SolanaQuote; now: number; authorize: () => boolean }) {
    return this.db.transaction(() => {
      if (!input.authorize() || !this.ownsLease(input.userId, input.cycleId, input.now)) throw new Error("Přístup nebo zámek cyklu už není platný.");
      const account = this.account(input.userId);
      const positions = this.positions(input.userId);
      if (this.dailyBraked(input.userId, input.now) || positions.some((position) => position.mark_error || position.mark_micros === null || position.marked_at === null || input.now - position.marked_at > 60_000)) return false;
      if (positions.length >= 3 || positions.reduce((sum, position) => sum + position.cost_micros, 0) + input.costMicros > 15_000_000 || this.everTraded(input.userId, input.mint)) return false;
      if (!Number.isSafeInteger(input.costMicros) || input.costMicros <= 0 || input.costMicros > 5_000_000 || account.cash_micros < input.costMicros + NETWORK_FEE_MICROS) return false;
      const id = `solp_${randomUUID().replaceAll("-", "")}`;
      this.db.prepare("INSERT INTO solana_paper_positions (id,user_id,mint,symbol,token_amount,cost_micros,entry_fee_micros,opened_at,mark_micros,marked_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, input.userId, input.mint, input.symbol.slice(0, 24), input.amount, input.costMicros, NETWORK_FEE_MICROS, input.now, input.markMicros, input.now);
      this.db.prepare("UPDATE solana_paper_accounts SET cash_micros=cash_micros-? WHERE user_id=?").run(input.costMicros + NETWORK_FEE_MICROS, input.userId);
      this.db.prepare("INSERT INTO solana_paper_trades (id,user_id,position_id,side,token_amount,gross_micros,network_fee_micros,quote_json,occurred_at) VALUES (?,?,?,'BUY',?,?,?,?,?)")
        .run(`solt_${randomUUID().replaceAll("-", "")}`, input.userId, id, input.amount, input.costMicros, NETWORK_FEE_MICROS, boundedJson(input.buyQuote), input.now);
      this.event(input.userId, input.cycleId, "executor", "ok", input.mint, "PAPER nákup podle konzervativní kotace; žádná transakce nebyla odeslána.", { positionId: id, amount: input.amount, costMicros: input.costMicros, networkFeeMicros: NETWORK_FEE_MICROS, buyQuote: input.buyQuote, reverseQuote: input.sellQuote }, input.now);
      return true;
    }).immediate();
  }

  sell(input: { userId: string; cycleId: string; position: PaperPosition; grossMicros: number; quote: SolanaQuote; now: number; authorize: () => boolean; reason: string }) {
    return this.db.transaction(() => {
      if (!input.authorize() || !this.ownsLease(input.userId, input.cycleId, input.now)) throw new Error("Přístup nebo zámek cyklu už není platný.");
      if (!Number.isSafeInteger(input.grossMicros) || input.grossMicros < NETWORK_FEE_MICROS) throw new Error("Kotace nepokrývá modelovaný síťový poplatek.");
      if (!Number.isSafeInteger(this.account(input.userId).cash_micros + input.grossMicros - NETWORK_FEE_MICROS)) throw new Error("Výnos překračuje bezpečný účetní rozsah.");
      const updated = this.db.prepare("UPDATE solana_paper_positions SET closed_at=?,proceeds_micros=?,mark_micros=?,marked_at=?,mark_error=NULL WHERE id=? AND user_id=? AND closed_at IS NULL")
        .run(input.now, input.grossMicros - NETWORK_FEE_MICROS, input.grossMicros, input.now, input.position.id, input.userId);
      if (updated.changes !== 1) return false;
      this.db.prepare("UPDATE solana_paper_accounts SET cash_micros=cash_micros+? WHERE user_id=?").run(input.grossMicros - NETWORK_FEE_MICROS, input.userId);
      this.db.prepare("INSERT INTO solana_paper_trades (id,user_id,position_id,side,token_amount,gross_micros,network_fee_micros,quote_json,occurred_at) VALUES (?,?,?,'SELL',?,?,?,?,?)")
        .run(`solt_${randomUUID().replaceAll("-", "")}`, input.userId, input.position.id, input.position.token_amount, input.grossMicros, NETWORK_FEE_MICROS, boundedJson(input.quote), input.now);
      this.event(input.userId, input.cycleId, "executor", "ok", input.position.mint, input.reason, { positionId: input.position.id, grossMicros: input.grossMicros, networkFeeMicros: NETWORK_FEE_MICROS, quote: input.quote }, input.now);
      return true;
    }).immediate();
  }
}
