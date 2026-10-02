import { BET, GAME_VERSION, PAYOUTS, REELS, evaluateStops } from './math.js';

// Exact enumeration of the production strips; no sampling or ledger operations.
export function slotMathReport() {
  const combinations = REELS.reduce((n, reel) => n * reel.length, 1);
  const counts = Object.fromEntries(Object.keys(PAYOUTS).map(symbol => [symbol, 0]));
  let totalPayout = 0, hits = 0;
  for (let a = 0; a < REELS[0]!.length; a++) for (let b = 0; b < REELS[1]!.length; b++) for (let c = 0; c < REELS[2]!.length; c++) {
    const result = evaluateStops([a, b, c]);
    totalPayout += result.payout;
    if (result.payout) { hits++; counts[result.symbols[0]!]!++; }
  }
  return { gameVersion: GAME_VERSION, bet: BET, reels: REELS, payouts: PAYOUTS, combinations, hits,
    rtp: totalPayout / (combinations * BET), hitRate: hits / combinations,
    expectedPayout: totalPayout / combinations, expectedNet: totalPayout / combinations - BET,
    outcomes: Object.entries(PAYOUTS).map(([symbol, payout]) => ({ symbol, payout, combinations: counts[symbol]!,
      probability: counts[symbol]! / combinations, rtpContribution: counts[symbol]! * payout / (combinations * BET) })) };
}
