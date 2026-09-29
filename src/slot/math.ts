import { randomInt } from "node:crypto";

export const GAME_VERSION = "ocean_slot_v1";
export const BET = 10;
export const PAYOUTS = Object.freeze({ wave: 30, fish: 100, shell: 250, octo: 1000, core: 10000 });
export type SymbolName = keyof typeof PAYOUTS;
// Frozen v1 strips, in the order used by the supplied mechanical prototype.
export const REELS: readonly (readonly SymbolName[])[] = Object.freeze([
  ["fish","octo","fish","wave","shell","wave","fish","shell","wave","core","fish","wave","shell","wave","octo","wave","shell","fish","wave","shell","octo","wave","fish","octo","wave"],
  ["octo","wave","shell","wave","octo","fish","wave","shell","fish","wave","fish","shell","wave","core","wave","fish","shell","wave","fish","octo","wave","shell","octo","fish","wave"],
  ["shell","wave","fish","wave","shell","octo","fish","wave","octo","fish","wave","octo","shell","wave","fish","wave","fish","shell","wave","core","octo","wave","shell","fish","wave"],
].map(reel => Object.freeze(reel as SymbolName[])));

export function evaluateStops(stops: readonly number[]) {
  if (stops.length !== 3 || stops.some(n => !Number.isInteger(n) || n < 0 || n >= 25)) throw new Error("INVALID_REEL_STOPS");
  const symbols = stops.map((stop, i) => REELS[i]![stop]!);
  return { stops: [...stops], symbols, payout: symbols.every(s => s === symbols[0]) ? PAYOUTS[symbols[0]!] : 0 };
}

export function drawStops() { return [randomInt(25), randomInt(25), randomInt(25)]; }
