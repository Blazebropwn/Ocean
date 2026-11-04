import type { Evidence, SolanaCandidate, SolanaMarketProvider, SolanaQuote, SolanaRiskReport } from "./types.js";
import { SOLANA_USDC_MINT } from "./types.js";
import { computeHolderConcentration } from "./holders.js";
import { parseRetryAfter, SolanaProviderCadence, SolanaProviderRateLimitError, type ProviderCadencePersistence } from "./provider-cadence.js";

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const MAX_BODY_BYTES = 2_000_000;
const MAX_RAW = (1n << 64n) - 1n;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Public new-pool pagination is bounded to pages 1..10. Fetch one rotating page
// per scan so discovery leaves request capacity for refreshing watched pools.
// The page is a bounded sample, not complete coverage of all new pools.
// https://api.geckoterminal.com/docs/index.html
const NEW_POOL_PAGES = [1, 5, 10] as const;
type ObjectValue = Record<string, unknown>;

/** Public Solana addresses are 32 bytes, not merely strings of base58 characters. */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  let decoded = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (decoded > 0n) { decoded >>= 8n; bytes += 1; }
  const zeros = value.match(/^1*/)?.[0].length ?? 0;
  return bytes + zeros === 32;
}

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonnegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function percent(value: unknown): number | null {
  const number = nonnegative(value);
  return number !== null && number <= 100 ? number : null;
}

function text(value: unknown, length = 80): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, length) : null;
}

function rawAmount(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) return false;
  return BigInt(value) <= MAX_RAW;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function authorityRevoked(token: ObjectValue | null, report: ObjectValue, key: string): boolean | null {
  if (!token || !Object.hasOwn(token, key)) return null;
  const authority = token[key];
  if (authority !== null && !isSolanaAddress(authority)) return null;
  if (Object.hasOwn(report, key) && report[key] !== authority) return null;
  return authority === null;
}

export class SolanaProviderError extends Error {
  constructor(provider: string, reason: string) {
    super(`${provider}: ${reason}`);
    this.name = "SolanaProviderError";
  }
}

type ProviderOptions = {
  jupiterApiKey?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  jupiterIntervalMs?: number;
  geckoIntervalMs?: number;
  geckoPersistence?: ProviderCadencePersistence;
  timeoutMs?: number;
};

/** Fixed public market endpoints and read-only account RPC. No wallet or transaction submission. */
export class PublicSolanaMarketProvider implements SolanaMarketProvider {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly intervalMs: number;
  private jupiterQueue: Promise<void> = Promise.resolve();
  private nextJupiterAt = 0;
  private readonly geckoCadence: SolanaProviderCadence;
  private scanQueue: Promise<void> = Promise.resolve();
  private nextPoolPageIndex = 0;

  constructor(private readonly options: ProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.intervalMs = options.jupiterIntervalMs ?? 2_100;
    this.geckoCadence = new SolanaProviderCadence({ now: () => this.now().getTime(), sleep: this.sleep, intervalMs: options.geckoIntervalMs, persistence: options.geckoPersistence });
  }

  marketDataStatus() {
    const { cooldownUntil } = this.geckoCadence.snapshot();
    return { provider: "GeckoTerminal", rateLimited: cooldownUntil !== null, retryAt: cooldownUntil === null ? null : new Date(cooldownUntil).toISOString() };
  }

  private async read(provider: string, url: string, extraHeaders: Record<string, string> = {}, rpcBody?: ObjectValue): Promise<{ body: ObjectValue; receivedAt: string; sourceDate: string | null }> {
    const request = () => this.readHttp(provider, url, extraHeaders, rpcBody);
    return provider === "GeckoTerminal" ? this.geckoCadence.run(request) : request();
  }

  private async readHttp(provider: string, url: string, extraHeaders: Record<string, string> = {}, rpcBody?: ObjectValue): Promise<{ body: ObjectValue; receivedAt: string; sourceDate: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8_000);
    timeout.unref();
    try {
      const response = await this.fetcher(url, {
        method: rpcBody ? "POST" : "GET", redirect: "error", signal: controller.signal,
        headers: { accept: provider === "GeckoTerminal" ? "application/json;version=20230203" : "application/json", "user-agent": "Ocean-Solana-Paper/1.0", ...(rpcBody ? { "content-type": "application/json" } : {}), ...extraHeaders },
        ...(rpcBody ? { body: JSON.stringify(rpcBody) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (provider === "GeckoTerminal" && response.status === 429) throw new SolanaProviderRateLimitError(provider, parseRetryAfter(response.headers.get("retry-after"), this.now().getTime()) ?? 0);
        throw new SolanaProviderError(provider, `HTTP ${response.status}`);
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) throw new SolanaProviderError(provider, "odpověď překročila limit");
      if (!response.body) throw new SolanaProviderError(provider, "prázdná odpověď");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) {
            await reader.cancel();
            throw new SolanaProviderError(provider, "odpověď překročila limit");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const parsed = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed) throw new SolanaProviderError(provider, "neplatný formát odpovědi");
      const date = response.headers.get("date");
      const dateMs = date ? Date.parse(date) : NaN;
      return { body: parsed, receivedAt: this.now().toISOString(), sourceDate: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null };
    } catch (error) {
      if (error instanceof SolanaProviderError || error instanceof SolanaProviderRateLimitError) throw error;
      // Do not expose provider bodies, URLs containing credentials, or network error internals.
      throw new SolanaProviderError(provider, controller.signal.aborted ? "vypršel časový limit" : "data nejsou dostupná nebo jsou neplatná");
    } finally { clearTimeout(timeout); }
  }

  async scan(): Promise<SolanaCandidate[]> {
    const previous = this.scanQueue;
    let release!: () => void;
    this.scanQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const page = NEW_POOL_PAGES[this.nextPoolPageIndex]!;
      const candidates = new Map<string, SolanaCandidate>();
      for (const candidate of await this.scanPage(page)) {
        if ((candidates.get(candidate.mint)?.liquidityUsd ?? -1) < candidate.liquidityUsd) candidates.set(candidate.mint, candidate);
      }
      // Advance only after a valid response, including a valid empty page. A 429,
      // transport error or invalid schema leaves the same page due for retry.
      this.nextPoolPageIndex = (this.nextPoolPageIndex + 1) % NEW_POOL_PAGES.length;
      return [...candidates.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 20);
    } finally { release(); }
  }

  private async scanPage(page: number): Promise<SolanaCandidate[]> {
    const { body, receivedAt, sourceDate } = await this.read("GeckoTerminal", `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token&page=${page}`);
    return this.decodePools(body, receivedAt, sourceDate, { discovery: "newly_indexed_pools_poll", page, sampledPages: [page], pageRotation: [...NEW_POOL_PAGES] }).slice(0, 20);
  }

  async refreshPools(poolAddresses: readonly string[]): Promise<SolanaCandidate[]> {
    if (poolAddresses.length === 0) return [];
    if (poolAddresses.length > 20 || poolAddresses.some((address) => !isSolanaAddress(address))) throw new SolanaProviderError("GeckoTerminal", "neplatný seznam sledovaných poolů");
    const addresses = [...new Set(poolAddresses)];
    const { body, receivedAt, sourceDate } = await this.read("GeckoTerminal", `https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/${addresses.join(",")}?include=base_token,quote_token`);
    // Missing addresses are intentionally absent; an old cached candidate is never a substitute.
    if (Array.isArray(body.data) && body.data.length === 0) return [];
    return this.decodePools(body, receivedAt, sourceDate, { discovery: "watched_pool_refresh" })
      .filter((candidate) => addresses.includes(candidate.poolAddress));
  }

  private decodePools(body: ObjectValue, receivedAt: string, sourceDate: string | null, provenance: Evidence): SolanaCandidate[] {
    if (sourceDate !== null && (Date.parse(receivedAt) - Date.parse(sourceDate) > 120_000 || Date.parse(sourceDate) - Date.parse(receivedAt) > 10_000)) throw new SolanaProviderError("GeckoTerminal", "zastaralá nebo časově nekonzistentní odpověď");
    if (!Array.isArray(body.data) || !Array.isArray(body.included) || body.data.length > 100 || body.included.length > 250) {
      throw new SolanaProviderError("GeckoTerminal", "neplatný seznam poolů");
    }
    const tokens = new Map(body.included.flatMap((value) => {
      const item = object(value);
      return item && item.type === "token" && typeof item.id === "string" ? [[item.id, object(item.attributes)] as const] : [];
    }));
    const candidates = new Map<string, SolanaCandidate>();
    for (const value of body.data) {
      const pool = object(value);
      const attributes = object(pool?.attributes);
      const relationships = object(pool?.relationships);
      const baseRelation = object(object(relationships?.base_token)?.data);
      const quoteRelation = object(object(relationships?.quote_token)?.data);
      const token = typeof baseRelation?.id === "string" ? tokens.get(baseRelation.id) : null;
      const mint = token?.address;
      const quoteMint = typeof quoteRelation?.id === "string" ? quoteRelation.id.replace(/^solana_/, "") : null;
      const decimals = token?.decimals;
      const createdAt = timestamp(attributes?.pool_created_at);
      const liquidity = nonnegative(attributes?.reserve_in_usd);
      const volume = nonnegative(object(attributes?.volume_usd)?.m5);
      if (pool?.type !== "pool" || !attributes || !isSolanaAddress(mint) || !isSolanaAddress(attributes.address)
        || !isSolanaAddress(quoteMint) || baseRelation?.id !== `solana_${mint}` || pool.id !== `solana_${attributes.address}`
        || mint === WRAPPED_SOL || mint === SOLANA_USDC_MINT
        || !Number.isInteger(decimals) || Number(decimals) < 0 || Number(decimals) > 18
        || createdAt === null || Date.parse(createdAt) > Date.parse(receivedAt) + 60_000
        || liquidity === null || volume === null) continue;
      const candidate: SolanaCandidate = {
        mint, poolAddress: attributes.address, symbol: text(token?.symbol, 24) ?? mint.slice(0, 8),
        name: text(token?.name, 100) ?? mint, decimals: Number(decimals), poolCreatedAt: createdAt,
        observedAt: receivedAt, liquidityUsd: liquidity, volume5mUsd: volume,
        evidence: { provider: "geckoterminal", ...provenance, receivedAt, sourceDate,
          poolCreatedAt: createdAt, quoteMint, reserveUsd: attributes.reserve_in_usd,
          volume5mUsd: object(attributes.volume_usd)?.m5, transactions5m: object(object(attributes.transactions)?.m5),
          dex: text(object(object(relationships?.dex)?.data)?.id, 60) },
      };
      if ((candidates.get(candidate.poolAddress)?.liquidityUsd ?? -1) < liquidity) candidates.set(candidate.poolAddress, candidate);
    }
    // A nonempty but entirely unrecognisable schema is an error, not an empty successful scan.
    if (body.data.length > 0 && candidates.size === 0) throw new SolanaProviderError("GeckoTerminal", "žádný pool nemá úplná ověřitelná data");
    return [...candidates.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  }

  async risk(mint: string): Promise<SolanaRiskReport> {
    if (!isSolanaAddress(mint)) throw new SolanaProviderError("RugCheck", "neplatný mint");
    const { body, receivedAt, sourceDate } = await this.read("RugCheck", `https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    if (body.mint !== mint) throw new SolanaProviderError("RugCheck", "report neodpovídá mintu");
    const token = object(body.token);
    const holders = await computeHolderConcentration(body, mint, async (addresses) => {
      if (!addresses.length || addresses.length > 40 || addresses.some((address) => !isSolanaAddress(address))) throw new SolanaProviderError("Solana RPC", "neplatný seznam účtů");
      const { body: rpc } = await this.read("Solana RPC", "https://api.mainnet-beta.solana.com", {}, {
        jsonrpc: "2.0", id: "ocean-holder-check", method: "getMultipleAccounts",
        params: [addresses, { encoding: "jsonParsed", commitment: "confirmed" }],
      });
      if (rpc.error || rpc.id !== "ocean-holder-check") throw new SolanaProviderError("Solana RPC", "účty nelze ověřit");
      return rpc.result;
    });
    const topHolderPct = holders.topHolderPct;
    const markets = Array.isArray(body.markets) && body.markets.length <= 100 ? body.markets.map(object) : [];
    const completeMarkets = markets.length > 0 && markets.every((market) => market !== null
      && isSolanaAddress(market.mintA) && isSolanaAddress(market.mintB));
    const relevantMarkets = markets.filter((market) => market && (market.mintA === mint || market.mintB === mint));
    const locks = relevantMarkets.map((market) => percent(object(market?.lp)?.lpLockedPct));
    const liquidityLockedPct = completeMarkets && locks.length > 0 && locks.every((value) => value !== null) ? Math.min(...locks as number[]) : null;
    const risks: SolanaRiskReport["risks"] = [];
    if (!Array.isArray(body.risks) || body.risks.length > 100) risks.push({ name: "Neúplný seznam rizik", level: "unknown" });
    else for (const value of body.risks) {
      const risk = object(value);
      const name = text(risk?.name, 120);
      const level = text(risk?.level, 20)?.toLowerCase();
      risks.push({ name: name ?? "Neznámé riziko", level: level === "warn" || level === "danger" || level === "info" ? level : "unknown" });
    }
    if (body.rugged === true) risks.push({ name: "RugCheck označuje token jako rugged", level: "danger" });
    if (typeof body.rugged !== "boolean") risks.push({ name: "Chybí stav rugged", level: "unknown" });
    return {
      mint, observedAt: receivedAt, mintAuthorityRevoked: authorityRevoked(token, body, "mintAuthority"),
      freezeAuthorityRevoked: authorityRevoked(token, body, "freezeAuthority"),
      tokenProgram: isSolanaAddress(body.tokenProgram) ? body.tokenProgram : null,
      topHolderPct, liquidityLockedPct, risks,
      evidence: { provider: "rugcheck", receivedAt, sourceDate, tokenDetectedAt: timestamp(body.detectedAt),
        mintAuthority: token && Object.hasOwn(token, "mintAuthority") ? token.mintAuthority : "missing",
        freezeAuthority: token && Object.hasOwn(token, "freezeAuthority") ? token.freezeAuthority : "missing",
        tokenDecimals: nonnegative(token?.decimals), tokenProgram: text(body.tokenProgram),
        rugged: typeof body.rugged === "boolean" ? body.rugged : null,
        totalMarketLiquidity: nonnegative(body.totalMarketLiquidity), topHolderPct, liquidityLockedPct,
        holderConcentration: holders.evidence,
        concentrationMethod: "max_reported_holder_excluding_chain_verified_pumpswap_vaults", lockMethod: "minimum_reported_lock_across_token_markets",
        risks, marketCount: relevantMarkets.length, reportIsSafetyGuarantee: false },
    };
  }

  async quote(inputMint: string, outputMint: string, amount: string): Promise<SolanaQuote> {
    if (!isSolanaAddress(inputMint) || !isSolanaAddress(outputMint) || inputMint === outputMint || !rawAmount(amount)) {
      throw new SolanaProviderError("Jupiter", "neplatný požadavek na cenovou nabídku");
    }
    const previous = this.jupiterQueue;
    let release!: () => void;
    this.jupiterQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const wait = this.nextJupiterAt - this.now().getTime();
      if (wait > 0) await this.sleep(wait);
      this.nextJupiterAt = this.now().getTime() + this.intervalMs;
      const startedAt = this.now().toISOString();
      const params = new URLSearchParams({ inputMint, outputMint, amount });
      const headers: Record<string, string> = this.options.jupiterApiKey ? { "x-api-key": this.options.jupiterApiKey } : {};
      const { body, receivedAt, sourceDate } = await this.read("Jupiter", `https://api.jup.ag/swap/v2/order?${params}`, headers);
      if (sourceDate !== null && (Date.parse(receivedAt) - Date.parse(sourceDate) > 30_000 || Date.parse(sourceDate) - Date.parse(receivedAt) > 10_000)) {
        throw new SolanaProviderError("Jupiter", "zastaralá nebo časově nekonzistentní odpověď");
      }
      const impact = finite(body.priceImpactPct);
      const fee = nonnegative(body.feeBps);
      const route = text(body.router, 40);
      const routes = Array.isArray(body.routePlan) && body.routePlan.length > 0 && body.routePlan.length <= 30
        ? body.routePlan.map((step) => text(object(object(step)?.swapInfo)?.label, 60)) : [];
      if (body.inputMint !== inputMint || body.outputMint !== outputMint || body.inAmount !== amount
        || body.swapMode !== "ExactIn" || body.errorCode !== undefined || body.errorMessage !== undefined
        || body.error !== undefined || body.transaction !== null || (body.taker !== null && body.taker !== undefined)
        || !rawAmount(body.outAmount) || !rawAmount(body.otherAmountThreshold)
        || BigInt(body.otherAmountThreshold) > BigInt(body.outAmount)
        || impact === null || impact < -1 || impact > 1 || fee === null || !Number.isInteger(fee) || fee > 10_000
        || (body.feeMint !== inputMint && body.feeMint !== outputMint)
        || !route || routes.length === 0 || routes.some((label) => label === null)) {
        throw new SolanaProviderError("Jupiter", "neúplná nebo neproveditelná cenová nabídka");
      }
      // Missing chain fee fields cannot silently become zero. They remain explicit evidence.
      const chainFees: Evidence = {};
      for (const field of ["signatureFeeLamports", "prioritizationFeeLamports", "rentFeeLamports"] as const) {
        const value = nonnegative(body[field]);
        if (value === null || !Number.isSafeInteger(value)) throw new SolanaProviderError("Jupiter", "neznámé síťové poplatky");
        chainFees[field] = value;
      }
      const expiry = body.expireAt === undefined ? null : timestamp(body.expireAt);
      if ((body.expireAt !== undefined && expiry === null) || (expiry !== null && Date.parse(expiry) <= Date.parse(receivedAt))) {
        throw new SolanaProviderError("Jupiter", "cenová nabídka již není platná");
      }
      // /order has no provider quote timestamp. Use request start as a conservative age bound;
      // the HTTP Date is retained separately and is never advertised as chain observation time.
      return {
        inputMint, outputMint, inAmount: amount, outAmount: body.outAmount, minOutAmount: body.otherAmountThreshold,
        quotedAt: startedAt, expiresAt: expiry, priceImpactBps: Math.abs(impact) * 10_000,
        feeBps: fee, feeMint: body.feeMint, route: `${route}: ${routes.join(", ")}`,
        evidence: { provider: "jupiter", quoteOnly: true, takerProvided: false, startedAt, receivedAt, sourceDate,
          requestId: text(body.requestId, 100), priceImpactPct: body.priceImpactPct, feeBps: fee,
          feeMint: body.feeMint, feesIncludedInQuote: true,
          platformFeeBps: nonnegative(object(body.platformFee)?.feeBps), ...chainFees,
          lastValidBlockHeight: nonnegative(body.lastValidBlockHeight), expiry,
          noTransactionRequested: true, executionGuaranteed: false },
      };
    } finally { release(); }
  }
}
