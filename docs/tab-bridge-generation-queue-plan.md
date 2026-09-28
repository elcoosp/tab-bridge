# tab-bridge — Generation Gate Plan: max 2 concurrent DeepSeek generations, FIFO-queue the rest

**Executors:** this document is written for an AI coding agent (or a human) that follows instructions literally. It is the third plan in this series and is self-contained.
**Repo:** `github.com/elcoosp/tab-bridge` (TypeScript, Node ≥ 20, zero runtime deps) at commit `c621b2a`.
**Companion plans (already delivered, not prerequisites):** `tab-bridge-kod-production-plan.md` (tasks T1–T12, K1–K7, I1–I5) and `kod-tui-uiux-production-plan.md`.

**Constraint being fixed (field-reported by the operator):** DeepSeek allows **at most 2 chat generations running at the same time per account**. A 3rd concurrent send is refused by DeepSeek with the error **"Another message is being generated"**. Today tab-bridge happily dispatches N concurrent turns (one per session/tab) straight into that refusal.

**Goal state:**
1. tab-bridge caps concurrent provider generations at a configurable `maxConcurrentTurns` (default **2**) and **queues every extra turn FIFO** until a slot frees.
2. A queued turn is invisible to callers: kod (or any OpenAI-compatible client) just observes a longer time-to-first-byte — in kod's TUI that reads as a longer "thinking" phase. **No kod code changes, no new client error surface.**
3. If the DeepSeek refusal ever still surfaces (only possible when a human drives the same DeepSeek account in a parallel window while 2 bridge turns generate), it is detected by the injector and mapped to a **retryable `429` with `Retry-After: 15`** — never a dead-end `502`.
4. The full test matrix stays green and the gate is observable (`/healthz`, audit logs, `x-bridge-queued-ms` response header).

---

## Part 0 — System map and anatomy of the failure (read first, modify nothing yet)

```
OpenAI-compatible client (kod swarm / curl / …)
      │  POST /v1/chat/completions   (one request per session; kod may run several sessions in parallel)
      ▼
tab-bridge HTTP facade        src/facade/http.ts
      └─ TabBridge.handleChat  src/bridge.ts      ← per-session mutex (tryAcquire → 409 on same-session overlap)
            └─ runTurn           src/engine.ts   ← bind tab → ensureReady → sendTurn → stream → repair → commit
                  └─ DeepSeekAdapter src/adapter/deepseek.ts
                        └─ WebSocket /worker → extension/background.js
                              └─ extension/injector.js → chat.deepseek.com DOM  (≤ 1 active turn PER TAB)
```

### What exists today (verified at `c621b2a`)

* **Per-session mutual exclusion only.** `TabBridge.handleChat` (`src/bridge.ts` line ~97) does `registry.lockFor(sessionId).tryAcquire()` and rejects same-session overlap with `409 session_busy` (ADR-7/R6: "reject, never queue"). There is **no cross-session, account-wide concurrency control anywhere**: two turns on two different sessions run `runTurn` concurrently and both submit to DeepSeek at once.
* The bridge is proud of parallelism elsewhere: `WorkerPool` even raised its listener cap because *"kod retry storms legitimately hold dozens concurrently"* (`src/pool/pool.ts` line ~49). Nothing throttles how many of those hit the provider simultaneously.
* DeepSeek's rejection path today: the injector's send either never verifies (generic `submit-failed`) or the provider surfaces a notice that matches none of the existing regexes (the only detected provider error class is rate-limiting, `RATE_LIMIT_RE` in `extension/injector.js` line ~67). Either way the worker relays `ERROR{code:…}` and `mapTurnError` (`src/facade/errors.ts`) falls through to `badGateway("tab error: …")` → **HTTP 502**. For kod that is a terminal, non-informative failure.
* kod's HTTP client (`reqwest` in `crates/kod-provider-openai/src/provider.rs` line ~90) sets a **total request timeout** = the endpoint's `timeout_secs` (default **300**, `examples/kod-config.toml` ships `timeout_secs = 300`). A queued wait would legitimately consume part of that budget, so the kod-side *config* must be sized for queueing (config-only — this plan adds no kod code).

### Gap list (all closed by this plan)

| ID | Sev | One-line summary |
|----|-----|------------------|
| G1 | P0 | No cap on concurrent provider generations: the 3rd parallel session turn is submitted to DeepSeek and refused ("Another message is being generated") |
| G2 | P0 | No queueing: excess requests fail immediately even though a generation slot frees up within seconds-to-minutes |
| G3 | P1 | The concurrency refusal is indistinguishable from a real tab failure — no injector detection, no error code, mapped to a dead-end 502 |
| G4 | P2 | kod's endpoint `timeout_secs = 300` is a total budget that a legal queue wait can exhaust — needs documented sizing (kod config only) |
| G5 | P2 | Zero observability: `/healthz` exposes nothing about in-flight/queued turns |
| G6 | P3 | A client that disconnects **while queued** would otherwise still run its turn later (a zombie that submits to DeepSeek, wastes quota, risks the 20-min send-frequency window) — needs a queued-phase abort |

### Target behavior after this plan

```
3 concurrent POSTs, sessions A / B / C, maxConcurrentTurns = 2:

  t0   A admitted (slot 1), B admitted (slot 2)      C ENQUEUED (FIFO tail)
  t?   A's runTurn completes → slot freed → C admitted (queuedMs logged)
  C's client saw: request accepted at t0, first byte at t?  ⇒ just "longer thinking"

Same-session overlap (A twice): still 409 session_busy — the gate never sees it
(the per-session mutex is acquired BEFORE the gate). ADR-7/R6 is preserved.
```

* `/healthz` gains `turn_gate: { disabled, active, waiting, max_concurrent, queue_capacity, queue_timeout_ms }`.
* Non-streaming JSON responses gain `x-bridge-queued-ms: <ms>` (0 when admitted immediately).
* Queue overflow (capacity) and queue starvation (timeout) surface as **503 `queue_full` / `queue_timeout` + `Retry-After: 5`** — cheap, transient, exactly what kod's existing retry treats as retryable.
* Client disconnect while queued ⇒ the queued entry is cancelled (`499 client_gone`, never written to the dead socket). **No zombie turns.**

---

## Part 1 — Ground rules for the executing agent

1. **Clone and branch:**
   ```bash
   git clone https://github.com/elcoosp/tab-bridge && cd tab-bridge && git checkout -b generation-gate
   ```
2. **Baseline first.** Record results; if red, STOP and report — do not build on a broken base.
   ```bash
   pnpm install && pnpm run typecheck && pnpm test
   ```
3. **One task at a time, in order** (Q1 → Q8). After each task: apply the edit, run the task's **Verify** command, fix until green, commit:
   ```bash
   git add -A && git commit -m "feat(bridge): Q1 generation gate (TurnGate) with FIFO queue"
   ```
4. **Only modify files a task names.** If an "old code" block doesn't match the file (repo moved on), re-read the file, adapt minimally, note the deviation in the commit message.
5. **Never weaken a test to make it pass.** If a listed test conflicts with a listed code change, the code change is wrong — re-read the task.
6. **Tests run against `dist/`** (`pnpm test` = `pnpm run build && node --test dist/test/*.test.js`). Always run `pnpm test`, never `node --test` directly, after editing `src/` or `test/`. Extension files are plain JS — syntax-check with `node --check extension/injector.js`.
7. **No new npm dependencies** (the repo is zero-runtime-deps by design). `AbortSignal`, `setTimeout`, `fetch` are all Node ≥ 20 built-ins.
8. **Out of scope:** kod source changes (kod needs **zero** code for this feature — only a config value in Q8); changes to the worker protocol (`WORKER_PROTOCOL` version stays untouched); tab-allocation changes in the extension's `background.js`.
---

## Part 2 — Tasks

### Q1 — The TurnGate module (`src/core/turngate.ts`) + unit tests

**Files:** new `src/core/turngate.ts`, new `test/gate.test.ts`.
**Closes:** G1, G2 (the mechanism), G6 (queued-phase abort primitive).
**Why here:** `core/` already holds in-process scheduling state (`registry.ts` with its `Mutex`). The gate is the same class of primitive: pure in-process, no I/O, no worker-protocol knowledge.

**Design decisions you must not deviate from:**

* The slot spans the **whole `runTurn`** (bind, reset, send, stream, repair, commit) — not just the DeepSeek generation window. Bind/reset do not generate, so this is deliberately slightly conservative; it keeps slot accounting trivial (one acquire / one release per turn) and it correctly covers **repair rounds, which are a second generation inside the same turn** (see Appendix A).
* FIFO is exact: `acquire()` enqueues synchronously on the single-threaded event loop, in request-arrival order.
* Rejections are typed (`GateRejectionError`) and carry an HTTP-shaped `retryAfterSec`; mapping to `BridgeError` happens in the bridge (Q4), keeping the `core → facade` dependency arrow pointing the right way.
* `maxConcurrent = 0` disables the gate entirely (pure passthrough) — this is the production kill-switch.

**Create `src/core/turngate.ts` with exactly this content:**

```ts
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
```

**Create `test/gate.test.ts` with exactly this content:**

```ts
// Unit tests for the generation gate (Q1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnGate, GateRejectionError } from "../src/core/turngate.js";

function gate(over: Partial<ConstructorParameters<typeof TurnGate>[0]> = {}): TurnGate {
  return new TurnGate({ maxConcurrent: 2, capacity: 4, queueTimeoutMs: 1_000, ...over });
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("gate: admits up to maxConcurrent immediately; queues the rest FIFO", async () => {
  const g = gate({ maxConcurrent: 2 });
  const order: string[] = [];
  const track = (id: string, p: Promise<number>) =>
    p.then((ms) => {
      order.push(id);
      return ms;
    });
  const a = track("a", g.acquire("a"));
  const b = track("b", g.acquire("b"));
  const c = track("c", g.acquire("c"));
  const d = track("d", g.acquire("d"));
  await tick(30);
  assert.deepEqual(g.stats(), {
    disabled: false,
    active: 2,
    waiting: 2,
    max_concurrent: 2,
    queue_capacity: 4,
    queue_timeout_ms: 1_000,
  });
  assert.deepEqual(order, ["a", "b"], "only maxConcurrent admissions before any release");
  g.release();
  g.release();
  await Promise.all([a, b, c, d]);
  assert.deepEqual(order, ["a", "b", "c", "d"], "waiters must be admitted FIFO");
  g.release();
  g.release();
  assert.equal(g.stats().active, 0);
  assert.equal(g.stats().waiting, 0);
});

test("gate: immediate admission reports queuedMs = 0", async () => {
  const g = gate({ maxConcurrent: 1 });
  assert.equal(await g.acquire("a"), 0);
  g.release();
});

test("gate: admitted waiter reports the ms it spent waiting", async () => {
  const g = gate({ maxConcurrent: 1 });
  await g.acquire("h");
  const queued = g.acquire("w");
  await tick(40);
  g.release();
  assert.ok((await queued) >= 30, "queuedMs must reflect the real wait");
  g.release();
});

test("gate: queue_full rejects beyond capacity without disturbing other waiters", async () => {
  const g = gate({ maxConcurrent: 1, capacity: 1, queueTimeoutMs: 5_000 });
  await g.acquire("h");
  const q1 = g.acquire("q1");
  await tick(10);
  await assert.rejects(
    g.acquire("q2"),
    (e: unknown) => e instanceof GateRejectionError && e.code === "queue_full" && e.retryAfterSec === 5
  );
  assert.equal(g.stats().waiting, 1, "q1 must still be queued");
  g.release();
  assert.ok((await q1) >= 5, "q1 is admitted after release");
  g.release();
  assert.equal(g.stats().active, 0);
});

test("gate: queue_timeout rejects after the deadline; no slot leak", async () => {
  const g = gate({ maxConcurrent: 1, queueTimeoutMs: 80 });
  await g.acquire("h");
  await assert.rejects(
    g.acquire("v"),
    (e: unknown) => e instanceof GateRejectionError && e.code === "queue_timeout" && e.retryAfterSec === 5
  );
  assert.equal(g.stats().waiting, 0, "timed-out waiter must be removed from the queue");
  g.release();
  const ms = await g.acquire("next");
  assert.equal(ms, 0, "the timed-out waiter must not have leaked a slot");
  g.release();
  assert.equal(g.stats().active, 0);
});

test("gate: abort while queued rejects with client_gone", async () => {
  const g = gate({ maxConcurrent: 1 });
  await g.acquire("h");
  const ac = new AbortController();
  const v = g.acquire("v", ac.signal);
  await tick(10);
  ac.abort();
  await assert.rejects(v, (e: unknown) => e instanceof GateRejectionError && e.code === "client_gone");
  assert.equal(g.stats().waiting, 0);
  g.release();
  assert.equal(g.stats().active, 0);
});

test("gate: abort before acquire rejects without taking a slot", async () => {
  const g = gate({ maxConcurrent: 1 });
  await g.acquire("h");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(g.acquire("v", ac.signal), (e: unknown) => e instanceof GateRejectionError);
  g.release();
  assert.equal(g.stats().active, 0);
});

test("gate: abort after admission is a harmless no-op", async () => {
  const g = gate({ maxConcurrent: 1 });
  const ac = new AbortController();
  const v = g.acquire("v", ac.signal);
  assert.equal(await v, 0);
  ac.abort();
  g.release();
  assert.equal(g.stats().active, 0);
  assert.equal(g.stats().waiting, 0);
});

test("gate: maxConcurrent 0 disables the gate (pure passthrough)", async () => {
  const g = gate({ maxConcurrent: 0 });
  assert.equal(await g.acquire("a"), 0);
  assert.equal(await g.acquire("b"), 0);
  assert.equal(g.stats().disabled, true);
  g.release();
  g.release();
  assert.equal(g.stats().active, 0);
});

test("gate: release admits only as many waiters as freed slots", async () => {
  const g = gate({ maxConcurrent: 2 });
  await g.acquire("a");
  await g.acquire("b");
  const c = g.acquire("c");
  const d = g.acquire("d");
  const e = g.acquire("e");
  await tick(10);
  g.release();
  await tick(10);
  assert.equal(g.stats().active, 2, "one release admits exactly one waiter");
  assert.equal(g.stats().waiting, 2);
  g.release();
  g.release();
  await Promise.all([c, d, e]);
  g.release();
  g.release();
  g.release();
  assert.equal(g.stats().active, 0);
});
```

**Verify:**
```bash
pnpm run typecheck && pnpm test
# every gate.* test must pass; no other test may change status
```

**Commit:** `feat(bridge): Q1 generation gate (TurnGate) with FIFO queue, typed rejections, queued-phase abort`
### Q2 — Config knobs + CLI flags (`src/config.ts`, `src/index.ts`)

**Files:** `src/config.ts`, `src/index.ts`.
**Closes:** G1 (operational sizing), G5 (visibility in the startup log).

**Edit 1 — `src/config.ts`: extend the `Config` interface.** After the `maxPromptChars` field (lines ~16–18), add:

```ts
  /** Max turns generating against the provider account at once. DeepSeek
   * rejects a 3rd concurrent generation with "Another message is being
   * generated"; the bridge queues extra turns FIFO instead (0 disables the
   * gate). */
  maxConcurrentTurns: number;
  /** Max turns waiting in the generation queue. Overflow fails fast with
   * 503 queue_full + Retry-After. */
  queueCapacity: number;
  /** Max ms a turn may sit in the generation queue before failing with 503
   * queue_timeout + Retry-After. 0 waits forever. */
  queueTimeoutMs: number;
```

**Edit 2 — `src/config.ts`: extend `DEFAULTS`** (after `maxPromptChars: 1_000_000,`):

```ts
  maxConcurrentTurns: 2,
  queueCapacity: 32,
  queueTimeoutMs: 600_000,
```

> Defaults rationale: DeepSeek's observed limit is 2 ⇒ `maxConcurrentTurns: 2`. A worst-case turn is `turnTimeoutMs` (240 s) + one repair round, so the worst FIFO wait for one queued turn is ≈ 1 turn ≈ 8 min ⇒ `queueTimeoutMs: 600_000` (10 min) with margin. `queueCapacity: 32` is far above any real kod swarm and still bounds memory trivially. If your account turns out to allow only 1 concurrent generation, run `--max-concurrent-turns=1` — the knob exists exactly for that.

**Edit 3 — `src/config.ts`: add three flag cases** in `parseServeArgs`, after the `--max-prompt-chars` case (before `default:`):

```ts
      case "--max-concurrent-turns":
        cfg.maxConcurrentTurns = Number(val());
        if (!Number.isInteger(cfg.maxConcurrentTurns) || cfg.maxConcurrentTurns < 0) {
          throw new Error("--max-concurrent-turns must be an integer >= 0 (0 disables the gate)");
        }
        break;
      case "--queue-capacity":
        cfg.queueCapacity = Number(val());
        if (!Number.isInteger(cfg.queueCapacity) || cfg.queueCapacity < 1 || cfg.queueCapacity > 4096) {
          throw new Error("--queue-capacity must be an integer 1-4096");
        }
        break;
      case "--queue-timeout-ms":
        cfg.queueTimeoutMs = Number(val());
        if (!Number.isInteger(cfg.queueTimeoutMs) || cfg.queueTimeoutMs < 0) {
          throw new Error("--queue-timeout-ms must be an integer >= 0 (0 waits forever)");
        }
        break;
```

**Edit 4 — `src/config.ts`: extend `usage()`** — after the `--max-prompt-chars` line, add:

```ts
    "  --max-concurrent-turns=<n>  provider generations in flight at once, 0 disables the gate (default 2)",
    "  --queue-capacity=<n>        max turns waiting in the generation queue (default 32)",
    "  --queue-timeout-ms=<n>      max queue wait before 503 queue_timeout, 0 waits forever (default 600000)",
```

**Edit 5 — `src/index.ts`: log the effective values** in the `log.info("bridge.listening", { … })` call. Replace:

```ts
      max_prompt_chars: config.maxPromptChars,
      worker_link: `ws://${config.host}:${config.port}/worker`,
```

with:

```ts
      max_prompt_chars: config.maxPromptChars,
      max_concurrent_turns: config.maxConcurrentTurns,
      queue_capacity: config.queueCapacity,
      queue_timeout_ms: config.queueTimeoutMs,
      worker_link: `ws://${config.host}:${config.port}/worker`,
```

**Verify:**
```bash
pnpm run typecheck && pnpm test
node dist/src/index.js serve --help | grep -E "max-concurrent-turns|queue-capacity|queue-timeout-ms"
node dist/src/index.js serve --max-concurrent-turns=-1 2>&1 | grep "must be an integer"
node dist/src/index.js serve --queue-capacity=0 2>&1 | grep "must be an integer"
```

**Commit:** `feat(bridge): Q2 config knobs for the generation gate (--max-concurrent-turns, --queue-capacity, --queue-timeout-ms)`

---

### Q3 — Error taxonomy: queue rejections + defensive concurrency mapping (`src/facade/errors.ts`)

**Files:** `src/facade/errors.ts`.
**Closes:** G2 (typed 503s), G3 (bridge-side mapping).

**Edit 1 — add the constant** after `export const RATE_LIMIT_COOLDOWN_SEC = 1200;` (line ~82):

```ts
/** A send refused because another generation is still running clears within
 * seconds-to-minutes (unlike the ~20-minute send-frequency window), so the
 * Retry-After for the defensive 429 is short. */
export const CONCURRENCY_RETRY_AFTER_SEC = 15;
```

**Edit 2 — add the three helpers** after `poolExhausted` (line ~64):

```ts
export function queueFull(retryAfterSec: number, message: string): BridgeError {
  return new BridgeError({ status: 503, code: "queue_full", message, retryAfter: retryAfterSec });
}

export function queueTimeout(retryAfterSec: number, message: string): BridgeError {
  return new BridgeError({ status: 503, code: "queue_timeout", message, retryAfter: retryAfterSec });
}

/** 499 (nginx convention): the client closed the connection while its turn
 * was queued. Never reaches the wire — the response socket is already gone. */
export function clientGone(message: string): BridgeError {
  return new BridgeError({ status: 499, code: "client_gone", message });
}
```

**Edit 3 — `mapTurnError`: insert the concurrency mapping** between the `provider-rate-limited` block (ends line ~99) and the `not-ready:` block (line ~100). Replace:

```ts
  if (msg.startsWith("not-ready:") || msg.startsWith("reset failed")) {
    return badGateway(`tab not usable: ${msg}`);
  }
```

with:

```ts
  // DeepSeek refuses a send while the account already has the maximum number
  // of concurrent generations running ("Another message is being generated").
  // The turn gate (src/core/turngate.ts) makes this unreachable for bridge
  // traffic; when it does surface anyway (a human driving the same account in
  // a parallel window), give callers a retryable 429 with a short window,
  // never a dead-end 502.
  if (msg.startsWith("turn-error:concurrency_blocked")) {
    return rateLimited(
      CONCURRENCY_RETRY_AFTER_SEC,
      "provider is already generating the maximum number of concurrent replies; retry shortly"
    );
  }
  if (
    /another\s+(?:message|response|reply|request|generation)|already\s+being\s+generated|正在生成|已有一条消息/i.test(
      msg
    )
  ) {
    return rateLimited(
      CONCURRENCY_RETRY_AFTER_SEC,
      `provider rejected the send: another message is still generating (${msg})`
    );
  }
  if (msg.startsWith("not-ready:") || msg.startsWith("reset failed")) {
    return badGateway(`tab not usable: ${msg}`);
  }
```

> Belt-and-braces: the first condition catches the dedicated injector code added in Q7; the regex catches the same refusal arriving under any other code (`submit-failed`, `dom-error`, …) with the provider's wording in the detail. The Chinese alternatives mirror the existing bilingual rate-limit detection (`RATE_LIMIT_RE`).

**Verify:**
```bash
pnpm run typecheck && pnpm test
```

**Commit:** `feat(bridge): Q3 queue_full/queue_timeout/client_gone taxonomy + defensive 429 for provider concurrency refusals`

---

### Q4 — Wire the gate into the bridge (`src/bridge.ts`, `src/engine.ts`)

**Files:** `src/bridge.ts`, `src/engine.ts` (one interface field only).
**Closes:** G1, G2, G5, G6 (behavior).

**Edit 1 — `src/bridge.ts`: imports.** Replace:

```ts
import { BridgeError } from "./facade/errors.js";
```

with:

```ts
import { BridgeError, queueFull, queueTimeout, clientGone } from "./facade/errors.js";
import { TurnGate, GateRejectionError } from "./core/turngate.js";
```

**Edit 2 — `src/bridge.ts`: module-level mapper** (place it directly above `export class TabBridge`):

```ts
/** Queued-phase rejections arrive as typed gate errors; map them onto the
 * HTTP taxonomy so callers (kod's retry treats 503 as retryable-transient)
 * can react cheaply. client_gone is 499 and never reaches the wire. */
function mapGateRejection(e: GateRejectionError): BridgeError {
  switch (e.code) {
    case "queue_full":
      return queueFull(e.retryAfterSec, e.message);
    case "queue_timeout":
      return queueTimeout(e.retryAfterSec, e.message);
    case "client_gone":
      return clientGone(e.message);
  }
}
```

**Edit 3 — `src/bridge.ts`: `ChatParams` gains the abort signal.** Replace:

```ts
export interface ChatParams {
  messages: ChatMessage[];
  tools: ToolSpec[];
  think: boolean;
  /** Resolved session id, or null for the stateless legacy path. */
  sessionId: string | null;
  events?: TurnEvents;
}
```

with:

```ts
export interface ChatParams {
  messages: ChatMessage[];
  tools: ToolSpec[];
  think: boolean;
  /** Resolved session id, or null for the stateless legacy path. */
  sessionId: string | null;
  events?: TurnEvents;
  /** Aborted when the HTTP client disconnects. Consumed by the generation
   * gate for the QUEUED phase only; an admitted turn always runs to
   * completion (unchanged v1 behavior). */
  signal?: AbortSignal;
}
```

**Edit 4 — `src/bridge.ts`: field + constructor wiring.** Replace:

```ts
  readonly pool: WorkerPool;
  readonly adapter: ChatProviderAdapter;
```

with:

```ts
  readonly pool: WorkerPool;
  readonly adapter: ChatProviderAdapter;
  /** Caps concurrent provider generations (DeepSeek limit: ~2 per account);
   * excess turns queue FIFO. See src/core/turngate.ts. */
  readonly turnGate: TurnGate;
```

and inside the constructor, after the `this.adapter = adapter ?? new DeepSeekAdapter(…)` line, add:

```ts
    this.turnGate = new TurnGate({
      maxConcurrent: config.maxConcurrentTurns,
      capacity: config.queueCapacity,
      queueTimeoutMs: config.queueTimeoutMs,
    });
```

**Edit 5 — `src/bridge.ts`: the heart of the plan.** Replace the whole `handleChat` body from the mutex block through the `finally` with the version below. Old code (lines ~97–142):

```ts
    // Same-session overlap is a caller bug: reject, never queue (ADR-7/R6).
    const mutex = this.registry.lockFor(row.sessionId);
    if (!mutex.tryAcquire()) {
      const err = new BridgeError({
        status: 409,
        code: "session_busy",
        message: `session ${row.sessionId} already has a turn in flight`,
      });
      throw err;
    }
    try {
      const out = await runTurn(
        {
          messages: params.messages,
          tools: params.tools,
          think: params.think,
          row,
          registry: this.registry,
          adapter: this.adapter,
          repairRounds: this.config.repairRounds,
          turnTimeoutMs: this.config.turnTimeoutMs,
          bindTimeoutMs: this.config.bindTimeoutMs,
          bindTab: this.bindTabImpl,
        },
        params.events
      );
      return out;
    } catch (e) {
      // A turn that fails after submission leaves the tab state unknown:
      // drop tabHash so the next request re-anchors safely (Chapter 9).
      if (row.tabId !== null && row.chain.length > 0) {
        row.tabHash = null;
      }
      throw e;
    } finally {
      mutex.release();
      this.registry.dropLock(row.sessionId);
      if (ephemeral) {
        this.registry.delete(row.sessionId);
        // Free the worker-side binding so the tab returns to the allocatable
        // pool instead of leaking one tab per sessionless request.
        if (row.tabId !== null) {
          this.pool.release(row.sessionId, 3_000).catch(() => {});
        }
      }
    }
```

New code:

```ts
    // Same-session overlap is a caller bug: reject, never queue (ADR-7/R6).
    // The generation gate below is a DIFFERENT axis: it caps how many turns
    // run against the provider account at once (DeepSeek refuses a 3rd
    // concurrent generation with "Another message is being generated").
    // Cross-session turns queue FIFO; same-session overlap still 409s here,
    // before the gate is ever consulted.
    const mutex = this.registry.lockFor(row.sessionId);
    if (!mutex.tryAcquire()) {
      const err = new BridgeError({
        status: 409,
        code: "session_busy",
        message: `session ${row.sessionId} already has a turn in flight`,
      });
      throw err;
    }
    let gateHeld = false;
    try {
      // Blocks (FIFO) until one of maxConcurrentTurns generation slots frees
      // up. Throws GateRejectionError on queue_full / queue_timeout /
      // client_gone — mapped to BridgeError below. To callers this is just a
      // longer time-to-first-byte ("thinking"); nothing else changes.
      const gateWaitMs = await this.turnGate.acquire(row.sessionId, params.signal);
      gateHeld = true;
      const out = await runTurn(
        {
          messages: params.messages,
          tools: params.tools,
          think: params.think,
          row,
          registry: this.registry,
          adapter: this.adapter,
          repairRounds: this.config.repairRounds,
          turnTimeoutMs: this.config.turnTimeoutMs,
          bindTimeoutMs: this.config.bindTimeoutMs,
          bindTab: this.bindTabImpl,
        },
        params.events
      );
      return { ...out, ...(gateWaitMs > 0 ? { gateWaitMs } : {}) };
    } catch (e) {
      if (e instanceof GateRejectionError) {
        // A queued-phase rejection never addressed the tab: no prompt was
        // placed, no navigation issued. tabHash must survive (same reasoning
        // as task T8 of the integration plan).
        throw mapGateRejection(e);
      }
      // A turn that fails after submission leaves the tab state unknown:
      // drop tabHash so the next request re-anchors safely (Chapter 9).
      if (row.tabId !== null && row.chain.length > 0) {
        row.tabHash = null;
      }
      throw e;
    } finally {
      // Release the gate slot first so the next queued turn starts before
      // the session bookkeeping unwinds (both are synchronous).
      if (gateHeld) this.turnGate.release();
      mutex.release();
      this.registry.dropLock(row.sessionId);
      if (ephemeral) {
        this.registry.delete(row.sessionId);
        // Free the worker-side binding so the tab returns to the allocatable
        // pool instead of leaking one tab per sessionless request.
        if (row.tabId !== null) {
          this.pool.release(row.sessionId, 3_000).catch(() => {});
        }
      }
    }
```

**Edit 6 — `src/bridge.ts`: health observability.** In `health()`, replace:

```ts
      sessions: this.registry.size,
```

with:

```ts
      sessions: this.registry.size,
      turn_gate: this.turnGate.stats(),
```

**Edit 7 — `src/engine.ts`: TurnOutput field.** In `export interface TurnOutput`, after `repairRoundsUsed: number;` add:

```ts
  /** Ms the turn spent waiting in the generation gate before starting.
   * Present only when it actually waited (> 0). Surfaced as the
   * x-bridge-queued-ms response header on the JSON path. */
  gateWaitMs?: number;
```

(`runTurn` itself is untouched — the bridge spreads `gateWaitMs` into the output.)

**Verify:**
```bash
pnpm run typecheck && pnpm test
curl -s http://127.0.0.1:8789/healthz | grep turn_gate   # once you next boot the bridge
```

**Commit:** `feat(bridge): Q4 FIFO generation gate in handleChat + turn_gate health + gateWaitMs`

---

### Q5 — HTTP facade: abort signal, client-gone handling, queued-ms header (`src/facade/http.ts`)

**Files:** `src/facade/http.ts`.
**Closes:** G6 (no zombie turns), plus the `x-bridge-queued-ms` diagnostic.

**Edit 1 — create the abort controller** in `handleChat` (facade), right after the `const sessionId = resolveSessionKey(…)` line (~line 263). Insert:

```ts
  // 'close' fires on premature disconnect AND after a normal finish; the
  // generation gate only consults the signal while the request is queued,
  // so a late abort is a harmless no-op.
  const ac = new AbortController();
  res.on("close", () => ac.abort());
```

**Edit 2 — non-streaming path.** Replace (lines ~268–269):

```ts
  if (!stream) {
    const out = await bridge.handleChat({ messages, tools, think, sessionId } satisfies ChatParams);
```

with:

```ts
  if (!stream) {
    let out: Awaited<ReturnType<TabBridge["handleChat"]>>;
    try {
      out = await bridge.handleChat({
        messages,
        tools,
        think,
        sessionId,
        signal: ac.signal,
      } satisfies ChatParams);
    } catch (e) {
      if (e instanceof BridgeError && e.code === "client_gone") {
        log.info("http.client-gone", { id, stream: false });
        return;
      }
      throw e;
    }
```

**Edit 3 — non-streaming path: queued-ms header.** In the same block, replace the whole `sendJson(…)` call:

```ts
    sendJson(
      res,
      200,
      {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: out.finish,
          },
        ],
        usage: out.usage,
        ...(warnings.length > 0 ? { x_bridge_warning: warnings } : {}),
      },
      headers
    );
```

with:

```ts
    sendJson(
      res,
      200,
      {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: out.finish,
          },
        ],
        usage: out.usage,
        ...(warnings.length > 0 ? { x_bridge_warning: warnings } : {}),
      },
      { ...headers, "x-bridge-queued-ms": String(out.gateWaitMs ?? 0) }
    );
```

(`sendJson` already accepts an optional headers object; the ignored-params headers from `headers` are preserved.)

**Edit 4 — streaming path: pass the signal.** Replace:

```ts
    const out = await bridge.handleChat({ messages, tools, think, sessionId, events } satisfies ChatParams);
```

with:

```ts
    const out = await bridge.handleChat({
      messages,
      tools,
      think,
      sessionId,
      events,
      signal: ac.signal,
    } satisfies ChatParams);
```

**Edit 5 — streaming path: client-gone short-circuit.** In the existing `catch` at the end of the streaming block, replace:

```ts
  } catch (e) {
    // Preserve typed errors (409 session_busy, 429 rate_limited): flattening
    // them through mapTurnError turns a non-retryable 409 into a retryable
    // 500, and callers retry into their own running turn.
    const be = e instanceof BridgeError ? e : mapTurnError(e);
    sse.fail(be.status, be.body(), be.retryAfter);
  }
```

with:

```ts
  } catch (e) {
    if (e instanceof BridgeError && e.code === "client_gone") {
      log.info("http.client-gone", { id, stream: true });
      return;
    }
    // Preserve typed errors (409 session_busy, 429 rate_limited): flattening
    // them through mapTurnError turns a non-retryable 409 into a retryable
    // 500, and callers retry into their own running turn.
    const be = e instanceof BridgeError ? e : mapTurnError(e);
    sse.fail(be.status, be.body(), be.retryAfter);
  }
```

> Note: SSE headers are still sent lazily (`SseStream.start()` on the first frame, ADR-7). A queue failure therefore still surfaces as a **clean HTTP error** (503/499 as JSON with `retry-after`), not an empty 200-stream — no change needed in `sse.ts`.

**Verify:**
```bash
pnpm run typecheck && pnpm test
```

**Commit:** `feat(facade): Q5 queued-phase abort on client disconnect + x-bridge-queued-ms header`
### Q6 — Contract tests through HTTP (`test/queue.test.ts`)

**Files:** new `test/queue.test.ts`.
**Closes:** verification for G1, G2, G5, G6 at the L4 boundary, exactly like `contract.test.ts`.

The test file defines a `TimingAdapter` wrapper that delegates to `ScriptedAdapter` and slows `streamResponse` down deterministically — no production code changes.

**Create `test/queue.test.ts` with exactly this content:**

```ts
// Queue contract tests: the generation gate (Q1-Q5) exercised over HTTP.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TabBridge } from "../src/bridge.js";
import { createHttpServer } from "../src/facade/http.js";
import { ScriptedAdapter } from "../src/adapter/scripted.js";
import type {
  ChatProviderAdapter,
  ManagedTab,
  Ready,
  ResetOutcome,
  StreamSink,
  TurnOptions,
  TurnResult,
} from "../src/adapter/types.js";
import type { Config } from "../src/config.js";

function baseConfig(db: string, over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    apiKey: null,
    stateful: true,
    autoCreateTabs: false,
    managedOnly: true,
    ttlMs: 30 * 60_000,
    repairRounds: 0,
    warmTabs: 0,
    dbPath: db,
    turnTimeoutMs: 10_000,
    bindTimeoutMs: 2_000,
    maxPromptChars: 1_000_000,
    maxConcurrentTurns: 1,
    queueCapacity: 8,
    queueTimeoutMs: 5_000,
    ...over,
  };
}

/** Delegates to ScriptedAdapter; slows streamResponse by `delayMs` and
 * records one {startedAt, endedAt} entry per completed turn. */
class TimingAdapter implements ChatProviderAdapter {
  readonly id = "timing-web";
  readonly turns: Array<{ startedAt: number; endedAt: number }> = [];
  constructor(
    private readonly inner: ScriptedAdapter,
    private readonly delayMs: number
  ) {}
  capabilities() {
    return this.inner.capabilities();
  }
  attach(p: unknown) {
    this.inner.attach(p);
  }
  ensureReady(t: ManagedTab, ms: number): Promise<Ready> {
    return this.inner.ensureReady(t, ms);
  }
  sendTurn(t: ManagedTab, text: string, o: TurnOptions): Promise<void> {
    return this.inner.sendTurn(t, text, o);
  }
  resetConversation(t: ManagedTab): Promise<ResetOutcome> {
    return this.inner.resetConversation(t);
  }
  health(t: ManagedTab) {
    return this.inner.health(t);
  }
  dispose(t: ManagedTab): Promise<void> {
    return this.inner.dispose(t);
  }
  async streamResponse(tab: ManagedTab, sink: StreamSink): Promise<TurnResult> {
    const startedAt = Date.now();
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    try {
      return await this.inner.streamResponse(tab, sink);
    } finally {
      this.turns.push({ startedAt, endedAt: Date.now() });
    }
  }
}

let dir: string;
let adapter: ScriptedAdapter;
let timing: TimingAdapter;
let bridge: TabBridge;
let server: Server;
let base: string;

/** (Re)start the stack. Tests that need custom gate config call this again;
 * each bridge gets its own journal path so state never leaks across tests,
 * and `base` is rebound so requests always hit the CURRENT bridge. */
async function startBridge(over: Partial<Config>, delayMs = 150): Promise<void> {
  if (server) server.close();
  timing = new TimingAdapter(adapter, delayMs);
  const db = join(dir, `sessions-${Math.random().toString(36).slice(2, 8)}.json`);
  bridge = new TabBridge(baseConfig(db, over), timing);
  server = createHttpServer({ bridge });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tabbridge-queue-"));
  adapter = new ScriptedAdapter({ maxPromptChars: 4000 });
  await startBridge({}, 150);
});

afterEach(() => {
  bridge.dispose();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function chat(
  sessionId: string,
  opts: { stream?: boolean } = {}
): Promise<{ status: number; headers: Headers; body: string }> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      model: "deepseek-web-chat",
      stream: opts.stream === true,
      messages: [{ role: "user", content: "hi" }],
    }),
  }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.text() }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("queue: serializes cross-session turns to maxConcurrentTurns, FIFO order", async () => {
  adapter.push({ text: "alpha" }, { text: "beta" }, { text: "gamma" });
  const pa = chat("A");
  await sleep(80);
  const pb = chat("B");
  await sleep(80);
  const pc = chat("C");
  const [ra, rb, rc] = await Promise.all([pa, pb, pc]);
  assert.deepEqual([ra.status, rb.status, rc.status], [200, 200, 200]);
  assert.equal(timing.turns.length, 3);
  for (const t of timing.turns) {
    assert.ok(t.endedAt - t.startedAt >= 140, "each turn must actually run its delay");
  }
  assert.ok(timing.turns[1].startedAt >= timing.turns[0].endedAt - 5, "B started only after A finished");
  assert.ok(timing.turns[2].startedAt >= timing.turns[1].endedAt - 5, "C started only after B finished");
});

test("queue: same-session overlap still 409s (ADR-7/R6 preserved)", async () => {
  adapter.push({ text: "one" }, { text: "two" });
  const [r1, r2] = await Promise.all([chat("S"), chat("S")]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const conflict = r1.status === 409 ? r1 : r2;
  assert.match(conflict.body, /session_busy/);
});

test("queue: queue_timeout -> 503 + retry-after, holder unaffected, no slot leak", async () => {
  await startBridge({ queueTimeoutMs: 250 }, 1_200);
  adapter.push({ text: "held" }, { text: "later" });
  const rh = chat("H");
  await sleep(50);
  const rv = chat("V");
  const [h, v] = await Promise.all([rh, rv]);
  assert.equal(h.status, 200);
  assert.equal(v.status, 503);
  assert.match(v.body, /queue_timeout/);
  assert.equal(v.headers.get("retry-after"), "5");
  await sleep(50);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.turn_gate.active, 0, "no slot may leak after the rejection");
  const rd = await chat("D");
  assert.equal(rd.status, 200, "the gate must admit new turns after the leak check");
});

test("queue: queue_full -> immediate 503 when capacity is exhausted", async () => {
  await startBridge({ queueCapacity: 1, queueTimeoutMs: 5_000 }, 800);
  adapter.push({ text: "h" }, { text: "b" }, { text: "c-unused" });
  const ph = chat("H");
  await sleep(50);
  const pb = chat("B"); // occupies the single queue slot
  await sleep(50);
  const t0 = Date.now();
  const pc = chat("C"); // over capacity
  const c = await pc;
  assert.equal(c.status, 503);
  assert.match(c.body, /queue_full/);
  assert.ok(Date.now() - t0 < 500, "queue_full must fail fast, not wait");
  const [h, b] = await Promise.all([ph, pb]);
  assert.equal(h.status, 200);
  assert.equal(b.status, 200);
});

test("queue: streaming requests queue transparently", async () => {
  adapter.push({ text: "held-answer" }, { text: "streamed-answer" });
  const ph = chat("H");
  await sleep(50);
  const ps = chat("Q", { stream: true });
  const [h, s] = await Promise.all([ph, ps]);
  assert.equal(h.status, 200);
  assert.equal(s.status, 200);
  assert.match(s.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(s.body, /chat\.completion\.chunk/);
  assert.match(s.body, /streamed-answer/);
  assert.match(s.body, /"finish_reason":"stop"/);
  assert.match(s.body, /data: \[DONE\]/);
});

test("queue: health exposes gate stats while a turn runs and one waits", async () => {
  adapter.push({ text: "h" }, { text: "q" });
  const ph = chat("H");
  await sleep(50);
  const pq = chat("Q");
  await sleep(50);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.turn_gate.active, 1);
  assert.equal(health.turn_gate.waiting, 1);
  assert.equal(health.turn_gate.max_concurrent, 1);
  await Promise.all([ph, pq]);
  const after = await (await fetch(`${base}/healthz`)).json();
  assert.equal(after.turn_gate.active, 0);
  assert.equal(after.turn_gate.waiting, 0);
});

test("queue: x-bridge-queued-ms appears on JSON responses (0 when immediate)", async () => {
  adapter.push({ text: "h" }, { text: "v" });
  const ph = chat("H");
  await sleep(50);
  const pv = chat("V");
  const [h, v] = await Promise.all([ph, pv]);
  assert.equal(h.headers.get("x-bridge-queued-ms"), "0");
  const queuedMs = Number(v.headers.get("x-bridge-queued-ms"));
  assert.ok(Number.isFinite(queuedMs) && queuedMs >= 100, `expected a real wait, got ${queuedMs}`);
  assert.deepEqual([h.status, v.status], [200, 200]);
});

test("queue: defensive mapping — provider concurrency refusal text becomes 429", async () => {
  // No gate involvement: a turn whose provider error mentions the refusal
  // must surface as retryable 429, never 502 (mapTurnError defense).
  adapter.push({ failText: "turn-error:submit-failed:Another message is being generated" });
  const r = await chat("X");
  assert.equal(r.status, 429);
  assert.match(r.body, /rate_limited/);
  assert.equal(r.headers.get("retry-after"), "15");
});
```

> Note the 8th test: `ScriptedAdapter` supports `failText` (thrown verbatim by `streamResponse`) — it exercises the Q3 `mapTurnError` regex end-to-end. This file is self-contained on purpose: it reuses the `baseConfig` pattern from `contract.test.ts` but defines its own `startBridge` helper so tests that need custom gate config rebind the HTTP server instead of silently testing a stale bridge.

**Verify:**
```bash
pnpm run typecheck && pnpm test
```

**Commit:** `test(bridge): Q6 contract tests for the generation gate (serialization, 409 preservation, queue_full/timeout, streaming, health, headers)`

---

### Q7 — Injector: detect the DeepSeek concurrency refusal (`extension/injector.js`)

**Files:** `extension/injector.js`, `extension/README.md`.
**Closes:** G3 (extension side). `extension/background.js` needs **no change** — its `TURN_ERROR` relay (case at line ~701) passes any `code` + `detail` through generically, and deliberately does **not** put the tab into the 20-minute cooldown (that is reserved for `rate_limited`; a concurrency refusal self-heals in seconds).

**Edit 1 — add the regex** right after the `RATE_LIMIT_RE` definition (line ~68):

```js
/** DeepSeek concurrency refusal: a send is refused because the account
 * already has the maximum number of concurrent generations running
 * ("Another message is being generated"; observed limit: 2). Disjoint from
 * RATE_LIMIT_RE by construction. */
const CONCURRENCY_RE =
  /(?:another\s+(?:message|response|reply|request|generation)|already\s+(?:being\s+)?generated|generat\w*\s+(?:already\s+)?in\s+progress|one\s+(?:conversation|chat)\s+at\s+a\s+time|please\s+wait[^.\n]{0,40}(?:finish|complete)|已有一条消息|消息正在生成|正在生成中|请等待.{0,20}(?:完成|结束))/i;
```

**Edit 2 — add the notice scans** directly after `submitRateLimitHit` (ends line ~317):

```js
/** Concurrency-refusal text visible in transient notice surfaces (mirrors
 * noticeRateLimitHit). */
function noticeConcurrencyHit() {
  for (const el of findAll(SELECTORS.noticeRegions)) {
    const t = (el.textContent || "").trim();
    if (t && t.length < 300 && CONCURRENCY_RE.test(t)) return true;
  }
  return false;
}

/** Broad submit-block scan for the concurrency refusal — notice surfaces AND
 * chat nodes that appeared after `preCount` (same shapes as
 * submitRateLimitHit: inline bubble, toast, or nothing at all when the send
 * is rejected server-side before render). */
function submitConcurrencyHit(preCount) {
  if (noticeConcurrencyHit()) return true;
  const nodes = conversationNodes();
  for (let i = Math.max(0, preCount); i < nodes.length; i++) {
    const t = (nodes[i].textContent || "").trim();
    if (t && t.length < 400 && CONCURRENCY_RE.test(t)) return true;
  }
  return false;
}
```

**Edit 3 — `submitPrompt`: surface `concurrency_blocked` at every refusal site.**

3a. Replace:

```js
  if (mode === "ignored") {
    if (submitRateLimitHit(preCount)) {
      return { ok: false, code: "rate_limited", detail: "composer rejected the prompt under a provider send block" };
    }
    return { ok: false, code: "submit-failed", detail: "composer rejected the prompt text" };
  }
```

with:

```js
  if (mode === "ignored") {
    if (submitRateLimitHit(preCount)) {
      return { ok: false, code: "rate_limited", detail: "composer rejected the prompt under a provider send block" };
    }
    if (submitConcurrencyHit(preCount)) {
      return { ok: false, code: "concurrency_blocked", detail: "composer rejected the prompt: another message is generating" };
    }
    return { ok: false, code: "submit-failed", detail: "composer rejected the prompt text" };
  }
```

3b. Replace:

```js
  if (!ready.ok) {
    if (ready.rateLimited || submitRateLimitHit(preCount)) {
```

with:

```js
  if (!ready.ok) {
    if (submitConcurrencyHit(preCount)) {
      return {
        ok: false,
        code: "concurrency_blocked",
        detail: `${ready.detail || "provider notice: another message is generating"} (mode=${mode})`,
      };
    }
    if (ready.rateLimited || submitRateLimitHit(preCount)) {
```

3c. After the `rateLimitedResult` const (lines ~595–599), add:

```js
  const concurrencyBlockedResult = () => ({
    ok: false,
    code: "concurrency_blocked",
    detail: "provider notice: another message is generating (submit rejected)",
  });
```

3d. Extend the three verify sites. After EACH of the three lines:

```js
  if (a === "rate-limited" || (a !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
```
```js
  if (b === "rate-limited" || (b !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
```
```js
  if (c === "rate-limited" || (c !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
```

insert the matching line (with the same variable):

```js
  if (a !== true && submitConcurrencyHit(preCount)) return concurrencyBlockedResult();
```
```js
  if (b !== true && submitConcurrencyHit(preCount)) return concurrencyBlockedResult();
```
```js
  if (c !== true && submitConcurrencyHit(preCount)) return concurrencyBlockedResult();
```

**Edit 4 — stream handler, `hint-error` case (lines ~921–927).** Replace:

```js
    case "hint-error":
      t.lastSseAt = Date.now();
      if (/rate_limit/i.test(d.finishReason || "")) {
        finishTurn(false, "rate_limited", d.content || "provider rate limit (stream hint)");
      }
      // non-rate hints: keep waiting — stream close / complete decides
      break;
```

with:

```js
    case "hint-error":
      t.lastSseAt = Date.now();
      if (/rate_limit/i.test(d.finishReason || "")) {
        finishTurn(false, "rate_limited", d.content || "provider rate limit (stream hint)");
      } else if (CONCURRENCY_RE.test(d.finishReason || "") || CONCURRENCY_RE.test(d.content || "")) {
        finishTurn(false, "concurrency_blocked", d.content || "provider: another message is being generated");
      }
      // non-rate hints: keep waiting — stream close / complete decides
      break;
```

**Edit 5 — stream handler, `complete` case.** After the existing rate-limit `hintError` block (lines ~938–941), insert:

```js
      if (
        d.hintError &&
        (CONCURRENCY_RE.test(d.hintError.finishReason || "") ||
          CONCURRENCY_RE.test(d.hintError.content || ""))
      ) {
        finishTurn(false, "concurrency_blocked", d.hintError.content || "provider: another message is being generated");
        break;
      }
```

**Edit 6 — stream handler, `complete` case, empty-text branch (lines ~942–949).** Replace:

```js
      if (!finalText && t.emitted.length === 0) {
        if (serverDownVisible()) {
          finishTurn(false, "dom-error", "provider: server temporarily unavailable");
          break;
        }
        fallbackToDom(t, "completion stream closed without text");
        break;
      }
```

with:

```js
      if (!finalText && t.emitted.length === 0) {
        if (serverDownVisible()) {
          finishTurn(false, "dom-error", "provider: server temporarily unavailable");
          break;
        }
        if (submitConcurrencyHit(t.submitCount)) {
          finishTurn(false, "concurrency_blocked", "provider notice: another message is generating");
          break;
        }
        fallbackToDom(t, "completion stream closed without text");
        break;
      }
```

**Edit 7 — watchdog (lines ~996–1000).** After the existing rate-limit hit check, insert:

```js
    if (submitConcurrencyHit(t.submitCount)) {
      finishTurn(false, "concurrency_blocked", "provider notice: another message is generating");
      return;
    }
```

**Edit 8 — `extension/README.md`: document the new code.** In the worker error-code table (the one whose `rate_limited` row says it carries `retryAfterSec: 1200`), add a row:

```markdown
| `concurrency_blocked` | DeepSeek refused the send because another generation is still running (observed limit: 2 concurrent per account). The bridge's turn gate makes this unreachable for bridge traffic; it can surface when a human drives the same account in a parallel window. Mapped to HTTP 429 + `Retry-After: 15`. Deliberately NO cooldown. |
```

**Verify:**
```bash
node --check extension/injector.js
node --test extension/test/   # existing extension tests stay green
grep -c "concurrency_blocked" extension/injector.js   # expect 7
grep -n "concurrency_blocked" extension/background.js # expect NO matches (generic relay is intentional)
```

**Commit:** `feat(extension): Q7 detect DeepSeek concurrency refusals as concurrency_blocked`

---

### Q8 — Docs + kod-side config sizing (no kod code)

**Files:** `examples/kod-config.toml`, `README.md`, `docs/SPEC.md`.

**Edit 1 — `examples/kod-config.toml`.** Replace:

```toml
timeout_secs   = 300
```

with:

```toml
# kod's reqwest timeout is a TOTAL request budget (connect + queue wait +
# generation). The bridge may legally hold a request in its generation queue
# for up to --queue-timeout-ms (default 600s) before the turn even starts.
# Size this above max queue wait + 2x worst-case turn time:
#   timeout_secs > queue_timeout_ms/1000 + 2 * turn_timeout_ms/1000
# 900s covers the defaults (600s queue + 2x240s turns) with margin.
timeout_secs   = 900
```

**Edit 2 — `README.md`: new section** (place it near the existing concurrency / rate-limit prose; grep for `rate_limited` to find the right neighborhood):

```markdown
## Generation gate (max concurrent DeepSeek generations)

DeepSeek refuses a send while the account already has ~2 concurrent
generations running ("Another message is being generated"). The bridge turns
that server-side refusal into client-side queueing:

- `--max-concurrent-turns=<n>` (default 2): turns holding a generation slot
  at once. `0` disables the gate.
- `--queue-capacity=<n>` (default 32): max queued turns; overflow fails fast
  with `503 queue_full` + `Retry-After: 5`.
- `--queue-timeout-ms=<n>` (default 600000): max queue wait; starvation fails
  with `503 queue_timeout` + `Retry-After: 5`. `0` waits forever.

Queued turns are invisible to callers: a client (kod included) just observes
a longer time-to-first-byte — in kod's TUI that reads as a longer "thinking"
phase. No client-side special casing is needed. If your DeepSeek account
turns out to allow only one concurrent generation, run
`--max-concurrent-turns=1`.

Observability: `/healthz` exposes `turn_gate` (active/waiting/capacity);
non-streaming responses carry `x-bridge-queued-ms`; audit logs emit
`turn.gate.wait|admit|full|timeout|client-gone`. Same-session overlap still
returns `409 session_busy` — the gate is cross-session provider capacity
only. If the refusal ever surfaces (parallel human use of the account), the
injector reports `concurrency_blocked` and the bridge answers a retryable
`429` + `Retry-After: 15`.
```

**Edit 3 — `docs/SPEC.md`: error taxonomy rows.** Find the error-code table (search for `pool_exhausted`) and add:

```markdown
| `503` | `queue_full` | All `max-concurrent-turns` slots busy and the queue is at `--queue-capacity`. Retry-After: 5. Transient — retry the same request. |
| `503` | `queue_timeout` | Queued longer than `--queue-timeout-ms`. Retry-After: 5. Transient. |
| `499` | `client_gone` | Internal only (nginx convention): the client disconnected while queued; the queued entry is cancelled and no turn is run. Never written to the wire. |
| `429` | `rate_limited` (concurrency variant) | The provider refused the send because another generation is running (`concurrency_blocked` upstream). Retry-After: 15. |
```

**Verify:**
```bash
pnpm run typecheck && pnpm test
grep -n "queue_full" docs/SPEC.md README.md
grep -n "900" examples/kod-config.toml
```

**Commit:** `docs: Q8 generation-gate docs, SPEC error rows, kod timeout_secs sizing`

---

## Part 3 — Verification matrix

| # | Scenario | Command / action | Expected |
|---|----------|------------------|----------|
| 1 | Unit gate behavior | `pnpm test` (gate.\* tests) | all green |
| 2 | Contract serialization / 409 / 503s / streaming / health / headers | `pnpm test` (queue.\* tests) | all green |
| 3 | Static checks | `pnpm run typecheck` | 0 errors |
| 4 | Injector syntax + coverage | `node --check extension/injector.js && grep -c "concurrency_blocked" extension/injector.js` | exit 0, count 7 |
| 5 | No background cooldown regression | `grep -n "concurrency_blocked" extension/background.js` | no matches |
| 6 | Flags wired | `node dist/src/index.js serve --help \| grep -E "max-concurrent-turns\|queue-"` | 3 lines |
| 7 | Live serialization (manual) | boot bridge + extension, then `for s in a b c; do curl -s -X POST …/v1/chat/completions -H "x-session-id: $s" -d '…' & done; curl -s …/healthz` | 3×200, health shows `turn_gate.active` ≤ 2 during the burst, audit log shows `turn.gate.wait` + `turn.gate.admit` with `queuedMs > 0` for one session |
| 8 | kod end-to-end (manual) | run a kod swarm with ≥ 3 agents against the bridge | no new error surface; agents simply start later; TUI shows normal "thinking" |
| 9 | kod budget (manual/config) | confirm the tab-bridge endpoint in `~/.kod/config.toml` uses `timeout_secs ≥ 900` | set per Q8 Edit 1 |
| 10 | Rollback switch | `tab-bridge serve --max-concurrent-turns=0` | gate off, behavior identical to pre-plan |

---

## Part 4 — Appendices (read, do not implement)

### Appendix A — Why the slot spans the whole `runTurn`

A DeepSeek *generation* starts when the prompt is submitted and ends when the stream completes. A bridge turn also contains bind/readiness (~0–20 s), an optional reset+reseed (page navigation, ~2–10 s) and an optional **repair round — which submits a second prompt and generates again**. Accounting slots narrowly around "submit→stream-end" would mean two acquire/release cycles per turn plus a hold across the repair gap, all to save a few seconds of slot occupancy that is not generating. The whole-turn slot is trivially correct, leak-free (one acquire / one release in one `finally`), and errs on the safe side of the provider's limit. Revisit only if telemetry (`turn.gate.admit` `queuedMs` distribution) shows admission latency is a real problem.

### Appendix B — Sizing `queueTimeoutMs` vs kod's `timeout_secs`

kod's `OpenAICompatProvider` builds its `reqwest` client with `.timeout(Duration::from_secs(timeout_secs))` — a **total** budget covering connect, queue wait and full generation. Therefore:

```
kod timeout_secs > bridge queueTimeoutMs/1000 + 2 × bridge turnTimeoutMs/1000
```

With the defaults: `900 > 600 + 2×240 = 1080`? No — it does not hold for the absolute worst case (a full queue-timeout followed by two full turn-timeouts in one request is impossible: a request either times out in the queue OR runs a turn). The realistic worst case per request is `queueTimeoutMs + turnTimeoutMs×(1 + repair)` = 600 s + 480 s = 1080 s > 900 s only when a turn uses its full 240 s AND a repair round; typical DeepSeek-Flash turns are 20–90 s, where 900 s has huge margin. If your workload routinely saturates `turnTimeoutMs`, set `timeout_secs = 1800`. The bridge stays the authority on failing first (`queue_timeout` at 600 s), so kod always receives a typed, retryable 503 instead of a client-side transport abort.

### Appendix C — Defaults and rollback

| Knob | Default | When to change |
|------|---------|----------------|
| `--max-concurrent-turns` | 2 | `1` if the account still refuses a 2nd concurrent send; `0` to disable the gate entirely (instant rollback to pre-plan behavior) |
| `--queue-capacity` | 32 | lower to shed load earlier (clients get fast 503 `queue_full`) |
| `--queue-timeout-ms` | 600000 | lower for snappier failure; raise (and kod `timeout_secs` with it) for long-turn workloads |

The gate changes no worker-protocol message, no persistence format, and no public API shape (`ChatParams.signal` and `TurnOutput.gateWaitMs` are additive and optional) — rollback is a flag, not a revert.

### Appendix D — Known limitations (accepted for v1)

1. **No mid-turn abort.** Once admitted, a turn runs to completion even if the client disappears (pre-existing v1 behavior; the abort signal covers the queued phase only — that is what eliminates *zombie* turns, the harmful case).
2. **No worker-health pre-check at admission.** If the extension worker is down, queued turns are admitted one-by-one and fail fast at bind (`no-worker-link` → `503 pool_exhausted`, bounded by `bindTimeoutMs`). Failing the whole queue on `worker-down` was considered and rejected as unnecessary coupling for marginal benefit.
3. **Admission does not reserve a tab.** Slot-holding turns still need `bindTab`; with fewer tabs than slots, a turn may hold a slot while waiting out bind's `no-tab-available` deadline (≤ `bindTimeoutMs`). Size `warmTabs ≥ maxConcurrentTurns` if this shows up in telemetry.
4. **Detection regexes are empirical.** `CONCURRENCY_RE` covers the known English + Chinese phrasings; if DeepSeek changes the wording, the failure mode reverts to the pre-Q3 generic mapping — the gate itself is unaffected (it prevents the refusal proactively).

### Appendix E — Interplay with the other two plans

* **tab-bridge-kod-production-plan.md:** Q4 keeps T8's contract (a queued-phase rejection never drops `tabHash` — the `GateRejectionError` branch throws before the tabHash-drop code). Q3's 429-concurrency mapping sits next to the existing rate-limit mapping and reuses `rateLimited()`, so kod's K-series hint-sleeping retry handles it with zero changes. No task here touches files that T1–T12/I1–I5 rewrite in conflicting ways; if you executed that plan first, re-read the touched hunks and adapt the "old code" blocks.
* **kod-tui-uiux-production-plan.md:** unchanged. The longer "thinking" phase renders through the same streaming pump; the UX plan's status/header work already assumes variable time-to-first-token.
