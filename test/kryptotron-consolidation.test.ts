import test from "node:test";
import assert from "node:assert/strict";
import { prepareConsolidatedState } from "../src/kryptotron-consolidation.js";

const state = () => ({ positions: { BTCUSDC: { in_position: false } }, entries_paused: false,
  dca: { enabled: true, amount: 10, purchases: [{ amount: 10 }] }, telegram: { pending_action: "resume" },
  trades_week: 2, consecutive_losses: 1 });

test("cutover preserves history and limits while disabling new real purchases", () => {
  const source = state();
  const migrated = prepareConsolidatedState(source, 0);
  assert.equal(migrated.entries_paused, true);
  assert.deepEqual(migrated.dca, { enabled: false, amount: 10, purchases: [{ amount: 10 }] });
  assert.equal(migrated.trades_week, 2);
  assert.equal(migrated.consecutive_losses, 1);
  assert.deepEqual(migrated.telegram, {});
  assert.equal(source.entries_paused, false);
});

test("cutover refuses positions and unresolved spot, protection or DCA orders", () => {
  assert.throws(() => prepareConsolidatedState(state(), 1));
  assert.throws(() => prepareConsolidatedState({ ...state(), positions: { BTCUSDC: { in_position: true } } }, 0));
  for (const field of ["pending_order", "pending_protection"]) {
    assert.throws(() => prepareConsolidatedState({ ...state(), [field]: { id: "pending" } }, 0));
  }
  assert.throws(() => prepareConsolidatedState({ ...state(), dca: { pending: { id: "pending" } } }, 0));
});
