import type { Config } from "../config.js";
import type { OceanDatabase, UserRecord } from "../db.js";
import { hasApprovedAccess } from "../routes/shared.js";
import { SolanaPaperStore, NETWORK_FEE_MICROS, CYCLE_COOLDOWN_MS, type PaperPosition } from "./store.js";
import { SOLANA_TOKEN_PROGRAM, SOLANA_USDC_MINT, type Evidence, type SolanaCandidate, type SolanaCandidateSummary, type SolanaMarketProvider, type SolanaQuote, type SolanaRiskReport, type SolanaRuntime, type SolanaStage } from "./types.js";
import { SolanaWatchlist } from "./watchlist.js";

export const SOLANA_PAPER_POLICY_VERSION = "paper-2026-11-04-v2";

export const SOLANA_PAPER_LIMITS = Object.freeze({
  maxPositionUsdc: 5, maxOpenPositions: 3, maxExposureUsdc: 15,
  minLiquidityUsd: 50_000, minVolume5mUsd: 1_000, maxHolderPct: 20,
  minLiquidityLockedPct: 95, cooldownSeconds: 60, networkFeeUsdc: 0.01,
  slippageBps: 100, maxQuoteAgeSeconds: 30, maxPriceImpactBps: 300,
  maxRouteFeeBps: 100, minPoolAgeMinutes: 5, maxPoolAgeHours: 24,
  stopLossPct: 10, takeProfitPct: 20, maxHoldingMinutes: 30,
  maxDailyLossUsdc: 5, maxDailyEntries: 10,
});

const U64_MAX = 18_446_744_073_709_551_615n;
const ids: SolanaStage["id"][] = ["scanner", "rug-check", "sizer", "executor", "logger", "equity"];
const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const iso = (timestamp: number | null) => timestamp === null ? null : new Date(timestamp).toISOString();
const money = (micros: number) => micros / 1_000_000;

export function hasSolanaPilotAccess(user: UserRecord | undefined, config: Config) {
  return Boolean(user && config.solanaPilotUserId && user.id === config.solanaPilotUserId && hasApprovedAccess(user, config));
}

function recent(timestamp: string, now: number, maxAge: number) {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value <= now + 5_000 && now - value <= maxAge;
}

export function rawAmount(value: string) {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error("Neplatné raw množství tokenu.");
  const amount = BigInt(value);
  if (amount > U64_MAX) throw new Error("Raw množství překračuje rozsah tokenového účtu.");
  return amount;
}

export function candidateRejection(candidate: SolanaCandidate, now: number): string | null {
  return candidateRejections(candidate, now)[0] ?? null;
}

export function candidateRejections(candidate: SolanaCandidate, now: number): string[] {
  const reasons: string[] = [];
  if (!mintPattern.test(candidate.mint) || candidate.mint === SOLANA_USDC_MINT || !mintPattern.test(candidate.poolAddress)) reasons.push("Neplatný token nebo adresa poolu.");
  if (!Number.isInteger(candidate.decimals) || candidate.decimals < 0 || candidate.decimals > 18) reasons.push("Neznámá přesnost tokenu.");
  if (!recent(candidate.observedAt, now, 120_000)) reasons.push("Data poolu jsou zastaralá.");
  const created = Date.parse(candidate.poolCreatedAt);
  const age = now - created;
  if (!Number.isFinite(created) || age < 5 * 60_000 || age > 24 * 60 * 60_000) reasons.push("Pool musí být starý 5 minut až 24 hodin.");
  if (!Number.isFinite(candidate.liquidityUsd) || candidate.liquidityUsd < 50_000) reasons.push("Likvidita je nižší než 50 000 USD nebo ji nelze ověřit.");
  if (!Number.isFinite(candidate.volume5mUsd) || candidate.volume5mUsd < 1_000) reasons.push("Objem za 5 minut je nižší než 1 000 USD nebo chybí.");
  return reasons;
}

export function riskRejection(report: SolanaRiskReport, mint: string, now: number): string | null {
  return riskRejections(report, mint, now)[0] ?? null;
}

export function riskRejections(report: SolanaRiskReport, mint: string, now: number): string[] {
  const reasons: string[] = [];
  if (report.mint !== mint || !recent(report.observedAt, now, 120_000)) reasons.push("Rizikový report neodpovídá tokenu nebo je zastaralý.");
  if (report.mintAuthorityRevoked !== true) reasons.push("Mint authority není prokazatelně odebraná.");
  if (report.freezeAuthorityRevoked !== true) reasons.push("Freeze authority není prokazatelně odebraná.");
  if (report.tokenProgram !== SOLANA_TOKEN_PROGRAM) reasons.push("Tokenový program není v pilotu povolený.");
  if (report.topHolderPct === null || !Number.isFinite(report.topHolderPct) || report.topHolderPct < 0 || report.topHolderPct > 20) reasons.push("Koncentrace držitelů není ověřená nebo překračuje 20 %.");
  if (report.liquidityLockedPct === null || !Number.isFinite(report.liquidityLockedPct) || report.liquidityLockedPct < 95 || report.liquidityLockedPct > 100) reasons.push("Není doložené uzamčení alespoň 95 % likvidity.");
  if (!Array.isArray(report.risks)) reasons.push("RugCheck obsahuje varování, nebezpečí nebo neznámé kontroly.");
  else for (const risk of report.risks) if (risk.level.toLowerCase() !== "info") reasons.push(`RugCheck (${risk.level}): ${risk.name}`);
  return [...new Set(reasons)];
}

export function conservativeQuoteAmount(quote: SolanaQuote, inputMint: string, outputMint: string, amount: string, now: number): bigint {
  rawAmount(amount);
  if (quote.inputMint !== inputMint || quote.outputMint !== outputMint || quote.inAmount !== amount) throw new Error("Kotace neodpovídá směru nebo množství obchodu.");
  if (!recent(quote.quotedAt, now, 30_000) || (quote.expiresAt !== null && (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now))) throw new Error("Kotace už není čerstvá.");
  if (!Number.isFinite(quote.priceImpactBps) || quote.priceImpactBps < 0 || quote.priceImpactBps > 300) throw new Error("Cenový dopad překračuje 3 % nebo není ověřený.");
  if (!Number.isInteger(quote.feeBps) || quote.feeBps < 0 || quote.feeBps > 100 || (quote.feeMint !== inputMint && quote.feeMint !== outputMint) || !quote.route) throw new Error("Poplatek nebo trasa není v povoleném limitu.");
  // These are sanity limits, not a USD conversion. The extra .01 USDC remains an explicit paper assumption.
  let lamports = 0;
  for (const field of ["signatureFeeLamports", "prioritizationFeeLamports", "rentFeeLamports"]) {
    const value = quote.evidence[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Síťové poplatky kotace nejsou doložené.");
    lamports += value;
  }
  if (!Number.isSafeInteger(lamports) || lamports > 100_000) throw new Error("Kotace obsahuje neočekávaný síťový nebo rent poplatek.");
  const expected = rawAmount(quote.outAmount);
  const minimum = rawAmount(quote.minOutAmount);
  if (minimum > expected) throw new Error("Minimální výstup kotace je nekonzistentní.");
  const conservative = minimum * 9_900n / 10_000n;
  if (conservative <= 0n) throw new Error("Po rezervě na skluz je výstup nulový.");
  return conservative;
}

function usdcMicros(amount: bigint) {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("USDC množství překračuje bezpečný účetní rozsah.");
  return Number(amount);
}

export class SolanaPaperEngine {
  readonly store: SolanaPaperStore;
  readonly watchlist: SolanaWatchlist;
  private readonly runtimes = new Map<string, SolanaRuntime>();
  constructor(db: OceanDatabase, readonly provider: SolanaMarketProvider, readonly now: () => number = Date.now) { this.store = new SolanaPaperStore(db); this.watchlist = new SolanaWatchlist(db); }

  runtime(userId: string): SolanaRuntime {
    return this.runtimes.get(userId) ?? { running: false, cycleId: null, stage: null, mint: null, symbol: null, detail: "Žádný cyklus právě neběží.", startedAt: null, updatedAt: null };
  }

  snapshot(userId: string, compact = false) {
    const now = this.now();
    const account = this.store.ensureAccount(userId, now);
    const positions = this.store.positions(userId);
    const db = this.store.db;
    const events = db.prepare(`SELECT sequence,stage,status,mint,reason,${compact ? "'{}'" : "evidence_json"} AS evidence_json,occurred_at FROM solana_paper_events WHERE user_id=? ORDER BY sequence DESC LIMIT ?`).all(userId, compact ? 20 : 50) as { sequence: number; stage: SolanaStage["id"]; status: SolanaStage["status"]; mint: string | null; reason: string; evidence_json: string; occurred_at: number }[];
    const latestCycle = db.prepare("SELECT id FROM solana_paper_cycles WHERE user_id=? ORDER BY started_at DESC,id DESC LIMIT 1").get(userId) as { id: string } | undefined;
    const stageEvents = latestCycle ? db.prepare("SELECT stage,status,reason FROM solana_paper_events WHERE user_id=? AND cycle_id=? ORDER BY sequence DESC").all(userId, latestCycle.id) as { stage: SolanaStage["id"]; status: SolanaStage["status"]; reason: string }[] : [];
    const stages = ids.map((id): SolanaStage => {
      const latest = stageEvents.find((event) => event.stage === id);
      const runtime = this.runtime(userId);
      if (runtime.running && runtime.stage === id) return { id, status: "running", detail: runtime.detail };
      return { id, status: latest?.status === "running" ? "idle" : latest?.status ?? "idle", detail: latest?.status === "running" ? "Tento krok zatím nemá dokončený výsledek." : latest?.reason ?? "V tomto cyklu se tento krok neprovedl." };
    });
    const marked = positions.map((position) => ({
      id: position.id, mint: position.mint, symbol: position.symbol, tokenAmount: position.token_amount,
      costUsdc: money(position.cost_micros), entryFeeUsdc: money(position.entry_fee_micros), openedAt: iso(position.opened_at),
      markUsdc: position.mark_error || position.mark_micros === null || position.marked_at === null || now - position.marked_at > 60_000 ? null : money(Math.max(0, position.mark_micros - NETWORK_FEE_MICROS)),
      lastKnownMarkUsdc: position.mark_micros === null ? null : money(Math.max(0, position.mark_micros - NETWORK_FEE_MICROS)),
      markedAt: iso(position.marked_at), markError: position.mark_error ?? (position.marked_at === null || now - position.marked_at > 60_000 ? "Kotace pozice je zastaralá; spusť nový cyklus." : null),
    }));
    const markedTotalMicros = positions.reduce((sum, position) => sum + Math.max(0, (position.mark_micros ?? 0) - NETWORK_FEE_MICROS), 0);
    const allPriced = marked.every((position) => position.markUsdc !== null) && Number.isSafeInteger(markedTotalMicros) && Number.isSafeInteger(account.cash_micros + markedTotalMicros);
    const realized = db.prepare("SELECT COALESCE(SUM(proceeds_micros-cost_micros-entry_fee_micros),0) AS pnl FROM solana_paper_positions WHERE user_id=? AND closed_at IS NOT NULL").get(userId) as { pnl: number };
    const trades = compact ? [] : db.prepare("SELECT id,position_id,side,token_amount,gross_micros,network_fee_micros,occurred_at FROM solana_paper_trades WHERE user_id=? ORDER BY occurred_at DESC,id DESC LIMIT 30").all(userId) as { id: string; position_id: string; side: string; token_amount: string; gross_micros: number; network_fee_micros: number; occurred_at: number }[];
    const cycle = db.prepare("SELECT id,started_at,completed_at,status FROM solana_paper_cycles WHERE user_id=? ORDER BY started_at DESC,id DESC LIMIT 1").get(userId) as { id: string; started_at: number; completed_at: number | null; status: string } | undefined;
    const candidates = this.store.candidates(userId);
    const details = this.store.scanDetails(userId);
    const watched = this.watchlist.stats(userId, now);
    const rejectionCounts = new Map<string, number>();
    for (const candidate of candidates.filter((candidate) => candidate.status === "blocked")) {
      for (const reason of new Set(candidate.reasons?.length ? candidate.reasons : [candidate.reason])) rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
    }
    return {
      mode: "PAPER" as const, initialUsdc: money(account.initial_micros), cashUsdc: money(account.cash_micros),
      equityUsdc: allPriced ? money(account.cash_micros + markedTotalMicros) : null,
      realizedPnlUsdc: money(realized.pnl), unrealizedPnlUsdc: allPriced ? money(markedTotalMicros - positions.reduce((sum, position) => sum + position.cost_micros + position.entry_fee_micros, 0)) : null,
      limits: SOLANA_PAPER_LIMITS, stages, positions: marked,
      runtime: this.runtime(userId), counters: this.store.counters(userId), equityHistory: this.store.equityHistory(userId),
      diagnostics: { policyVersion: typeof details.policyVersion === "string" ? details.policyVersion : cycle ? "legacy" : SOLANA_PAPER_POLICY_VERSION, inspectedTokens: candidates.length, rejectedTokens: candidates.filter((candidate) => candidate.status === "blocked").length, rejectionCounts: [...rejectionCounts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)) },
      watchlist: { trackedPools: watched.poolCount, trackedTokens: watched.mintCount, refreshedPools: typeof details.refreshedPools === "number" ? details.refreshedPools : 0, refreshErrors: typeof details.refreshErrors === "number" ? details.refreshErrors : 0, lastError: typeof details.lastError === "string" ? details.lastError : null },
      candidates: candidates.sort((a, b) => {
        const rank = { checking: 0, bought: 1, passed: 2, eligible: 3, blocked: 4 };
        return rank[a.status] - rank[b.status];
      }).slice(0, 20),
      trades: trades.map((trade) => ({ id: trade.id, positionId: trade.position_id, side: trade.side, tokenAmount: trade.token_amount, grossUsdc: money(trade.gross_micros), networkFeeUsdc: money(trade.network_fee_micros), occurredAt: iso(trade.occurred_at) })),
      decisions: events.map((event) => ({ sequence: event.sequence, stage: event.stage, status: event.status, mint: event.mint, reason: event.reason, evidence: JSON.parse(event.evidence_json) as Evidence, occurredAt: iso(event.occurred_at) })),
      lastCycle: cycle ? { id: cycle.id, startedAt: iso(cycle.started_at), completedAt: iso(cycle.completed_at), status: cycle.status } : null,
      nextCycleAt: account.last_cycle_at === null ? null : iso(Math.max(account.last_cycle_at + CYCLE_COOLDOWN_MS, account.lease_until ?? 0)), asOf: iso(now),
    };
  }

  private assertAuthorized(authorize: () => boolean, userId: string, cycleId: string) {
    if (!authorize() || !this.store.ownsLease(userId, cycleId, this.now())) throw new Error("Přístup nebo zámek cyklu už není platný.");
  }

  private event(userId: string, cycleId: string, stage: SolanaStage["id"], status: SolanaStage["status"], mint: string | null, reason: string, evidence: Evidence, authorize: () => boolean) {
    this.assertAuthorized(authorize, userId, cycleId);
    this.store.event(userId, cycleId, stage, status, mint, reason, evidence, this.now());
  }

  private progress(userId: string, cycleId: string, stage: SolanaStage["id"], detail: string, authorize: () => boolean, candidate?: Pick<SolanaCandidate, "mint" | "symbol">) {
    this.assertAuthorized(authorize, userId, cycleId);
    const previous = this.runtime(userId);
    this.runtimes.set(userId, { running: true, cycleId, stage, mint: candidate?.mint ?? null, symbol: candidate?.symbol ?? null, detail, startedAt: previous.cycleId === cycleId ? previous.startedAt : iso(this.now()), updatedAt: iso(this.now()) });
    this.event(userId, cycleId, stage, "running", candidate?.mint ?? null, detail, { symbol: candidate?.symbol ?? null }, authorize);
  }

  private async refreshPosition(userId: string, cycleId: string, position: PaperPosition, authorize: () => boolean, manualClose: boolean) {
    try {
      this.progress(userId, cycleId, "equity", `Načítám prodejní kotaci ${position.symbol} pro ocenění a výstupní limity.`, authorize, position);
      const quote = await this.provider.quote(position.mint, SOLANA_USDC_MINT, position.token_amount);
      this.assertAuthorized(authorize, userId, cycleId);
      const gross = usdcMicros(conservativeQuoteAmount(quote, position.mint, SOLANA_USDC_MINT, position.token_amount, this.now()));
      if (gross < NETWORK_FEE_MICROS) throw new Error("Kotace nepokrývá modelovaný síťový poplatek.");
      this.store.mark(userId, position.id, gross, null, this.now());
      const net = gross - NETWORK_FEE_MICROS;
      const cost = position.cost_micros + position.entry_fee_micros;
      const reason = manualClose ? "Ruční PAPER uzavření." : net <= cost * 0.9 ? "PAPER stop-loss −10 %." : net >= cost * 1.2 ? "PAPER take-profit +20 %." : this.now() - position.opened_at >= 30 * 60_000 ? "PAPER časový výstup po 30 minutách." : null;
      if (reason) this.store.sell({ userId, cycleId, position, grossMicros: gross, quote, now: this.now(), authorize, reason });
      else this.event(userId, cycleId, "equity", "ok", position.mint, "Pozice oceněná čerstvou prodejní kotací po rezervě na skluz a poplatek.", { positionId: position.id, quote, netMicros: net }, authorize);
      return true;
    } catch (error) {
      this.assertAuthorized(authorize, userId, cycleId);
      const reason = error instanceof Error ? error.message : "Prodejní kotace není dostupná.";
      this.store.mark(userId, position.id, null, reason, this.now());
      this.event(userId, cycleId, "equity", "error", position.mint, `Pozici nelze ocenit ani uzavřít: ${reason}`, { positionId: position.id }, authorize);
      return false;
    }
  }

  private async scanCandidates(userId: string, cycleId: string, authorize: () => boolean) {
    const details: Evidence = { policyVersion: SOLANA_PAPER_POLICY_VERSION, discoveredPools: 0, requestedPools: 0, refreshedPools: 0, refreshErrors: 0, lastError: null };
    this.store.recordScanDetails(userId, cycleId, details);
    this.progress(userId, cycleId, "scanner", "Hledám nové pooly a připravuji obnovu těch sledovaných.", authorize);
    let discovered: SolanaCandidate[] = [];
    let discoveryError: string | null = null;
    try { discovered = (await this.provider.scan()).slice(0, 60); }
    catch (error) { discoveryError = error instanceof Error ? error.message : "Nové pooly nejsou dostupné."; }
    this.assertAuthorized(authorize, userId, cycleId);
    this.watchlist.remember(userId, discovered, this.now());
    const due = this.provider.refreshPools ? this.watchlist.due(userId, this.now(), discovered.map((candidate) => candidate.poolAddress), 20) : [];
    const requested = due.map((pool) => pool.poolAddress);
    let refreshed: SolanaCandidate[] = [];
    let refreshError: string | null = null;
    details.discoveredPools = discovered.length;
    details.requestedPools = requested.length;
    this.store.recordScanDetails(userId, cycleId, details);
    if (requested.length) {
      this.progress(userId, cycleId, "scanner", `Obnovuji čerstvá data ${requested.length} sledovaných poolů.`, authorize);
      try {
        const received = await this.provider.refreshPools!(requested);
        this.assertAuthorized(authorize, userId, cycleId);
        refreshed = this.watchlist.refreshed(userId, requested, received, this.now()).map((candidate) => ({ ...candidate, evidence: { ...candidate.evidence, discovery: "watched_pool_refresh" } }));
        if (refreshed.length < requested.length) refreshError = `U ${requested.length - refreshed.length} sledovaných poolů chybí čerstvá ověřitelná data; v tomto kole se nepoužijí.`;
      } catch (error) {
        this.assertAuthorized(authorize, userId, cycleId);
        this.watchlist.refreshed(userId, requested, [], this.now());
        refreshError = error instanceof Error ? error.message : "Sledované pooly se nepodařilo obnovit.";
      }
    }
    details.refreshedPools = refreshed.length;
    details.refreshErrors = requested.length - refreshed.length;
    details.lastError = [discoveryError, refreshError].filter(Boolean).join(" ") || null;
    this.store.recordScanDetails(userId, cycleId, details);
    if (details.lastError) this.event(userId, cycleId, "scanner", "error", null, String(details.lastError), { scan: details }, authorize);
    if (!discovered.length && !refreshed.length && (discoveryError || refreshError)) throw new Error(discoveryError || refreshError!);
    const byMint = new Map<string, SolanaCandidate>();
    for (const candidate of [...discovered, ...refreshed]) {
      const previous = byMint.get(candidate.mint);
      const eligible = candidateRejection(candidate, this.now()) === null;
      const previousEligible = previous && candidateRejection(previous, this.now()) === null;
      if (!previous || (eligible && !previousEligible) || (eligible === Boolean(previousEligible) && previous.liquidityUsd < candidate.liquidityUsd)) byMint.set(candidate.mint, candidate);
    }
    return [...byMint.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 80);
  }

  async cycle(userId: string, authorize: () => boolean, closePositionId?: string, options: { allowEntry?: () => boolean } = {}) {
    if (!authorize()) throw new Error("Přístup už není platný.");
    const cycleId = this.store.acquire(userId, this.now());
    try {
      const positions = this.store.positions(userId);
      if (closePositionId) {
        const position = positions.find((item) => item.id === closePositionId);
        if (!position) throw new Error("Otevřená PAPER pozice nebyla nalezena.");
        if (!await this.refreshPosition(userId, cycleId, position, authorize, true)) throw new Error("PAPER pozici se nepodařilo uzavřít; zůstává otevřená.");
      } else {
        for (const position of positions) await this.refreshPosition(userId, cycleId, position, authorize, false);
        const candidates = await this.scanCandidates(userId, cycleId, authorize);
        this.assertAuthorized(authorize, userId, cycleId);
        const selectionTime = this.now();
        const summaries: SolanaCandidateSummary[] = candidates.map((candidate) => {
          const reasons = candidateRejections(candidate, selectionTime);
          if (this.store.everTraded(userId, candidate.mint)) reasons.push("Token už byl v pilotu obchodovaný; opakovaný vstup je zakázaný.");
          return { mint: candidate.mint, symbol: candidate.symbol, liquidityUsd: candidate.liquidityUsd, volume5mUsd: candidate.volume5mUsd, observedAt: candidate.observedAt, source: candidate.evidence.discovery === "watched_pool_refresh" ? "watchlist" : "discovery", status: reasons.length ? "blocked" : "eligible", reason: reasons[0] ?? "Základní limity poolu splněné; čeká na rizikový předvýběr.", reasons };
        });
        const updateCandidate = (mint: string, status: SolanaCandidateSummary["status"], reason: string | string[]) => {
          this.assertAuthorized(authorize, userId, cycleId);
          const item = summaries.find((candidate) => candidate.mint === mint);
          if (item) { item.status = status; item.reason = typeof reason === "string" ? reason : reason[0] ?? "Kontroly prošly."; item.reasons = status === "blocked" ? typeof reason === "string" ? [reason] : reason : []; }
          this.store.recordCandidates(userId, cycleId, summaries);
        };
        const paused = (candidate: SolanaCandidate, stage: SolanaStage["id"]) => {
          if (!options.allowEntry || options.allowEntry()) return false;
          const reason = "Automat byl pozastaven; nový PAPER vstup byl zastavený.";
          updateCandidate(candidate.mint, "blocked", reason);
          this.event(userId, cycleId, stage, "blocked", candidate.mint, reason, {}, authorize);
          return true;
        };
        this.store.recordCandidates(userId, cycleId, summaries);
        const lastRiskChecks = this.store.lastRiskChecks(userId);
        const eligible = candidates.filter((candidate) => candidateRejection(candidate, selectionTime) === null && !this.store.everTraded(userId, candidate.mint))
          .sort((a, b) => (lastRiskChecks.get(a.mint) ?? 0) - (lastRiskChecks.get(b.mint) ?? 0) || b.liquidityUsd - a.liquidityUsd || a.mint.localeCompare(b.mint));
        // Rotate the bounded risk budget so permanently rejected popular tokens cannot starve the watchlist.
        const selectedMints = new Set<string>();
        const selected = [...eligible, ...candidates].filter((candidate) => {
          if (selectedMints.has(candidate.mint)) return false;
          selectedMints.add(candidate.mint);
          return true;
        }).slice(0, 5);
        this.event(userId, cycleId, "scanner", "ok", null, `Scanner vyhodnocuje ${candidates.length} různých tokenů z nových i sledovaných poolů. Rizikové kontroly mají rozpočet nejvýše 5 kandidátů.`, { source: "discovery_and_refreshed_watchlist", policyVersion: SOLANA_PAPER_POLICY_VERSION, candidateCount: candidates.length, eligiblePoolCount: eligible.length, selectedCount: selected.length, scan: this.store.scanDetails(userId) }, authorize);
        for (const candidate of summaries.slice(0, 20)) this.event(userId, cycleId, "scanner", candidate.status === "blocked" ? "blocked" : "ok", candidate.mint, `${candidate.symbol}: ${candidate.reason}`, { candidate, discovery: true }, authorize);
        const seen = new Set<string>();
        for (const candidate of selected) {
          this.assertAuthorized(authorize, userId, cycleId);
          if (options.allowEntry && !options.allowEntry()) {
            this.event(userId, cycleId, "scanner", "blocked", null, "Automat byl pozastaven; další kontroly a nové vstupy v tomto cyklu byly zastavené.", {}, authorize);
            break;
          }
          if (seen.has(candidate.mint) || this.store.everTraded(userId, candidate.mint)) {
            this.event(userId, cycleId, "scanner", "blocked", candidate.mint, "Token už byl zpracovaný nebo v pilotu obchodovaný; opakovaný vstup je zakázaný.", {}, authorize);
            continue;
          }
          seen.add(candidate.mint);
          const rejections = candidateRejections(candidate, this.now());
          if (rejections.length) { updateCandidate(candidate.mint, "blocked", rejections); this.event(userId, cycleId, "scanner", "blocked", candidate.mint, rejections.join(" "), { candidate, rejections }, authorize); continue; }
          let currentStage: SolanaStage["id"] = "rug-check";
          const partialEvidence: Evidence = { candidate };
          try {
            updateCandidate(candidate.mint, "checking", "Načítám skutečný RugCheck report.");
            this.progress(userId, cycleId, "rug-check", `Prověřuji oprávnění, držitele a likviditu ${candidate.symbol}.`, authorize, candidate);
            this.store.recordRiskCheck(userId, cycleId);
            const risk = await this.provider.risk(candidate.mint);
            this.assertAuthorized(authorize, userId, cycleId);
            partialEvidence.risk = risk;
            const rejected = [...candidateRejections(candidate, this.now()), ...riskRejections(risk, candidate.mint, this.now())];
            this.event(userId, cycleId, "rug-check", rejected.length ? "blocked" : "ok", candidate.mint, rejected.length ? rejected.join(" ") : "Dostupné rizikové kontroly prošly; nejde o záruku bezpečnosti tokenu.", { candidate, risk, rejections: rejected }, authorize);
            updateCandidate(candidate.mint, rejected.length ? "blocked" : "passed", rejected.length ? rejected : "Rizikové kontroly prošly; čeká na velikost a obousměrnou kotaci.");
            if (rejected.length) continue;
            if (paused(candidate, "rug-check")) break;
            currentStage = "sizer";
            const open = this.store.positions(userId);
            const account = this.store.account(userId);
            const exposure = open.reduce((sum, position) => sum + position.cost_micros, 0);
            const size = Math.min(5_000_000, 15_000_000 - exposure, account.cash_micros - NETWORK_FEE_MICROS);
            const dailyBraked = this.store.dailyBraked(userId, this.now());
            if (open.length >= 3 || size < 1_000_000 || open.some((position) => position.mark_error || position.mark_micros === null || position.marked_at === null || this.now() - position.marked_at > 60_000) || dailyBraked) {
              const reason = dailyBraked ? "Brzda za posledních 24 hodin: součet realizovaných ztrát dosáhl 5 USDC nebo proběhlo 10 vstupů. Nový vstup je blokovaný." : "Limit pozic, expozice, hotovosti nebo neoceněná pozice blokuje další vstup.";
              updateCandidate(candidate.mint, "blocked", reason);
              this.event(userId, cycleId, "sizer", "blocked", candidate.mint, reason, { openPositions: open.length, exposureMicros: exposure, cashMicros: account.cash_micros, dailyBraked, maxDailyLossUsdc: 5, maxDailyEntries: 10 }, authorize); continue;
            }
            this.event(userId, cycleId, "sizer", "ok", candidate.mint, `PAPER velikost ${money(size).toFixed(2)} USDC v pevných limitech.`, { sizeMicros: size }, authorize);
            currentStage = "executor";
            this.progress(userId, cycleId, "executor", `Načítám nákupní kotaci ${candidate.symbol} za ${money(size).toFixed(2)} USDC.`, authorize, candidate);
            const buy = await this.provider.quote(SOLANA_USDC_MINT, candidate.mint, String(size));
            this.assertAuthorized(authorize, userId, cycleId);
            if (paused(candidate, "executor")) break;
            partialEvidence.buyQuote = buy;
            const amount = conservativeQuoteAmount(buy, SOLANA_USDC_MINT, candidate.mint, String(size), this.now()).toString();
            this.progress(userId, cycleId, "executor", `Ověřuji zpětnou prodejní kotaci ${candidate.symbol}; zatím bez PAPER nákupu.`, authorize, candidate);
            const sell = await this.provider.quote(candidate.mint, SOLANA_USDC_MINT, amount);
            this.assertAuthorized(authorize, userId, cycleId);
            if (paused(candidate, "executor")) break;
            partialEvidence.reverseQuote = sell;
            const now = this.now();
            const freshRejection = candidateRejection(candidate, now) ?? riskRejection(risk, candidate.mint, now);
            if (freshRejection) throw new Error(freshRejection);
            conservativeQuoteAmount(buy, SOLANA_USDC_MINT, candidate.mint, String(size), now);
            const markMicros = usdcMicros(conservativeQuoteAmount(sell, candidate.mint, SOLANA_USDC_MINT, amount, now));
            if (markMicros - NETWORK_FEE_MICROS < size * 0.9) throw new Error("Okamžitý zpětný prodej ztrácí přes 10 %; vstup byl odmítnut.");
            this.assertAuthorized(authorize, userId, cycleId);
            const bought = this.store.buy({ userId, cycleId, mint: candidate.mint, symbol: candidate.symbol, amount, costMicros: size, markMicros, buyQuote: buy, sellQuote: sell, now, authorize, allowEntry: options.allowEntry });
            updateCandidate(candidate.mint, bought ? "bought" : "blocked", bought ? "PAPER nákup zapsaný podle ověřené obousměrné kotace." : "Nový vstup zastavil změněný stav nebo pozastavení automatu.");
            if (!bought) this.event(userId, cycleId, "sizer", "blocked", candidate.mint, "Před vstupem se změnil limit, ocenění nebo stav účtu; nákup byl odmítnut.", {}, authorize);
          } catch (error) {
            updateCandidate(candidate.mint, "blocked", error instanceof Error ? error.message : "Data nebo obousměrná kotace nejsou dostupné.");
            this.event(userId, cycleId, currentStage, "blocked", candidate.mint, error instanceof Error ? error.message : "Data nebo obousměrná kotace nejsou dostupné.", partialEvidence, authorize);
          }
        }
      }
      this.event(userId, cycleId, "logger", "ok", null, "Rozhodnutí a případné PAPER obchody byly uloženy odděleně od Binance.", { cycleId }, authorize);
      const unpriced = this.store.positions(userId).some((position) => position.mark_error || position.mark_micros === null || position.marked_at === null || this.now() - position.marked_at > 60_000);
      this.event(userId, cycleId, "equity", unpriced ? "error" : "ok", null, unpriced ? "Celkovou equity nelze určit: alespoň jedna pozice nemá čerstvou prodejní kotaci." : "Equity vychází z virtuální hotovosti a konzervativních prodejních kotací.", {}, authorize);
      this.store.finish(userId, cycleId, this.now());
      this.runtimes.set(userId, { ...this.runtime(userId), running: false, updatedAt: iso(this.now()) });
      return this.snapshot(userId);
    } catch (error) {
      if (authorize() && this.store.ownsLease(userId, cycleId, this.now())) this.store.event(userId, cycleId, closePositionId ? "executor" : "scanner", "error", null, error instanceof Error ? error.message : "Cyklus se nepodařilo dokončit.", {}, this.now());
      this.store.finish(userId, cycleId, this.now(), true);
      this.runtimes.set(userId, { ...this.runtime(userId), running: false, updatedAt: iso(this.now()) });
      throw error;
    }
  }
}
