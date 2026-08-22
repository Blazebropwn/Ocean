type SupabaseRow = Record<string, unknown>;

export type KryptotronSnapshot = {
  connected: boolean;
  status: "running" | "waiting" | "degraded" | "offline" | "unknown";
  lastHeartbeatAt: string | null;
  lastMarketCheckAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
  positions: Array<{ symbol: string; inPosition: boolean; entryPrice: number; quantity: number; highestPrice: number; protectionActive: boolean; protectionPrice: number }>;
  limits: { dailyLoss: number; weeklyLoss: number; tradesToday: number; tradesWeek: number };
  lastTrade: { symbol: string; entryPrice: number; exitPrice: number; quantity: number; pnl: number; result: string; reason: string | null; enteredAt: string | null; exitedAt: string } | null;
};

async function supabaseRows(url: string, key: string, path: string): Promise<SupabaseRow[]> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase odpověděl ${response.status}`);
  return await response.json() as SupabaseRow[];
}

export async function loadKryptotronSnapshot(url: string, key: string): Promise<KryptotronSnapshot> {
  const [states, trades] = await Promise.all([
    supabaseRows(url, key, "bot_state?key=eq.main&select=data,updated_at&limit=1"),
    supabaseRows(url, key, "bot_trades?select=symbol,entry_price,exit_price,qty,pnl,result,reason,entry_time,exit_time&order=exit_time.desc&limit=1"),
  ]);
  const state = states[0];
  const data = state?.data && typeof state.data === "object" ? state.data as Record<string, unknown> : {};
  const rawPositions = data.positions && typeof data.positions === "object" ? data.positions as Record<string, Record<string, unknown>> : {};
  const positions = Object.entries(rawPositions).map(([symbol, position]) => ({
    symbol,
    inPosition: position.in_position === true,
    entryPrice: Number(position.entry_price ?? 0),
    quantity: Number(position.position_qty ?? 0),
    highestPrice: Number(position.highest_price ?? position.highest_since_entry ?? 0),
    protectionActive: position.trail_active === true,
    protectionPrice: Number(position.trail_sl ?? position.trail_sl_price ?? 0),
  }));
  const trade = trades[0];
  return {
    connected: Boolean(state),
    status: runtimeStatus(data.runtime_status, data.last_heartbeat_at),
    lastHeartbeatAt: stringOrNull(data.last_heartbeat_at),
    lastMarketCheckAt: stringOrNull(data.last_market_check_at),
    nextCheckAt: stringOrNull(data.next_check_at),
    lastError: stringOrNull(data.last_error),
    updatedAt: typeof state?.updated_at === "string" ? state.updated_at : null,
    positions,
    limits: {
      dailyLoss: Number(data.daily_loss ?? 0),
      weeklyLoss: Number(data.weekly_loss ?? 0),
      tradesToday: Number(data.trades_today ?? 0),
      tradesWeek: Number(data.trades_week ?? 0),
    },
    lastTrade: trade && typeof trade.symbol === "string" ? {
      symbol: trade.symbol,
      entryPrice: Number(trade.entry_price ?? 0),
      exitPrice: Number(trade.exit_price ?? 0),
      quantity: Number(trade.qty ?? 0),
      pnl: Number(trade.pnl ?? 0),
      result: String(trade.result ?? ""),
      reason: typeof trade.reason === "string" ? trade.reason : null,
      enteredAt: typeof trade.entry_time === "string" ? trade.entry_time : null,
      exitedAt: String(trade.exit_time ?? ""),
    } : null,
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function runtimeStatus(value: unknown, heartbeat: unknown): KryptotronSnapshot["status"] {
  if (typeof heartbeat === "string") {
    const age = Date.now() - Date.parse(heartbeat);
    if (Number.isFinite(age) && age > 5 * 60 * 60 * 1000) return "offline";
  }
  return value === "running" || value === "waiting" || value === "degraded" ? value : "unknown";
}
