import test from "node:test";
import assert from "node:assert/strict";
import { SolanaProviderCadence, SolanaProviderRateLimitError, parseRetryAfter, type ProviderCadenceState } from "../src/solana/provider-cadence.js";

const START = Date.parse("2026-11-04T20:00:00Z");

test("Gecko calls share one queue and start at least seven seconds apart", async () => {
  let now = START;
  const started: number[] = [], waits: number[] = [];
  const gate = new SolanaProviderCadence({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  assert.deepEqual(await Promise.all([1, 2, 3, 4].map((n) => gate.run(async () => { started.push(now); return n; }))), [1, 2, 3, 4]);
  assert.deepEqual(started, [START, START + 7_000, START + 14_000, START + 21_000]);
  assert.deepEqual(waits, [7_000, 7_000, 7_000]);
});

test("non-429 failures release the queue but still count towards request cadence", async () => {
  let now = START;
  const gate = new SolanaProviderCadence({ now: () => now, sleep: async (ms) => { now += ms; } });
  const failure = new Error("HTTP 503");
  await assert.rejects(gate.run(async () => { throw failure; }), (error) => error === failure);
  assert.equal(await gate.run(async () => now), START + 7_000);
  assert.equal(gate.snapshot().consecutive429, 0);
});

test("Retry-After accepts seconds and HTTP dates while rejecting malformed and fractional delays", () => {
  assert.equal(parseRetryAfter("120", START), START + 120_000);
  assert.equal(parseRetryAfter("0", START), START);
  assert.equal(parseRetryAfter("00000000000000000000000000000000000120", START), START + 120_000);
  assert.equal(parseRetryAfter(" Wed, 04 Nov 2026 20:03:00 GMT ", START), START + 180_000);
  assert.equal(parseRetryAfter("Wed, 04 Nov 2026 19:59:00 GMT", START), START);
  for (const header of [null, "", "1.5", "-1", "1e6", "Infinity", "NaN", "tomorrow", "Wed, 32 Nov 2026 20:00:00 GMT"]) assert.equal(parseRetryAfter(header, START), null);
  assert.equal(parseRetryAfter("999999999999999999999999999999999999999", START), 8_640_000_000_000_000);
  assert.equal(parseRetryAfter("8640000000000", START), 8_640_000_000_000_000);
  assert.throws(() => parseRetryAfter("1", Number.MAX_SAFE_INTEGER), /Neplatný čas/);
});

test("a 429 blocks already queued requests without a long sleep or another HTTP call", async () => {
  let now = START, calls = 0;
  const waits: number[] = [];
  const gate = new SolanaProviderCadence({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  const requests = await Promise.allSettled([gate.run(async () => { calls++; throw new SolanaProviderRateLimitError("GeckoTerminal", START + 300_000); }), gate.run(async () => { calls++; })]);
  for (const result of requests) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") { assert(result.reason instanceof SolanaProviderRateLimitError); assert.equal(result.reason.retryAt, START + 300_000); }
  }
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(gate.snapshot().cooldownUntil, START + 300_000);
});

test("missing Retry-After adds exponential pauses, survives restart, and clears only after success", async () => {
  let now = START, calls = 0;
  let saved: ProviderCadenceState | undefined;
  const options = { now: () => now, sleep: async (ms: number) => { now += ms; }, persistence: { read: () => saved, write: (state: ProviderCadenceState) => { saved = { ...state }; } } };
  let gate = new SolanaProviderCadence(options);
  const fail = () => gate.run(async () => { calls++; throw new SolanaProviderRateLimitError("GeckoTerminal", now); });
  await assert.rejects(fail(), (error: unknown) => error instanceof SolanaProviderRateLimitError && error.retryAt === START + 60_000);
  gate = new SolanaProviderCadence(options);
  now += 59_000;
  await assert.rejects(fail(), (error: unknown) => error instanceof SolanaProviderRateLimitError && error.retryAt === START + 60_000);
  assert.equal(calls, 1);
  now++;
  await assert.rejects(gate.run(async () => { calls++; }), SolanaProviderRateLimitError);
  now = START + 60_000;
  await assert.rejects(fail(), (error: unknown) => error instanceof SolanaProviderRateLimitError && error.retryAt === now + 120_000);
  now += 120_000;
  await assert.rejects(gate.run(async () => { calls++; throw new Error("HTTP 503"); }), /HTTP 503/);
  assert.equal(gate.snapshot().consecutive429, 2);
  now += 7_000;
  await gate.run(async () => { calls++; });
  assert.equal(gate.snapshot().consecutive429, 0);
  assert.equal(gate.snapshot().cooldownUntil, null);
  assert.deepEqual(saved, { nextAllowedAt: now + 7_000, consecutive429: 0 });
});

test("repeated throttling caps fallback backoff without shortening a longer server deadline", async () => {
  let now = START;
  const gate = new SolanaProviderCadence({ now: () => now });
  for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    await assert.rejects(gate.run(async () => { throw new SolanaProviderRateLimitError("GeckoTerminal", now); }), (error: unknown) => error instanceof SolanaProviderRateLimitError && error.retryAt === now + delay);
    now += delay;
  }
  const serverDeadline = now + 24 * 60 * 60_000;
  await assert.rejects(gate.run(async () => { throw new SolanaProviderRateLimitError("GeckoTerminal", serverDeadline); }), (error: unknown) => error instanceof SolanaProviderRateLimitError && error.retryAt === serverDeadline);
});

test("another persisted cooldown observed during the spacing wait prevents HTTP", async () => {
  let now = START, calls = 0;
  let saved: ProviderCadenceState | undefined;
  const gate = new SolanaProviderCadence({ now: () => now, persistence: { read: () => saved, write: (state) => { saved = state; } }, sleep: async (ms) => { now += ms; saved = { nextAllowedAt: now + 600_000, consecutive429: 1 }; } });
  await gate.run(async () => { calls++; });
  await assert.rejects(gate.run(async () => { calls++; }), (error: unknown) => error instanceof SolanaProviderRateLimitError && error.retryAt === now + 600_000);
  assert.equal(calls, 1);
});

test("a stalled test clock fails closed instead of busy waiting or starting requests too early", async () => {
  let calls = 0, sleeps = 0;
  const gate = new SolanaProviderCadence({ now: () => START, sleep: async () => { sleeps++; } });
  await gate.run(async () => { calls++; });
  await assert.rejects(gate.run(async () => { calls++; }), /Časový zdroj/);
  assert.equal(calls, 1);
  assert.equal(sleeps, 3);
  assert.throws(() => new SolanaProviderCadence({ intervalMs: 1 }), /rozestup/);
  const fixture = new SolanaProviderCadence({ now: () => START, intervalMs: 0 });
  await fixture.run(async () => {}); await fixture.run(async () => {});
});

test("a failed durable reservation prevents HTTP and a failed cooldown write retains the in-process limit", async () => {
  let now = START, calls = 0, writes = 0;
  const unavailable = new Error("storage unavailable");
  const blocked = new SolanaProviderCadence({ now: () => now, persistence: { read: () => undefined, write: () => { throw unavailable; } } });
  await assert.rejects(blocked.run(async () => { calls++; }), (error) => error === unavailable);
  assert.equal(calls, 0);
  const gate = new SolanaProviderCadence({ now: () => now, persistence: { read: () => undefined, write: () => { if (++writes === 2) throw unavailable; } } });
  await assert.rejects(gate.run(async () => { calls++; throw new SolanaProviderRateLimitError("GeckoTerminal", now + 300_000); }), (error) => error === unavailable);
  assert.equal(gate.snapshot().cooldownUntil, START + 300_000);
  now += 10_000;
  await assert.rejects(gate.run(async () => { calls++; }), (error: unknown) => error instanceof SolanaProviderRateLimitError && error.retryAt === START + 300_000);
  assert.equal(calls, 1);
});
