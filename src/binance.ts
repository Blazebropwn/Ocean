import { createHmac } from "node:crypto";

export type BinanceEnvironment = "testnet" | "mainnet";

type BinanceAccount = { canTrade?: boolean; balances?: Array<{ asset?: string; free?: string; locked?: string }> };
type BinancePermissions = { enableReading?: boolean; enableWithdrawals?: boolean; enableSpotAndMarginTrading?: boolean };

function baseUrl(environment: BinanceEnvironment) {
  return environment === "testnet" ? "https://testnet.binance.vision" : "https://api.binance.com";
}

async function signedRequest<T>(environment: BinanceEnvironment, path: string, apiKey: string, secret: string): Promise<T> {
  const query = `recvWindow=5000&timestamp=${Date.now()}`;
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  const response = await fetch(`${baseUrl(environment)}${path}?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { msg?: string };
    throw new Error(body.msg || `Binance odpověděla ${response.status}.`);
  }
  return await response.json() as T;
}

export async function verifyBinanceCredentials(apiKey: string, secret: string, environment: BinanceEnvironment) {
  const account = await signedRequest<BinanceAccount>(environment, "/api/v3/account", apiKey, secret);
  let withdrawalsDisabled = environment === "testnet";
  let readingEnabled = true;
  let tradingEnabled = account.canTrade === true;

  if (environment === "mainnet") {
    const permissions = await signedRequest<BinancePermissions>(environment, "/sapi/v1/account/apiRestrictions", apiKey, secret);
    withdrawalsDisabled = permissions.enableWithdrawals !== true;
    readingEnabled = permissions.enableReading === true;
    tradingEnabled = permissions.enableSpotAndMarginTrading === true && tradingEnabled;
  }
  if (!readingEnabled) throw new Error("API klíč nemá povolené čtení účtu.");
  if (!withdrawalsDisabled) throw new Error("API klíč má povolené výběry. Nejdříve je na Binance zakažte.");
  if (!tradingEnabled) throw new Error("API klíč nemá povolené spotové obchodování.");

  const assets = (account.balances ?? []).filter((balance) => Number(balance.free ?? 0) + Number(balance.locked ?? 0) > 0).length;
  return { readingEnabled, tradingEnabled, withdrawalsDisabled, assets };
}
