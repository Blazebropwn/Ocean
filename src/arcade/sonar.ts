import { randomInt } from 'node:crypto';

export const SONAR_VERSION = 'sonar-v2';
export const RUN_DURATION_MS = 600_000;
export type SonarRound = { target: number; width: number; perfectWidth: number; speed: number; hitPoints: number; perfectPoints: number };
export function angularDistance(a: number, b: number) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}
export function createSonarRounds(): SonarRound[] {
  let previous = -Math.PI / 2;
  return Array.from({ length: 256 }, (_, index) => {
    let target: number;
    do { target = randomInt(1_000_000) / 1_000_000 * Math.PI * 2; } while (angularDistance(target, previous) < 1.05);
    previous = target;
    const width = Math.max(.32, .8 - index * .018);
    return { target, width, perfectWidth: width * .3, speed: Math.min(3.2, 1.35 + index * .085), hitPoints: 50, perfectPoints: 100 };
  });
}

// Recompute from the issued course and tap times; never accept a submitted score.
export function scoreSonarRun(rounds: SonarRound[], taps: number[], durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > RUN_DURATION_MS || taps.length > rounds.length) return null;
  let angle = -Math.PI / 2, previous = 0, score = 0, hits = 0, perfects = 0;
  for (let i = 0; i < taps.length; i++) {
    const time = taps[i]!, round = rounds[i]!;
    if (!Number.isFinite(time) || time < previous + 25 || time > durationMs) return null;
    angle = (angle + round.speed * (time - previous) / 1000) % (Math.PI * 2);
    previous = time;
    const distance = angularDistance(angle, round.target);
    if (distance > round.width / 2) return i === taps.length - 1 ? { score, hits, perfects } : null;
    const perfect = distance <= round.perfectWidth / 2;
    score += perfect ? round.perfectPoints : round.hitPoints;
    hits++; perfects += Number(perfect);
  }
  return { score, hits, perfects };
}
