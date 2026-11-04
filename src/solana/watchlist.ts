import type { OceanDatabase } from "../db.js";
import { SOLANA_USDC_MINT, type SolanaCandidate } from "./types.js";

export const WATCHLIST_MAX_POOLS = 120;
export const WATCHLIST_MAX_REFRESH = 20;
export const WATCHLIST_TTL_MS = 24 * 60 * 60_000;
export const WATCHLIST_REFRESH_INTERVAL_MS = 60_000;
export const WATCHLIST_ADMISSION_LIQUIDITY_USD = 10_000;

const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type WatchRow = {
  pool_address: string; mint: string; decimals: number; pool_created_at: number;
  first_discovered_at: number; last_discovered_at: number; last_refreshed_at: number;
  last_checked_at: number; missing_refreshes: number;
};

export type WatchedPool = {
  poolAddress: string; mint: string; poolCreatedAt: string;
  firstDiscoveredAt: string; lastDiscoveredAt: string; lastRefreshedAt: string;
  lastCheckedAt: string; missingRefreshes: number;
};

function validCandidate(candidate: SolanaCandidate, now: number) {
  if (!candidate || !addressPattern.test(candidate.poolAddress) || !addressPattern.test(candidate.mint)
    || candidate.mint === SOLANA_USDC_MINT || typeof candidate.symbol !== "string" || typeof candidate.name !== "string"
    || !Number.isInteger(candidate.decimals) || candidate.decimals < 0 || candidate.decimals > 18
    || !Number.isFinite(candidate.liquidityUsd) || candidate.liquidityUsd < 0
    || !Number.isFinite(candidate.volume5mUsd) || candidate.volume5mUsd < 0) return false;
  const created = Date.parse(candidate.poolCreatedAt);
  const observed = Date.parse(candidate.observedAt);
  return Number.isFinite(created) && Number.isFinite(observed)
    && created <= now + 5_000 && created + WATCHLIST_TTL_MS > now
    && observed <= now + 5_000 && observed >= now - 120_000 && observed >= created;
}

function samePool(row: WatchRow, candidate: SolanaCandidate) {
  return row.mint === candidate.mint && row.decimals === candidate.decimals
    && row.pool_created_at === Date.parse(candidate.poolCreatedAt)
    && Date.parse(candidate.observedAt) >= row.last_refreshed_at;
}

/** Stores discovery metadata and refresh scheduling only. Cached rows are never trading candidates. */
export class SolanaWatchlist {
  constructor(readonly db: OceanDatabase) {}

  private prune(userId: string, now: number) {
    this.db.prepare("DELETE FROM solana_paper_watchlist WHERE user_id=? AND expires_at<=?").run(userId, now);
  }

  private row(userId: string, address: string) {
    return this.db.prepare("SELECT * FROM solana_paper_watchlist WHERE user_id=? AND pool_address=?").get(userId, address) as WatchRow | undefined;
  }

  remember(userId: string, candidates: readonly SolanaCandidate[], now: number) {
    this.db.transaction(() => {
      this.prune(userId, now);
      for (const candidate of candidates.slice(0, 60)) {
        if (!validCandidate(candidate, now)) continue;
        const previous = this.row(userId, candidate.poolAddress);
        if (previous && !samePool(previous, candidate)) continue;
        if (!previous && candidate.liquidityUsd < WATCHLIST_ADMISSION_LIQUIDITY_USD) continue;
        const created = Date.parse(candidate.poolCreatedAt);
        this.db.prepare(`INSERT INTO solana_paper_watchlist
          (user_id,pool_address,mint,symbol,name,decimals,pool_created_at,expires_at,first_discovered_at,last_discovered_at,last_refreshed_at,last_checked_at,liquidity_usd,volume_5m_usd)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(user_id,pool_address) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,
            last_discovered_at=excluded.last_discovered_at,last_refreshed_at=excluded.last_refreshed_at,
            last_checked_at=excluded.last_checked_at,liquidity_usd=excluded.liquidity_usd,
            volume_5m_usd=excluded.volume_5m_usd,missing_refreshes=0`)
          .run(userId, candidate.poolAddress, candidate.mint, candidate.symbol.slice(0, 24), candidate.name.slice(0, 100),
            candidate.decimals, created, created + WATCHLIST_TTL_MS, now, now, Date.parse(candidate.observedAt), now,
            candidate.liquidityUsd, candidate.volume5mUsd);
      }
      // Prefer pools near the actual entry threshold; keep younger pools in that same band so they can mature.
      // First discovery and address break ties without making rediscovery extend the fixed pool lifetime.
      this.db.prepare(`DELETE FROM solana_paper_watchlist WHERE user_id=? AND pool_address IN (
        SELECT pool_address FROM solana_paper_watchlist WHERE user_id=?
        ORDER BY (liquidity_usd>=50000) DESC,liquidity_usd DESC,first_discovered_at ASC,pool_address ASC
        LIMIT -1 OFFSET ?)`)
        .run(userId, userId, WATCHLIST_MAX_POOLS);
    }).immediate();
  }

  due(userId: string, now: number, excludedPoolAddresses: readonly string[] = [], limit = WATCHLIST_MAX_REFRESH): WatchedPool[] {
    this.prune(userId, now);
    const excluded = new Set(excludedPoolAddresses);
    const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(WATCHLIST_MAX_REFRESH, Math.floor(limit))) : 0;
    const rows = this.db.prepare(`SELECT * FROM solana_paper_watchlist WHERE user_id=? AND last_checked_at<=?
      ORDER BY last_checked_at ASC,first_discovered_at ASC,pool_address ASC LIMIT ?`)
      .all(userId, now - WATCHLIST_REFRESH_INTERVAL_MS, WATCHLIST_MAX_POOLS) as WatchRow[];
    return rows.filter((row) => !excluded.has(row.pool_address)).slice(0, boundedLimit).map((row) => ({
      poolAddress: row.pool_address, mint: row.mint, poolCreatedAt: new Date(row.pool_created_at).toISOString(),
      firstDiscoveredAt: new Date(row.first_discovered_at).toISOString(), lastDiscoveredAt: new Date(row.last_discovered_at).toISOString(),
      lastRefreshedAt: new Date(row.last_refreshed_at).toISOString(), lastCheckedAt: new Date(row.last_checked_at).toISOString(),
      missingRefreshes: row.missing_refreshes,
    }));
  }

  /** Call after every attempted refresh, including failures (with []). Never falls back to stored observations. */
  refreshed(userId: string, requestedAddresses: readonly string[], freshCandidates: readonly SolanaCandidate[], now: number): SolanaCandidate[] {
    return this.db.transaction(() => {
      this.prune(userId, now);
      const requested = new Set(requestedAddresses.slice(0, WATCHLIST_MAX_REFRESH));
      for (const address of requested) this.db.prepare(`UPDATE solana_paper_watchlist
        SET last_checked_at=?,missing_refreshes=MIN(missing_refreshes+1,1000000) WHERE user_id=? AND pool_address=?`).run(now, userId, address);
      const fresh = new Map<string, SolanaCandidate>();
      for (const candidate of freshCandidates.slice(0, WATCHLIST_MAX_REFRESH)) {
        if (!validCandidate(candidate, now) || !requested.has(candidate.poolAddress)) continue;
        const row = this.row(userId, candidate.poolAddress);
        if (!row || !samePool(row, candidate)) continue;
        const previous = fresh.get(candidate.poolAddress);
        if (!previous || Date.parse(candidate.observedAt) > Date.parse(previous.observedAt)) fresh.set(candidate.poolAddress, candidate);
      }
      for (const candidate of fresh.values()) this.db.prepare(`UPDATE solana_paper_watchlist SET symbol=?,name=?,
        last_refreshed_at=?,liquidity_usd=?,volume_5m_usd=?,missing_refreshes=0 WHERE user_id=? AND pool_address=?`)
        .run(candidate.symbol.slice(0, 24), candidate.name.slice(0, 100), Date.parse(candidate.observedAt),
          candidate.liquidityUsd, candidate.volume5mUsd, userId, candidate.poolAddress);
      return [...fresh.values()];
    }).immediate();
  }

  stats(userId: string, now: number) {
    this.prune(userId, now);
    return this.db.prepare(`SELECT COUNT(*) AS poolCount,COUNT(DISTINCT mint) AS mintCount,
      COALESCE(SUM(CASE WHEN missing_refreshes>0 THEN 1 ELSE 0 END),0) AS missingCount
      FROM solana_paper_watchlist WHERE user_id=?`).get(userId) as { poolCount: number; mintCount: number; missingCount: number };
  }
}
