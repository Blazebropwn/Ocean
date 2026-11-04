import { SOLANA_TOKEN_PROGRAM } from "./types.js";

type ObjectValue = Record<string, unknown>;
type Holder = { address: string | null; owner: string | null; pct: number };
type Pair = { holder: Holder; pool: string; mintA: string; mintB: string };

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const MAX_PAIRS = 20;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function addressBytes(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  const zeros = value.match(/^1*/)?.[0].length ?? 0;
  return bytes.length + zeros === 32 ? Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]) : null;
}

function percentage(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function bytesMatch(bytes: Buffer, offset: number, address: string): boolean {
  const expected = addressBytes(address);
  return expected !== null && bytes.subarray(offset, offset + 32).equals(expected);
}

/** Only the stable prefix is read: new fields have been appended to this account.
 * Official layout / discriminator / program:
 * https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json
 * https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md
 */
function isVerifiedPoolVault(pair: Pair, mint: string, vaultValue: unknown, poolValue: unknown): boolean {
  const vault = object(vaultValue);
  const data = object(vault?.data);
  const parsed = object(data?.parsed);
  const info = object(parsed?.info);
  if (vault?.owner !== SOLANA_TOKEN_PROGRAM || vault.executable !== false || data?.program !== "spl-token"
    || parsed?.type !== "account" || info?.mint !== mint || info.owner !== pair.pool || info.state !== "initialized"
    || (info.delegate !== undefined && info.delegate !== null)
    || (info.closeAuthority !== undefined && info.closeAuthority !== null && info.closeAuthority !== pair.pool)) return false;

  const pool = object(poolValue);
  if (pool?.owner !== PUMP_SWAP_PROGRAM || pool.executable !== false || !Array.isArray(pool.data)
    || pool.data.length !== 2 || pool.data[1] !== "base64" || typeof pool.data[0] !== "string"
    || pool.data[0].length > 4_096 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pool.data[0])) return false;
  const bytes = Buffer.from(pool.data[0], "base64");
  // Prefix: discriminator(8), bump(1), index(2), creator(32), base/quote/LP
  // mints(3*32), base/quote vaults(2*32), LP supply(8). Older pools may
  // predate the later coin_creator and mode fields.
  if (bytes.length < 211 || !bytes.subarray(0, 8).equals(POOL_DISCRIMINATOR)) return false;
  const reportMintsMatch = (bytesMatch(bytes, 43, pair.mintA) && bytesMatch(bytes, 75, pair.mintB))
    || (bytesMatch(bytes, 43, pair.mintB) && bytesMatch(bytes, 75, pair.mintA));
  if (!reportMintsMatch || !pair.holder.address) return false;
  return (bytesMatch(bytes, 43, mint) && bytesMatch(bytes, 139, pair.holder.address))
    || (bytesMatch(bytes, 75, mint) && bytesMatch(bytes, 171, pair.holder.address));
}

/**
 * Count all reported holders unless a particular reserve account is proven on
 * chain. Labels (including knownAccounts / insider) never authorize exclusion.
 * readAccounts receives at most 40 addresses and must return the RESULT of
 * getMultipleAccounts, { context: { slot }, value: [...] }, in request order,
 * using encoding=jsonParsed (unparsed PumpSwap pools fall back to base64).
 * https://solana.com/docs/rpc/http/getmultipleaccounts
 */
export async function computeHolderConcentration(
  report: ObjectValue,
  mint: string,
  readAccounts: (addresses: string[]) => Promise<unknown>,
): Promise<{ topHolderPct: number | null; evidence: ObjectValue }> {
  const warnings: string[] = [];
  const excluded: ObjectValue[] = [];
  const verification: ObjectValue = { method: "getMultipleAccounts", encoding: "jsonParsed", requestedAccountCount: 0, status: "not_needed", slot: null };
  const evidence: ObjectValue = {
    concentrationMethod: "max_reported_holder_excluding_verified_pool_vaults_without_rescaling",
    maxReportedHolderPct: null, excludedPoolVaults: excluded, holderVerification: verification, holderWarnings: warnings,
  };
  if (!addressBytes(mint) || (Object.hasOwn(report, "mint") && report.mint !== mint)
    || !Array.isArray(report.topHolders) || report.topHolders.length === 0 || report.topHolders.length > 100) {
    warnings.push("invalid_holder_report");
    return { topHolderPct: null, evidence };
  }
  const holders: Holder[] = [];
  const seenAddresses = new Set<string>();
  for (const value of report.topHolders) {
    const holder = object(value);
    const pct = percentage(holder?.pct);
    // Anonymous, percentage-only reports remain countable, but can never be
    // excluded. An explicitly malformed or duplicated address invalidates the
    // concentration rather than quietly removing the holder.
    if (!holder || pct === null || (Object.hasOwn(holder, "address") && !addressBytes(holder.address))
      || (typeof holder.address === "string" && seenAddresses.has(holder.address))) {
      warnings.push("invalid_holder_report");
      return { topHolderPct: null, evidence };
    }
    const address = typeof holder.address === "string" ? holder.address : null;
    if (address) seenAddresses.add(address);
    holders.push({ address, owner: addressBytes(holder.owner) ? holder.owner as string : null, pct });
  }
  const maximum = Math.max(...holders.map((holder) => holder.pct));
  evidence.maxReportedHolderPct = maximum;
  evidence.reportedHolderCount = holders.length;
  const pairs: Pair[] = [];
  const pairKeys = new Set<string>();
  if (Array.isArray(report.markets) && report.markets.length <= 100) {
    for (const holder of [...holders].sort((a, b) => b.pct - a.pct)) {
      if (!holder.address || !holder.owner) continue;
      for (const value of report.markets) {
        const market = object(value);
        if (!market || !addressBytes(market.pubkey) || market.pubkey !== holder.owner
          || !addressBytes(market.mintA) || !addressBytes(market.mintB) || market.mintA === market.mintB) continue;
        const reserve = market.mintA === mint ? market.liquidityA : market.mintB === mint ? market.liquidityB : null;
        const key = `${holder.address}:${market.pubkey}`;
        if (reserve !== holder.address || pairKeys.has(key)) continue;
        pairKeys.add(key);
        if (pairs.length < MAX_PAIRS) pairs.push({ holder, pool: market.pubkey as string, mintA: market.mintA as string, mintB: market.mintB as string });
        else if (!warnings.includes("pool_verification_limit_reached")) warnings.push("pool_verification_limit_reached");
      }
    }
  }
  const excludedAddresses = new Set<string>();
  if (pairs.length > 0) {
    const addresses = [...new Set(pairs.flatMap((pair) => [pair.holder.address!, pair.pool]))];
    verification.requestedAccountCount = addresses.length;
    try {
      const response = object(await readAccounts(addresses));
      const slot = object(response?.context)?.slot;
      if (!response || !Number.isSafeInteger(slot) || Number(slot) < 0 || !Array.isArray(response.value) || response.value.length !== addresses.length) {
        warnings.push("invalid_pool_verification_response");
        verification.status = "unverified";
      } else {
        verification.slot = slot;
        verification.status = "checked";
        const values = response.value;
        const accounts = new Map(addresses.map((address, i) => [address, values[i]]));
        for (const pair of pairs) {
          if (!isVerifiedPoolVault(pair, mint, accounts.get(pair.holder.address!), accounts.get(pair.pool))) {
            if (!warnings.includes("unverified_pool_candidate_included")) warnings.push("unverified_pool_candidate_included");
            continue;
          }
          excludedAddresses.add(pair.holder.address!);
          excluded.push({ address: pair.holder.address, owner: pair.pool, pct: pair.holder.pct,
            poolAddress: pair.pool, program: PUMP_SWAP_PROGRAM, verification: "onchain_spl_account_and_pumpswap_pool", slot });
        }
      }
    } catch {
      // No exception body or RPC URL: it could contain credentials.
      warnings.push("pool_verification_unavailable");
      verification.status = "unavailable";
    }
  }
  const included = holders.filter((holder) => !holder.address || !excludedAddresses.has(holder.address));
  evidence.includedHolderCount = included.length;
  if (included.length === 0) warnings.push("no_non_reserve_holders_reported");
  const topHolderPct = included.length > 0 ? Math.max(...included.map((holder) => holder.pct)) : null;
  return { topHolderPct, evidence };
}
