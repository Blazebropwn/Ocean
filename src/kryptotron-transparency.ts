const reasons: Record<string, string> = {
  MANUAL_CLOSE: "Uživatel ručně uzavřel pozici. Pro tento pár následuje hodinová pauza.",
  AWAITING_STRATEGY_CHECK: "Pauza skončila. Čekám na další pravidelnou kontrolu strategie.",
  PAIR_COOLDOWN: "Po ručním uzavření běží hodinová pauza pro tento pár.",
  MANUAL_CLOSE_PENDING: "Ruční uzavření čeká na potvrzení burzou.",
  ENTRY_ALLOWED: "Býčí režim a dostupný rizikový rozpočet dovolují vstup.",
  BEAR_REGIME: "EMA50 není nad EMA200. Strategie čeká na býčí režim.",
  POSITION_ALREADY_OPEN: "Pozice je otevřená a má potvrzenou burzovní ochranu.",
  ENTRIES_PAUSED: "Nové obchody jsou pozastavené uživatelem.",
  DAILY_LOSS_LIMIT: "Byl dosažen denní limit ztráty.",
  WEEKLY_LOSS_LIMIT: "Byl dosažen týdenní limit ztráty.",
  DAILY_TRADE_LIMIT: "Byl dosažen denní limit vstupů.",
  WEEKLY_TRADE_LIMIT: "Byl dosažen týdenní limit vstupů.",
  COOLDOWN_ACTIVE: "Běží ochranná přestávka mezi obchody.",
  INSUFFICIENT_BALANCE: "Povolená částka nedosahuje minima objednávky.",
  STALE_STATE: "Čekám na čerstvá a ověřená data.",
  RECONCILIATION_REQUIRED: "Stav účtu nebo objednávek vyžaduje kontrolu.",
  PROTECTION_ERROR: "Burzovní ochrana pozice není potvrzená. Vyžaduje kontrolu.",
  PERSISTENCE_REQUIRED: "Potvrzený obchod čeká na uložení do historie.",
  DEATH_CROSS: "EMA50 překročila EMA200 směrem dolů; pravidlo požaduje výstup.",
  TRAILING_STOP: "Burza provedla trailing stop po poklesu od dosaženého maxima.",
  EMERGENCY_STOP: "Burza provedla ochranný stop loss.",
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const reconciliationReasons: Record<string, string> = {
  INVENTORY_MISMATCH: "Na burze je méně prostředků než v evidenci Ocean. Je nutné porovnat historii obchodů a převodů, včetně změn mimo Ocean.",
  UNATTRIBUTED_BALANCE: "Na burze jsou prostředky bez přiřazení v evidenci Ocean. Je nutné ověřit jejich původ.",
  POSITION_BALANCE_MISMATCH: "Zůstatek na burze neodpovídá evidované otevřené pozici. Je nutné ověřit její množství.",
  UNKNOWN_OPEN_ORDER: "Na burze je otevřená objednávka, kterou Ocean neeviduje. Je nutné ověřit její původ.",
  PENDING_EXECUTION: "Objednávka čeká na potvrzení burzou. Kontrola jejího výsledku pokračuje automaticky.",
  PROTECTION_ERROR: reasons.PROTECTION_ERROR!,
};

/** Whitelisted user explanations; raw exception text stays in the worker log. */
export function readKryptotronTransparency(data: Record<string, unknown>, now = Date.now()) {
  const rawCheck = record(data.reconciliation);
  const checkedAt = date(rawCheck.checked_at);
  const age = checkedAt ? now - Date.parse(checkedAt) : Infinity;
  const fresh = age >= -30_000 && age <= 90_000;
  const reconciliationStatus = rawCheck.status === "OK" ? (fresh ? "OK" : "STALE") : "UNRESOLVED";
  const issues = Array.isArray(rawCheck.issues) ? rawCheck.issues.flatMap((value) => {
    const issue = record(value);
    return typeof issue.code === "string" && /^[A-Z_]{1,64}$/.test(issue.code)
      ? [{ code: issue.code, symbol: typeof issue.symbol === "string" && /^[A-Z0-9]{3,20}$/.test(issue.symbol) ? issue.symbol : null,
        message: reconciliationReasons[issue.code] ?? "Kontrola účtu vyžaduje ověření evidence a objednávek. Kontaktuj správce Ocean." }]
      : [];
  }).slice(0, 20) : [];
  const decisions = Object.entries(record(data.decisions)).flatMap(([symbol, value]) => {
    const item = record(value), at = date(item.checkedAt), risk = record(item.risk);
    if (!/^[A-Z0-9]{3,20}$/.test(symbol) || !at) return [];
    let code = typeof item.reasonCode === "string" && reasons[item.reasonCode] ? item.reasonCode : "STALE_STATE";
    const cooldown = date(record(data.pair_cooldowns)[symbol]);
    if (cooldown && Date.parse(cooldown) > now) code = "PAIR_COOLDOWN";
    else if (code === "PAIR_COOLDOWN") code = "AWAITING_STRATEGY_CHECK";
    return [{ symbol, checkedAt: at, stale: now - Date.parse(at) > 4 * 3_600_000 + 120_000 || Date.parse(at) > now + 30_000,
      marketRegime: item.marketRegime === "BULL" ? "BULL" : item.marketRegime === "BEAR" ? "BEAR" : "UNKNOWN",
      price: number(item.price), emaFast: number(item.emaFast), emaSlow: number(item.emaSlow),
      positionState: code !== "PAIR_COOLDOWN" && item.positionState === "OPEN" ? "OPEN" : "FLAT",
      decision: code === "PAIR_COOLDOWN" ? "NO_ENTRY" : ["NO_ENTRY", "ENTRY_ALLOWED", "HOLD", "REVIEW", "EXIT_REQUIRED"].includes(String(item.decision)) ? String(item.decision) : "REVIEW",
      reasonCode: code, reason: reasons[code]!, nextCheckAt: date(item.nextCheckAt),
      risk: { maxOrderQuote: number(risk.maxOrderQuote), positionPct: number(risk.positionPct),
        stopLossPct: number(risk.stopLossPct), dailyLossLimit: number(risk.dailyLossLimit), weeklyLossLimit: number(risk.weeklyLossLimit) },
    }];
  }).slice(0, 10);
  const safeMode = data.safe_mode === true;
  const trades = Array.isArray(data.trade_explanations) ? data.trade_explanations.slice(-20).reverse().flatMap(value => {
    const item = record(value), at = date(item.at);
    if (!at || typeof item.symbol !== "string" || !/^[A-Z0-9]{3,20}$/.test(item.symbol)) return [];
    const code = typeof item.reasonCode === "string" ? item.reasonCode : "";
    return [{ symbol: item.symbol, at, action: item.decision === "POSITION_OPENED" ? "OPENED" : "CLOSED",
      reasonCode: code, reason: reasons[code] ?? "Obchod vyžaduje kontrolu původního záznamu.",
      entryPrice: number(item.entryPrice), exitPrice: number(item.exitPrice), quantity: number(item.quantity),
      grossPnl: number(item.grossPnl), nominalStopRiskQuote: number(item.nominalStopRiskQuote),
      stopPrice: number(item.stopPrice), trailingActivationPrice: number(item.trailingActivationPrice),
      trailingBips: number(item.trailingBips), protectionStatus: item.protectionStatus === "ACTIVE" ? "ACTIVE" : null,
    }];
  }) : [];
  return { safeMode, reconciliation: { status: reconciliationStatus, checkedAt, issues }, decisions,
    trades,
    strategyStatus: safeMode ? "SAFE_MODE" : data.entries_paused !== false ? "PAUSED" : reconciliationStatus !== "OK" ? "UNVERIFIED"
      : Array.isArray(data.pending_trade_logs) && data.pending_trade_logs.length ? "PERSISTENCE_REQUIRED" : "ACTIVE",
    historyPending: Array.isArray(data.pending_trade_logs) ? data.pending_trade_logs.length : 0,
  };
}
