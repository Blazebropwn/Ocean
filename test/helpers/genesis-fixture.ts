import type { OceanDatabase } from "../../src/db.js";
import { issueGenesisBatch, redeemGenesis, type GenesisCodeExport } from "../../src/genesis/service.js";
export const TEST_GENESIS_KEY = "ab".repeat(32);
export const TEST_GENESIS_ADMIN = "genesis_admin";
export function genesisAdmin(db: OceanDatabase) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,username,password_hash,role,approved_at) VALUES (?,?,?,?, 'owner',datetime('now'))")
    .run(TEST_GENESIS_ADMIN,"genesis-admin@example.test",TEST_GENESIS_ADMIN,"not-a-password");
}
export function issueTestGenesis(db: OceanDatabase, exportCodes: (codes: GenesisCodeExport[]) => void) {
  genesisAdmin(db);
  return issueGenesisBatch(db, { adminUserId: TEST_GENESIS_ADMIN, hmacKey: TEST_GENESIS_KEY }, exportCodes);
}
export function redeemTestGenesis(db: OceanDatabase, userId: string, code: string) { return redeemGenesis(db, userId, code, TEST_GENESIS_KEY); }
