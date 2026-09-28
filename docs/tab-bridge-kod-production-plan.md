# tab-bridge × kod — Production Integration Plan

**Executors:** this document is written for an AI coding agent (or a human) that follows instructions literally.
**Repos:** `github.com/elcoosp/tab-bridge` (TypeScript, Node ≥ 20, zero runtime deps) and `github.com/elcoosp/kod` (Rust workspace, edition 2024).
**Goal state:** (1) every known tab-bridge bug/code smell found in this review is fixed with the exact code below; (2) kod, when tab-bridge answers `429` with the ~20-minute DeepSeek send-frequency window, **sleeps out the remaining window and re-drives the request instead of failing**; (3) the integration passes the full test matrix of both repos.

---

## Part 0 — System map (read this first, do not modify anything yet)

```
kod engine (Rust)
  └─ OpenAICompatProvider (crates/kod-provider-openai/src/provider.rs)
       └─ adk-model OpenAI transport (EXTERNAL crate "adk-model" v2.2 — you CANNOT edit it)
            └─ HTTP POST {base_url}/v1/chat/completions   (engine tool loop uses NON-streaming
                                                           provider.complete() → collect())
                    │                          ▲
                    ▼ 429 + Retry-After: 1200  │
tab-bridge (Node)  src/facade/http.ts → src/bridge.ts → src/engine.ts
       └─ src/adapter/deepseek.ts ──WebSocket /worker──▶ extension/background.js (Chrome MV3 SW)
                                                            └─ extension/injector.js ──▶ chat.deepseek.com DOM
                                                            └─ extension/sse-hook.js (MAIN-world stream tap)
```

### The rate-limit lifecycle today (verified at commit `c621b2a` / `eb39247`)

1. DeepSeek enforces a per-account send-frequency window (~20 min, field-verified). The injector detects "Messages too frequent" (SSE `event: hint` with `finish_reason:"rate_limit_reached"`, HTTP 429 on the completion POST, or the inline toast/bubble) and reports `TURN_ERROR{code:"rate_limited"}` (`extension/injector.js`, `sse-hook.js`).
2. `background.js` puts the tab into a 20-minute cooldown (`RATE_LIMIT_COOLDOWN_MS`) and sends `ERROR{code:"rate_limited", retryAfterSec:1200}`.
3. The bridge maps it to **HTTP 429 + `Retry-After: 1200`** (`src/facade/errors.ts`, `RATE_LIMIT_COOLDOWN_SEC = 1200`) and marks the session `pendingReset`, so the next successful turn does a full `RESET_RESEED` (the orphan user message is cleaned).
4. **kod breaks this contract today**, in two independent places:
   * **Non-streaming path** (what the engine's tool loop actually uses — `run_collected_loop` → `provider.complete()` → `collect()` → `kod_provider::retry::with_retry`): the adk error is flattened by `adk_err()` into an untyped `KodError::Provider(String)`, so `with_retry` never sees `RateLimited`. Even if it did, `with_retry` clamps every `Retry-After` to `max_delay = 8s` (`crates/kod-provider/src/retry.rs`, line ~99). Result: 3 blind retries inside ~1.5 s, all inside the still-closed 20-minute window, then a hard failure.
   * **Streaming path** (`stream_request` in the same file): a 429 is `adk_precommit_retryable` → the attempt loop `continue`s **with no sleep at all**, 3 attempts back-to-back, then fails. The source comment even admits: *"the adk-model transport surfaces errors as AdkError (a string-shaped type with no headers), so retry hints cannot be extracted here."*
   * Engine-level fallback (`kod-core/src/engine/mod.rs` ~line 8434): `TurnFailure::TransportRateLimit` → `SameEndpointBackoff` → `apply_retry_adjustment` returns `false` for that action → the turn breaks to the next endpoint or fails. No wait anywhere.

**Target behavior after this plan:** the 429 is recognized, typed as `KodError::RateLimited`, its hint (parsed from the tab-bridge body text `"...wait ~20 minutes..."` or the exact remaining-cooldown value the bridge sends after task T4) is slept out **once**, and the same request is re-driven. A second 429 inside the same turn fails fast.

### tab-bridge defects found in this review (full list — all fixed in Part 2)

| ID | Sev | One-line summary |
|----|-----|------------------|
| T1 | P0 | `INJECT_TEXT` casts non-string `content` (multimodal arrays / null) → garbage or `""` injected into the tab |
| T2 | P0 | Holdback ceiling (4000 chars) silently converts large tool calls (e.g. kod `write_file`) into prose — no warning, no repair round |
| T3 | P1 | Deterministic call-id synthesis collides for identical parallel calls → duplicate `tool_call_id` breaks kod's result linkage |
| T4 | P1 | Worker-sent `retryAfterSec` is ignored by the bridge; Retry-After is a hardcoded 1200 instead of the remaining cooldown |
| T5 | P1 | `ensureReady` hot-loops PINGs (no sleep when the tab is simply not in the snapshot) and fails instantly on transient `degraded` health |
| T6 | P1 | Injector port death mid-turn leaves the bridge hanging for the full 240 s turn timeout instead of failing fast |
| T7 | P2 | No bridge→worker liveness heartbeat (`WsConnection.sendPing` exists, is never called) — half-open TCP after machine sleep reads as "connected" |
| T8 | P2 | `handleChat` drops `row.tabHash` even for pre-submit failures (bind/readiness), forcing spurious `RESET_RESEED` after transient outages |
| T9 | P2 | Bearer-key comparison is not constant-time |
| T10 | P2 | Session journal grows forever (`compact()` exists, is never called) |
| T11 | P3 | Dead code + rot: `POST /v1/sessions` force-block, duplicated catch comment, `void bridge`, hardcoded `--version 1.0.0` (package is 1.2.x), `process.exit(cmd ? 0 : 0)` |
| T12 | P3 | `SESSION_OBSERVED` message from the injector is silently dropped in `background.js` (the "user-claimed-tab guard" it powers was never built) |

---

## Part 1 — Ground rules for the executing agent

Follow these literally. Do not improvise.

1. **Work in two clones.** Suggested layout:
   ```bash
   git clone https://github.com/elcoosp/tab-bridge && cd tab-bridge && git checkout -b prod-integration
   git clone https://github.com/elcoosp/kod && cd kod && git checkout -b rate-limit-wait
   ```
2. **Baseline before touching anything.** Record results; if a baseline is red, STOP and report — do not build on a broken base.
   ```bash
   # tab-bridge (needs pnpm; Node >= 20, >= 22 recommended)
   pnpm install && pnpm run typecheck && pnpm test     # expect: 0 type errors, 89 tests pass
   # kod (Rust 1.85+)
   cargo test -p kod-error -p kod-provider -p kod-provider-openai -p kod-config -p kod-core
   cargo clippy --workspace
   ```
3. **One task at a time.** Tasks are numbered (T1…T12, K1…K7, I1…I5). Execute in order. After each task: apply the edit, run that task's **Verify** command, fix until green, then commit:
   ```bash
   git add -A && git commit -m "fix(bridge): T3 unique call ids for identical parallel calls"
   ```
4. **Only modify files a task names.** If an edit's "old code" doesn't match the file (repo moved on), re-read the file, adapt minimally, and note the deviation in the commit message.
5. **Never weaken a test to make it pass.** If a listed test conflicts with a listed code change, the code change is wrong — re-read the task.
6. **tab-bridge rebuild note:** tests run against `dist/` (`pnpm test` = build + `node --test dist/test/*.test.js`). Always run `pnpm test`, never `node --test` directly, after editing `src/` or `test/`.
7. **Out of scope:** do not add npm dependencies (the repo is zero-runtime-deps by design), do not rename public APIs beyond what tasks specify, do not reformat files.

---

## Part 2 — tab-bridge fixes (apply in order T1 → T12)

### T1 (P0) — INJECT_TEXT must coerce non-string content

**Files:** `src/core/classifier.ts`, `src/engine.ts`, `src/facade/errors.ts`

**Problem.** `classifyBase` builds `injectText: delta[0].content as string` in two places. kod/OpenAI clients may legally send `content: [{type:"text",text:"..."}]` (multimodal array shape) or `content: null`. The cast pushes an **array** (or null) into `compileInjectText`, and the array is sent to the worker as the composer text (JSON-serialized garbage on the wire). `textOf()` already exists in `src/core/canonical.ts` for exactly this and is not used here.

**Fix 1 — `src/core/classifier.ts`:** extend the import and coerce both fast paths.

```ts
// line ~6 — replace the import
import { canonical, stripSystemPrefix, textOf } from "./canonical.js";
```

```ts
// Fast path 1 (single new user message) — replace the whole if-block:
  if (delta.length === 1 && delta[0].role === "user") {
    const text = textOf(delta[0].content);
    if (text.length === 0) {
      return { plan: "RESET_RESEED", reason: "empty-user-delta" };
    }
    return {
      plan: "INJECT_TEXT",
      reason: "single-user-delta",
      injectText: text,
    };
  }
```

```ts
// Fast path 3 (echo-skip) — replace injectText inside the if-block:
  if (
    delta.length === 2 &&
    delta[0].role === "assistant" &&
    !hasToolCalls(delta[0]) &&
    delta[1].role === "user"
  ) {
    const text = textOf(delta[1].content);
    if (text.length === 0) {
      return { plan: "RESET_RESEED", reason: "empty-user-delta" };
    }
    return {
      plan: "INJECT_TEXT",
      reason: "echo-skip-user-delta",
      injectText: text,
    };
  }
```

**Fix 2 — `src/engine.ts`:** after `promptText` is computed in the execute-plan block (right below the `prompt-too-large` check), reject empty compiled prompts with a typed error:

```ts
    // A fully empty compiled prompt would submit nothing (or an empty
    // bubble) into the tab. Fail with a typed, caller-actionable error.
    if (promptText.trim().length === 0) {
      throw new Error("empty-prompt");
    }
```

**Fix 3 — `src/facade/errors.ts`:** in `mapTurnError`, next to the `prompt-too-large` branch, add:

```ts
  if (msg === "empty-prompt") {
    return badRequest("compiled prompt is empty (message content resolved to no text)");
  }
```

**Tests.** In `test/classifier.test.ts` add:
```ts
it("coerces ContentPart-array user content and rejects empty text", () => {
  const row = { hasRow: true, scheme: 3, mode: "stateful" as const,
    chain: ["a".repeat(32)], tabHash: null };
  const plan = classify(row, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: [{ type: "text", text: "next step" }] },
  ]);
  assert.equal(plan.plan, "INJECT_TEXT");
  assert.equal(plan.injectText, "next step");

  const empty = classify(row, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: null },
  ]);
  assert.equal(empty.plan, "RESET_RESEED");
});
```
(Adjust imports/row shape to match the existing tests in that file.)

**Verify:** `pnpm test` — all green including the new case.

### T2 (P0) — Holdback ceiling silently swallows large tool calls

**Files:** `src/emulation/types.ts`, `src/emulation/holdback.ts`, `src/engine.ts`, `src/bridge.ts`, `src/config.ts`, `test/holdback.test.ts`

**Problem.** `HOLDBACK_CEILING = 4000`. While the holdback buffer is inside a ` ```tool_call ` fence and no closing ` ``` ` has arrived, a buffer over 4000 chars is flushed **as plain content** — and the flush emits a bare `{type:"content"}` event, which carries **no warning**, so the repair round never triggers (`warnings.length === 0`). A kod `write_file` with ≳3 KB of JSON-escaped content therefore *silently* degrades into a text completion: kod receives prose instead of a tool call and the agent loop misbehaves. This is the single most integration-breaking tab-bridge bug for a coding harness.

**Fix 1 — `src/emulation/types.ts`:**
```ts
export const HOLDBACK_CEILING = 65_536;
```

**Fix 2 — `src/emulation/holdback.ts`:** the ceiling flush (inside `drain()`, the `if (this.pending.length > this.ceiling)` branch) must surface a warning so the repair machinery can act:
```ts
      // No close yet: ceiling check.
      if (this.pending.length > this.ceiling) {
        this.holding = false;
        const flushed = this.pending;
        this.pending = "";
        events.push({
          type: "invalid",
          text: flushed,
          error:
            `tool_call fence exceeded the holdback ceiling (${this.ceiling} chars); ` +
            "flushed as content — the model likely tried to inline a very large payload",
        });
        return events;
      }
```
(`invalid` events already flow through the engine's `emitEvent` as content + warning, which arms the bounded repair round.)

**Fix 3 — make the ceiling configurable end-to-end.**

`src/config.ts` — add to `Config` and `DEFAULTS`:
```ts
  /** Max chars buffered inside an open tool_call fence before it is
   * flushed as content with a warning (repair round can then react). */
  holdbackCeiling: number;
```
```ts
  holdbackCeiling: 65_536,
```
Add flag parsing (next to `--repair-rounds`) and a usage line:
```ts
      case "--holdback-ceiling":
        cfg.holdbackCeiling = Number(val());
        if (!Number.isInteger(cfg.holdbackCeiling) || cfg.holdbackCeiling < 1000) {
          throw new Error("--holdback-ceiling must be an integer >= 1000");
        }
        break;
```
```ts
    "  --holdback-ceiling=<n>  max chars held inside an open tool_call fence (default 65536)",
```

`src/engine.ts` — add to `TurnRequest`:
```ts
  /** Holdback ceiling override (0/unset = library default). */
  holdbackCeiling?: number;
```
and in `observePass`, replace `const holdback = new HoldbackBuffer();` with:
```ts
  const holdback = new HoldbackBuffer(req.holdbackCeiling ?? HOLDBACK_CEILING);
```
(import `HOLDBACK_CEILING` alongside the existing `HoldbackBuffer` import — it is exported from `src/emulation/types.ts`.)

`src/bridge.ts` — in `handleChat`, add to the `runTurn` request object:
```ts
          holdbackCeiling: this.config.holdbackCeiling,
```

**Tests.** Append to `test/holdback.test.ts` (match the file's existing import style):
```ts
it("a fence larger than a small custom ceiling flushes as content WITH a warning", () => {
  const hb = new HoldbackBuffer(50);
  const events = hb.push('```tool_call\n{"name":"write_file","arguments":{"path":"a.txt","content":"' +
    "x".repeat(80) + '"}}\n```');
  const evs = [...events, ...hb.finish()];
  assert.ok(evs.some((e) => e.type === "invalid"), "must emit an invalid/warning event");
});
it("a 10KB tool_call survives the default ceiling as a call", () => {
  const hb = new HoldbackBuffer(); // default 65536
  const big = "y".repeat(10_000);
  const events = hb.push('```tool_call\n{"name":"write_file","arguments":{"content":"' + big + '"}}\n```');
  const evs = [...events, ...hb.finish()];
  const call = evs.find((e) => e.type === "call");
  assert.ok(call, "large call must parse");
});
```

**Verify:** `pnpm test`.

### T3 (P1) — Unique call ids for identical parallel calls

**Files:** `src/emulation/ids.ts`, `src/engine.ts`

**Problem.** `synthCallId(name, argsJson)` = `call_` + blake2b(name+args)[:5 bytes]. Two tool calls with the same name and identical arguments in one reply (a coding agent does this constantly — e.g. two `read_file` calls on the same path in different graph branches) produce the **same `tool_call_id`**. kod links tool results to calls by id (`Part::FunctionResponse{id}`); duplicate ids corrupt the linkage and can force `RESET_RESEED` loops.

**Fix — `src/emulation/ids.ts`:**
```ts
export function synthCallId(name: string, argsJson: string, occurrence = 0): string {
  let canonical: string;
  try {
    canonical = canonJson(JSON.parse(argsJson || "{}"));
  } catch {
    canonical = argsJson || "";
  }
  const digest = createHash("blake2b512")
    .update(`${name}:${canonical}#${occurrence}`, "utf8")
    .digest();
  return `call_${digest.subarray(0, 5).toString("hex")}`;
}
```
Determinism is preserved (same reply text ⇒ same occurrence indexes ⇒ same ids across restarts).

**`src/engine.ts`:** thread an occurrence counter through the streaming path.
1. `validateCallEvent` gains a parameter and uses it:
```ts
export function validateCallEvent(
  name: string,
  argsJson: string,
  tools: ToolSpec[],
  suppliedId?: string,
  occurrence = 0
): { ok: true; call: ParsedCall } | { ok: false; error: string } {
```
and at the bottom of the success branch:
```ts
      id: suppliedId ?? synthCallId(name, JSON.stringify(argsObj), occurrence),
```
2. In `observePass`, add next to the other local state:
```ts
  const callOccurrence = new Map<string, number>();
  const nextOccurrence = (name: string, argsJson: string): number => {
    const key = `${name}\u0000${argsJson}`;
    const n = callOccurrence.get(key) ?? 0;
    callOccurrence.set(key, n + 1);
    return n;
  };
```
3. In `emitEvent`'s call branch:
```ts
      const v = validateCallEvent(
        ev.name,
        ev.argsJson,
        tools,
        ev.id,
        ev.id === undefined ? nextOccurrence(ev.name, ev.argsJson) : 0
      );
```

**Tests.** `test/ids.test.ts` (or the engine/contract test file that already asserts call ids — search for `call_` in `test/`):
```ts
it("identical parallel calls get distinct ids per occurrence", () => {
  const a = synthCallId("read_file", '{"path":"x"}', 0);
  const b = synthCallId("read_file", '{"path":"x"}', 1);
  assert.notEqual(a, b);
  assert.equal(synthCallId("read_file", '{"path":"x"}', 0), a); // still deterministic
});
```

**Verify:** `pnpm test`.

### T4 (P1) — Honor the worker's `retryAfterSec` (exact remaining cooldown)

**Files:** `src/adapter/deepseek.ts`, `src/facade/errors.ts`, `src/link/protocol.ts`, `extension/background.js`

**Problem.** The worker protocol defines `ERROR.retryAfterSec` and `background.js` sends `retryAfterSec: 1200`, but the bridge never reads it — `mapTurnError` always returns the constant 1200. Once kod waits out Retry-After (Part 3), a stale hint sends kod back **into** a still-closed window (e.g. after a bridge restart, or when the tab was rate-limited 15 minutes ago and a *new* 429 carries the old constant). The BIND_FAILED `rate-limited-cooldown` path also hardcodes no hint at all.

**Fix 1 — `src/adapter/deepseek.ts`:** `errText` must carry the hint:
```ts
/** Normalize an ERROR observation into a mappable error string. */
function errText(ev: Extract<WorkerObservation, { t: "ERROR" }>): string {
  const base = `turn-error:${ev.code}`;
  const detail = ev.detail ? `:${ev.detail}` : "";
  const retry =
    typeof ev.retryAfterSec === "number" && ev.retryAfterSec > 0
      ? `;retry-after=${ev.retryAfterSec}`
      : "";
  return `${base}${detail}${retry}`;
}
```

**Fix 2 — `src/link/protocol.ts`:** extend the BIND_FAILED observation:
```ts
  | { t: "BIND_FAILED"; sessionId: string; code: string; detail?: string; retryAfterSec?: number }
```

**Fix 3 — `src/facade/errors.ts`:** parse the hint where rate limits are mapped. At the top of `mapTurnError` (after `const msg = ...`):
```ts
  const retryHint = /retry-after=(\d+)/.exec(msg);
  const retryAfterSec = retryHint ? Number(retryHint[1]) : RATE_LIMIT_COOLDOWN_SEC;
```
Use it in both branches:
```ts
  if (
    msg === "provider-rate-limited" ||
    msg.startsWith("provider-rate-limited:") ||
    msg.startsWith("turn-error:rate_limited")
  ) {
    return rateLimited(
      retryAfterSec,
      `provider reports rate limiting (Messages too frequent); wait ~${Math.ceil(retryAfterSec / 60)} minutes before retrying`
    );
  }
```
and inside the `bind-failed` branch:
```ts
    if (detail.includes("rate-limited")) {
      return rateLimited(
        retryAfterSec,
        `every managed tab is cooling down from a provider rate limit; wait ~${Math.ceil(retryAfterSec / 60)} minutes`
      );
    }
```

**Fix 4 — `extension/background.js`:** send the real remaining cooldown on the bind path. Add near `tabInCooldown`:
```js
/** Longest remaining rate-limit cooldown across known tabs, in seconds. */
function maxCooldownRemainingSecs() {
  let max = 0;
  for (const st of tabState.values()) {
    if (st.rateLimitedUntil && st.rateLimitedUntil > Date.now()) {
      max = Math.max(max, st.rateLimitedUntil - Date.now());
    }
  }
  return Math.ceil(max / 1000);
}
```
and in `handleBind`, replace the rate-limited-cooldown send:
```js
    send({
      t: "BIND_FAILED",
      sessionId: m.sessionId,
      code: "rate-limited-cooldown",
      retryAfterSec: Math.max(30, maxCooldownRemainingSecs()),
    });
```
The turn-error path (`ERROR{code:"rate_limited", retryAfterSec:1200}`) stays as is — DeepSeek's hint carries no seconds; 1200 is the observed window.

**Tests.** `test/ratelimit.test.ts` (or `contract.test.ts`) — drive `mapTurnError` directly:
```ts
it("uses the worker retry-after hint when present", () => {
  const be = mapTurnError(new Error("turn-error:rate_limited;retry-after=640"));
  assert.equal(be.retryAfter, 640);
});
it("falls back to the 1200s default without a hint", () => {
  const be = mapTurnError(new Error("turn-error:rate_limited"));
  assert.equal(be.retryAfter, 1200);
});
```

**Verify:** `pnpm test` (bridge) — then reload the unpacked extension in Chrome (extension changes are not covered by `pnpm test`; sanity-check via the E2E fake worker: `pnpm run e2e`).

### T5 (P1) — `ensureReady`: no PING flood; tolerate transient `degraded`

**Files:** `src/adapter/deepseek.ts`

**Problem.** Two defects in `ensureReady`'s poll loop:
1. When the PING **succeeds** but the tab is not in the snapshot (`me === undefined`), the loop re-pings immediately — a hot loop hammering the worker for the whole `bindTimeoutMs` (20 s).
2. A tab whose health snapshot reads `degraded` (transient: injector port reconnect, SW restart) fails the turn **instantly** instead of being awaited, even though the code's own comment says these states are transient.

**Fix — replace the loop body:**
```ts
  async ensureReady(tab: ManagedTab, timeoutMs: number): Promise<Ready> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, detail: "tab-not-known-to-worker" };
      try {
        const tabs = await this.pool.ping(Math.min(5_000, Math.max(500, remaining)));
        const me = tabs.find((t) => t.tabId === tab.tabId);
        if (me) {
          if (me.health === "ok") return { ok: true };
          // Terminal for this window: map to 429/5xx immediately.
          if (me.health !== "degraded") return { ok: false, detail: me.health };
          // Transient (port reconnect / SW restart): keep polling.
        }
        // Back off before the next ping — a hot loop here hammers the
        // worker for the entire deadline when the tab is simply absent.
        await new Promise((r) => setTimeout(r, 250));
      } catch (e) {
        if (e instanceof TimeoutError) return { ok: false, detail: "ensureReady-timeout" };
        if (Date.now() >= deadline) return { ok: false, detail: "tab-not-known-to-worker" };
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
```

**Verify:** `pnpm test` (worker-link tier exercises bind/readiness over a real socket). Manual check: `TAB_BRIDGE_DEBUG=1 node dist/src/index.js serve ...` with no worker connected must log PINGs at ≥250 ms spacing, not thousands.

### T6 (P1) — Fail in-flight turns fast when the injector port dies

**Files:** `extension/background.js`

**Problem.** `port.onDisconnect` only marks health `degraded`. Any turn in flight on that tab (`turnByReq`) keeps waiting until its full deadline timer fires (240 s), so a tab crash/nav turns into a 4-minute hang that kod experiences as a timeout instead of a fast `port-lost` 502.

**Fix — replace the `port.onDisconnect` listener inside `handleInjectorConnect`:**
```js
  port.onDisconnect.addListener(() => {
    if (portByTab.get(tabId) === port) portByTab.delete(tabId);
    blog("injector disconnected (tab", tabId + ")");
    markHealth(tabId, "degraded", "port-disconnected");
    // Fail every in-flight turn on this tab now — the injector can no
    // longer answer, and letting them ride to the deadline turns a tab
    // crash into a 4-minute hang.
    for (const [reqId, rec] of [...turnByReq]) {
      if (rec.tabId === tabId && !rec.finished) {
        rec.finished = true;
        clearTimeout(rec.timer);
        if (rec.quietTimer) clearTimeout(rec.quietTimer);
        turnByReq.delete(reqId);
        send({ t: "ERROR", reqId, code: "port-lost", detail: "injector port disconnected mid-turn" });
      }
    }
  });
```

**Verify:** `pnpm run e2e` (the fake extension covers the worker link). Manual drill per `TESTING.md` tier 3: start a turn, kill the tab, confirm the bridge logs `worker.observation ERROR port-lost` within ~1 s instead of after the deadline.

### T7 (P2) — Bridge→worker heartbeat (detect half-open sockets)

**Files:** `src/pool/pool.ts`

**Problem.** The worker pings bridge-ward every 25 s, but the bridge never pings worker-ward. If the extension host's TCP connection dies silently (laptop sleep, network switch), the bridge reads no `close` event, `hasWorker` stays `true`, and every bind wastes its full 20 s timeout until the OS finally gives up (minutes to hours). `WsConnection.sendPing()` exists and is never called; `WsConnection` already emits `"pong"` on control-frame 0xA.

**Fix — add to `WorkerPool` (fields near `private conn`):**
```ts
  private lastPongAt = Date.now();
  private heartbeatTimer: NodeJS.Timeout | null = null;
```

Methods:
```ts
  /** Detect half-open worker sockets: ping on an interval, detach when
   * pongs go stale. `WsConnection` emits "pong" for control frames. */
  startHeartbeat(intervalMs = 25_000, staleAfterMs = 75_000): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const conn = this.conn;
      if (!conn || !conn.isOpen) return;
      if (Date.now() - this.lastPongAt > staleAfterMs) {
        log.warn("worker.heartbeat-timeout", { staleMs: Date.now() - this.lastPongAt });
        this.detach("heartbeat-timeout");
        return;
      }
      try {
        conn.sendPing(Buffer.from("hb"));
      } catch {
        /* send failure surfaces via the socket close path */
      }
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
```

Wire-up:
1. In `attach()`, right after `this.conn = conn;`:
   ```ts
    conn.on("pong", () => {
      this.lastPongAt = Date.now();
    });
    this.startHeartbeat();
   ```
2. In `detach()` and in `onDown()`, add `this.stopHeartbeat();` as the first line.
3. `dispose()` already calls `this.pool.detach("shutdown")` — no change needed.

**Verify:** `pnpm test`; manual: start bridge + extension, suspend/resume the machine, confirm `worker.heartbeat-timeout` logs within ~75 s of resume-less stale state and binds fail fast with the usual 503.

### T8 (P2) — Don't drop `tabHash` on pre-submit failures

**Files:** `src/engine.ts`, `src/bridge.ts`

**Problem.** `TabBridge.handleChat`'s catch nulls `row.tabHash` for **any** `runTurn` error. Bind/readiness failures (worker down, bind timeout) never touched the tab — the engine deliberately avoids marking the row there ("otherwise every outage poisons the session") — but the facade-level catch undoes that care: with `tabHash = null`, the next tool-round delta fails the `fabricated-assistant-echo` tabHash check and forces a full `RESET_RESEED`. A 10-second outage converts every live session into a full reseed.

**Fix 1 — `src/engine.ts`** execute-plan catch (the one that calls `req.registry.markFailed(row)`):
```ts
  } catch (e) {
    req.registry.markFailed(row);
    // Tag the error so the facade can distinguish post-submission
    // failures (tab state unknown) from bind/readiness failures (tab
    // untouched — dropping tabHash here would force needless reseeds).
    if (e instanceof Error) {
      (e as Error & { postSubmit?: boolean }).postSubmit = true;
    }
    log.audit("turn.failed", {
      sessionId: row.sessionId,
      plan: plan.plan,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
```

**Fix 2 — `src/bridge.ts`** `handleChat` catch:
```ts
    } catch (e) {
      // Only a failure AFTER the tab was addressed leaves tab state
      // unknown; `markFailed` already handled the row for those. Bind/
      // readiness failures must leave the chain anchor untouched.
      const postSubmit = Boolean(
        (e as Error & { postSubmit?: boolean })?.postSubmit
      );
      if (postSubmit && row.tabId !== null && row.chain.length > 0) {
        row.tabHash = null;
      }
      throw e;
    }
```

**Verify:** `pnpm test`. Reasoning check: post-submit failures already get `pendingReset=true` + `tabHash=null` from `markFailed`, so behavior is preserved there; pre-submit failures now keep the anchor.

### T9 (P2) — Constant-time bearer comparison

**Files:** `src/facade/http.ts`

**Problem.** `authOk` compares the Authorization header with `===` — a timing side channel on the API key. Localhost threat model, but the README advertises bearer auth as the access control.

**Fix — replace the helper:**
```ts
import { timingSafeEqual } from "node:crypto";

function authOk(bridge: TabBridge, req: IncomingMessage): boolean {
  if (!bridge.config.apiKey) return true;
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${bridge.config.apiKey}`;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
```
**Verify:** `pnpm test` (worker-link tier covers token auth).

### T10 (P2) — Compact the session journal

**Files:** `src/core/registry.ts`

**Problem.** `JsonlSessionStore` appends one line per commit forever; `compact()` exists but nothing calls it. Long-running deployments boot slower and slower (full-file replay, last-line-wins).

**Fix — in `src/core/registry.ts`:**
1. Extend the store interface (persist is optional, so this stays backwards compatible):
```ts
export interface PersistStore {
  append(row: SessionRow): void;
  /** Optional housekeeping: rewrite the journal down to the given rows. */
  compact?(rows: SessionRow[]): void;
}
```
2. Track sweep count next to `sweepTimer`:
```ts
  private sweepCount = 0;
```
3. At the end of `sweep()` (after the deletion loop, before `return expired`):
```ts
    this.sweepCount += 1;
    if (expired.length > 0 || this.sweepCount % 30 === 0) {
      // Rewrite the journal: after expirations, and periodically even
      // without them, so a long-lived process does not grow the file
      // one line per commit forever.
      try {
        this.opts.persist?.compact?.(this.list());
      } catch {
        /* best effort */
      }
    }
```
**Verify:** `pnpm test`; manual: run a bridge for a few minutes, confirm `bridge-sessions.json` is rewritten (mtime changes) and boots identical rows.

### T11 (P3) — Dead code and rot cleanup

**Files:** `src/facade/http.ts`, `src/index.ts`, `src/config.ts` (usage text only)

1. **`POST /v1/sessions`** — the `poolBefore`/`force === false` block is dead (an empty `if` with a comment). Replace the whole `if (method === "POST") { ... }` body with:
```ts
    if (method === "POST") {
      const force = query.get("force") === "true";
      if (force && bridge.registry.size > 64) {
        bridge.registry.evictOldestIdle();
      }
      const sessionId = `sess-${randomId(8)}`;
      bridge.createSession(sessionId);
      sendJson(res, 201, { session_id: sessionId });
      return;
    }
```
2. **Duplicated comment** — `handleChat`'s streaming catch contains the same 3-line comment twice. Delete one copy.
3. **`resolveSessionKey`** — drop the unused `bridge` parameter and the `void bridge;` line; update the single caller (`resolveSessionKey(req, body)`).
4. **`--version`** hardcodes `1.0.0` while `package.json` says `1.2.x` and the SSE hook diag hardcodes `hookVersion: "1.2.27"`. Single-source the CLI:
```ts
// src/index.ts — add near the top
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkgVersion: string =
  (require("../../package.json") as { version?: string }).version ?? "unknown";
```
and use `process.stdout.write("tab-bridge " + pkgVersion + "\n");` in the version branch. (Path is relative to `dist/src/index.js` after build; if you move this helper, fix the relative path accordingly.) Also change `process.exit(cmd ? 0 : 0);` to `process.exit(0);`.
5. Keep `extension/sse-hook.js`'s `hookVersion` as is (MAIN-world scripts cannot read the manifest) but note it in a comment if not already present.

**Verify:** `pnpm run typecheck && pnpm test && node dist/src/index.js --version` prints the package version.

### T12 (P3) — Remove the dead `SESSION_OBSERVED` message

**Files:** `extension/injector.js` (or `extension/background.js` — choose one, see below)

**Problem.** The injector emits `SESSION_OBSERVED` every DS session change (`setInterval`, line ~1259) but `background.js`'s port handler has no case for it — it is silently dropped. The injector header comment advertises a "user-claimed-tab guard" that was never built.

**Fix (choose A; do A only if you also build the guard — out of scope here, so default is B):**
- **A (implement):** add a `case "SESSION_OBSERVED":` to `background.js`'s port message switch that stores `st.dsSessionId = msg.dsSessionId` on the tab state and logs it. (No behavioral guard.)
- **B (remove, default):** delete the `SESSION_OBSERVED` reporting interval and `lastDsSession` block from `injector.js`, and drop "DS session-id observation (user-claimed-tab guard)" from the header comment list. Update `extension/README.md` if it mentions it.

**Verify:** extension loads without console errors after reload; `rg -n "SESSION_OBSERVED" extension/` returns either a handled case (A) or nothing (B).

---

## Part 3 — kod: wait out the 20-minute rate-limit window, then re-drive

The feature lands in 7 tasks across 4 crates. Contract after completion:

> When tab-bridge answers **429** (either a plain HTTP 429 with `Retry-After`, or the same 429 flattened through the adk transport), kod **sleeps exactly the suggested window (bounded by config) once**, retries the **same request**, and only fails if the window closes twice in a row. With `rate_limit_wait_secs = 0` (default) behavior is byte-identical to today.

### K1 — `kod-error`: provider_status accepts an explicit hint

**File:** `crates/kod-error/src/error.rs`

Keep `provider_status(status, body)` working (Anthropic path calls it), add a hint-carrying variant, and delegate:

```rust
    /// Classify an HTTP error status + body into the closest typed variant.
    pub fn provider_status(status: u16, body: &str) -> Self {
        Self::provider_status_with_hint(status, body, None)
    }

    /// Same as [`KodError::provider_status`], but a parsed retry hint
    /// (from `Retry-After` or a body-text cue) overrides the 30 s
    /// default on 429.
    pub fn provider_status_with_hint(
        status: u16,
        body: &str,
        retry_after: Option<std::time::Duration>,
    ) -> Self {
        let snippet = kod_types::strutil::truncate_chars(body, 300);
        match status {
            401 | 403 => KodError::Provider(format!("auth error {status}: {snippet}")),
            404 => KodError::Provider(format!("not found {status}: {snippet}")),
            408 => KodError::ProviderTimeout { timeout_ms: 0 },
            429 => KodError::RateLimited {
                retry_after_secs: retry_after.map(|d| d.as_secs()).unwrap_or(30),
            },
            500..=599 => KodError::Provider(format!("server error {status}: {snippet}")),
            _ => KodError::Provider(format!("http {status}: {snippet}")),
        }
    }
```

**Verify:** `cargo test -p kod-error` (existing tests unchanged and green).

### K2 — `kod-provider`: long-hint sleep support in `RetryPolicy`

**File:** `crates/kod-provider/src/retry.rs`

**1. Expose the text-hint scanner** (it is private today; provider crates need it because adk hides headers). Add after `scan_text_hint`:

```rust
/// Parse a free-form "try again in ~20 minutes" hint out of an error
/// body or message. Public for provider crates whose transport flattens
/// errors to strings (adk), where headers are unreachable but the
/// upstream body text is embedded in the message. Returns seconds.
pub fn text_hint_secs(body: &str) -> Option<u64> {
    scan_text_hint(body).map(|d| d.as_secs())
}
```

**2. Extend `RetryPolicy`** — add the field to the struct, to `Default`, and to `immediate()`:

```rust
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub jitter_fraction: f64,
    /// Longest provider-suggested rate-limit window the loop may sleep
    /// out in full. `ZERO` (default) preserves the legacy behavior: any
    /// hint is clamped to `max_delay`. A hint at or below this budget is
    /// slept exactly ONCE per call before the next attempt (a second
    /// long window fails the call instead of parking it again).
    pub max_rate_limit_wait: Duration,
    /// Injectable sleep for tests. Production leaves this as `tokio::time::sleep`.
    pub sleep_fn: Arc<SleepFn>,
}
```
```rust
// Default::default():
            max_rate_limit_wait: Duration::ZERO,
```
```rust
// RetryPolicy::immediate():
            max_rate_limit_wait: Duration::ZERO,
```

**3. Rewrite the delay branch of `with_retry`:**

```rust
pub async fn with_retry<T, F, Fut>(policy: &RetryPolicy, f: F) -> Result<T>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut attempt = 1u32;
    let mut long_wait_used = false;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if !e.is_retryable() => return Err(e),
            Err(e) if attempt >= policy.max_attempts => return Err(e),
            Err(e) => {
                let delay = match &e {
                    KodError::RateLimited { retry_after_secs } => {
                        let hint = Duration::from_secs(*retry_after_secs);
                        if hint > policy.max_delay
                            && hint <= policy.max_rate_limit_wait
                            && !long_wait_used
                        {
                            // The provider asked for a long window (e.g. a
                            // stateful tab backend's ~20-minute send
                            // frequency limit). Sleep it out exactly once;
                            // a second such window fails the call.
                            long_wait_used = true;
                            hint
                        } else {
                            hint.min(policy.max_delay)
                        }
                    }
                    _ => policy.delay_for(attempt),
                };
                tracing::warn!(
                    attempt,
                    max_attempts = policy.max_attempts,
                    delay_ms = delay.as_millis() as u64,
                    long_wait = long_wait_used,
                    error = %e,
                    "transient provider error; retrying"
                );
                (policy.sleep_fn)(delay).await;
                attempt += 1;
            }
        }
    }
}
```

**Tests** (append to `mod tests`):
```rust
    #[tokio::test]
    async fn long_rate_limit_hint_is_slept_out_once_within_budget() {
        let sleeps: StdArc<std::sync::Mutex<Vec<Duration>>> =
            StdArc::new(std::sync::Mutex::new(Vec::new()));
        let s2 = sleeps.clone();
        let policy = RetryPolicy {
            max_rate_limit_wait: Duration::from_secs(1500),
            sleep_fn: StdArc::new(move |d: Duration| {
                s2.lock().unwrap().push(d);
                Box::pin(async {})
            }),
            ..RetryPolicy::immediate()
        };
        let calls = StdArc::new(AtomicU32::new(0));
        let c2 = calls.clone();
        let result: Result<u32> = with_retry(&policy, || {
            let n = c2.fetch_add(1, Ordering::SeqCst);
            async move {
                if n < 2 {
                    Err(KodError::RateLimited { retry_after_secs: 1200 })
                } else {
                    Ok(7)
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), 7);
        let s = sleeps.lock().unwrap();
        assert_eq!(s[0], Duration::from_secs(1200), "first hint slept in full");
        assert_eq!(*s.last().unwrap(), Duration::ZERO, "second long hint clamped (budget spent)");
    }

    #[tokio::test]
    async fn zero_budget_keeps_legacy_clamp() {
        let policy = RetryPolicy::immediate(); // max_rate_limit_wait = ZERO
        let calls = StdArc::new(AtomicU32::new(0));
        let c2 = calls.clone();
        let result: Result<u32> = with_retry(&policy, || {
            let n = c2.fetch_add(1, Ordering::SeqCst);
            async move {
                if n < 2 {
                    Err(KodError::RateLimited { retry_after_secs: 1200 })
                } else {
                    Ok(1)
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
```

**Verify:** `cargo test -p kod-provider`.

### K3 — `kod-provider-openai`: type the 429, wait it out (both paths)

**File:** `crates/kod-provider-openai/src/provider.rs`

**1. Struct + builder.** Add a field to `OpenAICompatProvider` (place it near `stream_guard_enabled`; initialize `Duration::ZERO` in **every** constructor — grep `fn with_api_key` / `fn new` / `with_api_key_and_timeout`):

```rust
    /// Longest provider-suggested rate-limit window the retry loops may
    /// sleep out. ZERO (default) = never wait out long windows.
    rate_limit_wait: std::time::Duration,
```

```rust
    /// Bound how long the retry loops may sleep out a provider-suggested
    /// rate-limit window. Tab-bridge's send-frequency limit is ~20 min;
    /// set ~1500 s for such endpoints (see EndpointConfig).
    pub fn with_rate_limit_wait(mut self, wait: std::time::Duration) -> Self {
        self.rate_limit_wait = wait;
        self
    }
```

**2. Typed error mapping.** Next to the existing `fn adk_err`:

```rust
/// Map an adk error onto the typed KodError taxonomy. adk owns the raw
/// HTTP response and exposes only `details.upstream_status_code` plus a
/// formatted message, so: 429 → typed `RateLimited` with a hint parsed
/// from the message text — tab-bridge's 429 body embeds
/// "…wait ~20 minutes…", which `text_hint_secs` reads (the numeric
/// `Retry-After` header itself is unreachable on this path). Everything
/// else keeps the legacy string mapping.
fn adk_err_typed(e: adk_core::AdkError) -> KodError {
    if e.details.upstream_status_code == Some(429) {
        let text = e.to_string();
        let secs = kod_provider::retry::text_hint_secs(&text).unwrap_or(1200);
        return KodError::RateLimited { retry_after_secs: secs };
    }
    adk_err(e)
}
```

**3. Non-streaming path (`collect` / `collect_once`) — this is what the engine's tool loop calls.** In `collect()`, build the policy with the budget:

```rust
        let policy = kod_provider::retry::RetryPolicy {
            max_rate_limit_wait: self.rate_limit_wait,
            ..kod_provider::retry::RetryPolicy::default()
        };
        kod_provider::retry::with_retry(&policy, || {
            let req = request.clone();
            async move { self.collect_once(&req, stream).await }
        })
        .await
```

In `collect_once`, change the first `map_err(adk_err)` (the one on `self.inner.generate_content(...)`, NOT the per-item one) to `map_err(adk_err_typed)`.

**4. Streaming path (`stream_request`).** Add a helper near `adk_err_typed`:

```rust
/// Delay before the next streaming attempt. A typed rate limit within
/// the wait budget sleeps out its window exactly once (attempt 1 only —
/// a second window inside one turn fails fast instead of parking the
/// session again). Other transients get a small linear backoff; the
/// pre-fix loop retried instantly, hammering a provider that had just
/// said "slow down".
fn rate_limit_delay(err: &KodError, wait_budget: Duration, attempt: u32) -> Duration {
    if let KodError::RateLimited { retry_after_secs } = err {
        let hint = Duration::from_secs(*retry_after_secs);
        if hint <= wait_budget && attempt <= 1 {
            return hint;
        }
        return Duration::ZERO;
    }
    Duration::from_millis(250 * u64::from(attempt))
}
```

In the attempt loop's pre-commit error branch (`Err(e) => { if !adk_precommit_retryable(&e) ... }`):

```rust
                    Err(e) => {
                        if !adk_precommit_retryable(&e) {
                            yield Err(adk_err(e));
                            return;
                        }
                        let err = adk_err_typed(e);
                        if attempt < MAX_STREAM_ATTEMPTS {
                            let delay = rate_limit_delay(&err, self.rate_limit_wait, attempt);
                            tracing::warn!(
                                attempt,
                                delay_ms = delay.as_millis() as u64,
                                error = %err,
                                "openai-compat stream: pre-commit transport error; retrying",
                            );
                            if delay > Duration::ZERO {
                                tokio::time::sleep(delay).await;
                            }
                            continue;
                        }
                        yield Err(err);
                        return;
                    }
```

And in the mid-stream decide block (`if let Some(err) = transport_error { ... }`), apply the same treatment before `continue`:

```rust
                if let Some(err) = transport_error {
                    if transport_retryable
                        && tracker.is_safe_to_retry()
                        && attempt < MAX_STREAM_ATTEMPTS
                    {
                        let delay = rate_limit_delay(&err, self.rate_limit_wait, attempt);
                        tracing::warn!(
                            attempt,
                            delay_ms = delay.as_millis() as u64,
                            error = %err,
                            "openai-compat stream: pre-commit read error; retrying",
                        );
                        if delay > Duration::ZERO {
                            tokio::time::sleep(delay).await;
                        }
                        continue;
                    }
                    yield Err(err);
                    return;
                }
```

**Verify:** `cargo test -p kod-provider-openai && cargo clippy -p kod-provider-openai`.

### K4 — `kod-config`: the `rate_limit_wait_secs` endpoint knob

**File:** `crates/kod-config/src/llm.rs` — add to `EndpointConfig` (before the closing brace; serde-default keeps every existing config file valid):

```rust
    /// Longest provider-suggested rate-limit window (seconds) that this
    /// endpoint's retry loops may sleep out inside a single request.
    ///
    /// Tab-bridge (stateful browser backend) enforces a ~20-minute
    /// send-frequency window and answers 429 with `Retry-After` up to
    /// 1200 s; set `rate_limit_wait_secs = 1500` so kod waits out the
    /// window and re-drives the turn instead of failing. `None`/0 keeps
    /// the legacy fail-fast behavior (hint clamped to the backoff cap).
    #[serde(default)]
    pub rate_limit_wait_secs: Option<u64>,
```

Also add one row to the endpoint table in `docs/config-reference.md`:
`rate_limit_wait_secs | u64 (seconds), optional | Sleep out provider rate-limit windows up to this long before re-driving a request. Set ~1500 for tab-bridge. Default: 0 (fail fast).`

**Verify:** `cargo test -p kod-config`.

### K5 — `kod-core`: wire the knob into provider construction

**File:** `crates/kod-core/src/provider_setup.rs` — in `build_provider`, the `ProviderKind::OpenAICompatible` arm becomes:

```rust
        ProviderKind::OpenAICompatible => {
            let api_key = resolve_api_key(endpoint);
            let provider = OpenAICompatProvider::with_api_key_and_timeout(
                endpoint.base_url.clone(),
                endpoint.model.clone(),
                api_key,
                endpoint.timeout_secs,
            )?
            .with_rate_limit_wait(std::time::Duration::from_secs(
                endpoint.rate_limit_wait_secs.unwrap_or(0),
            ));
            Ok(Arc::new(provider))
        }
```

**Verify:** `cargo test -p kod-core --lib provider_setup 2>/dev/null || cargo test -p kod-core --lib` (config_integration tests must stay green).

### K6 — `kod-core`: populate the rate-limit hint in `TurnFailure::classify`

**File:** `crates/kod-core/src/retry_strategy.rs`

The `TransportRateLimit { retry_after_secs }` variant exists but `classify` always fills `None`, even when the error text carries a hint. Fix the rate-limit arm:

```rust
        if l.contains("rate limit") || l.contains("429") || l.contains("too many requests") {
            return TurnFailure::TransportRateLimit {
                retry_after_secs: kod_provider::retry::text_hint_secs(raw),
            };
        }
```

(`kod-core` already depends on `kod-provider`. This makes `failure.summary()` log `"rate limited; retry after 1200s"` instead of a bare `"rate limited"`, and gives the engine's fallback loop accurate telemetry. The engine's fall-through decision itself is intentionally unchanged — the wait happens once, in the provider, where the request is still alive.)

Add a test to `mod tests`:
```rust
    #[test]
    fn classify_rate_limit_parses_body_hint() {
        let f = TurnFailure::classify(
            "http 429: provider reports rate limiting (Messages too frequent); \
             wait ~20 minutes before retrying",
        );
        match f {
            TurnFailure::TransportRateLimit { retry_after_secs } => {
                assert_eq!(retry_after_secs, Some(1200));
            }
            other => panic!("expected rate limit, got {other:?}"),
        }
    }
```

**Verify:** `cargo test -p kod-core --lib retry_strategy`.

### K7 — Integration tests for the new behavior

**File:** `crates/kod-provider-openai/tests/stream_retry.rs` (it already has a `MockServer` + `drain` harness — reuse it).

Add two tests, following the file's existing patterns:

```rust
/// tab-bridge contract: 429 whose body embeds the window text, then the
/// real answer once the window "elapses". With a wait budget >= the
/// hint, the provider must sleep out the hint (shortened here to 1 s)
/// and re-drive the SAME request instead of surfacing the error.
#[tokio::test]
async fn rate_limited_request_waits_out_hint_then_succeeds() {
    // Mock: first POST → 429 + tab-bridge-shaped body; second POST → text SSE.
    // Hint text uses a short unit so the test sleeps ~1 s of real time.
    // (mock server setup mirrors pre_commit_http_error_retries_up_to_budget_then_errors)
    // Provider: OpenAICompatProvider::...  .with_rate_limit_wait(Duration::from_secs(5))
    // Assert: drain(...) yields the text body; assert at least one 429 hit.
}

/// Without a budget (default), a 429 must NOT be slept out: it surfaces
/// after the attempt budget exactly like today (behavior lock).
#[tokio::test]
async fn rate_limit_without_wait_budget_fails_fast_as_before() {
    // Same mock, provider WITHOUT with_rate_limit_wait.
    // Assert: drain(...) returns Err containing "rate" / 429 text.
}
```

Concrete mock body to use for the 429 (matches tab-bridge's real shape — `src/facade/errors.ts`):

```json
{"error":{"message":"provider reports rate limiting (Messages too frequent); wait ~20 minutes before retrying","type":"tab_bridge_error","code":"rate_limited"}}
```

For the test, replace the "~20 minutes" text with `retry after 1 second` so the parsed hint is 1 s (the cue scanner accepts "retry after N unit"); assert the request is retried and succeeds. If the mock server cannot vary responses per request count, extend it minimally following its existing route registration style — do not change unrelated mocks.

Also add the non-streaming twin to `crates/kod-provider-openai/tests/provider.rs` (or `contracts.rs`, whichever holds `complete()` tests): same 429-then-success shape through `provider.complete(&req)` with `with_rate_limit_wait(5s)` and a 1 s hint.

**Verify:** `cargo test -p kod-provider-openai` — new tests green, existing stream_retry tests untouched and green.

---

## Part 4 — Integration hardening and go-live

### I1 — Ship the tuned endpoint config

Update `examples/kod-config.toml` (tab-bridge repo) to the final recommended shape and mirror it into `~/.kod/config.toml` on the deploy box:

```toml
[[llm.endpoints]]
name                = "tab-bridge"
provider            = "openai-compatible"
base_url            = "http://127.0.0.1:8789/v1"
model               = "deepseek-web-think"   # or "deepseek-web-chat"
api_key_env         = "TAB_BRIDGE_KEY"
context_window      = 200000                  # see I3 — chars/latency headroom, not the model's raw limit
timeout_secs        = 300
rate_limit_wait_secs = 1500                   # kod sleeps out the 20-min DeepSeek window once, then re-drives
```

Why 1500 and not 1200: the bridge's hint is precise after T4 (remaining cooldown), but the config is static — 1500 covers the full 1200 s window plus margin for queue/bind time, and the *actual* sleep is always `min(hint, budget)`.

### I2 — Verify the two 429 delivery channels

kod can receive the rate limit on two wire shapes; both must be exercised once before go-live:

1. **HTTP 429 before SSE headers** (the common case — the bridge sends headers lazily). Covered by K7's mock tests and a live drill:
   ```bash
   # with the bridge running and NO tabs cooling:
   curl -s -X POST http://127.0.0.1:8789/v1/chat/completions \
     -H 'content-type: application/json' -d '{"model":"deepseek-web-chat","messages":[{"role":"user","content":"hi"}]}'
   # trigger a real rate limit (send several turns quickly), then re-run and confirm:
   #   HTTP/1.1 429, retry-after: <n>, body code "rate_limited"
   ```
2. **Mid-stream SSE error frame** (`data: {"error":{...}}` after a 200 with events — possible when a failure hits after content flowed, e.g. during the repair round). This frame is bridge-emitted (`SseStream.fail`), HTTP-200, and **cannot be a 429**. Verify with:
   ```bash
   pnpm run e2e        # includes SSE error-frame scenarios
   ```
   Acceptance: kod treats a mid-stream error frame as a failed (committed) turn — **no automatic re-drive** (correct: re-generating would duplicate tab content). Confirm the adk transport surfaces the text; if instead it silently yields an empty stream, file a follow-up: the bridge should then also include `"finish_reason":"stop"` handling — but do NOT change the bridge in this pass.

### I3 — Prompt-size contract (400 `prompt-too-large` is terminal for kod)

The bridge compiles the **full flattened transcript** into the composer and refuses (never truncates) beyond the effective cap. Effective cap = `--max-prompt-chars` (default 1,000,000 chars) — note `TabBridge` passes it into the DeepSeek adapter's `maxPromptChars`, overriding the adapter's 96 000 default.

kod classifies `prompt-too-large` as `Unknown` → `NextEndpoint` (or hard-fails single-endpoint setups), and 400s are not retryable by design. So:

* Set kod's `context_window` to a value whose worst-case rendered transcript stays under the bridge cap. Rough budget: rendered chars ≈ tokens × 3 for mixed code/text. `context_window = 200000` → ≲600 K chars worst case — safe under the 1 M default.
* If you raise `context_window`, raise `--max-prompt-chars` proportionally (the paste-to-file path accepts large payloads; `SUBMIT_READY_TIMEOUT_MS` is 90 s).
* Record the chosen pair in the deployment runbook. Mismatch symptom: bridge logs `turn.failed prompt-too-large:N>M` while kod reports "provider refused/unknown failure".

### I4 — Concurrency and 409 semantics (verification only, no code)

* Same-session overlap → bridge answers **409 `session_busy`**; kod's `adk_precommit_retryable` correctly treats 409 as terminal (test exists in `provider.rs`). Do not "fix" the 409 by queueing — ADR-7/R6 rejects silent queuing.
* kod swarm: ensure agents don't share one `session_id` when driving the same bridge concurrently (the `user` field is the session key — `crates/kod-provider-openai/src/provider.rs`, "Tab-bridge affinity"). Distinct agents ⇒ distinct sessions ⇒ distinct tabs, or they 409 each other.

### I5 — Full verification matrix (run all, in order, from clean builds)

```bash
# ── tab-bridge ─────────────────────────────────────────────
pnpm run typecheck          # 0 errors
pnpm test                   # all tests green (baseline 89 + new ones)
pnpm run e2e                # 15 scenarios, real bridge + real WS worker + real HTTP/SSE

# ── kod ─────────────────────────────────────────────────────
cargo test -p kod-error -p kod-provider -p kod-provider-openai -p kod-config -p kod-core
cargo clippy --workspace    # no new warnings

# ── live drill (TESTING.md tier 4) ──────────────────────────
# 1. bridge up:  node dist/src/index.js serve --port 8789 --api-key-env TAB_BRIDGE_KEY \
#                --stateful=true --auto-create-tabs --managed-only --ttl=30m \
#                --repair-rounds=1 --holdback-ceiling=65536
# 2. extension loaded in Chrome, HELLO_OK in the worker console
# 3. kod session against the endpoint; run a task that forces several write_file calls
#    (large tool payloads exercise T2/T3)
# 4. force a rate limit (rapid consecutive turns) and verify in kod's log:
#      "rate limited; retry after 1200s"  →  ~20 min later the SAME request completes
#      and the bridge log shows  turn.plan RESET_RESEED reason=pending-reset(...)  (orphan cleaned)
# 5. kill Chrome mid-turn → kod must fail fast with a port-lost/timeout 502, not hang 240 s
# 6. restart the bridge mid-session → next turn reseeds cleanly from the persisted chain
```

### Go-live checklist

- [ ] All tasks T1–T12 committed on `prod-integration`, `pnpm test` + `pnpm run e2e` green
- [ ] All tasks K1–K7 committed on `rate-limit-wait`, `cargo test` (5 crates) + `cargo clippy` green
- [ ] `examples/kod-config.toml` updated and deployed to `~/.kod/config.toml` with `rate_limit_wait_secs = 1500`
- [ ] Live drill I5 steps 1–6 executed once with real Chrome + real DeepSeek
- [ ] Docs: tab-bridge README (error table mentions `--holdback-ceiling`; retry semantics unchanged), `docs/config-reference.md` row from K4
- [ ] Rollback plan: both changes are additive; setting `rate_limit_wait_secs = 0` and reverting the bridge branch restores prior behavior exactly

---

## Appendix A — File index (everything this plan touches)

**tab-bridge:** `src/core/classifier.ts` (T1) · `src/engine.ts` (T1, T2, T3, T8) · `src/facade/errors.ts` (T1, T4) · `src/emulation/types.ts` (T2) · `src/emulation/holdback.ts` (T2) · `src/config.ts` (T2) · `src/bridge.ts` (T2, T8) · `src/emulation/ids.ts` (T3) · `src/adapter/deepseek.ts` (T4, T5) · `src/link/protocol.ts` (T4) · `extension/background.js` (T4, T6, T12) · `src/pool/pool.ts` (T7) · `src/facade/http.ts` (T9, T11) · `src/core/registry.ts` (T10) · `src/index.ts` (T11) · `extension/injector.js` (T12) · `examples/kod-config.toml` (I1) · tests under `test/`

**kod:** `crates/kod-error/src/error.rs` (K1) · `crates/kod-provider/src/retry.rs` (K2) · `crates/kod-provider-openai/src/provider.rs` (K3) · `crates/kod-config/src/llm.rs` (K4) · `docs/config-reference.md` (K4) · `crates/kod-core/src/provider_setup.rs` (K5) · `crates/kod-core/src/retry_strategy.rs` (K6) · `crates/kod-provider-openai/tests/stream_retry.rs` + `tests/provider.rs` (K7)

## Appendix B — Target rate-limit state machine (one request, end to end)

```
kod turn ──POST──▶ bridge ──BIND──▶ worker: all managed tabs cooling?
      ▲                                   │ yes
      │                                   ▼
      │                BIND_FAILED{rate-limited-cooldown, retryAfterSec=remaining}
      │                                   │
      │                                   ▼
      │                        bridge: 429 + Retry-After: remaining
      │                                   │
      │  turn sent, DeepSeek accepts-then-errors ("Messages too frequent")
      │  injector → ERROR{rate_limited, retryAfterSec:1200}
      │  bridge: tab cooldown 20 min + session pendingReset
      │                                   │
      └───────────────────────────────────┘
kod:
  adk_err_typed → KodError::RateLimited{hint}
  hint ≤ rate_limit_wait_secs ?  sleep(hint) once, re-drive SAME request
                              :  legacy clamp (fail after 3 quick attempts)
  second 429 in the same turn → fail (never park twice)
  eventual success → bridge RESET_RESEED (orphan cleaned) → INJECT flow resumes
```

