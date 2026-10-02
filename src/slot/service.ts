import { randomUUID } from "node:crypto";
import type { OceanDatabase } from "../db.js";
import { appendTide, EconomyError, tideBalance } from "../tide/ledger.js";
import { BET, drawStops, evaluateStops, GAME_VERSION } from "./math.js";

type SpinRow = { id: string; user_id: string; idempotency_key: string; game_version: string; bet: number; stops_json: string; symbols_json: string; payout: number; balance_before: number; balance_after: number; created_at: string };
function publicSpin(row: SpinRow) {
  return { spinId: row.id, userId: row.user_id, idempotencyKey: row.idempotency_key, gameVersion: row.game_version,
    bet: row.bet, stops: JSON.parse(row.stops_json), symbols: JSON.parse(row.symbols_json), payout: row.payout,
    balanceBefore: row.balance_before, balanceAfter: row.balance_after, createdAt: row.created_at };
}

// RNG dependency is supplied only in direct service tests, never by HTTP.
export function spinSlot(db: OceanDatabase, userId: string, key: string, rng: () => number[] = drawStops) {
  return db.transaction(() => {
    const previous = db.prepare("SELECT * FROM slot_spins WHERE user_id = ? AND idempotency_key = ?").get(userId, key) as SpinRow | undefined;
    if (previous) return { spin: publicSpin(previous), replayed: true, balance: tideBalance(db, userId) };
    const before = tideBalance(db, userId);
    if (before < BET) throw new EconomyError("INSUFFICIENT_TIDE", "Na spin potřebuješ 10 TIDE.");
    const result = evaluateStops(rng());
    const after = before - BET + result.payout;
    if (!Number.isSafeInteger(after)) throw new EconomyError("BALANCE_LIMIT", "Zůstatek dosáhl maximální hodnoty.");
    const id = `spin_${randomUUID().replaceAll("-", "")}`, createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO slot_spins (id,user_id,idempotency_key,game_version,bet,stops_json,symbols_json,payout,balance_before,balance_after,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, key, GAME_VERSION, BET, JSON.stringify(result.stops), JSON.stringify(result.symbols), result.payout, before, after, createdAt);
    appendTide(db, { userId, amount: -BET, transactionType: "SLOT_BET", source: GAME_VERSION, referenceId: id, createdAt });
    if (result.payout) appendTide(db, { userId, amount: result.payout, transactionType: "SLOT_WIN", source: GAME_VERSION, referenceId: id, createdAt });
    if (tideBalance(db, userId) !== after) throw new Error("TIDE_SETTLEMENT_MISMATCH");
    const row = db.prepare("SELECT * FROM slot_spins WHERE id = ?").get(id) as SpinRow;
    return { spin: publicSpin(row), replayed: false, balance: after };
  }).immediate();
}
