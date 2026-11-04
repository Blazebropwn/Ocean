export const GECKO_REQUEST_INTERVAL_MS = 7_000;
export const PROVIDER_MIN_RATE_LIMIT_MS = 60_000;
export const PROVIDER_MAX_BACKOFF_MS = 15 * 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_FAILURES = 32;

export type ProviderCadenceState = { nextAllowedAt: number; consecutive429: number };
export type ProviderCadencePersistence = {
  read: () => ProviderCadenceState | undefined;
  write: (state: ProviderCadenceState) => void;
};
type CadenceOptions = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Zero is reserved for deterministic provider fixtures; production uses the default. */
  intervalMs?: number;
  persistence?: ProviderCadencePersistence;
};

function validTime(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

function addDelay(now: number, delay: number) {
  return Math.min(MAX_DATE_MS, now + delay);
}

/** An absolute deadline avoids losing Retry-After when crossing scheduler layers. */
export class SolanaProviderRateLimitError extends Error {
  readonly httpStatus = 429;

  constructor(readonly provider: string, readonly retryAt: number) {
    if (!validTime(retryAt)) throw new Error("Neplatný čas opakování požadavku.");
    super(`${provider}: HTTP 429; další požadavek nejdříve ${new Date(retryAt).toISOString()}.`);
    this.name = "SolanaProviderRateLimitError";
  }
}

/** Both HTTP forms are accepted. Oversized positive delays saturate without overflow or an early retry. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!validTime(now)) throw new Error("Neplatný čas poskytovatele dat.");
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = trimmed.replace(/^0+/, "") || "0";
    if (seconds.length > 20) return MAX_DATE_MS;
    const deadline = BigInt(now) + BigInt(seconds) * 1_000n;
    return deadline > BigInt(MAX_DATE_MS) ? MAX_DATE_MS : Number(deadline);
  }
  // Restrict Date.parse to HTTP-date forms; values such as "1.5" must not become dates.
  const httpDate = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;
  if (!httpDate.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return validTime(parsed) ? Math.max(now, parsed) : null;
}

/** Serializes every Gecko request, including discovery pages and watched-pool refreshes. */
export class SolanaProviderCadence {
  private queue: Promise<void> = Promise.resolve();
  private state: ProviderCadenceState = { nextAllowedAt: 0, consecutive429: 0 };
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly intervalMs: number;

  constructor(private readonly options: CadenceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.intervalMs = options.intervalMs ?? GECKO_REQUEST_INTERVAL_MS;
    if (this.intervalMs !== 0 && (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < GECKO_REQUEST_INTERVAL_MS || this.intervalMs > MAX_DATE_MS)) {
      throw new Error("Neplatný rozestup požadavků GeckoTerminal.");
    }
    this.synchronize();
  }

  private time() {
    const now = this.now();
    if (!validTime(now)) throw new Error("Neplatný čas poskytovatele dat.");
    return now;
  }

  private synchronize() {
    const saved = this.options.persistence?.read();
    if (!saved) return;
    if (!validTime(saved.nextAllowedAt) || !Number.isInteger(saved.consecutive429) || saved.consecutive429 < 0 || saved.consecutive429 > MAX_FAILURES) {
      throw new Error("Neplatný uložený limit poskytovatele dat.");
    }
    this.state = {
      nextAllowedAt: Math.max(this.state.nextAllowedAt, saved.nextAllowedAt),
      consecutive429: Math.max(this.state.consecutive429, saved.consecutive429),
    };
  }

  private save(state: ProviderCadenceState) {
    this.state = state;
    this.options.persistence?.write({ ...state });
  }

  snapshot() {
    this.synchronize();
    return { ...this.state, cooldownUntil: this.state.consecutive429 > 0 && this.state.nextAllowedAt > this.time() ? this.state.nextAllowedAt : null };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.synchronize();
      let now = this.time();
      // A rate-limit pause is returned to the scheduler, never held in a minutes-long queue sleep.
      if (this.state.consecutive429 > 0 && this.state.nextAllowedAt > now) {
        throw new SolanaProviderRateLimitError("GeckoTerminal", this.state.nextAllowedAt);
      }
      // Recheck after sleeping: another process may have persisted a longer cooldown meanwhile.
      for (let waits = 0; this.state.nextAllowedAt > now; waits++) {
        if (waits >= 3) throw new Error("Časový zdroj nepotvrdil rozestup požadavků GeckoTerminal.");
        await this.sleep(this.state.nextAllowedAt - now);
        this.synchronize();
        now = this.time();
        if (this.state.consecutive429 > 0 && this.state.nextAllowedAt > now) {
          throw new SolanaProviderRateLimitError("GeckoTerminal", this.state.nextAllowedAt);
        }
      }
      const reservedAt = addDelay(now, this.intervalMs);
      this.save({ ...this.state, nextAllowedAt: reservedAt });
      try {
        const result = await task();
        // Do not erase a newer cooldown persisted while the request was pending.
        const before = { ...this.state };
        this.synchronize();
        const newerCooldown = this.state.consecutive429 > before.consecutive429 || this.state.nextAllowedAt > reservedAt && this.state.consecutive429 > 0;
        this.save({ nextAllowedAt: this.state.nextAllowedAt, consecutive429: newerCooldown ? this.state.consecutive429 : 0 });
        return result;
      } catch (error) {
        if (!(error instanceof SolanaProviderRateLimitError)) throw error;
        this.synchronize();
        const failures = Math.min(MAX_FAILURES, this.state.consecutive429 + 1);
        const delay = Math.min(PROVIDER_MAX_BACKOFF_MS, PROVIDER_MIN_RATE_LIMIT_MS * 2 ** Math.min(failures - 1, 4));
        const retryAt = Math.max(this.state.nextAllowedAt, error.retryAt, addDelay(this.time(), delay));
        this.save({ nextAllowedAt: retryAt, consecutive429: failures });
        throw new SolanaProviderRateLimitError(error.provider, retryAt);
      }
    } finally { release(); }
  }
}
