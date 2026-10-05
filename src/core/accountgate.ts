/**
 * AccountTurnGate (ADR-12v3): keyed generation gate — N accounts ×
 * per-account slots, ONE FIFO waiter queue PER ACCOUNT.
 *
 * v3 revision (place-then-stick): with rotation gone, a waiter bound to
 * account X can only ever be admitted when X itself frees a slot. The v2
 * single global queue was therefore both unnecessary and unsafe — its
 * pump(freedAccount) admitted whichever waiter sat at the global head and
 * charged `freedAccount`, so a foreign-account head could be admitted
 * without any capacity check on its own account while a phantom slot was
 * pinned on the freeing one (capacity drift on both sides). The queue is
 * now per account: release(X) pumps X's queue head only, and every
 * admission charges the account whose slot actually freed. Waiters are
 * never dropped or reordered within an account; per-account capacity is
 * exact by construction.
 *
 * Same contract as the global TurnGate (GateRejectionError shapes, queue
 * timeout, client-gone abort), keyed by account instead of process-wide.
 * Drop-in: lives beside TurnGate in src/core/turngate.ts.
 */

import { GateRejectionError } from "./turngate.js";
import { log } from "../log.js";

export interface AccountTurnGateOptions {
  /** Slots per account (the provider cap is per account: 2). 0 disables. */
  perAccountConcurrent: number;
  /** Total waiters bound across all per-account queues. */
  capacity: number;
  queueTimeoutMs: number;
}

interface Waiter {
  sessionId: string;
  accountId: string;
  enqueuedAt: number;
  timer: NodeJS.Timeout | null;
  settled: boolean;
  resolve: (queuedMs: number) => void;
  reject: (e: GateRejectionError) => void;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
}

export class AccountTurnGate {
  private activeByAccount = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();

  constructor(private readonly opts: AccountTurnGateOptions) {}

  get disabled(): boolean {
    return this.opts.perAccountConcurrent <= 0;
  }

  activeOn(accountId: string): number {
    return this.activeByAccount.get(accountId) ?? 0;
  }

  hasFreeSlot(accountId: string): boolean {
    return this.disabled || this.activeOn(accountId) < this.opts.perAccountConcurrent;
  }

  private queueFor(accountId: string): Waiter[] {
    let q = this.queues.get(accountId);
    if (!q) {
      q = [];
      this.queues.set(accountId, q);
    }
    return q;
  }

  private totalQueued(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  async acquire(accountId: string, sessionId: string, signal?: AbortSignal): Promise<number> {
    if (this.disabled) return 0;
    if (signal?.aborted) throw this.clientGone(sessionId);
    if (this.hasFreeSlot(accountId)) {
      this.activeByAccount.set(accountId, this.activeOn(accountId) + 1);
      return 0;
    }
    if (this.totalQueued() >= this.opts.capacity) {
      log.audit("turn.gate.full", { sessionId, waiting: this.totalQueued() });
      throw new GateRejectionError(
        "queue_full",
        5,
        `turn queue full (${this.totalQueued()}/${this.opts.capacity}); retry shortly`
      );
    }
    const enqueuedAt = Date.now();
    const waiter: Waiter = {
      sessionId,
      accountId,
      enqueuedAt,
      timer: null,
      settled: false,
      resolve: () => {},
      reject: () => {},
      signal: signal ?? null,
      onAbort: null,
    };
    if (signal) {
      waiter.onAbort = () => {
        log.audit("turn.gate.client-gone", { sessionId });
        this.settle(waiter, () => waiter.reject(this.clientGone(sessionId)));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    if (this.opts.queueTimeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        this.settle(waiter, () => {
          waiter.reject(
            new GateRejectionError(
              "queue_timeout",
              5,
              `queued turn wait exceeded ${this.opts.queueTimeoutMs}ms`
            )
          );
        });
      }, this.opts.queueTimeoutMs);
      waiter.timer.unref?.();
    }
    this.queueFor(accountId).push(waiter);
    log.audit("turn.gate.wait", {
      sessionId,
      account: accountId,
      position: this.queueFor(accountId).length,
    });
    return new Promise<number>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
  }

  /** Release one slot on `accountId` and admit that account's own FIFO
   * head — never a waiter bound to another account (ADR-12v3 fix). */
  release(accountId: string): void {
    if (this.disabled) return;
    const next = Math.max(0, this.activeOn(accountId) - 1);
    this.activeByAccount.set(accountId, next);
    this.pump(accountId);
  }

  private pump(freedAccount: string): void {
    if (this.waitersOn(freedAccount) === 0) return;
    if (!this.hasFreeSlot(freedAccount)) return;
    const q = this.queueFor(freedAccount);
    const waiter = q.shift() as Waiter;
    this.activeByAccount.set(freedAccount, this.activeOn(freedAccount) + 1);
    const queuedMs = Date.now() - waiter.enqueuedAt;
    if (queuedMs > 0) log.info("turn.gate.admit", { sessionId: waiter.sessionId, queuedMs });
    this.settle(waiter, () => waiter.resolve(queuedMs));
  }

  private waitersOn(accountId: string): number {
    return this.queues.get(accountId)?.length ?? 0;
  }

  private settle(waiter: Waiter, fn: () => void): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    const q = this.queueFor(waiter.accountId);
    const i = q.indexOf(waiter);
    if (i !== -1) q.splice(i, 1);
    fn();
  }

  private clientGone(sessionId: string): GateRejectionError {
    return new GateRejectionError("client_gone", 0, `client disconnected while turn was queued (session ${sessionId})`);
  }

  stats(): Record<string, unknown> {
    return {
      disabled: this.disabled,
      per_account_concurrent: this.opts.perAccountConcurrent,
      waiting: this.totalQueued(),
      accounts: [...this.activeByAccount.entries()].map(([account, active]) => ({
        account,
        active,
        queued: this.waitersOn(account),
      })),
    };
  }
}
