import assert from "node:assert/strict";
import test from "node:test";
import { isSolanaAddress, PublicSolanaMarketProvider } from "../src/solana/providers.js";
import { SOLANA_TOKEN_PROGRAM, SOLANA_USDC_MINT } from "../src/solana/types.js";

const MINT = "vUG3bCjNo3Zf9mPBxU8RJTgjK3ut654QKz4ntvipump";
const POOL = "Fzf5x26QwDpu62w2Js3XTZaDHRzdWB5CRYDt3AKXoaqv";
const SOL = "So11111111111111111111111111111111111111112";
const NOW = "2026-11-04T11:00:00.000Z";

// Shapes follow the providers' public GET responses, fetched 2026-11-04. Amounts
// and identity are ordinary public market data; no wallet or credentials are used.
function poolFixture() {
  return {
    data: [{ id: `solana_${POOL}`, type: "pool", attributes: {
      address: POOL, name: "AMAZON / SOL", pool_created_at: "2026-11-04T10:53:16Z",
      reserve_in_usd: "29023.8473", volume_usd: { m5: "1225.55" },
      transactions: { m5: { buys: 12, sells: 3 } },
    }, relationships: {
      base_token: { data: { id: `solana_${MINT}`, type: "token" } },
      quote_token: { data: { id: `solana_${SOL}`, type: "token" } },
      dex: { data: { id: "pumpswap", type: "dex" } },
    } }],
    included: [{ id: `solana_${MINT}`, type: "token", attributes: {
      address: MINT, name: "Amazon.com, Inc.", symbol: "AMAZON", decimals: 6,
    } }],
  };
}

function riskFixture() {
  return {
    mint: MINT, tokenProgram: SOLANA_TOKEN_PROGRAM,
    token: { mintAuthority: null as unknown, freezeAuthority: null as unknown, decimals: 6, isInitialized: true },
    mintAuthority: null as unknown, freezeAuthority: null as unknown,
    topHolders: [{ pct: 10.461625068842265 }, { pct: 0.03975161181948622 }],
    markets: [{ mintA: MINT, mintB: SOL, lp: { lpLockedPct: 100 } }],
    risks: [{ name: "High holder correlation", level: "warn" }],
    rugged: false, totalMarketLiquidity: 29629.70076171306,
    detectedAt: "2026-11-04T10:53:16.01162658Z",
  };
}

function quoteFixture() {
  return {
    inputMint: SOLANA_USDC_MINT, outputMint: MINT,
    inAmount: "5000000", outAmount: "53504691", otherAmountThreshold: "52969644",
    swapMode: "ExactIn", slippageBps: 100,
    priceImpactPct: "0.00008132766687465318", priceImpact: 0.008132766687465319,
    routePlan: [{ percent: 100, bps: 10000, swapInfo: { label: "JupiterZ", inputMint: SOLANA_USDC_MINT, outputMint: MINT } }],
    feeMint: SOLANA_USDC_MINT, feeBps: 50, transaction: null as unknown,
    signatureFeeLamports: 0, prioritizationFeeLamports: 0, rentFeeLamports: 0,
    requestId: "public-fixture-request-id", router: "jupiterz", taker: null,
    platformFee: { feeBps: 50, feeMint: SOLANA_USDC_MINT },
  };
}

function provider(body: unknown, extra: Partial<ConstructorParameters<typeof PublicSolanaMarketProvider>[0]> = {}) {
  return new PublicSolanaMarketProvider({ now: () => new Date(NOW), jupiterIntervalMs: 0,
    fetcher: async () => new Response(JSON.stringify(body), { headers: { date: new Date(NOW).toUTCString() } }), ...extra });
}

test("Solana address validation requires base58 representing exactly 32 bytes", () => {
  assert.equal(isSolanaAddress(MINT), true);
  assert.equal(isSolanaAddress(SOLANA_USDC_MINT), true);
  assert.equal(isSolanaAddress("1".repeat(32)), true);
  for (const bad of ["", "1".repeat(33), "0".repeat(44), "z".repeat(44), `${MINT}/report`, null]) {
    assert.equal(isSolanaAddress(bad), false);
  }
});

test("new pool polling normalizes actual metadata and preserves indexed-pool provenance", async () => {
  const requestedUrls: string[] = [];
  const market = provider(poolFixture(), { fetcher: async (url, init) => {
    requestedUrls.push(String(url));
    assert.equal(init?.method, "GET");
    return Response.json(poolFixture());
  } });
  const [candidate] = await market.scan();
  assert.deepEqual(requestedUrls, [1, 5, 10].map((page) => `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token&page=${page}`));
  assert.equal(candidate?.mint, MINT);
  assert.equal(candidate?.decimals, 6);
  assert.equal(candidate?.liquidityUsd, 29023.8473);
  assert.equal(candidate?.volume5mUsd, 1225.55);
  assert.equal(candidate?.poolCreatedAt, "2026-11-04T10:53:16.000Z");
  assert.equal(candidate?.evidence.discovery, "newly_indexed_pools_poll");
  assert.deepEqual(candidate?.evidence.sampledPages, [1, 5, 10]);
});

test("scanner samples three bounded pages, deduplicates mints and keeps the highest-liquidity pool", async () => {
  const otherMint = "9gipZT8Ewp4AjDo6CxW8THTobJJ5X2KuStWndxzNuv6Y";
  const market = provider({}, { fetcher: async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    const fixture = poolFixture();
    fixture.data[0]!.attributes.reserve_in_usd = String(page * 10_000);
    if (page === 5) {
      fixture.data[0]!.relationships.base_token.data.id = `solana_${otherMint}`;
      fixture.included[0]!.id = `solana_${otherMint}`;
      fixture.included[0]!.attributes.address = otherMint;
    }
    return Response.json(fixture);
  } });
  const candidates = await market.scan();
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.mint, MINT);
  assert.equal(candidates[0]?.liquidityUsd, 100_000);
  assert.equal(candidates[0]?.evidence.page, 10);
  assert.equal(candidates[1]?.mint, otherMint);
});

test("a failed later pool page does not silently return a successful partial scan", async () => {
  const requestedPages: number[] = [];
  const market = provider({}, { fetcher: async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    requestedPages.push(page);
    return page === 5 ? new Response("provider unavailable", { status: 503 }) : Response.json(poolFixture());
  } });
  await assert.rejects(market.scan(), /HTTP 503/);
  assert.deepEqual(requestedPages, [1, 5]);
});

test("scanner rejects absent decimals, invalid mint binding, missing liquidity and future pools", async () => {
  const fixtures = [poolFixture(), poolFixture(), poolFixture(), poolFixture()];
  fixtures[0]!.included[0]!.attributes.decimals = NaN;
  fixtures[1]!.included[0]!.attributes.address = SOLANA_USDC_MINT;
  fixtures[2]!.data[0]!.attributes.reserve_in_usd = "NaN";
  fixtures[3]!.data[0]!.attributes.pool_created_at = "2026-12-01T00:00:00Z";
  for (const fixture of fixtures) await assert.rejects(provider(fixture).scan(), /žádný pool/);
  await assert.rejects(provider({ data: [], included: undefined }).scan(), /neplatný seznam/);
});

test("risk checks explicit nested revocation with conservative holder and lock metrics", async () => {
  const report = await provider(riskFixture()).risk(MINT);
  assert.equal(report.mintAuthorityRevoked, true);
  assert.equal(report.freezeAuthorityRevoked, true);
  assert.equal(report.topHolderPct, 10.461625068842265);
  assert.equal(report.liquidityLockedPct, 100);
  assert.equal(report.observedAt, NOW);
  assert.equal(report.evidence.tokenDetectedAt, "2026-11-04T10:53:16.011Z");
  assert.equal(report.evidence.reportIsSafetyGuarantee, false);
  assert.deepEqual(report.risks, [{ name: "High holder correlation", level: "warn" }]);
});

test("missing, malformed or contradictory authorities never become revoked", async () => {
  for (const bad of [undefined, "", false, "invalid-authority"]) {
    const fixture = riskFixture();
    fixture.token.mintAuthority = bad;
    fixture.token.freezeAuthority = bad;
    const report = await provider(fixture).risk(MINT);
    assert.equal(report.mintAuthorityRevoked, null);
    assert.equal(report.freezeAuthorityRevoked, null);
  }
  const contradictory = riskFixture();
  contradictory.mintAuthority = MINT;
  assert.equal((await provider(contradictory).risk(MINT)).mintAuthorityRevoked, null);
  const active = riskFixture();
  active.token.mintAuthority = MINT;
  active.mintAuthority = MINT;
  assert.equal((await provider(active).risk(MINT)).mintAuthorityRevoked, false);
});

test("unknown holder, liquidity, risk state remains unknown; report identity is required", async () => {
  const fixture: Record<string, unknown> = riskFixture();
  fixture.topHolders = [{ pct: 3 }, { pct: null }];
  fixture.markets = [{ mintA: MINT, mintB: SOL, lp: {} }];
  delete fixture.risks;
  delete fixture.rugged;
  const report = await provider(fixture).risk(MINT);
  assert.equal(report.topHolderPct, null);
  assert.equal(report.liquidityLockedPct, null);
  assert.equal(report.risks.filter((risk) => risk.level === "unknown").length, 2);
  fixture.mint = SOL;
  await assert.rejects(provider(fixture).risk(MINT), /neodpovídá mintu/);
});

test("risk uses minimum reported pool lock and maximum holder including pools", async () => {
  const fixture = riskFixture();
  fixture.topHolders.push({ pct: 55 });
  fixture.markets.push({ mintA: MINT, mintB: SOL, lp: { lpLockedPct: 25 } });
  const report = await provider(fixture).risk(MINT);
  assert.equal(report.topHolderPct, 55);
  assert.equal(report.liquidityLockedPct, 25);
});

test("a malformed market cannot disappear behind a valid locked market", async () => {
  for (const malformed of [null, {}, { mintA: MINT }, { mintA: MINT, mintB: "invalid" }]) {
    const fixture: Record<string, unknown> = riskFixture();
    fixture.markets = [...riskFixture().markets, malformed];
    assert.equal((await provider(fixture).risk(MINT)).liquidityLockedPct, null);
  }
});

test("quote-only request never supplies a taker, signs, or calls execution endpoints", async () => {
  let calls = 0;
  const market = provider(quoteFixture(), { jupiterApiKey: "server-test-secret", fetcher: async (url, init) => {
    calls += 1;
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.jup.ag");
    assert.equal(parsed.pathname, "/swap/v2/order");
    assert.deepEqual([...parsed.searchParams.keys()], ["inputMint", "outputMint", "amount"]);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "server-test-secret");
    assert.equal(init?.body, undefined);
    return Response.json(quoteFixture());
  } });
  const quote = await market.quote(SOLANA_USDC_MINT, MINT, "5000000");
  assert.equal(calls, 1);
  assert.equal(quote.outAmount, "53504691");
  assert.equal(quote.minOutAmount, "52969644");
  assert.equal(quote.priceImpactBps, 0.8132766687465318);
  assert.equal(quote.feeBps, 50);
  assert.equal(quote.evidence.feesIncludedInQuote, true);
  assert.equal(quote.expiresAt, null);
  assert.equal(JSON.stringify(quote).includes("server-test-secret"), false);
  assert.equal(JSON.stringify(quote).includes('"transaction"'), false);
});

test("quotes reject unexpected errors, transactions, fees, routes, amount mismatches and malformed prices", async () => {
  const alterations: Record<string, unknown>[] = [
    { transaction: "unexpected-base64" }, { transaction: "" }, { errorCode: 3 }, { errorMessage: "provider message" },
    { outAmount: "0" }, { outAmount: "18446744073709551616" }, { outAmount: "1.2" }, { inAmount: "1" },
    { otherAmountThreshold: "53504692" }, { otherAmountThreshold: undefined }, { priceImpactPct: undefined },
    { priceImpactPct: "NaN" }, { priceImpactPct: "2" }, { feeBps: undefined }, { feeBps: -1 },
    { feeMint: SOL }, { routePlan: [] }, { rentFeeLamports: undefined }, { prioritizationFeeLamports: -5 },
    { expireAt: "2026-11-04T10:59:59Z" }, { expireAt: "not-a-time" },
  ];
  for (const alteration of alterations) {
    await assert.rejects(provider({ ...quoteFixture(), ...alteration }).quote(SOLANA_USDC_MINT, MINT, "5000000"), /Jupiter:/);
  }
});

test("quote input amounts reject zero, decimals, scientific notation, unsafe range and noncanonical leading zeros", async () => {
  let calls = 0;
  const market = provider({}, { fetcher: async () => { calls += 1; return Response.json({}); } });
  for (const amount of ["0", "1.2", "1e6", "01", "18446744073709551616", "-1"]) {
    await assert.rejects(market.quote(SOLANA_USDC_MINT, MINT, amount), /neplatný požadavek/);
  }
  assert.equal(calls, 0);
});

test("Jupiter keyless cadence serializes callers and a failed call releases the next", async () => {
  let time = Date.parse(NOW);
  let calls = 0;
  const waits: number[] = [];
  const market = new PublicSolanaMarketProvider({ now: () => new Date(time), sleep: async (ms) => { waits.push(ms); time += ms; },
    fetcher: async () => { calls += 1; return calls === 1 ? new Response("untrusted secret body", { status: 429 }) : Response.json(quoteFixture()); } });
  const results = await Promise.allSettled([
    market.quote(SOLANA_USDC_MINT, MINT, "5000000"), market.quote(SOLANA_USDC_MINT, MINT, "5000000"),
  ]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "fulfilled");
  assert.deepEqual(waits, [2100]);
});

test("quote age uses request start and known stale HTTP dates fail closed", async () => {
  let time = Date.parse(NOW);
  const market = provider({}, { now: () => new Date(time), fetcher: async () => {
    time += 12_000;
    return Response.json(quoteFixture(), { headers: { date: new Date(time).toUTCString() } });
  } });
  const quote = await market.quote(SOLANA_USDC_MINT, MINT, "5000000");
  assert.equal(quote.quotedAt, NOW);
  assert.equal(quote.evidence.receivedAt, "2026-11-04T11:00:12.000Z");
  for (const date of ["2026-11-04T10:59:29Z", "2026-11-04T11:00:11Z"]) {
    const stale = provider({}, { fetcher: async () => Response.json(quoteFixture(), { headers: { date: new Date(date).toUTCString() } }) });
    await assert.rejects(stale.quote(SOLANA_USDC_MINT, MINT, "5000000"), /časově nekonzistentní/);
  }
});

test("HTTP requests abort on timeout rather than hanging a paper cycle", async () => {
  const market = provider({}, { timeoutMs: 5, fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const fallback = setTimeout(() => reject(new Error("test timeout fallback")), 100);
    init?.signal?.addEventListener("abort", () => { clearTimeout(fallback); reject(new Error("aborted")); }, { once: true });
  }) });
  await assert.rejects(market.scan(), /vypršel časový limit/);
});

test("provider HTTP/network/malformed errors are sanitized and never silently become good data", async () => {
  const fetchers: (typeof fetch)[] = [
    async () => { throw new Error("transport with secret credentials"); },
    async () => new Response("secret body", { status: 503 }),
    async () => new Response("not-json-secret"),
    async () => Response.json({ data: [], included: [] }, { headers: { "content-length": "2000001" } }),
    async () => new Response(" ".repeat(2_000_001)),
  ];
  for (const fetcher of fetchers) {
    await assert.rejects(provider({}, { fetcher }).scan(), (error: unknown) => {
      assert.match(String(error), /GeckoTerminal:/);
      assert.equal(String(error).includes("secret"), false);
      return true;
    });
  }
});
