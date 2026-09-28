/**
 * Generation gate: DeepSeek refuses a send while the account already has the
 * maximum number of concurrent generations running ("Another message is being
 * generated" — observed limit: 2). This gate turns that server-side refusal
 * into bridge-side FIFO queueing: a turn waits for a slot before runTurn
 * starts, so clients observe a longer time-to-first-byte ("thinking") instead
 * of an error. No client-side special casing needed.
 *
 * Scope: the slot spans the WHOLE runTurn (bind, reset, send, stream, repair,
 * commit). Bind/reset do not generate, so this is deliberately slightly
 * conservative — it keeps slot accounting trivial and covers repair rounds,
 * which are a second generation inside the same turn (Appendix A).
 */
import { log } from "../log.js";

export type GateRejectCode = "queue_full" | "queue_timeout" | "client_gone";

/** Typed rejection so the bridge can map it onto the HTTP taxonomy
 * (facade/errors.ts) without core importing facade. */
export class GateRejectionError extends Error {
  constructor(
    readonly code: GateRejectCode,
    readonly retryAfterSec: number,
    message: string
  ) {
    super(message);
    this.name = "GateRejectionError";
  }
}

export interface TurnGateOptions {
  /** Max turns holding a generation slot at once. 0 disables the gate. */
  maxConcurrent: number;
  /** Max turns allowed to wait. Overflow fails fast (queue_full). */
  capacity: number;
  /** Max ms a turn may wait. 0 waits forever. Overflow fails (queue_timeout). */
  queueTimeoutMs: number;
}

export interface TurnGateStats {
  disabled: boolean;
  active: number;
  waiting: number;
  max_concurrent: number;
  queue_capacity: number;
  queue_timeout_ms: number;
}

interface Waiter {
  sessionId: string;
  enqueuedAt: number;
  timer: NodeJS.Timeout | null;
  settled: boolean;
  resolve: (queuedMs: number) => void;
  reject: (e: GateRejectionError) => void;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
}

export class TurnGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly opts: TurnGateOptions) {}

  get disabled(): boolean {
    return this.opts.maxConcurrent <= 0;
  }

  stats(): TurnGateStats {
    return {
      disabled: this.disabled,
      active: this.active,
      waiting: this.waiters.length,
      max_concurrent: this.opts.maxConcurrent,
      queue_capacity: this.opts.capacity,
      queue_timeout_ms: this.opts.queueTimeoutMs,
    };
  }

  /**
   * Take a generation slot, queueing FIFO when all slots are busy.
   * Resolves with the ms spent waiting (0 when admitted immediately).
   * Rejects with GateRejectionError on queue_full / queue_timeout /
   * client-side abort while queued.
   */
  async acquire(sessionId: string, signal?: AbortSignal): Promise<number> {
    if (this.disabled) return 0;
    if (signal?.aborted) throw this.clientGone(sessionId);
    if (this.active < this.opts.maxConcurrent) {
      this.active += 1;
      return 0;
    }
    if (this.waiters.length >= this.opts.capacity) {
      log.audit("turn.gate.full", {
        sessionId,
        waiting: this.waiters.length,
        capacity: this.opts.capacity,
      });
      throw new GateRejectionError(
        "queue_full",
        5,
        `turn queue full (${this.waiters.length}/${this.opts.capacity}); retry shortly`
      );
    }

    const enqueuedAt = Date.now();
    const waiter: Waiter = {
      sessionId,
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
        log.audit("turn.gate.client-gone", { sessionId, waitedMs: Date.now() - enqueuedAt });
        this.settle(waiter, () => waiter.reject(this.clientGone(sessionId)));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    if (this.opts.queueTimeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        log.audit("turn.gate.timeout", { sessionId, waitedMs: Date.now() - enqueuedAt });
        this.settle(
          waiter,
          () =>
            waiter.reject(
              new GateRejectionError(
                "queue_timeout",
                5,
                `queued turn wait exceeded ${this.opts.queueTimeoutMs}ms`
              )
            )
        );
      }, this.opts.queueTimeoutMs);
      waiter.timer.unref?.();
    }

    this.waiters.push(waiter);
    log.audit("turn.gate.wait", {
      sessionId,
      position: this.waiters.length,
      active: this.active,
    });
    return new Promise<number>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
  }

  /** Give the current slot back and admit the next queued turn, if any. */
  release(): void {
    if (this.disabled) return;
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length > 0 && this.active < this.opts.maxConcurrent) {
      const waiter = this.waiters.shift() as Waiter;
      this.active += 1;
      const queuedMs = Date.now() - waiter.enqueuedAt;
      if (queuedMs > 0) log.info("turn.gate.admit", { sessionId: waiter.sessionId, queuedMs });
      this.settle(waiter, () => waiter.resolve(queuedMs));
    }
  }

  /** Settle exactly once: unqueue, disarm timer/listener, then run fn. */
  private settle(waiter: Waiter, fn: () => void): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    const i = this.waiters.indexOf(waiter);
    if (i !== -1) this.waiters.splice(i, 1);
    fn();
  }

  private clientGone(sessionId: string): GateRejectionError {
    return new GateRejectionError(
      "client_gone",
      0,
      `client disconnected while turn was queued (session ${sessionId})`
    );
  }
}
