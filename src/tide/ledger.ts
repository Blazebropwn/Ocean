import { randomUUID } from "node:crypto";
import type { OceanDatabase } from "../db.js";

export function tideBalance(db: OceanDatabase, userId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(amount),0) AS balance FROM tide_ledger WHERE user_id = ?").get(userId) as { balance: number }).balance;
}

export function appendTide(db: OceanDatabase, entry: { userId: string; amount: number; transactionType: "GENESIS_REDEMPTION" | "GENESIS_ADMIN_ALLOCATION" | "SLOT_BET" | "SLOT_WIN"; source: "genesis" | "genesis_admin" | "ocean_slot_v1"; referenceId: string; createdAt: string }) {
  if (!db.inTransaction) throw new Error("TIDE_REQUIRES_TRANSACTION");
  db.prepare("INSERT INTO tide_ledger (id,user_id,amount,transaction_type,source,reference_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(`tide_${randomUUID().replaceAll("-", "")}`, entry.userId, entry.amount, entry.transactionType, entry.source, entry.referenceId, entry.createdAt);
}

export function tideHistory(db: OceanDatabase, userId: string, before: number, limit = 25) {
  const entries = db.prepare(`SELECT sequence,id,user_id AS userId,amount,transaction_type AS transactionType,
    source,reference_id AS referenceId,created_at AS createdAt FROM tide_ledger WHERE user_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`)
    .all(userId, before, limit + 1) as Array<{ sequence: number; [key: string]: unknown }>;
  return { entries: entries.slice(0, limit), nextCursor: entries.length > limit ? entries[limit - 1]!.sequence : null };
}

export class EconomyError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
