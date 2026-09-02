type SupabaseRow = Record<string, unknown>;

export type KryptotronSnapshot = {
  connected: boolean;
  environment: "testnet" | "mainnet" | null;
  status: "running" | "waiting" | "degraded" | "offline" | "unknown";
  lastHeartbeatAt: string | null;
  lastMarketCheckAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
  entriesPaused: boolean;
  events: Array<{ type: string; message: string; at: string }>;
  balance: { amount: number | null; asset: string };
  dca: { enabled: boolean; amount: number; symbols: string[]; completedWeek: string | null; totalInvested: number; purchaseCount: number; progress: Array<{ symbol: string; asset: string; quantity: number; target: number; percentage: number }>; lastRun: Array<{ symbol: string; status: string; amount: number | null; reason: string | null }> };
  streak: { enabled: boolean; paperMode: boolean; rUsdc: number; status: string; streak: number; trades: number; wins: number; losses: number; netPnl: number; sessionDate: string | null; lockReason: string | null };
  positions: Array<{
    symbol: string;
    inPosition: boolean;
    entryPrice: number;
    quantity: number;
    highestPrice: number;
    protectionActive: boolean;
    protectionStatus: string | null;
    protectionPrice: number;
    protectionActivationPrice: number;
    protectionTrailingBips: number;
  }>;
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

function statePath(stateKey: string, select = "data") {
  return `bot_state?key=eq.${encodeURIComponent(stateKey)}&select=${select}&limit=1`;
}

export async function initializeKryptotronInstance(url: string, key: string, stateKey: string, environment: "testnet" | "mainnet") {
  if (!/^kry_[a-f0-9]{32}$/.test(stateKey)) throw new Error("Neplatný identifikátor instance");
  const now = new Date().toISOString();
  const response = await fetch(`${url}/rest/v1/bot_state?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      key: stateKey,
      data: {
        runtime_status: "provisioning",
        environment,
        entries_paused: true,
        account_balance: null,
        quote_asset: "USDC",
        positions: {},
        events: [{ type: "SYSTEM", message: "Instance připravena ke spuštění", at: now }],
        dca: { enabled: false, amount: 5, symbols: ["BTCUSDC", "ETHUSDC", "SOLUSDC"], purchases: [] },
        streak: { enabled: false, paper_mode: true, r_usdc: 1 },
      },
      updated_at: now,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase odpověděl ${response.status}`);
  return stateKey;
}

export async function setKryptotronEntriesPaused(url: string, key: string, entriesPaused: boolean, stateKey = "main") {
  const states = await supabaseRows(url, key, statePath(stateKey));
  const state = states[0];
  if (!state?.data || typeof state.data !== "object") throw new Error("Stav Kryptotronu neexistuje");
  const data: Record<string, unknown> = { ...(state.data as Record<string, unknown>), entries_paused: entriesPaused };
  const events = Array.isArray(data.events) ? data.events : [];
  data.events = [{
    type: "CONTROL",
    message: entriesPaused ? "Nové obchody pozastaveny" : "Automatizace obnovena",
    at: new Date().toISOString(),
  }, ...events].slice(0, 20);
  const response = await fetch(`${url}/rest/v1/bot_state?key=eq.${encodeURIComponent(stateKey)}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase odpověděl ${response.status}`);
  return entriesPaused;
}

export async function setDcaEnabled(url: string, key: string, enabled: boolean, stateKey = "main") {
  const states = await supabaseRows(url, key, statePath(stateKey));
  const state = states[0];
  if (!state?.data || typeof state.data !== "object") throw new Error("Stav Kryptotronu neexistuje");
  const data: Record<string, unknown> = { ...(state.data as Record<string, unknown>) };
  const dca = data.dca && typeof data.dca === "object" ? data.dca as Record<string, unknown> : {};
  data.dca = { ...dca, enabled };
  const events = Array.isArray(data.events) ? data.events : [];
  data.events = [{ type: "CONTROL", message: enabled ? "Týdenní DCA zapnuto" : "Týdenní DCA vypnuto", at: new Date().toISOString() }, ...events].slice(0, 20);
  const response = await fetch(`${url}/rest/v1/bot_state?key=eq.${encodeURIComponent(stateKey)}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase odpověděl ${response.status}`);
  return enabled;
}

export async function setDcaAmount(url: string, key: string, amount: number, stateKey = "main") {
  const states = await supabaseRows(url, key, statePath(stateKey));
  const state = states[0];
  if (!state?.data || typeof state.data !== "object") throw new Error("Stav Kryptotronu neexistuje");
  const data: Record<string, unknown> = { ...(state.data as Record<string, unknown>) };
  const dca = data.dca && typeof data.dca === "object" ? data.dca as Record<string, unknown> : {};
  data.dca = { ...dca, amount };
  const events = Array.isArray(data.events) ? data.events : [];
  data.events = [{ type: "CONTROL", message: `DCA preset změněn na ${amount} USDC`, at: new Date().toISOString() }, ...events].slice(0, 20);
  const response = await fetch(`${url}/rest/v1/bot_state?key=eq.${encodeURIComponent(stateKey)}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase odpověděl ${response.status}`);
  return amount;
}

export async function requestTestDca(url: string, key: string, stateKey: string) {
  const states = await supabaseRows(url, key, statePath(stateKey));
  const state = states[0];
  if (!state?.data || typeof state.data !== "object") throw new Error("Stav Kryptotronu neexistuje");
  const data: Record<string, unknown> = { ...(state.data as Record<string, unknown>) };
  if (data.environment !== "testnet") throw new Error("Testovací nákup je dostupný pouze na Testnetu");
  const dca = data.dca && typeof data.dca === "object" ? data.dca as Record<string, unknown> : {};
  const existing = dca.test_request && typeof dca.test_request === "object" ? dca.test_request as Record<string, unknown> : null;
  if (existing?.status === "pending" || existing?.status === "processing") throw new Error("Testovací nákup už čeká na zpracování");
  // Keep the derived Binance client order ID within Binance's 36-character limit.
  const requestId = `test-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  data.dca = { ...dca, test_request: { id: requestId, status: "pending", requested_at: new Date().toISOString() } };
  const events = Array.isArray(data.events) ? data.events : [];
  data.events = [{ type: "DCA", message: "Testovací DCA zařazeno", at: new Date().toISOString() }, ...events].slice(0, 20);
  const response = await fetch(`${url}/rest/v1/bot_state?key=eq.${encodeURIComponent(stateKey)}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase odpověděl ${response.status}`);
  return requestId;
}

export async function setStreakEnabled(url: string, key: string, enabled: boolean, stateKey = "main") {
  const states = await supabaseRows(url, key, statePath(stateKey));
  const state = states[0];
  if (!state?.data || typeof state.data !== "object") throw new Error("Stav Kryptotronu neexistuje");
  const data: Record<string, unknown> = { ...(state.data as Record<string, unknown>) };
  const streak = data.streak && typeof data.streak === "object" ? data.streak as Record<string, unknown> : {};
  data.streak = { ...streak, enabled };
  const events = Array.isArray(data.events) ? data.events : [];
  data.events = [{ type: "CONTROL", message: enabled ? "Streak Governor zapnut" : "Streak Governor vypnut", at: new Date().toISOString() }, ...events].slice(0, 20);
  const response = await fetch(`${url}/rest/v1/bot_state?key=eq.${encodeURIComponent(stateKey)}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ data, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Supabase odpověděl ${response.status}`);
  return enabled;
}

export async function loadKryptotronSnapshot(url: string, key: string, stateKey = "main"): Promise<KryptotronSnapshot> {
  const [states, trades] = await Promise.all([
    supabaseRows(url, key, statePath(stateKey, "data,updated_at")),
    supabaseRows(url, key, `bot_trades?instance_id=eq.${encodeURIComponent(stateKey)}&select=symbol,entry_price,exit_price,qty,pnl,result,reason,entry_time,exit_time&order=exit_time.desc&limit=1`),
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
    protectionActive: position.protection_status === "ACTIVE" || position.trail_active === true,
    protectionStatus: stringOrNull(position.protection_status),
    protectionPrice: Number(position.protection_stop_price ?? position.trail_sl ?? position.trail_sl_price ?? 0),
    protectionActivationPrice: Number(position.protection_activation_price ?? 0),
    protectionTrailingBips: Number(position.protection_trailing_bips ?? 0),
  }));
  const trade = trades[0];
  const rawDca = data.dca && typeof data.dca === "object" ? data.dca as Record<string, unknown> : {};
  const rawStreak = data.streak && typeof data.streak === "object" ? data.streak as Record<string, unknown> : {};
  const rawStreakSession = rawStreak.session && typeof rawStreak.session === "object" ? rawStreak.session as Record<string, unknown> : {};
  const dcaPurchases = Array.isArray(rawDca.purchases) ? rawDca.purchases.filter((purchase): purchase is Record<string, unknown> => Boolean(purchase) && typeof purchase === "object") : [];
  const dcaTargets: Record<string, number> = { BTCUSDC: 1, ETHUSDC: 10, SOLUSDC: 100 };
  const dcaSymbols = Array.isArray(rawDca.symbols) ? rawDca.symbols.filter((symbol): symbol is string => typeof symbol === "string") : [];
  return {
    connected: Boolean(state),
    environment: data.environment === "testnet" || data.environment === "mainnet" ? data.environment : null,
    status: runtimeStatus(data.runtime_status, data.last_heartbeat_at),
    lastHeartbeatAt: stringOrNull(data.last_heartbeat_at),
    lastMarketCheckAt: stringOrNull(data.last_market_check_at),
    nextCheckAt: stringOrNull(data.next_check_at),
    lastError: stringOrNull(data.last_error),
    updatedAt: typeof state?.updated_at === "string" ? state.updated_at : null,
    entriesPaused: data.entries_paused === true,
    events: Array.isArray(data.events) ? data.events.flatMap((event) => {
      if (!event || typeof event !== "object") return [];
      const item = event as Record<string, unknown>;
      if (typeof item.message !== "string" || typeof item.at !== "string") return [];
      return [{ type: typeof item.type === "string" ? item.type : "SYSTEM", message: item.message, at: item.at }];
    }).slice(0, 10) : [],
    balance: {
      amount: finiteNumberOrNull(data.account_balance),
      asset: typeof data.quote_asset === "string" ? data.quote_asset : "USDC",
    },
    dca: {
      enabled: rawDca.enabled === true,
      amount: Number(rawDca.amount ?? 5),
      symbols: dcaSymbols,
      completedWeek: stringOrNull(rawDca.completed_week),
      totalInvested: dcaPurchases.reduce((sum, purchase) => sum + (finiteNumberOrNull(purchase.amount) ?? 0), 0),
      purchaseCount: dcaPurchases.length,
      progress: dcaSymbols.map((symbol) => {
        const target = dcaTargets[symbol] ?? 1;
        const quantity = dcaPurchases.reduce((sum, purchase) => purchase.symbol === symbol ? sum + (finiteNumberOrNull(purchase.quantity) ?? 0) : sum, 0);
        return { symbol, asset: symbol.replace(/USDC$/, ""), quantity, target, percentage: Math.min(100, quantity / target * 100) };
      }),
      lastRun: Array.isArray(rawDca.last_results) ? rawDca.last_results.flatMap((result) => {
        if (!result || typeof result !== "object") return [];
        const item = result as Record<string, unknown>;
        if (typeof item.symbol !== "string" || typeof item.status !== "string") return [];
        return [{ symbol: item.symbol, status: item.status, amount: finiteNumberOrNull(item.amount), reason: stringOrNull(item.reason) }];
      }) : [],
    },
    streak: {
      enabled: rawStreak.enabled === true,
      paperMode: rawStreak.paper_mode !== false,
      rUsdc: Number(rawStreak.r_usdc ?? 1),
      status: typeof rawStreakSession.status === "string" ? rawStreakSession.status : "READY",
      streak: Number(rawStreakSession.streak ?? 0), trades: Number(rawStreakSession.trades ?? 0),
      wins: Number(rawStreakSession.wins ?? 0), losses: Number(rawStreakSession.losses ?? 0),
      netPnl: Number(rawStreakSession.net_pnl ?? 0), sessionDate: stringOrNull(rawStreakSession.date),
      lockReason: stringOrNull(rawStreakSession.lock_reason),
    },
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

function finiteNumberOrNull(value: unknown) {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function runtimeStatus(value: unknown, heartbeat: unknown): KryptotronSnapshot["status"] {
  if (typeof heartbeat === "string") {
    const age = Date.now() - Date.parse(heartbeat);
    if (Number.isFinite(age) && age > 5 * 60 * 60 * 1000) return "offline";
  }
  return value === "running" || value === "waiting" || value === "degraded" ? value : "unknown";
}
