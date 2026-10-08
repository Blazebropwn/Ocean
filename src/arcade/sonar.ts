import { randomInt } from 'node:crypto';

export const SONAR_VERSION = 'sonar-classic-v1';
export const RUN_DURATION_MS = 600_000;
export const SONAR_HIT_PADDING = .04;
export type SonarRound = { target: number; width: number; hitPadding?: number; perfectWidth: number; speed: number; hitPoints: number; perfectPoints: number };
export function angularDistance(a: number, b: number) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}
export function createSonarRounds(): SonarRound[] {
  let previous = -Math.PI / 2;
  return Array.from({ length: 256 }, (_, index) => {
    let target: number;
    do { target = randomInt(1_000_000) / 1_000_000 * Math.PI * 2; } while (angularDistance(target, previous) < 1.05);
    previous = target;
    const width = Math.max(.3, .72 - index * .025);
    return { target, width, hitPadding: SONAR_HIT_PADDING, perfectWidth: width * .22, speed: Math.min(3.5, 1.45 + index * .14), hitPoints: 100, perfectPoints: 200 };
  });
}

// Recompute from the issued course and tap times; never accept a submitted score.
export function scoreSonarRun(rounds: SonarRound[], taps: number[], durationMs: number, version: string = SONAR_VERSION) {
  if (version !== SONAR_VERSION && version !== 'sonar-v2') return null;
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > RUN_DURATION_MS || taps.length > rounds.length) return null;
  let angle = -Math.PI / 2, previous = 0, score = 0, hits = 0, perfects = 0;
  for (let i = 0; i < taps.length; i++) {
    const time = taps[i]!, round = rounds[i]!;
    if (!Number.isFinite(time) || time < previous + 25 || time > durationMs) return null;
    angle = (angle + round.speed * (time - previous) / 1000) % (Math.PI * 2);
    previous = time;
    const distance = angularDistance(angle, round.target);
    const hitPadding = version === SONAR_VERSION ? (round.hitPadding ?? 0) : 0;
    if (distance > round.width / 2 + hitPadding) return i === taps.length - 1 ? { score, hits, perfects } : null;
    const accuracy = Math.max(0, 1 - distance / (round.width / 2));
    const perfect = version === 'sonar-v2' ? distance <= round.perfectWidth / 2 : accuracy > .78;
    score += version === 'sonar-v2' ? (perfect ? round.perfectPoints : round.hitPoints)
      : Math.round(100 + accuracy * 100 + hits * 10);
    hits++; perfects += Number(perfect);
  }
  return { score, hits, perfects };
}
