import type { OceanDatabase } from "../db.js";

export function genesisOverview(db: OceanDatabase, waveId?: string) {
  return db.transaction(() => {
    const waves = db.prepare(`SELECT w.id,w.kind,w.status,w.total_codes AS totalCodes,w.total_supply AS totalSupply,
      w.code_allocation AS codeAllocation,w.admin_allocation AS adminAllocation,w.admin_user_id AS adminUserId,
      u.username AS adminUsername,w.created_at AS createdAt,
      (SELECT COUNT(*) FROM genesis_codes c WHERE c.wave_id=w.id) AS issuedCodes,
      (SELECT COUNT(*) FROM genesis_redemptions r WHERE r.wave_id=w.id) AS redeemedCodes,
      (SELECT COALESCE(SUM(l.amount),0) FROM tide_ledger l JOIN genesis_redemptions r ON r.id=l.reference_id WHERE l.source='genesis' AND r.wave_id=w.id) AS redeemedAmount,
      (SELECT COALESCE(SUM(c.reward_tide),0) FROM genesis_codes c WHERE c.wave_id=w.id AND NOT EXISTS (SELECT 1 FROM genesis_redemptions r WHERE r.code_id=c.id)) AS unclaimedAmount,
      (SELECT COALESCE(SUM(l.amount),0) FROM tide_ledger l WHERE l.source='genesis_admin' AND l.reference_id=w.id) AS adminCredited
      FROM genesis_waves w LEFT JOIN users u ON u.id=w.admin_user_id ORDER BY w.created_at DESC,w.id DESC`).all() as Array<{
        id: string; status: string; totalCodes: number; totalSupply: number; codeAllocation: number; adminAllocation: number;
        issuedCodes: number; redeemedCodes: number; redeemedAmount: number; unclaimedAmount: number; adminCredited: number;
      }>;
    const selectedWave = waveId ?? waves[0]?.id ?? null;
    const codes = selectedWave ? db.prepare(`SELECT c.id,c.wave_id AS waveId,c.genesis_number AS number,c.reward_tide AS rewardTide,
      c.created_at AS createdAt,CASE WHEN r.id IS NULL THEN 'unclaimed' ELSE 'redeemed' END AS status,
      r.user_id AS redeemedBy,u.username AS redeemedUsername,r.created_at AS redeemedAt,l.id AS ledgerId
      FROM genesis_codes c LEFT JOIN genesis_redemptions r ON r.code_id=c.id LEFT JOIN users u ON u.id=r.user_id
      LEFT JOIN tide_ledger l ON l.source='genesis' AND l.reference_id=r.id
      WHERE c.wave_id=? ORDER BY c.genesis_number`).all(selectedWave) : [];
    return { selectedWave, waves: waves.map(w => ({ ...w, accountingValid: w.status === "issued" && w.issuedCodes === w.totalCodes
      && w.adminCredited === w.adminAllocation && w.redeemedAmount + w.unclaimedAmount === w.codeAllocation
      && w.adminAllocation + w.codeAllocation === w.totalSupply })), codes };
  })();
}
