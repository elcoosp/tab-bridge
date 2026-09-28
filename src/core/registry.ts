/**
 * Session registry (spec 5.3): rows, per-session mutex, TTL sweep, eviction.
 * Pure in-process state; persistence is delegated to a PersistStore hook.
 */
import { Mutex, randomId } from "../util/async.js";
import { CHAIN_SCHEME } from "./hashchain.js";

export type SessionState = "active" | "resetting" | "draining";
export type StateMode = "stateful" | "always-reset";

export interface SessionRow {
  sessionId: string;
  tabId: number | null;
  chain: string[];
  tabHash: string | null;
  turns: number;
  state: SessionState;
  mode: StateMode;
  scheme: number;
  createdAt: number;
  lastUsed: number;
  /** Ephemeral sessions (stateless legacy path) are never persisted. */
  ephemeral?: boolean;
  /**
   * A previous turn failed after the prompt may have been submitted (e.g.
   * DeepSeek "Messages too frequent" accepts the message, then errors). The
   * tab may hold an orphan user message, so the next turn must reset+reseed
   * instead of injecting into a conversation the bridge cannot vouch for.
   */
  pendingReset?: boolean;
}

export interface PersistStore {
  append(row: SessionRow): void;
}

export interface RegistryOptions {
  mode: StateMode;
  ttlMs: number;
  sweepIntervalMs?: number;
  persist?: PersistStore;
  onEvict?: (sessionId: string) => void;
}

export class SessionRegistry {
  private rows = new Map<string, SessionRow>();
  private locks = new Map<string, Mutex>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.startSweep(opts.sweepIntervalMs ?? 60_000);
  }

  get mode(): StateMode {
    return this.opts.mode;
  }

  get size(): number {
    return this.rows.size;
  }

  /** Existing row or undefined. */
  get(sessionId: string): SessionRow | undefined {
    return this.rows.get(sessionId);
  }

  /** Get or create a row (fresh rows start empty and SEED on first use). */
  getOrCreate(sessionId: string, ephemeral = false): SessionRow {
    const existing = this.rows.get(sessionId);
    if (existing) return existing;
    const now = Date.now();
    const row: SessionRow = {
      sessionId,
      tabId: null,
      chain: [],
      tabHash: null,
      turns: 0,
      state: "active",
      mode: this.opts.mode,
      scheme: CHAIN_SCHEME,
      createdAt: now,
      lastUsed: now,
      ...(ephemeral ? { ephemeral: true } : {}),
    };
    this.rows.set(sessionId, row);
    return row;
  }

  /** Insert a row restored from the persistence journal (boot replay). */
  restore(row: SessionRow): void {
    if (!this.rows.has(row.sessionId)) {
      row.mode = this.opts.mode;
      this.rows.set(row.sessionId, row);
    }
  }

  /** Anonymous session for the stateless legacy path. */
  createEphemeral(): SessionRow {
    return this.getOrCreate(`anon-${randomId(8)}`, true);
  }

  lockFor(sessionId: string): Mutex {
    let mu = this.locks.get(sessionId);
    if (!mu) {
      mu = new Mutex();
      this.locks.set(sessionId, mu);
    }
    return mu;
  }

  dropLock(sessionId: string): void {
    this.locks.delete(sessionId);
  }

  /** Whether a lock is currently held (used to reject overlap with 409). */
  isBusy(sessionId: string): boolean {
    return this.locks.get(sessionId)?.isLocked ?? false;
  }

  touch(row: SessionRow): void {
    row.lastUsed = Date.now();
  }

  /** Commit a completed turn: update chain bookkeeping and persist. */
  commit(row: SessionRow, chain: string[], tabHash: string | null): void {
    row.chain = chain;
    row.tabHash = tabHash;
    row.turns += 1;
    row.state = "active";
    row.pendingReset = false;
    // Adopt the current scheme: without this, a migrated row (scheme 1/2
    // chain reseeded under scheme 3) mismatches forever and every turn
    // reseeds instead of continuing.
    row.scheme = CHAIN_SCHEME;
    this.touch(row);
    if (!row.ephemeral) this.opts.persist?.append(row);
  }

  /**
   * Mark a failed turn whose prompt may have reached the tab. Persisted so a
   * restart still reseeds instead of injecting after an orphan message.
   */
  markFailed(row: SessionRow): void {
    row.pendingReset = true;
    if (row.chain.length > 0) row.tabHash = null;
    this.touch(row);
    if (!row.ephemeral) this.opts.persist?.append(row);
  }

  list(): SessionRow[] {
    return [...this.rows.values()].filter((r) => !r.ephemeral);
  }

  /** Delete a session. Returns the removed row or undefined. */
  delete(sessionId: string): SessionRow | undefined {
    const row = this.rows.get(sessionId);
    if (!row) return undefined;
    row.state = "draining";
    this.rows.delete(sessionId);
    this.locks.delete(sessionId);
    return row;
  }

  /** Evict the oldest idle non-ephemeral session (?force=true on create). */
  evictOldestIdle(): SessionRow | undefined {
    let oldest: SessionRow | undefined;
    for (const r of this.rows.values()) {
      if (r.ephemeral) continue;
      if (this.isBusy(r.sessionId)) continue;
      if (!oldest || r.lastUsed < oldest.lastUsed) oldest = r;
    }
    if (oldest) {
      this.delete(oldest.sessionId);
      this.opts.onEvict?.(oldest.sessionId);
    }
    return oldest;
  }

  private startSweep(intervalMs: number): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  /** Expire sessions idle past TTL. Ephemeral rows are never swept by TTL. */
  sweep(now = Date.now()): string[] {
    const expired: string[] = [];
    for (const r of this.rows.values()) {
      if (r.ephemeral) continue;
      if (this.isBusy(r.sessionId)) continue;
      if (now - r.lastUsed >= this.opts.ttlMs) expired.push(r.sessionId);
    }
    for (const id of expired) {
      this.delete(id);
      this.opts.onEvict?.(id);
    }
    return expired;
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
