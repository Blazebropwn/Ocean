import { createHmac } from "node:crypto";
import type { Config } from "./config.js";
import type { OceanDatabase } from "./db.js";
import { credentialsKeys, decryptCredentialWithKeys } from "./credentials.js";
import { deriveKryptotronOcto, type KryptotronSnapshot } from "./kryptotron.js";
import { calculateTradeCosts, orderId, unknownTradeCosts, type TradeCosts, type TradeReference } from "./trade-accounting.js";

type Stored = { reference_json: string; costs_json: string | null; checked_at: number | null };
export type ExecutionEvidence = [unknown, unknown, unknown, unknown];
export type ExecutionReader = (reference: TradeReference, apiKey: string, secret: string, environment: "mainnet" | "testnet") => Promise<ExecutionEvidence>;

export function tradeReference(raw: Record<string, unknown>): TradeReference | null {
  const exitedAt = typeof raw.exitedAt === "string" ? Date.parse(raw.exitedAt) : NaN;
  if (typeof raw.symbol !== "string" || !/^[A-Z0-9]{2,16}USDC$/.test(raw.symbol) || !Number.isFinite(exitedAt)
    || ![raw.quantity, raw.entryPrice, raw.exitPrice].every(v => typeof v === "number" && Number.isFinite(v) && v > 0)) return null;
  return { symbol: raw.symbol, exitedAt: new Date(exitedAt).toISOString(), quantity: raw.quantity as number,
    entryPrice: raw.entryPrice as number, exitPrice: raw.exitPrice as number,
    entryOrderId: orderId(raw.entryOrderId), exitOrderId: orderId(raw.exitOrderId) };
}

export function rememberTradeReference(db: OceanDatabase, instance: string, reference: TradeReference) {
  db.prepare(`INSERT INTO kryptotron_trade_costs(instance_id,symbol,exited_at,reference_json) VALUES (?,?,?,?)
    ON CONFLICT(instance_id,symbol,exited_at) DO UPDATE SET reference_json=excluded.reference_json,
      costs_json=NULL,evidence_json=NULL,checked_at=NULL
    WHERE json_extract(kryptotron_trade_costs.reference_json,'$.entryOrderId') IS NULL
       OR json_extract(kryptotron_trade_costs.reference_json,'$.exitOrderId') IS NULL`)
    .run(instance, reference.symbol, reference.exitedAt, JSON.stringify(reference));
}

export const readExecutionEvidence: ExecutionReader = async (reference, apiKey, secret, environment) => {
  const base = environment === "testnet" ? "https://testnet.binance.vision" : "https://api.binance.com";
  async function read(path: "/api/v3/order" | "/api/v3/myTrades", id: string) {
    const params = new URLSearchParams({ symbol: reference.symbol, orderId: id, recvWindow: "5000", timestamp: String(Date.now()) });
    if (path === "/api/v3/myTrades") params.set("limit", "1000");
    const query = params.toString(), signature = createHmac("sha256", secret).update(query).digest("hex");
    const response = await fetch(`${base}${path}?${query}&signature=${signature}`, {
      method: "GET", headers: { "X-MBX-APIKEY": apiKey }, signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error("Execution evidence unavailable");
    return response.json();
  }
  return Promise.all([read("/api/v3/order", reference.entryOrderId!), read("/api/v3/myTrades", reference.entryOrderId!),
    read("/api/v3/order", reference.exitOrderId!), read("/api/v3/myTrades", reference.exitOrderId!)]);
};

export class TradeCostService {
  private pending = new Map<string, Promise<void>>();
  constructor(private db: OceanDatabase, private config: Config, private reader: ExecutionReader = readExecutionEvidence,
    private now: () => number = Date.now) {}

  private stored(instance: string, ref: TradeReference): Stored | undefined {
    return this.db.prepare("SELECT reference_json,costs_json,checked_at FROM kryptotron_trade_costs WHERE instance_id=? AND symbol=? AND exited_at=?")
      .get(instance, ref.symbol, ref.exitedAt) as Stored | undefined;
  }

  private async verify(instance: string, ref: TradeReference) {
    let costs: TradeCosts = { ...unknownTradeCosts("UNAVAILABLE"), checkedAt: new Date(this.now()).toISOString() };
    let evidence: ExecutionEvidence | null = null;
    try {
      const row = this.db.prepare(`SELECT i.user_id,i.environment,c.* FROM kryptotron_instances i
        JOIN kryptotron_credentials c ON c.instance_id=i.id WHERE i.id=? AND i.status='connected'`).get(instance) as Record<string, string> | undefined;
      if (!row || !["mainnet", "testnet"].includes(row.environment!)) throw new Error("No connection");
      const keys = credentialsKeys(this.config), context = `${row.user_id}:${instance}`;
      const decrypt = (prefix: string, suffix: string) => decryptCredentialWithKeys({ ciphertext: row[prefix + "_ciphertext"]!,
        iv: row[prefix + "_iv"]!, tag: row[prefix + "_tag"]! }, keys, context + suffix);
      evidence = await this.reader(ref, decrypt("api_key", ":api-key"), decrypt("api_secret", ":api-secret"), row.environment as "mainnet" | "testnet");
      costs = calculateTradeCosts(ref, ...evidence, new Date(this.now()));
    } catch { /* Accounting failure must not hide the trading snapshot or leak keys. */ }
    this.db.prepare("UPDATE kryptotron_trade_costs SET costs_json=?,evidence_json=?,checked_at=? WHERE instance_id=? AND symbol=? AND exited_at=? AND reference_json=?")
      .run(JSON.stringify(costs), evidence ? JSON.stringify(evidence) : null, this.now(), instance, ref.symbol, ref.exitedAt, JSON.stringify(ref));
  }

  async enrich(instance: string, snapshot: KryptotronSnapshot): Promise<KryptotronSnapshot> {
    const targets: Array<{ ref: TradeReference; attach: (costs: TradeCosts) => void }> = [];
    if (snapshot.lastTrade) {
      const last = snapshot.lastTrade;
      const ref = tradeReference(last);
      if (ref) targets.push({ ref, attach: costs => { last.costs = costs; } });
    }
    for (const trade of snapshot.transparency?.trades ?? []) {
      if (trade.action !== "CLOSED") continue;
      const ref = tradeReference({ ...trade, exitedAt: trade.at });
      if (ref) targets.push({ ref, attach: costs => { trade.costs = costs; } });
    }
    // One verification per refresh, four bounded read-only requests. A shared
    // per-instance promise deduplicates overlapping browser polls.
    let candidate: TradeReference | undefined;
    let candidateCheckedAt = Infinity;
    for (const { ref } of targets) {
      if (ref.entryOrderId && ref.exitOrderId) rememberTradeReference(this.db, instance, ref);
      const row = this.stored(instance, ref);
      if (!row) continue;
      const saved = JSON.parse(row.reference_json) as TradeReference;
      if (!this.sameTrade(ref, saved)) continue;
      if (!saved.entryOrderId || !saved.exitOrderId) continue;
      const costs = row.costs_json ? JSON.parse(row.costs_json) as TradeCosts : null;
      const checkedAt = row.checked_at ?? -Infinity;
      if (costs?.status !== "verified" && this.now() - checkedAt >= 60_000 && (!candidate || checkedAt < candidateCheckedAt)) {
        candidate = saved;
        candidateCheckedAt = checkedAt;
      }
    }
    const running = this.pending.get(instance);
    if (running) await running;
    else if (candidate) {
      const job = this.verify(instance, candidate).finally(() => this.pending.delete(instance));
      this.pending.set(instance, job);
      await job;
    }
    for (const { ref, attach } of targets) {
      const row = this.stored(instance, ref);
      const saved = row ? JSON.parse(row.reference_json) as TradeReference : null;
      attach(row?.costs_json && saved && this.sameTrade(ref, saved) ? JSON.parse(row.costs_json) as TradeCosts
        : unknownTradeCosts(saved?.entryOrderId && saved.exitOrderId ? "UNAVAILABLE" : "MISSING_ORDER_IDS"));
    }
    return { ...snapshot, octo: deriveKryptotronOcto(snapshot) };
  }

  private sameTrade(a: TradeReference, b: TradeReference) {
    return a.symbol === b.symbol && a.exitedAt === b.exitedAt && a.quantity === b.quantity
      && Math.abs(a.entryPrice - b.entryPrice) <= Math.max(1e-8, b.entryPrice * 1e-9)
      && Math.abs(a.exitPrice - b.exitPrice) <= Math.max(1e-8, b.exitPrice * 1e-9)
      && (!a.entryOrderId || a.entryOrderId === b.entryOrderId) && (!a.exitOrderId || a.exitOrderId === b.exitOrderId);
  }
}
