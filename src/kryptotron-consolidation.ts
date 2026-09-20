/** Migration guard: a cutover must never abandon exchange or local orders. */
export function prepareConsolidatedState(state: Record<string, unknown>, exchangeOpenOrders: number) {
  const positions = state.positions as Record<string, { in_position?: unknown }> | undefined;
  const dca = state.dca as Record<string, unknown> | undefined;
  if (!positions || typeof positions !== "object" || Array.isArray(positions)) throw new Error("Chybí ověřený stav pozic.");
  if (exchangeOpenOrders !== 0 || Object.values(positions).some((p) => p?.in_position !== false)
    || state.pending_order || state.pending_protection || dca?.pending) {
    throw new Error("Převod je zablokovaný otevřenou pozicí nebo nedokončenou objednávkou.");
  }
  const result = structuredClone(state);
  result.entries_paused = true;
  result.environment = "mainnet";
  result.runtime_status = "provisioning";
  result.last_error = null;
  result.next_check_at = null;
  result.dca = { ...dca, enabled: false };
  // Legacy callback IDs and pending confirmations must never transfer.
  result.telegram = {};
  result.consolidation = {
    from: "main", at: new Date().toISOString(),
    previous_entries_paused: state.entries_paused,
    previous_dca_enabled: dca?.enabled ?? false,
  };
  return result;
}
