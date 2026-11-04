import assert from "node:assert/strict";
import test from "node:test";
import { computeHolderConcentration } from "../src/solana/holders.js";
import { SOLANA_TOKEN_PROGRAM } from "../src/solana/types.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const MINT = "vUG3bCjNo3Zf9mPBxU8RJTgjK3ut654QKz4ntvipump";
const QUOTE = "So11111111111111111111111111111111111111112";
const POOL = "GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J";
const VAULT = "5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa";
const OTHER_VAULT = "43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8";
const INVESTOR = "9gipZT8Ewp4AjDo6CxW8THTobJJ5X2KuStWndxzNuv6Y";
type Row = Record<string, unknown>;

function decode(address: string): Buffer {
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(BASE58.indexOf(char));
  const buffer = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { buffer[i] = Number(value & 255n); value >>= 8n; }
  return buffer;
}

function generatedAddress(index: number): string {
  const bytes = Buffer.alloc(32, 3);
  bytes.writeUInt32LE(index, 0);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let result = "";
  while (value > 0n) { result = BASE58[Number(value % 58n)]! + result; value /= 58n; }
  return "1".repeat(bytes.findIndex((value) => value !== 0)) + result;
}

function reportFixture(): Row {
  return { mint: MINT, topHolders: [{ address: VAULT, owner: POOL, pct: 55 }, { address: INVESTOR, owner: INVESTOR, pct: 9 }],
    // RugCheck's A/B order need not be the PumpSwap base/quote order.
    markets: [{ pubkey: POOL, mintA: QUOTE, mintB: MINT, liquidityA: OTHER_VAULT, liquidityB: VAULT }],
    knownAccounts: { [POOL]: { name: "AMM (PumpFunAMM)", type: "AMM" } } };
}

function vaultFixture(pool = POOL): Row {
  return { owner: SOLANA_TOKEN_PROGRAM, executable: false, data: { program: "spl-token", parsed: { type: "account",
    info: { mint: MINT, owner: pool, state: "initialized" } } } };
}

function poolFixture(vault = VAULT): Row {
  // PumpSwap IDL's stable Pool prefix, followed by older coin_creator field.
  const bytes = Buffer.alloc(243);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(bytes, 0);
  bytes[8] = 254;
  decode(INVESTOR).copy(bytes, 11);
  decode(MINT).copy(bytes, 43);
  decode(QUOTE).copy(bytes, 75);
  decode(INVESTOR).copy(bytes, 107);
  decode(vault).copy(bytes, 139);
  decode(OTHER_VAULT).copy(bytes, 171);
  return { owner: PROGRAM, executable: false, data: [bytes.toString("base64"), "base64"] };
}

function rpc(vault: unknown = vaultFixture(), pool: unknown = poolFixture()) {
  return async (addresses: string[]) => ({ context: { slot: 384_000_123 },
    value: addresses.map((address) => address === VAULT ? vault : address === POOL ? pool : null) });
}

test("verified PumpSwap reserve is excluded and remaining holder concentration is not rescaled", async () => {
  const result = await computeHolderConcentration(reportFixture(), MINT, rpc());
  assert.equal(result.topHolderPct, 9);
  assert.equal(result.evidence.maxReportedHolderPct, 55);
  assert.equal(result.evidence.reportedHolderCount, 2);
  assert.equal(result.evidence.includedHolderCount, 1);
  assert.deepEqual(result.evidence.holderWarnings, []);
  assert.deepEqual(result.evidence.excludedPoolVaults, [{ address: VAULT, owner: POOL, pct: 55, poolAddress: POOL,
    program: PROGRAM, verification: "onchain_spl_account_and_pumpswap_pool", slot: 384_000_123 }]);
});

test("verified quote-side reserves are bound to the quote mint and exact quote vault", async () => {
  const pool = poolFixture();
  const data = Buffer.from((pool.data as string[])[0]!, "base64");
  decode(QUOTE).copy(data, 43);
  decode(MINT).copy(data, 75);
  decode(OTHER_VAULT).copy(data, 139);
  decode(VAULT).copy(data, 171);
  pool.data = [data.toString("base64"), "base64"];
  assert.equal((await computeHolderConcentration(reportFixture(), MINT, rpc(vaultFixture(), pool))).topHolderPct, 9);
  decode(INVESTOR).copy(data, 171);
  pool.data = [data.toString("base64"), "base64"];
  assert.equal((await computeHolderConcentration(reportFixture(), MINT, rpc(vaultFixture(), pool))).topHolderPct, 55);
});

test("labels and anonymous percentages never justify excluding a holder or making an RPC call", async () => {
  for (const report of [
    { ...reportFixture(), markets: [] },
    { mint: MINT, topHolders: [{ pct: 55, insider: false }, { pct: 9 }], markets: [], knownAccounts: { whale: "AMM" } },
  ]) {
    const result = await computeHolderConcentration(report, MINT, async () => { assert.fail("No verifiable address pair"); });
    assert.equal(result.topHolderPct, 55);
    assert.deepEqual(result.evidence.excludedPoolVaults, []);
  }
});

test("forged, unsupported or inconsistent reserve evidence remains included", async () => {
  const variants: [string, Row, Row][] = [];
  const addVault = (name: string, mutate: (value: Row) => void) => { const vault = vaultFixture(); mutate(vault); variants.push([name, vault, poolFixture()]); };
  const addPool = (name: string, mutate: (value: Row) => void) => { const pool = poolFixture(); mutate(pool); variants.push([name, vaultFixture(), pool]); };
  addVault("wrong SPL owner", (vault) => { vault.owner = PROGRAM; });
  addVault("wrong parsed type", (vault) => { (vault.data as any).parsed.type = "mint"; });
  addVault("wrong mint", (vault) => { (vault.data as any).parsed.info.mint = QUOTE; });
  addVault("wrong authority", (vault) => { (vault.data as any).parsed.info.owner = INVESTOR; });
  addVault("delegated vault", (vault) => { (vault.data as any).parsed.info.delegate = INVESTOR; });
  addVault("frozen vault", (vault) => { (vault.data as any).parsed.info.state = "frozen"; });
  addPool("wrong pool program", (pool) => { pool.owner = INVESTOR; });
  addPool("executable pool", (pool) => { pool.executable = true; });
  addPool("wrong discriminator", (pool) => {
    const data = Buffer.from((pool.data as string[])[0]!, "base64"); data[0] = 0; pool.data = [data.toString("base64"), "base64"];
  });
  addPool("wrong base mint", (pool) => {
    const data = Buffer.from((pool.data as string[])[0]!, "base64"); decode(INVESTOR).copy(data, 43); pool.data = [data.toString("base64"), "base64"];
  });
  addPool("wrong quote mint", (pool) => {
    const data = Buffer.from((pool.data as string[])[0]!, "base64"); decode(INVESTOR).copy(data, 75); pool.data = [data.toString("base64"), "base64"];
  });
  addPool("wrong bound vault", (pool) => { pool.data = poolFixture(INVESTOR).data; });
  addPool("truncated pool", (pool) => { pool.data = [Buffer.alloc(203).toString("base64"), "base64"]; });
  addPool("invalid base64", (pool) => { pool.data = [`!${(pool.data as string[])[0]!}`, "base64"]; });
  for (const [name, vault, pool] of variants) {
    const result = await computeHolderConcentration(reportFixture(), MINT, rpc(vault, pool));
    assert.equal(result.topHolderPct, 55, name);
    assert.deepEqual(result.evidence.excludedPoolVaults, [], name);
  }
});

test("untrusted report pool metadata cannot substitute a different authority, mint or reserve", async () => {
  for (const mutate of [
    (report: Row) => { (report.topHolders as any[])[0].owner = INVESTOR; },
    (report: Row) => { (report.markets as any[])[0].liquidityB = INVESTOR; },
    (report: Row) => { (report.markets as any[])[0].mintA = INVESTOR; },
  ]) {
    const report = reportFixture(); mutate(report);
    const result = await computeHolderConcentration(report, MINT, rpc());
    assert.equal(result.topHolderPct, 55);
    assert.deepEqual(result.evidence.excludedPoolVaults, []);
  }
});

test("missing and malformed RPC results or transport failures retain reported concentration", async () => {
  const results = [null, {}, { value: [vaultFixture(), poolFixture()] },
    { context: { slot: 1 }, value: [] }, { context: { slot: -1 }, value: [vaultFixture(), poolFixture()] },
    { context: { slot: 1 }, value: [null, null] }];
  for (const response of results) {
    const result = await computeHolderConcentration(reportFixture(), MINT, async () => response);
    assert.equal(result.topHolderPct, 55);
    assert.deepEqual(result.evidence.excludedPoolVaults, []);
  }
  const result = await computeHolderConcentration(reportFixture(), MINT, async () => { throw new Error("private RPC URL or key"); });
  assert.equal(result.topHolderPct, 55);
  assert.deepEqual(result.evidence.holderWarnings, ["pool_verification_unavailable"]);
  assert.equal(JSON.stringify(result).includes("private RPC"), false);
});

test("all reported holders being verified reserves means investor concentration remains unknown", async () => {
  const report = reportFixture(); (report.topHolders as unknown[]).pop();
  const result = await computeHolderConcentration(report, MINT, rpc());
  assert.equal(result.topHolderPct, null);
  assert.equal((result.evidence.excludedPoolVaults as unknown[]).length, 1);
  assert.deepEqual(result.evidence.holderWarnings, ["no_non_reserve_holders_reported"]);
});

test("invalid holder percentages, addresses, duplicates and mint binding remain unknown", async () => {
  const invalid: Row[] = [
    { mint: QUOTE, topHolders: [{ pct: 5 }] }, { mint: MINT, topHolders: [] },
    { mint: MINT, topHolders: [{ pct: 5 }, { pct: null }] }, { mint: MINT, topHolders: [{ pct: 101 }] },
    { mint: MINT, topHolders: [{ pct: 5, address: "not-a-public-key" }] },
    { mint: MINT, topHolders: [{ pct: 5, address: VAULT }, { pct: 6, address: VAULT }] },
  ];
  for (const report of invalid) {
    const result = await computeHolderConcentration(report, MINT, async () => { assert.fail("Invalid reports must not query RPC"); });
    assert.equal(result.topHolderPct, null);
    assert.deepEqual(result.evidence.holderWarnings, ["invalid_holder_report"]);
  }
});

test("verification reads at most twenty pool/reserve pairs and forty account addresses", async () => {
  const report: Row = { mint: MINT, topHolders: [], markets: [] };
  for (let i = 0; i < 25; i++) {
    const vault = generatedAddress(i * 2 + 100);
    const pool = generatedAddress(i * 2 + 101);
    (report.topHolders as Row[]).push({ address: vault, owner: pool, pct: 25 - i });
    (report.markets as Row[]).push({ pubkey: pool, mintA: MINT, mintB: QUOTE, liquidityA: vault, liquidityB: OTHER_VAULT });
  }
  let calls = 0;
  const result = await computeHolderConcentration(report, MINT, async (addresses) => {
    calls++;
    assert.equal(addresses.length, 40);
    assert.equal(new Set(addresses).size, 40);
    return { context: { slot: 1 }, value: addresses.map(() => null) };
  });
  assert.equal(calls, 1);
  assert.equal(result.topHolderPct, 25);
  assert.ok((result.evidence.holderWarnings as string[]).includes("pool_verification_limit_reached"));
});
