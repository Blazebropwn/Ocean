import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import type { OceanDatabase } from "../db.js";
import { appendTide, EconomyError, tideBalance } from "../tide/ledger.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const GENESIS_WAVE = "GENESIS_001";
export const REWARD_DISTRIBUTION = Object.freeze({ 300: 40, 500: 30, 800: 15, 1000: 8, 2000: 4, 5000: 2, 10000: 1 });
export type GenesisCodeExport = { genesisNumber: number; code: string; rewardTide: number; wave: string };
export type GenesisIssueOptions = { adminUserId: string; hmacKey: string };
export function normalizeCode(code: string) { return code.trim().toUpperCase().replace(/[\s-]/g, ""); }
function keyBytes(key?: string) {
  if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) throw new EconomyError("GENESIS_UNAVAILABLE", "Aktivace není dostupná. Zkus to později.", 503);
  return Buffer.from(key, "hex");
}
export function keyId(key: string) { return createHash("sha256").update("ocean-genesis-hmac-v1:").update(keyBytes(key)).digest("hex"); }
export function hashCode(code: string, key?: string) {
  const normalized = normalizeCode(code);
  return key === undefined ? createHash("sha256").update(normalized).digest("hex")
    : createHmac("sha256", keyBytes(key)).update(normalized).digest("hex");
}
export function genesisIdentity(db: OceanDatabase, userId: string) {
  return db.prepare(`SELECT c.genesis_number AS number,r.wave_id AS waveId,r.created_at AS activatedAt
    FROM genesis_redemptions r JOIN genesis_codes c ON c.id=r.code_id JOIN genesis_waves w ON w.id=r.wave_id
    WHERE r.user_id=? AND w.kind IN ('genesis','legacy') ORDER BY r.created_at,r.id LIMIT 1`)
    .get(userId) as { number: number; waveId: string; activatedAt: string } | undefined;
}

// Explicit administrative operation only. Export must be durable before commit.
export function issueGenesisBatch(db: OceanDatabase, options: GenesisIssueOptions, exportCodes: (codes: GenesisCodeExport[]) => void) {
  const digestKeyId = keyId(options.hmacKey);
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM genesis_waves WHERE id=?").get(GENESIS_WAVE)) throw new EconomyError("GENESIS_ALREADY_ISSUED", "Genesis kódy již byly vydané.");
    if (db.prepare("SELECT 1 FROM genesis_waves WHERE kind='legacy'").get()) throw new EconomyError("GENESIS_LEGACY_EXISTS", "Databáze už obsahuje původní emisi. Nová emise vyžaduje samostatný migrační plán.");
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='owner' AND (approved_at IS NOT NULL OR email_verified_at IS NOT NULL)").get(options.adminUserId)) {
      throw new EconomyError("GENESIS_ADMIN_INVALID", "Alokace vyžaduje ID schváleného vlastníka.");
    }
    const rewards = Object.entries(REWARD_DISTRIBUTION).flatMap(([reward, count]) => Array<number>(count).fill(Number(reward)));
    for (let i = rewards.length - 1; i > 0; i--) { const j = randomInt(i + 1); [rewards[i], rewards[j]] = [rewards[j]!, rewards[i]!]; }
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO genesis_waves (id,kind,status,total_codes,code_allocation,admin_allocation,total_supply,admin_user_id,distribution_json,digest_key_id,created_at)
      VALUES (?,'genesis','draft',100,75000,25000,100000,?,?,?,?)`).run(GENESIS_WAVE, options.adminUserId, JSON.stringify(REWARD_DISTRIBUTION), digestKeyId, at);
    const seen = new Set<string>();
    const codes = rewards.map((rewardTide, i) => {
      let code: string;
      do { const raw = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""); code = `OCN-${raw.match(/.{5}/g)!.join("-")}`; } while (seen.has(code));
      seen.add(code);
      return { genesisNumber: i + 1, code, rewardTide, wave: GENESIS_WAVE };
    });
    const insert = db.prepare("INSERT INTO genesis_codes (id,wave_id,genesis_number,code_hash,digest_scheme,reward_tide,created_at) VALUES (?,?,?,?,'hmac_sha256_v1',?,?)");
    for (const c of codes) insert.run(`code_${randomUUID().replaceAll("-", "")}`, GENESIS_WAVE, c.genesisNumber, hashCode(c.code, options.hmacKey), c.rewardTide, at);
    appendTide(db, { userId: options.adminUserId, amount: 25000, transactionType: "GENESIS_ADMIN_ALLOCATION", source: "genesis_admin", referenceId: GENESIS_WAVE, createdAt: at });
    db.prepare("UPDATE genesis_waves SET status='issued' WHERE id=?").run(GENESIS_WAVE);
    db.prepare("INSERT INTO admin_audit_log (actor_user_id,action,details_json) VALUES (?,'GENESIS_WAVE_ISSUED',?)")
      .run(options.adminUserId, JSON.stringify({ wave: GENESIS_WAVE, totalSupply: 100000, codeAllocation: 75000, adminAllocation: 25000 }));
    exportCodes(codes);
    return codes.length;
  }).immediate();
}

function invalidCode(): never { throw new EconomyError("INVALID_CODE", "Invalid code", 400); }
export function redeemGenesis(db: OceanDatabase, userId: string, code: string, hmacKey?: string) {
  const normalized = normalizeCode(code);
  const modern = /^OCN[A-Z2-9]{20}$/.test(normalized);
  if (!modern && !/^[A-Z2-9]{12}$/.test(normalized)) invalidCode();
  if (modern) keyBytes(hmacKey);
  return db.transaction(() => {
    if (modern && db.prepare("SELECT 1 FROM genesis_waves WHERE digest_key_id IS NOT NULL AND digest_key_id<>? AND status='issued'").get(keyId(hmacKey!))) {
      throw new EconomyError("GENESIS_UNAVAILABLE", "Aktivace není dostupná. Zkus to později.", 503);
    }
    const found = db.prepare(`SELECT c.id,c.genesis_number AS number,c.wave_id AS waveId,c.reward_tide AS reward,w.kind
      FROM genesis_codes c JOIN genesis_waves w ON w.id=c.wave_id
      WHERE c.code_hash=? AND c.digest_scheme=? AND w.status='issued'`)
      .get(hashCode(normalized, modern ? hmacKey : undefined), modern ? "hmac_sha256_v1" : "sha256_legacy") as { id: string; number: number; waveId: string; reward: number; kind: string } | undefined;
    if (!found) invalidCode();
    const used = db.prepare("SELECT user_id FROM genesis_redemptions WHERE code_id=?").get(found.id) as { user_id: string } | undefined;
    if (used && used.user_id !== userId) invalidCode();
    if (used) return { genesis: genesisIdentity(db, userId) ?? null, reward: found.reward, replayed: true, balance: tideBalance(db, userId) };
    if (db.prepare("SELECT 1 FROM genesis_redemptions WHERE user_id=? AND wave_id=?").get(userId, found.waveId)) invalidCode();
    if (found.kind !== "promo" && genesisIdentity(db, userId)) invalidCode();
    const id = `gen_${randomUUID().replaceAll("-", "")}`, createdAt = new Date().toISOString();
    db.prepare("INSERT INTO genesis_redemptions (id,user_id,code_id,wave_id,created_at) VALUES (?,?,?,?,?)").run(id, userId, found.id, found.waveId, createdAt);
    appendTide(db, { userId, amount: found.reward, transactionType: "GENESIS_REDEMPTION", source: "genesis", referenceId: id, createdAt });
    // The immutable redemption + ledger link is the audit: user, code ID, wave, reward and time; never plaintext.
    return { genesis: genesisIdentity(db, userId) ?? null, reward: found.reward, replayed: false, balance: tideBalance(db, userId) };
  }).immediate();
}
