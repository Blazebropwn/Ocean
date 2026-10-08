import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { scoreSonarRun, SONAR_HIT_PADDING } from '../src/arcade/sonar.js';

const source = readFileSync('public/app.js', 'utf8');
const inputCode = source.slice(source.indexOf('function arcadeTap()'), source.indexOf('function drawSonar('));

for (const [angle, expectedHits, hitPadding] of [[.149, 1, 0], [-.149, 1, 0], [.151, 0, 0],
  [.189, 1, SONAR_HIT_PADDING], [-.189, 1, SONAR_HIT_PADDING], [.191, 0, SONAR_HIT_PADDING], [-.191, 0, SONAR_HIT_PADDING]] as const) {
  test(`SONAR judges visible angle ${angle} with padding ${hitPadding} without advancing past the painted frame`, () => {
    const rounds = [
      { target: 0, width: .3, hitPadding, speed: 3.5, perfectWidth: .066, hitPoints: 100, perfectPoints: 200 },
      { target: 2, width: .3, hitPadding, speed: 3.5, perfectWidth: .066, hitPoints: 100, perfectPoints: 200 },
    ];
    const elapsed = (angle + Math.PI / 2) / rounds[0]!.speed * 1000;
    const state = { active: true, saving: false, unsaved: false, elapsed, last: 9000,
      roundAt: 0, roundAngle: -Math.PI / 2, angle, target: 0, targetWidth: .3,
      speed: 3.5, score: 0, hits: 0, taps: [] as number[], flashUntil: 0,
      run: { rounds, maxDurationMs: 600_000 } };
    let paintedTarget: number | undefined;
    const element = { open: false, textContent: '' };
    runInNewContext(`${inputCode}\narcadeTap();`, {
      arcadeState: state, sonarOpening: false, performance: { now: () => 10000 },
      document: { hidden: false }, $: () => element,
      finishArcade: () => { state.active = false; },
      drawArcadeIdle: () => { paintedTarget = state.target; },
    });
    assert.equal(state.hits, expectedHits);
    assert.equal(state.taps[0], elapsed, 'submit the time represented by the visible frame');
    const result = scoreSonarRun(rounds, state.taps, elapsed)!;
    assert.equal(result.hits, expectedHits);
    assert.equal(result.score, state.score, 'client and server agree at sector edges');
    if (expectedHits && Math.abs(angle) > .15) assert.equal(state.score, 100, 'padding gives a normal edge hit, not a perfect hit');
    if (expectedHits) {
      assert.equal(paintedTarget, rounds[1]!.target, 'paint the next target immediately');
      assert.equal(state.last, 10000, 'next round starts from input time');
    } else {
      assert.equal(state.active, false);
      assert.equal(state.angle, angle, 'a miss leaves the actual judged frame visible');
    }
  });
}
