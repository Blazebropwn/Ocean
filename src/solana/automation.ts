import type { Config } from "../config.js";
import type { UserRecord } from "../db.js";
import { hasSolanaPilotAccess, SolanaPaperEngine } from "./engine.js";
import { CYCLE_COOLDOWN_MS, PaperBusyError } from "./store.js";

export type SolanaAutomationOptions = { now?: () => number; schedulingEnabled?: boolean };

/** A single account PAPER scheduler. It never holds a wallet or sends a transaction. */
export class SolanaPaperAutomation {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly jobs = new Set<Promise<unknown>>();
  private autoRunning = false;
  private closed = false;
  readonly now: () => number;

  constructor(readonly engine: SolanaPaperEngine, private readonly config: Config, private readonly options: SolanaAutomationOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private authorized(userId: string) {
    const user = this.engine.store.db.prepare("SELECT * FROM users WHERE id=?").get(userId) as UserRecord | undefined;
    return hasSolanaPilotAccess(user, this.config);
  }

  private existingControl(userId: string) {
    return this.engine.store.db.prepare("SELECT enabled,generation FROM solana_paper_automation WHERE user_id=?").get(userId) as { enabled: number; generation: number } | undefined;
  }

  private stopRevoked(userId: string) {
    // No account may be recreated if deletion revoked the pilot while an API awaited.
    this.engine.store.db.prepare("UPDATE solana_paper_automation SET enabled=0,generation=generation+1,next_run_at=NULL,last_error=NULL,updated_at=? WHERE user_id=? AND enabled=1").run(this.now(), userId);
  }

  private schedule(at: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.options.schedulingEnabled === false) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, Math.max(0, at - this.now()));
    this.timer.unref();
  }

  start() {
    const userId = this.config.solanaPilotUserId;
    if (!userId || this.closed) return;
    if (!this.authorized(userId)) { this.stopRevoked(userId); return; }
    const control = this.engine.store.automation(userId, this.now());
    // Only a saved explicit run intent resumes. A new pilot stays paused.
    if (control.enabled) this.schedule(control.next_run_at ?? this.now());
  }

  snapshot(userId: string, compact = false) {
    const snapshot = this.engine.snapshot(userId, compact);
    const control = this.engine.store.automation(userId, this.now());
    return { ...snapshot, automation: {
      enabled: Boolean(control.enabled),
      status: !control.enabled ? "paused" as const : snapshot.runtime.running ? "running" as const : control.last_error ? "error" as const : "waiting" as const,
      intervalSeconds: CYCLE_COOLDOWN_MS / 1_000,
      nextRunAt: control.enabled && control.next_run_at !== null ? new Date(control.next_run_at).toISOString() : null,
      lastError: control.last_error,
    } };
  }

  setEnabled(userId: string, enabled: boolean) {
    if (this.closed || !this.authorized(userId)) throw new Error("Přístup k automatu už není platný.");
    const before = this.engine.store.automation(userId, this.now());
    const control = this.engine.store.setAutomation(userId, enabled, this.now());
    if (Boolean(before.enabled) !== enabled) this.engine.store.event(userId, null, "logger", "ok", null,
      enabled ? "PAPER automat spuštěný uživatelem; cykly pokračují i po zavření prohlížeče a po restartu serveru." : "PAPER automat pozastavený uživatelem; žádné další automatické vstupy ani nové cykly přecenění a výstupů.", {}, this.now());
    if (enabled) this.schedule(control.next_run_at ?? this.now());
    else if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return this.snapshot(userId);
  }

  async runManual(userId: string, authorize: () => boolean, positionId?: string) {
    if (this.closed) throw new Error("Server dokončuje běžící PAPER cykly.");
    const job = this.engine.cycle(userId, authorize, positionId, { allowEntry: () => !this.closed });
    this.jobs.add(job);
    try { await job; return this.snapshot(userId); }
    finally { this.jobs.delete(job); }
  }

  /** Public for deterministic tests; normal callers use the durable start/pause route. */
  async tick() {
    const userId = this.config.solanaPilotUserId;
    if (this.closed || this.autoRunning || !userId) return;
    if (!this.authorized(userId)) { this.stopRevoked(userId); return; }
    const control = this.engine.store.automation(userId, this.now());
    if (!control.enabled) return;
    if (control.next_run_at !== null && control.next_run_at > this.now()) { this.schedule(control.next_run_at); return; }
    const generation = control.generation;
    const allowEntry = () => {
      if (this.closed || !this.authorized(userId)) return false;
      const current = this.existingControl(userId);
      return Boolean(current?.enabled && current.generation === generation);
    };
    this.autoRunning = true;
    const job = this.engine.cycle(userId, () => this.authorized(userId), undefined, { allowEntry });
    this.jobs.add(job);
    try {
      await job;
      const account = this.engine.store.account(userId);
      if (account) this.engine.store.scheduleAutomation(userId, generation, Math.max(this.now(), (account.last_cycle_at ?? this.now()) + CYCLE_COOLDOWN_MS), null, 0, this.now());
    } catch (error) {
      if (!this.authorized(userId)) this.stopRevoked(userId);
      else if (error instanceof PaperBusyError) this.engine.store.scheduleAutomation(userId, generation, error.retryAt, control.last_error, control.failure_count, this.now());
      else {
        const failures = control.failure_count + 1;
        const backoff = Math.min(15 * 60_000, CYCLE_COOLDOWN_MS * 2 ** Math.min(failures, 4));
        this.engine.store.scheduleAutomation(userId, generation, this.now() + backoff, error instanceof Error ? error.message : "Tržní data nejsou dostupná.", failures, this.now());
      }
    } finally {
      this.jobs.delete(job);
      this.autoRunning = false;
      if (!this.closed && this.authorized(userId)) {
        const current = this.engine.store.automation(userId, this.now());
        if (current.enabled) {
          // A pause/start invalidates the old entry permit, even if it happened in one API await.
          if (current.generation !== generation) {
            const account = this.engine.store.account(userId);
            this.engine.store.scheduleAutomation(userId, current.generation, Math.max(this.now(), (account.last_cycle_at ?? this.now()) + CYCLE_COOLDOWN_MS), null, 0, this.now());
          }
          this.schedule(this.engine.store.automation(userId, this.now()).next_run_at ?? this.now() + CYCLE_COOLDOWN_MS);
        }
      } else if (!this.closed) this.stopRevoked(userId);
    }
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.jobs]);
  }
}
