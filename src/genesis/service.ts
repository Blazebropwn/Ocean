import { createHash, randomInt, randomUUID } from "node:crypto";
import type { OceanDatabase } from "../db.js";
import { appendTide, EconomyError, tideBalance } from "../tide/ledger.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normalizeCode(code: string) { return code.trim().toUpperCase().replace(/[\s-]/g, ""); }
export function hashCode(code: string) { return createHash("sha256").update(normalizeCode(code)).digest("hex"); }
export function genesisIdentity(db: OceanDatabase, userId: string) {
  return db.prepare("SELECT genesis_number AS number,created_at AS activatedAt FROM genesis_redemptions WHERE user_id = ?").get(userId) as { number: number; activatedAt: string } | undefined;
}

// Export runs within the transaction. It must durably write a new private file
// before commit; callers remove that new file if the transaction fails.
export function issueGenesisBatch(db: OceanDatabase, exportCodes: (codes: Array<{ genesisNumber: number; code: string }>) => void) {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM genesis_codes LIMIT 1").get()) throw new EconomyError("GENESIS_ALREADY_ISSUED", "Genesis kódy již byly vydané.");
    const codes = Array.from({ length: 100 }, (_, i) => {
      const raw = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      return { genesisNumber: i + 1, code: raw.match(/.{4}/g)!.join("-") };
    });
    const insert = db.prepare("INSERT INTO genesis_codes (genesis_number,code_hash,created_at) VALUES (?,?,?)");
    const at = new Date().toISOString();
    for (const c of codes) insert.run(c.genesisNumber, hashCode(c.code), at);
    exportCodes(codes);
    return codes.length;
  }).immediate();
}

export function redeemGenesis(db: OceanDatabase, userId: string, code: string) {
  return db.transaction(() => {
    const found = db.prepare("SELECT genesis_number AS number FROM genesis_codes WHERE code_hash = ?").get(hashCode(code)) as { number: number } | undefined;
    if (!found) throw new EconomyError("INVALID_CODE", "Kód není platný.", 404);
    const used = db.prepare("SELECT user_id FROM genesis_redemptions WHERE genesis_number = ?").get(found.number) as { user_id: string } | undefined;
    if (used && used.user_id !== userId) throw new EconomyError("CODE_REDEEMED", "Kód už byl použitý.");
    const identity = genesisIdentity(db, userId);
    if (identity && identity.number !== found.number) throw new EconomyError("GENESIS_EXISTS", "Tento účet už má Genesis identitu.");
    if (used) return { genesis: identity!, reward: 300, replayed: true, balance: tideBalance(db, userId) };
    const id = `gen_${randomUUID().replaceAll("-", "")}`, createdAt = new Date().toISOString();
    db.prepare("INSERT INTO genesis_redemptions (id,user_id,genesis_number,created_at) VALUES (?,?,?,?)").run(id, userId, found.number, createdAt);
    appendTide(db, { userId, amount: 300, transactionType: "GENESIS_REDEMPTION", source: "genesis", referenceId: id, createdAt });
    return { genesis: genesisIdentity(db, userId)!, reward: 300, replayed: false, balance: tideBalance(db, userId) };
  }).immediate();
}
