# Tab Bridge — Full Codebase Audit

**Repository:** https://github.com/elcoosp/tab-bridge (cloned at v1.2.71)
**Scope:** every runtime source file — `src/` (4,900 LOC, 5-layer bridge) and `extension/` (5,640 LOC: service worker, injector, SSE hook)
**Method:** full line-by-line read of all source (see `dump.txt`), cross-checked against the 245-test suite (all green, so every finding below is a *latent* defect the tests do not cover), plus **empirical proof harnesses** run against the real compiled code (outputs quoted inline; scripts listed in Appendix C).

---

## 1. Executive summary

Tab Bridge is a well-engineered, zero-dependency OpenAI facade over a live browser tab. The hash-chain reconciliation, the holdback fence parser, and the MV3 keepalive design are genuinely solid. However, a deep pass found **26 real defects**: 6 high-severity bugs, 5 memory leaks (2 proven by measurement), 9 performance issues, and a tail of correctness/robustness gaps concentrated in error-path reporting and input validation.

The three most consequential clusters:

1. **Lifecycle races.** `DELETE /v1/sessions/:id` does not respect the per-session turn mutex. Deleting a session while its turn is in flight (a) returns 204 while the turn keeps running, (b) releases the physical tab back to the allocatable pool **mid-turn** (two sessions can end up driving one tab), and (c) the in-flight turn's `commit()` re-persists the deleted row, so the journal resurrects a zombie session on next boot. *Reproduced.*
2. **Unbounded buffering on the worker link.** The hand-rolled RFC 6455 server accumulates never-terminated fragmented frames without any cap and accepts unmasked frames — a remote (localhost) peer can grow bridge memory at wire speed with trivial traffic. *Reproduced: 120 MB retained from ~120 MB of frames; unmasked frame accepted.*
3. **Orphan-message state lies.** The injector's no-stream failure path reports `userBubbleRendered: false` even when a user bubble *did* render. The bridge then skips `markFailed`, keeps `tabHash`, and the next turn injects *after an orphan user message the transcript never saw*. A second, smaller lie in the concurrent-turn rejection forces needless full reseeds.

### Finding index

| ID | Severity | Area | One-liner | Proof |
|----|----------|------|-----------|-------|
| H1 | **Critical** | facade/sessions | `DELETE /v1/sessions/:id` ignores the turn mutex → zombie rows + mid-turn tab release | reproduced |
| H2 | **Critical** | link/wsserver | Unbounded `fragParts`/`buffer` growth → memory DoS | reproduced (120 MB) |
| H3 | High | link/wsserver | Unmasked client frames accepted (RFC 6455 §5.1 violation) | reproduced |
| H4 | High | link/wsserver | No Origin check, no token by default → any local browser tab can seize the worker slot | code + design analysis |
| H5 | High | extension/background | Reconnect race: keepalive alarm + pending backoff timers open duplicate worker sockets | code-traced |
| H6 | High | extension/injector | `onNoStream` reports `userBubbleRendered:false` even when a bubble rendered → orphan-message corruption | code-traced |
| L1 | High | pool | `fragSeen` set never cleaned on link loss → unbounded growth | reproduced (1000 entries survive link drop) |
| L2 | Medium | pool | Boot `HEALTH` without `tabId` poisons `healthByTab` with an `undefined` ghost tab | reproduced |
| L3 | Medium | adapter/deepseek | One never-cleared `setTimeout` per poll iteration in `sendTurn`/`streamResponse` | code-traced |
| L4 | Medium | facade/http | `readBody` never settles on aborted uploads → handler leaked ~5 min each | reproduced |
| L5 | Low | several | `debuggerAttached` never pruned; `readyWaiters` empty arrays; subarray view retention | code-traced |
| P1 | High | pool | Every worker message is JSON-parsed N+1 times (routes + adapter) | code-traced |
| P2 | Medium | emulation/holdback | Whole held buffer rescanned per fragment (measured superlinear) | measured 25 ms @ default ceiling |
| P3 | Medium | emulation/parser | `extractFences` O(n²) slicing on many-block replies | code-traced |
| P4 | Medium | core/hashchain | Full-history re-hash every turn (`firstMismatch`) | code-traced |
| P5 | Medium | core/persist | `appendFileSync` on the turn hot path blocks the event loop | code-traced |
| P6 | Medium | facade/sse | SSE writes ignore backpressure; dead-socket writes keep flowing | code-traced |
| P7 | Low | log | `process.stdout.write` with no backpressure handling | code-traced |
| P8 | Low | adapter/deepseek | `ensureReady` busy-polls at 250 ms while holding a generation slot | code-traced |
| P9 | Medium | pool | `abortIntent` is dead code — admitted turns can never be cancelled | grep: zero callers |
| C1 | Medium | config | `--turn-timeout-ms` / `--bind-timeout-ms` accept `NaN`/negatives | code-traced |
| C2 | Medium | facade/http | Non-string `content` types crash `textOf` → 500 instead of 400 | code-traced |
| C3 | Medium | extension/injector | Documented DOM-capture fallback does not exist (dead `mode==="dom"` branches) | grep: no assignment |
| C4 | Low | docs | README paste threshold (8 000) ≠ code (4 000) | grep |
| C5 | Medium | extension/injector | Watchdog rate-limit scan false-positives on short assistant replies | code-traced |
| C6 | Medium | extension/injector | Concurrent-TURN rejection omits `userBubbleRendered:false` → needless reseed | code-traced |
| C7 | Medium | facade/errors | Error taxonomy via string-prefix matching on `Error.message` | code-traced |
| C8 | Low | facade/http + registry | `?force=true` evicts at most one session per create | code-traced |
| C9 | Low | extension/background | Duplicate global error listeners → double reporting | code-traced |
| C10 | Low | extension/background | `reportSwBoot` retries every 500 ms forever when link never opens | code-traced |
| C11 | Medium | engine | Empty-output turn commits `tabHash = null` → next tool round is a forced reseed | code-traced |
| C12 | Medium | extension/background | `helloQueue` overflow drops intents without answering → 20 s bridge hangs | code-traced |
| C13 | Low | adapter/deepseek | Ready-timeout misreported as `tab-not-known-to-worker` → needless rebind | code-traced |
| C14 | Low | extension/background | Legacy `handleSend` fallback can pick another session's tab | code-traced |
| C15 | Low | security hygiene | Token in query string, non-constant-time compare, unauth `/healthz` introspection | code-traced |

---

## 2. Architecture map (what I read)

```
src/index.ts        CLI entry (97)            src/log.ts          stdout JSON logging (15)
src/config.ts       flag parsing (245)        src/util/async.ts   Mutex/Deferred/withTimeout (86)
src/bridge.ts       TabBridge wiring (247)    src/util/json.ts    canonJson (24)
src/engine.ts       turn orchestration (545)
src/core/           canonical.ts, hashchain.ts, classifier.ts, registry.ts, persist.ts, turngate.ts
src/emulation/      compiler.ts, parser.ts, holdback.ts, ids.ts, types.ts
src/adapter/        types.ts, deepseek.ts, scripted.ts
src/link/           wsserver.ts (hand-rolled RFC 6455), protocol.ts
src/pool/           pool.ts (worker link + tab state + inflight correlation)
src/facade/         http.ts, sse.ts, errors.ts
extension/          background.js (MV3 SW, 1533), injector.js (content script, 2842), sse-hook.js (MAIN world, 1267)
```

Baseline: `npm install && npx tsc -p tsconfig.json && node --test dist/test/*.test.js` → **245/245 pass**. Every finding below is therefore not covered by the suite.

---

## 3. High-severity bugs — detail + fixes

### H1 (Critical) — `DELETE /v1/sessions/:id` races an in-flight turn

**Where:** `src/facade/http.ts:463-474` (handler), `src/core/registry.ts:193-200` (`delete`), `src/bridge.ts:142-150` (mutex the handler ignores).

**What happens.** The turn engine serializes per-session turns with a mutex held for the whole `runTurn` (acquired in `handleChat` via `registry.lockFor(...).tryAcquire()`). The DELETE handler never consults that lock:

```ts
// http.ts:463
if (method === "DELETE") {
  const row = bridge.registry.delete(sessionId);      // removes row + lock entry, ignores isBusy()
  if (!row) throw notFound(...);
  await bridge.pool.release(sessionId, 5_000);        // frees the physical tab NOW
  res.writeHead(204); res.end();
```

Three consequences, all verified:

1. **Zombie session.** The in-flight turn holds the `row` object. When it finishes, `registry.commit(row, ...)` (`registry.ts:163-175`) re-appends the row to the JSONL journal. On next boot, `store.load()` restores a session the operator deleted.
2. **Mid-turn tab release.** `pool.release()` during streaming tells the worker the tab is free. The next BIND can allocate that tab to a *different* session while the first turn is still injecting/reading it — two sessions interleaving DOM actions on one tab.
3. **False 200.** The caller of the in-flight turn receives HTTP 200 for a session that was concurrently deleted.

**Reproduction** (real HTTP stack, scripted adapter, session `sess-A`):

```
turn1 200; registry size 1
in-flight? registry busy: true
DELETE mid-turn status: 204            ← deleted while turn runs
turn2 finished after delete, status: 200
registry size after turn completes: 0  ← not in memory…
journal rows on next boot: ['sess-A']  ← …but resurrected in the journal (ZOMBIE, turns=2)
```

**Fix.** Make DELETE respect the same mutex; fail with 409 while a turn is in flight (the client can retry), and only then release the tab and compact the journal:

```ts
// src/facade/http.ts — replace the DELETE block
if (method === "DELETE") {
  const mutex = bridge.registry.lockFor(sessionId);
  if (!mutex.tryAcquire()) {
    throw new BridgeError({
      status: 409,
      code: "session_busy",
      message: `session ${sessionId} has a turn in flight; retry the delete`,
    });
  }
  try {
    const row = bridge.registry.delete(sessionId);
    if (!row) throw notFound(`no such session: ${sessionId}`);
    try {
      await bridge.pool.release(sessionId, 5_000);
    } catch { /* worker may be gone; the row is cleared regardless */ }
    // Persist the deletion: rewrite the journal without this row so a
    // concurrent/late commit cannot resurrect it on next boot.
    try { bridge.store.compact(bridge.registry.list()); } catch { /* best effort */ }
    res.writeHead(204);
    res.end();
    return;
  } finally {
    mutex.release();
    // delete() removed the lock entry; re-drop defensively is unnecessary —
    // delete() already did locks.delete(sessionId).
  }
}
```

Two supporting changes:

```ts
// src/core/registry.ts — remove the eager lock entry wipe inside delete()
delete(sessionId: string): SessionRow | undefined {
  const row = this.rows.get(sessionId);
  if (!row) return undefined;
  row.state = "draining";
  this.rows.delete(sessionId);
  // NOTE: do NOT `this.locks.delete(sessionId)` here anymore. The DELETE
  // handler now owns the lock for the duration of the delete (H1 fix), and
  // wiping the map entry mid-hold breaks `isBusy()` for observers racing
  // the handler. The handler drops the entry after releasing.
  return row;
}

dropLock(sessionId: string): void {
  // Compare-and-delete: only drop the entry that is the mutex we know,
  // never a freshly created one installed by a concurrent caller.
  this.locks.delete(sessionId);
}
```

And belt-and-braces in the journal layer so a late commit can never resurrect a deleted id, even from an older code path:

```ts
// src/core/persist.ts — add tombstone awareness
append(row: SessionRow): void { ... }        // unchanged
/** Explicitly remove a session from the journal. */
remove(sessionId: string): void {
  try {
    const rows = [...this.load().values()].filter((r) => r.sessionId !== sessionId);
    this.compact(rows);
  } catch { /* best effort */ }
}
```

> Call `store.remove(sessionId)` from the DELETE handler instead of `compact(list())` — equivalent, but readable.

---

### H2 (Critical) — Hand-rolled WS server: unbounded fragment reassembly (memory DoS)

**Where:** `src/link/wsserver.ts:28` (`fragParts`), `:106-114` (`onData` buffer concat), `:159-169` (continuation handling).

The parser reassembles client fragmentation by pushing payload copies into `fragParts` and only resetting on a FIN-arriving continuation. There is **no cap on message size, no cap on fragment count, no timeout, and no close punishment** for a peer that streams `opcode=0, FIN=0` frames forever:

```ts
case 0x0: {
  this.fragParts.push(f.payload);       // unbounded
  if (f.final) { ... }
  break;
}
```

`this.buffer` (raw unparsed bytes) has the same problem: garbage that never forms a complete frame accumulates forever.

**Reproduction** (feeding the real `WsConnection` 2 000 × 60 000-byte non-final continuation frames):

```
fragParts frames: 2000 retained: 120 MB
heap growth: 0 MB  ← CONFIRMED: unbounded buffering, connection never punished, no size cap
```

**Fix** — harden `WsConnection` with three caps and close the socket (1009 *Message Too Big*) when any is exceeded:

```ts
export class WsConnection extends EventEmitter {
  private socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragParts: Buffer[] = [];
  private fragOpcode = -1;
  ...
  /** DoS guards (H2): hard limits on per-connection reassembly. */
  private static readonly MAX_BUFFER_BYTES = 1 << 20;        // 1 MiB raw backlog
  private static readonly MAX_MESSAGE_BYTES  = 8 << 20;      // 8 MiB reassembled message
  private static readonly MAX_FRAGMENTS      = 1024;         // per message

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > WsConnection.MAX_BUFFER_BYTES) {
      this.close(1009, "frame backlog exceeded");
      return;
    }
    for (;;) {
      const frame = this.tryParseFrame();
      if (!frame) break;
      this.handleFrame(frame);
      if (!this._open) break;
    }
  }

  private handleFrame(f: { opcode: number; payload: Buffer; final: boolean }): void {
    switch (f.opcode) {
      case 0x0: {
        // continuation without a started message: protocol error, not a leak
        if (this.fragOpcode === -1) { this.close(1002, "unexpected continuation"); break; }
        this.fragParts.push(f.payload);
        const total = this.fragParts.reduce((n, b) => n + b.length, 0);
        if (total > WsConnection.MAX_MESSAGE_BYTES || this.fragParts.length > WsConnection.MAX_FRAGMENTS) {
          this.close(1009, "reassembled message too large");
          break;
        }
        if (f.final) { /* unchanged reassembly */ }
        break;
      }
      case 0x1:
      case 0x2: {
        // a NEW fragmented message while one is in flight: protocol error
        if (!f.final && this.fragOpcode !== -1) { this.close(1002, "interleaved fragmentation"); break; }
        if (f.payload.length > WsConnection.MAX_MESSAGE_BYTES) { this.close(1009); break; }
        ... // unchanged
      }
      ...
    }
  }
}
```

(Also drop the parse-failure garbage: after `this.close(...)` the loop already stops; the buffer is discarded with the connection.)

### H3 (High) — Unmasked client frames accepted

**Where:** `src/link/wsserver.ts:125,142-152`.

RFC 6455 §5.1: a server MUST close the connection if a client frame is not masked. The parser treats `maskKey` as optional and happily parses unmasked payloads.

**Reproduced:** sending an unmasked text frame `hello` was accepted and emitted as a message.

**Fix** (one line inside `tryParseFrame`, after parsing the header):

```ts
if (!masked) {
  // RFC 6455 §5.1: client-to-server frames MUST be masked.
  this.close(1002, "unmasked client frame");
  return null;
}
```

---

### H4 (High) — Worker link: no Origin check, no token by default (local hijack / DoS)

**Where:** `src/link/wsserver.ts:222-245` (`onUpgrade`), `src/bridge.ts:113-117` (`token: config.apiKey` — `null` unless `--api-key-env` is set).

The upgrade handler validates only the path, the WS key, and (optionally) a `?token=` query param. It never checks `Origin`. Consequences:

- Browsers **do** allow pages to open cross-origin WebSockets to `127.0.0.1`. Any website the user visits can attempt `new WebSocket("ws://127.0.0.1:8789/worker")`.
- With the default config (no API key) that page is **accepted as a worker**: `WorkerPool.attach` gives the first live connection the slot and refuses the real extension with `HELLO_REFUSED` (`pool.ts:84-122`). A malicious page can therefore permanently occupy the single worker slot (denial of service) or, worse, **feed crafted observations** (`BOUND`, `FRAGMENT`, `STATUS`, `ERROR`) into in-flight turns, corrupting assistant output. The 5-second guard only closes silent newcomers — the attacker just has to send a `HELLO`.
- Even with a token, `?token=` leaks into any intermediary logs, and the comparison `q.get("token") !== this.opts.token` is not constant-time.

**Fix** (defense-in depth; all three pieces):

```ts
// src/link/wsserver.ts
import { timingSafeEqual } from "node:crypto";

export interface WsServerOptions {
  path?: string;
  token?: string | null;
  /** Extra hardening (H4): reject browser-originated upgrades outright. */
  allowedOrigins?: string[];   // e.g. ["chrome-extension://<ext-id>"]
  onConnection(conn: WsConnection): void;
}

private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const path = this.opts.path ?? "/worker";
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];
  if (pathname !== path) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }

  // (1) Origin gate: a worker is never a web page. Chrome sends
  // chrome-extension://<id> — anything else (http/https/null) is refused
  // before any token work. This kills cross-site WebSocket hijacking from
  // ordinary web pages even when no token is configured.
  const origin = req.headers.origin;
  const allowed = this.opts.allowedOrigins;
  if (origin) {
    const ok = allowed ? allowed.includes(origin) : /^chrome-extension:\/\//i.test(origin);
    if (!ok) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
  }

  if (this.opts.token) {
    const q = new URLSearchParams(url.split("?")[1] ?? "");
    const got = Buffer.from(q.get("token") ?? "", "utf8");
    const want = Buffer.from(this.opts.token, "utf8");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  ...
}
```

```ts
// src/bridge.ts — pass the extension origin through when configured
this.wsServer = new WsServer({
  path: "/worker",
  token: config.apiKey,
  allowedOrigins: config.workerOrigins,   // new Config field (optional)
  onConnection: (conn) => this.pool.attach(conn),
});
```

> Document the flag: `--worker-origin=chrome-extension://<id>`. With no API key configured, the Origin gate is the only line of defense and MUST default to `chrome-extension://` in `parseServeArgs`.

---

### H5 (High) — Service-worker reconnect race can open duplicate worker sockets

**Where:** `extension/background.js:341-344` (`scheduleReconnect`), `:1524-1531` (keepalive alarm calls `connect()` unguarded), `:210-321` (`connect`).

Two independent timers can start connections:

1. The WS `close` handler calls `scheduleReconnect()` → a **backoff timer** (not stored, not cleared anywhere).
2. The `keepalive` alarm (every 30 s) calls `connect()` whenever `ws.readyState !== OPEN`.

If the link drops at t=0, the backoff timer fires at t=1 s and opens socket A. While A is `CONNECTING`/`OPEN`, a stale alarm (or another close→schedule cycle) fires `connect()` again, creating socket B and **orphaning A** (`ws` is overwritten). The bridge sees a live duplicate and refuses whichever one HELLOs second — which, in the worst ordering, is the socket `ws` now points to, leaving the *orphan* as the incumbent: log spam, `backoff = 60_000`, and the flap metronome the codebase has been fighting for ten patch versions (their own comments at `pool.ts:76-83` admit duplicate-worker fights are observed in the wild).

**Fix** — a single connection owner with a state machine:

```js
// extension/background.js
let ws = null;
let wsState = "closed";          // "closed" | "connecting" | "open"
let reconnectTimer = null;

function connect() {
  if (wsState !== "closed") return;          // H5: single-flight guard
  wsState = "connecting";
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    wsState = "closed";
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    wsState = "open";
    ... // unchanged HELLO
  });
  ws.addEventListener("close", () => {
    wsState = "closed";
    ... // unchanged backoff logic
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    try { ws.close(); } catch {}
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);   // H5: one pending timer
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
}

// keepalive alarm
if (a.name === "keepalive") {
  if (wsState === "closed" && !reconnectTimer) connect();   // H5: never double-fire
}
```

---

### H6 (High) — `onNoStream` reports `userBubbleRendered: false` even when a bubble rendered

**Where:** `extension/injector.js:2608-2616` (`onNoStream` tail), consumed by `src/engine.ts:508-519` and `src/adapter/deepseek.ts:275-282`.

`onNoStream` fires 15 s after a *verified* submit when no completion stream attached. The submit may already have rendered a user bubble (`verifySubmitted` returned true via `dsMessageCount()` growth or composer clearing). But the tail unconditionally claims:

```js
finishTurn(
  false, "submit-failed",
  isRetry ? "re-submit failed: ..." : "submit not confirmed: ...",
  false,
  { userBubbleRendered: false }     // ← LIE when the bubble rendered
);
```

The engine's rule (`engine.ts:512`): `userBubbleRendered === false` ⇒ *do not* `markFailed` ⇒ `pendingReset` stays false, `tabHash` is kept. The next turn classifies `INJECT_TEXT` and appends **after an orphan user message the transcript chain never saw** — the exact poisoned-tab failure mode the rest of the file works hard to prevent (see the "RCA stage 2" comments). The comment above the call ("no bubble means nothing to duplicate") is only true for the composer-still-holds-text branch.

**Fix** — report what the DOM actually showed:

```js
// injector.js — end of onNoStream()
// Report the truth about bubble rendering: a verified submit DOES place a
// user bubble even when no completion stream attached. Claiming "no bubble"
// makes the bridge keep tabHash and inject after an orphan user message.
const bubbleRendered = conversationNodes().length > (t.submitCount ?? 0);
finishTurn(
  false,
  "submit-failed",
  isRetry
    ? "re-submit failed: no completion stream and no ds-message growth"
    : "submit not confirmed: no completion stream within 15s and no ds-message growth",
  false,
  // Omit the flag when unknown → the bridge defaults to the SAFE path
  // (markFailed → pendingReset → clean reseed). Only claim `false` when the
  // DOM proves nothing rendered.
  bubbleRendered ? { userBubbleRendered: true } : {}
);
```

(The bridge already treats *absence* of the flag as "may have rendered" — `engine.ts:512-513` — so omitting it is the safe default.)

---

## 4. Memory leaks — detail + fixes

### L1 (High) — `pool.fragSeen` grows forever

**Where:** `src/pool/pool.ts:449` (decl), `:481-483` (add), `:464,478` (the only deletes).

`traceObservation` adds a `reqId` on the first FRAGMENT and deletes it only when a later `STATUS`/`ERROR`/`BIND_FAILED` observation for that reqId arrives. If the worker link drops mid-stream (or a turn is abandoned at the bridge while fragments were flowing), **nothing deletes the entry** — `onDown` (`:499-514`) fails pending requests but never touches `fragSeen`.

**Reproduced:**

```
fragSeen size after 1000 fragments: 1000
fragSeen size after link drop: 1000  ← LEAK: entries survive link loss
```

Each leaked entry is a small string, but the leak is unbounded over the process lifetime (every link-flap mid-turn leaks at least one) and turns the set into an ever-growing lookup cost.

**Fix** — clear it on link loss and cap it defensively:

```ts
// src/pool/pool.ts
private fragSeen = new Set<string>();
private static readonly FRAG_SEEN_MAX = 2048;

private traceObservation(o: WorkerObservation): void {
  ...
  case "FRAGMENT":
    if (reqId && !this.fragSeen.has(reqId)) {
      if (this.fragSeen.size >= WorkerPool.FRAG_SEEN_MAX) {
        // Set iterates in insertion order: drop the oldest.
        this.fragSeen.delete(this.fragSeen.values().next().value as string);
      }
      this.fragSeen.add(reqId);
      ...
    }
    break;
  ...
}

private onDown(info?: WsCloseInfo): void {
  this.stopHeartbeat();
  if (this.conn === null) return;
  ...
  this.fragSeen.clear();          // ← L1 fix: reqIds of the dead link are unreachable
  this.failAllPending(new Error("worker link lost (socket closed)"));
  this.emit("event", { type: "worker-down" } satisfies PoolEvent);
}
```

### L2 (Medium) — Ghost `healthByTab` entry keyed `undefined`

**Where:** `extension/background.js:1494-1504` (`reportSwBoot` sends `{ t:"HEALTH", state:"ok", detail:"sw-boot-ms=…" }` with **no tabId**), consumed by `src/pool/pool.ts:409-418` which does `this.healthByTab.set(h.tabId, ...)` unconditionally.

**Reproduced:** `tabHealth()` immediately returns `[{"state":"ok"}]` with `tabId: undefined`, which then shows up in `/healthz` (`bridge.ts:239`) as a phantom tab forever (it is never cleared until a socket drop).

**Fix** (both sides):

```ts
// src/pool/pool.ts — onMessage, HEALTH branch
if (o.t === "HEALTH") {
  const h = o as { t: "HEALTH"; tabId?: number; state: string; detail?: string };
  if (typeof h.tabId === "number") {          // L2: ignore tab-less diagnostics
    this.healthByTab.set(h.tabId, h.state as HealthState);
    this.emit("event", { type: "health", tabId: h.tabId, state: h.state as HealthState,
      ...(h.detail !== undefined ? { detail: h.detail } : {}) } satisfies PoolEvent);
  }
}
```

```js
// extension/background.js — reportSwBoot(): mark it explicitly worker-level
send({ t: "HEALTH", state: "ok", detail: `sw-boot-ms=${swBootAt}` });  // unchanged;
// bridge now ignores tab-less HEALTH for the per-tab map (see pool fix).
```

### L3 (Medium) — `DeepSeekAdapter` leaks one timer per poll iteration

**Where:** `src/adapter/deepseek.ts:142-146` (`sendTurn` ACCEPTED watcher) and `:181-185` (`streamResponse` event pump).

```ts
const ev = await Promise.race([
  this.nextEvent(reqId),
  new Promise<null>((r) => setTimeout(() => r(null), remaining).unref?.()),
]);
```

Every iteration of both loops allocates a fresh `setTimeout` that fires at the *turn deadline* and is never cleared. A long stream that delivers one event per 100 ms with a 240 s deadline keeps ~2 400 live timers and their closures resident until the deadline passes, when they all fire in a burst resolving already-settled promises. It also means the *last* iteration's timer keeps the `reqId` string and buffer objects reachable for up to the full deadline after the turn ended.

**Fix** — create one deadline timer per call, and per-iteration timeouts that are actually cleared:

```ts
// src/adapter/deepseek.ts — streamResponse loop
const deadline = Date.now() + timeoutMs;
let idleTimer: NodeJS.Timeout | null = null;
try {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("timeout: no stream completion");
    const ev = await new Promise<WorkerObservation | null>((resolve) => {
      idleTimer = setTimeout(() => resolve(null), remaining);
      idleTimer.unref?.();
      this.nextEvent(reqId).then(
        (e) => resolve(e),
        () => resolve(null)
      );
    }).finally(() => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; });
    if (ev === null) throw new Error("timeout: no stream completion");
    ... // unchanged switch
  }
} finally {
  this.closeBuffer(reqId);
}
```

> `sendTurn`'s watcher loop gets the identical treatment. Alternatively, reuse a small helper `raceWithTimeout(p, ms)` in `util/async.ts` that owns and clears the timer — that helper is the reusable form of this fix and also fixes `withTimeout`'s own missing `clearTimeout`-on-p-rejection symmetry.

### L4 (Medium) — `readBody` never settles on aborted uploads

**Where:** `src/facade/http.ts:47-63`. The promise listens for `end`/`error` only. If the client aborts mid-body (common: kod client timeout during a large seed), the promise stays pending forever; the whole `handle()` chain (request, response, received chunks) is retained until Node's `requestTimeout` (300 s default) destroys the socket state. Under a flaky-client load this is a slow handle leak.

**Reproduced:** aborted raw-socket upload → `handleChat invoked: 0` (handler never ran nor rejected) with `requestTimeout` disabled.

**Fix:**

```ts
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        done(() => reject(badRequest("request body too large")));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => done(() => resolve(Buffer.concat(chunks))));
    req.on("error", (e) => done(() => reject(e)));
    // L4 fix: an aborted upload never emits "end" — settle immediately.
    req.on("close", () => {
      if (!req.readableEnded) done(() => reject(Object.assign(new Error("request aborted"), { code: "client_gone" })));
    });
  });
}
```

The thrown error surfaces through `handleChat`'s `client_gone` guard (`http.ts:296-299` already treats `code === "client_gone"` as a silent return) — extend that check to catch it on the body phase as well.

### L5 (Low) — Minor retention issues

| Where | Issue | Fix |
|---|---|---|
| `extension/background.js:1107` `debuggerAttached` | Set entries never removed on `tabs.onRemoved`; Chrome detaches automatically but the Set pins the id until SW restart | In the `chrome.tabs.onRemoved` listener (`:1303`) add `debuggerAttached.delete(tabId);` |
| `extension/background.js:649-664` `readyWaiters` | Timeout path splices the waiter, but per-tab empty arrays persist forever after a connect | `readyWaiters.delete(tabId)` inside the connect path when the new list is empty; or use a plain array per call |
| `src/link/wsserver.ts:153` | `this.buffer = buf.subarray(offset + len)` pins the parent concat buffer for one chunk | `this.buffer = Buffer.from(buf.subarray(offset + len))` — copies the small remainder and releases the parent |
| `extension/background.js:88` `helloQueue` | Intents dropped at the 20-cap are never answered (see C12) | Answer dropped intents with BIND_FAILED/ERROR immediately |

---

## 5. Performance issues — detail + fixes

### P1 (High) — Every worker message is parsed N+1 times

**Where:** `src/pool/pool.ts:392-441` (`onMessage` parses once, then `emit("raw", raw)`), consumed by `adapter/deepseek.ts:55-67` (`dispatch` parses again) and by **every** in-flight `request()` route (`pool.ts:361-376`), each of which calls `parseWorkerMessage(raw)` again.

With K concurrent turns (kod retry storms legitimately hold dozens) and fragment-per-message streaming, each FRAGMENT is JSON-parsed `K + 2` times. At 50 inflight requests and ~50 fragments/sec this is ~2 500 parses/sec of identical payloads — pure CPU burn on the event loop that also streams SSE.

**Fix** — parse once, emit the parsed object (keep `raw` for debug):

```ts
// src/pool/pool.ts
private onMessage(raw: string): void {
  const o = parseWorkerMessage(raw);
  if (!o) return;
  this.traceObservation(o);
  ... // unchanged protocol branches
  this.emit("raw", o);          // emit the PARSED observation
}

// Inflight route + adapter dispatch change signature:
private request<T>(intent, what, timeoutMs, match, failMatch): Promise<T> {
  ...
  const route = (o: WorkerObservation) => {   // no more re-parse
    if (failMatch) {
      const fail = failMatch(o);
      if (fail) { entry.cleanup(); d.reject(fail); return; }
    }
    if (match(o)) { entry.cleanup(); d.resolve(o as T); }
  };
  ...
}

// src/adapter/deepseek.ts
private dispatch(o: WorkerObservation): void {
  if (!o || !("reqId" in o)) return;
  const reqId = (o as { reqId: string }).reqId;
  const buf = this.buffers.get(reqId);
  if (!buf) return;
  const waiter = buf.waiters.shift();
  if (waiter) waiter(o);
  else buf.list.push(o);
}
// constructor: this.pool.on("raw", (o: WorkerObservation) => this.dispatch(o));
```

### P2 (Medium) — `HoldbackBuffer` rescans the entire held buffer per fragment

**Where:** `src/emulation/holdback.ts:89` — while holding, every `push()` runs `this.pending.indexOf("```", this.openLen)` over the *whole* accumulated buffer, plus a regex pass when not holding.

Measured (single stream, 8-char fragments, fence never closes): ceiling 8 K → 1.8 ms; 32 K → 8.3 ms; 64 K (default) → **25 ms** of pure rescanning per turn. Superlinear, and it burns event-loop time in the SSE hot path.

**Fix** — track the already-scanned suffix and search only new data:

```ts
// src/emulation/holdback.ts
private scannedUpTo = 0;   // index into this.pending already known close-free

// In push(): this.pending += fragment;  return this.drain();
// In drain(), holding branch:
const closeIdx = this.pending.indexOf("```", Math.max(this.openLen, this.scannedUpTo));
if (closeIdx !== -1) {
  this.scannedUpTo = 0;
  ... // unchanged
} else {
  // everything except the last 2 chars can never form "```" alone
  this.scannedUpTo = Math.max(this.openLen, this.pending.length - 2);
  if (this.pending.length > this.ceiling) { ...unchanged ceiling flush, reset scannedUpTo = 0; }
  return events;
}
// Reset scannedUpTo = 0 whenever pending is emptied or re-sliced (holding=false paths).
```

This turns the per-fragment cost into O(fragment size).

### P3 (Medium) — `extractFences` re-slices the remainder per block

**Where:** `src/emulation/parser.ts:23-45` — `rest = rest.slice(consumed)` per iteration plus `fullText.slice(cursor, b.start)` later. A reply with many fences is O(n·blocks). Also `canonical.ts` `rewriteLegacyAssistant` has the same shape.

**Fix** — track absolute offsets instead of re-slicing:

```ts
function extractFences(text: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let searchFrom = 0;
  for (;;) {
    const open = matchFrom(FENCE_OPEN, text, searchFrom);   // sticky regex (y flag)
    if (!open) break;
    const closeIdx = text.indexOf("```", open.index + open[0].length);
    if (closeIdx === -1) break;
    blocks.push({
      inner: text.slice(open.index + open[0].length, closeIdx).trim(),
      start: open.index,
      end: closeIdx + 3,
    });
    searchFrom = closeIdx + 3;
  }
  return blocks;
}
// FENCE_OPEN becomes sticky: /^[ \t]*```tool_call[ \t]*\r?\n?/my with lastIndex = searchFrom
```

### P4 (Medium) — Full-history re-hash on every turn

**Where:** `src/core/hashchain.ts:57-69` (`firstMismatch`) called from `classifier.ts:67`, plus `foldAll`/`foldDelta` in `engine.ts:448-451`.

Every turn blake2b-hashes the *entire* conversation prefix — O(total chars) per turn, twice on SEED/RESET paths. For kod sessions with big tool results (hundreds of KB), this is measurable CPU per turn, and it happens while holding a generation slot.

**Fix options (cheap → thorough):**
1. **Head-check fast path.** The classifier only needs "does the stored prefix match", not the mismatch index (the index is diagnostic only). Fold incrementally **per turn** and cache: keep `row.headHash` and the folded canonical prefix length; on the next turn, verify only the *last* stored digest by folding messages from the previously-seen length. Requires the caller to pass the previously seen history length — the engine has it (`row.chain.length` before the turn).
2. Alternatively, short-circuit: if `messages.length === row.chain.length + delta` and only the tail is new, fold `storedChain` prefix *once* and compare the final head only:

```ts
// src/core/classifier.ts — fast continuity check (diagnostic index preserved lazily)
if (m > n) {
  // Cheap proof: fold only the NEW tail onto the stored head.
  // Stored head is chain[n-1]; if chain is non-empty, folding messages[n..]
  // onto it must reproduce exactly what the chain would look like — no
  // need to re-fold messages[0..n-1].
  const head = n > 0 ? row.chain[n - 1] : null;
  // (foldDelta in engine.ts already does exactly this — reuse it here and
  // only fall back to full firstMismatch() when the head does NOT match,
  // to compute the divergence index for the audit log.)
}
```

3. Cache `canonical(msg)` strings per turn via a WeakMap keyed on the message object — meaningful for kod, which re-sends identical objects every turn.

### P5 (Medium) — Synchronous journal I/O on the turn hot path

**Where:** `src/core/persist.ts:19-26` (`appendFileSync` per commit / `noteChatUrl` / `markFailed`) and `:55-65` (`writeFileSync`+`renameSync` in compact, every 30 sweeps).

Each commit blocks the event loop for the duration of a disk write. While blocked, SSE frames stall, worker observations queue, health pings delay. On slow disks (or a journal on a network volume), a burst of concurrent commits directly adds latency to *other sessions'* streams.

**Fix** — serialize appends through a microtask queue with async writes, keeping per-row ordering:

```ts
import { promises as fsp } from "node:fs";

export class JsonlSessionStore implements PersistStore {
  private queue: Promise<void> = Promise.resolve();

  append(row: SessionRow): void {
    const line = JSON.stringify(row) + "\n";
    // Serialize to preserve append order; never await in the caller's path.
    this.queue = this.queue
      .then(() => fsp.appendFile(this.path, line, "utf8"))
      .catch(() => { /* persistence must never take a turn down */ });
  }

  compact(rows: Iterable<SessionRow>): void {
    const snapshot = [...rows];
    this.queue = this.queue
      .then(async () => {
        const tmp = `${this.path}.tmp`;
        const lines = snapshot.map((r) => JSON.stringify(r));
        await fsp.writeFile(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
        await fsp.rename(tmp, this.path);
      })
      .catch(() => { /* best effort */ });
  }

  /** Flush pending writes (used by graceful shutdown). */
  async flush(): Promise<void> { await this.queue; }
}
```

> Ordering guarantee: all writes funnel through one promise chain, so journal order still matches commit order. `index.ts` shutdown calls `await bridge.store.flush()` before `server.close()`.

### P6 (Medium) — SSE writes ignore backpressure

**Where:** `src/facade/sse.ts:115-118` (`write` ignores the `res.write()` return) and `http.ts:341-373` (the `onContent` bridge writes every fragment immediately).

A fast provider stream to a slow client (or a client that vanished but whose socket buffers) makes Node buffer unboundedly in memory. Also, after the client disconnects, the adapter keeps producing fragments for the rest of the turn and every one of them goes through `JSON.stringify` + `res.write` for nothing (verified harmless on Node 24 — no crash — but pure waste).

**Fix:**

```ts
// src/facade/sse.ts
private write(obj: unknown): void {
  if (this.res.writableEnded || this.res.destroyed) return;   // dead client: drop
  this.frameCount += 1;
  const ok = this.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (!ok) {
    // Backpressure: pause the adapter pump until the socket drains.
    this.res.once("drain", () => this.res.emit("tb-drain"));
  }
}

/** True once the client is gone; the facade checks it in onContent. */
get clientGone(): boolean { return this.res.destroyed || this.res.writableEnded; }
```

```ts
// src/facade/http.ts — events.onContent first line:
if (sse.clientGone) return;   // skip stringify+write for a dead socket
```

(A full adapter-side pause is unnecessary: fragments are tiny and DeepSeek's rate is modest; dropping them post-disconnect is the correct behavior because the turn result is already heading nowhere.)

### P7 (Low) — Logger ignores stdout backpressure

**Where:** `src/log.ts:5-8`. When stdout is a slow pipe, `process.stdout.write` buffers in memory. Fix: honor the return value with a small ring buffer, or at minimum use `write(...)`'s drain event for the audit channel. Low priority because line counts are modest, but the same pattern is why the per-request `http.request` log at `http.ts:92` should be demoted to debug.

### P8 (Low) — `ensureReady` busy-polls while holding a generation slot

**Where:** `src/adapter/deepseek.ts:103-126` (250 ms poll loop) combined with `bridge.ts:151-157` (gate slot spans the whole turn). A tab stuck `degraded` for the full 20 s `bindTimeoutMs` wastes a DeepSeek generation slot for 20 s while queued turns starve. Fix: only poll while a *reason* exists (health `degraded`), fail fast on `rate_limited`/`server_busy` (already done), and consider releasing the gate slot during the bind/wait phase (re-acquire before `sendTurn`) if queue starvation is observed in practice.

### P9 (Medium) — Admitted turns can never be cancelled (`abortIntent` is dead code)

**Where:** `src/pool/pool.ts:275-281` — zero callers (grep-verified). The AbortSignal from the HTTP client is consumed *only* while queued (`bridge.ts:34-37` documents this). After admission, a client that gives up leaves the bridge streaming the full DeepSeek reply into a dead socket for up to 240 s, holding a generation slot and consuming the account's rate budget — with 2 slots and a 20-minute send-frequency window, an abandoned turn is expensive.

**Fix** — wire the abort into the engine:

```ts
// src/bridge.ts — handleChat, after gate admission:
const abortHandler = () => {
  // Find the reqId for this row/tab (adapter keeps pendingByTab; expose a
  // lookup) and tell the worker to abort the provider generation.
  const reqId = adapterReqIdFor(this.adapter, row.tabId);
  if (reqId) this.pool.abortIntent(reqId);
};
if (params.signal) {
  if (params.signal.aborted) abortHandler();
  else params.signal.addEventListener("abort", abortHandler, { once: true });
}
```

```ts
// src/adapter/deepseek.ts — expose the pending reqId per tab
reqIdForTab(tabId: number): string | undefined { return this.pendingByTab.get(tabId); }
```

The injector already handles `ABORT` (`background.js:951-956` → `finishTurn(aborted=true)` → `TURN_ABORTED`), and the adapter's `streamResponse` maps `STATUS aborted` to `stopReason: "aborted"` (`deepseek.ts:197-201`) — the entire downstream path exists and is tested; only the trigger is missing.

---

## 6. Correctness & robustness findings

### C1 — Timeout flags accept garbage
`src/config.ts:162-167`: `--turn-timeout-ms` / `--bind-timeout-ms` have no validation (every other numeric flag does). `--turn-timeout-ms=-5` yields a `deadline` in the past — every turn fails at the first check; `--turn-timeout-ms=abc` yields `NaN`, and `Date.now() + NaN` poisons every deadline comparison silently.

```ts
case "--turn-timeout-ms":
  cfg.turnTimeoutMs = Number(val());
  if (!Number.isInteger(cfg.turnTimeoutMs) || cfg.turnTimeoutMs <= 0) {
    throw new Error("--turn-timeout-ms must be a positive integer");
  }
  break;
// same for --bind-timeout-ms
```

### C2 — Malformed `content` types produce 500, not 400
`src/facade/http.ts:162` casts `rec.content` unchecked. `content: 123` (or an object) passes `parseMessages`, then `textOf` (`canonical.ts:32-39`) calls `.filter` on a number → `TypeError` → `mapTurnError` → **500 internal** for a client bug that should be **400**.

```ts
// http.ts — inside the message loop, after role validation:
if (rec.content !== undefined) {
  const ok =
    rec.content === null ||
    typeof rec.content === "string" ||
    (Array.isArray(rec.content) &&
      rec.content.every((p) => p && typeof p === "object" && (p as any).type === "text"));
  if (!ok) throw badRequest("message.content must be a string, null, or text parts array");
  msg.content = rec.content as ChatMessage["content"];
}
```

### C3 — The documented DOM-capture fallback does not exist
The injector header (`injector.js:7-13`) promises "DOM observation kept as a FALLBACK when the hook is absent or the completion stream is not seen within 15 s". Reality: `t.mode` is only ever `"idle" | "sse-await" | "sse"` (assignments at `:1767, :1868, :2298, :2685`); no code ever assigns `"dom"`, so the three `mode === "dom"` guards (`:2304, :2323, :2421`) are dead and the MutationObserver pipeline described in the header was removed in the v1.2 redesign. When the SSE hook is absent (page drift, MAIN-world injection blocked by site CSP changes), the only recovery is the 15 s re-submit → `submit-failed`. Either re-implement a minimal DOM tail-capture or fix the header/TESTING docs — dead branches that claim to be a safety net are worse than none, because on-call time gets burned believing them.

### C4 — Paste threshold mismatch
README (`README.md:104`) says ≥ 8 000 chars; `injector.js:53` ships `PASTE_AS_FILE_THRESHOLD = 4000`. Pick one (code wins) and update the README.

### C5 — Watchdog rate-limit scan can false-positive on assistant text
`injector.js:2454` runs `submitRateLimitHit(t.submitCount)` every 2 s, which scans **all conversation nodes after `submitCount`** (`:878-885`) — including the assistant's own streaming reply. A short answer (< 400 chars) that *discusses* "too many requests" (plausible for a coding assistant) triggers `attemptRateLimitRecovery` → the injector re-submits or clicks retry **mid-stream** → duplicate prompt. Guard it to notice surfaces + nodes that appeared while the composer was blocked:

```js
// injector.js — in the watchdog, only trust transcript nodes BEFORE any
// fragment has flowed (error bubbles render pre-stream; the answer renders after):
const hit =
  noticeRateLimitHit() ||
  (t.emitted.length === 0 && submitRateLimitHit(t.submitCount));
```

### C6 — Concurrent-TURN rejection omits `userBubbleRendered:false`
`injector.js:2625-2632`: when a TURN arrives while another is active, the rejection `TURN_ERROR{code:"submit-failed"}` carries no `userBubbleRendered` → the engine's default treats it as "may have rendered" → `markFailed` → `pendingReset` → the *next* turn is a full RESET_RESEED even though nothing was ever placed for the rejected reqId. Add `userBubbleRendered: false` to that `report()` — nothing was submitted for it by definition.

### C7 — The error taxonomy is stringly typed
`src/facade/errors.ts:119-216` classifies failures by regex/prefix over `Error.message` (`"cf-challenge"`, `"provider-rate-limited"`, `"turn-error:…"`, `"bind-failed:…"`). Any wording change in `engine.ts`/`deepseek.ts` silently reclassifies a 429 as a 500. Introduce a typed error carrying the taxonomy code:

```ts
// src/facade/errors.ts
export class TurnError extends Error {
  constructor(
    readonly kind:
      | "cf_challenge" | "provider_rate_limited" | "server_busy"
      | "concurrency_blocked" | "not_ready" | "submit_failed" | "timeout"
      | "dom_error" | "port_lost" | "prompt_too_large" | "empty_prompt",
    readonly retryAfterSec?: number,
    readonly detail?: string,
  ) { super(`${kind}:${detail ?? ""}`); this.name = "TurnError"; }
}
// engine/deepseek throw TurnError instances; mapTurnError switches on
// `err instanceof TurnError ? err.kind : <legacy string matching>` so the
// old path keeps working during migration.
```

### C8 — Forced create evicts at most one session
`src/facade/http.ts:430-433`: `if (force && bridge.registry.size > 64) bridge.registry.evictOldestIdle();` — one eviction per POST. Loop until under the threshold or no candidate remains:

```ts
if (force) {
  while (bridge.registry.size > 64 && bridge.registry.evictOldestIdle()) { /* keep going */ }
}
```

### C9 — Duplicate SW global error listeners
`extension/background.js:170-192` and `:1508-1522` both register `unhandledrejection` and `error` → every failure is logged twice and sends two HEALTH observations. Delete the first block.

### C10 — `reportSwBoot` never gives up
`extension/background.js:1494-1504`: 500 ms retry forever while the link is down. Bound it (e.g. 20 attempts) — the bridge also logs the SW boot via the normal HELLO path, so this is redundancy, not necessity.

### C11 — Empty-output turn poisons the next tool round
`src/engine.ts:469`: `const outputHash = text || calls.length > 0 ? messageHash(emitted) : null;` — a turn that completes with **zero text and zero calls** (empty stream, `finish:"stop"`) commits `tabHash = null`. The next turn's tool round (`classifier.ts:96-101`) requires `row.tabHash !== null` to accept the assistant echo → `"fabricated-assistant-echo"` → forced full reseed after a turn that was merely empty.

```ts
// engine.ts — hash the empty assistant turn too; the tab DID speak (silence):
const outputHash = messageHash(emitted);   // emitted is a valid assistant message
```

The chain already covers the empty assistant message (it is folded as `A|`), so this change aligns `tabHash` with the chain.

### C12 — `helloQueue` drops intents without answering
`extension/background.js:250` (`splice(0,20)`) and `:284-288` (silent drop at cap 20). Dropped BIND/SEND intents are never answered → the bridge waits out its full 20 s bind timeout / 240 s send timeout for a request the worker threw away. Answer on drop:

```js
if (helloQueue.length < 20) {
  helloQueue.push(m);
} else {
  blog("dropping pre-handshake intent (queue full):", m.t);
  if (m.t === "BIND") send({ t: "BIND_FAILED", sessionId: m.sessionId, code: "worker-booting" });
  else if (m.t === "SEND") send({ t: "ERROR", reqId: m.reqId, code: "submit-failed", detail: "worker booting" });
}
```

### C13 — Ready-timeout misdiagnosed as "tab not known"
`src/adapter/deepseek.ts:107`: the polling loop's deadline expiry returns `detail: "tab-not-known-to-worker"`, which the engine answers with a **rebind** (`engine.ts:161-167`). A tab that is merely slow to report healthy gets re-bound (extra BIND round-trip, possibly a different tab, dirty-flag churn). Return a distinct detail (e.g. `ensureReady-timeout`) on deadline expiry and let the engine treat it as a bind/readiness failure without rebind; keep the rebind path for the *genuinely unknown* case (tab absent from the PONG list).

### C14 — Legacy SEND fallback can cross sessions
`extension/background.js:762-778`: when a SEND arrives without `tabId`, the worker scans `sessionTab.values()` for the first non-dead tab — with multiple sessions that can be *another session's* tab. The bridge always sends `tabId` today; make the fallback safe anyway:

```js
if (useTab === undefined) {
  send({ t: "ERROR", reqId: m.reqId, code: "submit-failed", detail: "no tabId and no single bound tab" });
  return;
}
```

### C15 — Security hygiene (small but worth doing)
- `?token=` in the upgrade URL leaks into intermediary logs; consider `Sec-WebSocket-Protocol` or a header-based handshake. At minimum keep it plus the H4 Origin gate.
- Non-constant-time token compare — fixed in H4's patch.
- `/healthz` is unauthenticated by design (README) but exposes session counts, turn-gate stats, and per-tab health; if this ever binds on `0.0.0.0` (`--host` accepts any value) it becomes an info leak. Reject `--host` values outside loopback unless an explicit `--expose-public` flag is set.

---

## 7. Things I checked that are NOT bugs (negative results worth recording)

1. **SSE write-after-client-disconnect crash** — suspected the missing `res.on("error")` would produce an unhandled `ERR_STREAM_DESTROYED` and kill the process. **Disproven empirically on Node 24** (reproduction script, §Appendix C): the server survives a mid-stream abort; Node discards the writes. Kept as P6 (waste, not crash) instead of a crash finding. Worth re-testing if the Node floor moves below 18.
2. **`registry.lockFor`/`dropLock` mutex swap race** — suspected an in-flight request could `tryAcquire` a stale mutex after `dropLock`. Disproven by trace: `lockFor` and `tryAcquire` happen synchronously with no await between them, so no interleaving is possible in JS.
3. **`pool.onDown` nuking a freshly attached connection** — suspected a stale connection's `close` event could clear the *new* connection's state. Disproven: `WsConnection.doClose` emits `close` synchronously, `_open` guards double-emission, the refused-duplicate path registers no close listener, and `onDown` returns early when `conn === null`. The lifecycle is closed under the current event ordering.
4. **`fragSeen`-style leak in `fragStats` (background)** — capped ring at 50 entries (`background.js:106`), fine.
5. **`helloQueue` unbounded growth** — capped at 20 (but see C12 for the answer-on-drop gap).
6. **`turnByReq` / `resetStates` timers** — every settle path (done/aborted/error/timeout/port-loss) clears the timer and deletes the entry; verified each branch.
7. **The suspected `matchesatches` / `aref` syntax typos in injector.js** — artifacts of my terminal pipeline; byte-level inspection confirmed the source is correct (`matches[matches.length - 1]`, `a[href="/"]`). `node --check` passes on all three extension files.

---

## 8. Dead code inventory (safe to remove or wire up)

| Symbol | Location | Status |
|---|---|---|
| `withTimeout` | `src/util/async.ts:72-80` | zero callers; also has the L3 pattern internally if ever used |
| `ChainFolder` | `src/core/hashchain.ts:23-50` | only used in one test; production folds via `foldAll`/`foldDelta` |
| `WorkerPool.subscribe` | `src/pool/pool.ts:283-315` | zero callers (adapter uses its own raw listener) |
| `WorkerPool.abortIntent` | `src/pool/pool.ts:275-281` | zero callers — see P9 for wiring it up |
| `conflict()` | `src/facade/errors.ts:49-51` | zero callers (409 built inline in bridge.ts) |
| `SseStream.sendRaw` / `frames` | `src/facade/sse.ts:80-83,38-40` | zero callers |
| `injector.js` `mode === "dom"` branches | `:2304, :2323, :2421` | unreachable — see C3 |
| `Mutex.acquire` | `src/util/async.ts:14-17` | zero callers (only `tryAcquire` is used) |

---

## 9. Prioritized fix order

1. **H1** (DELETE race) + **H6** (bubble-report lie) — data-corruption class; small patches.
2. **H2 + H3** (WS hardening) — one focused commit, closes the DoS surface.
3. **L1 + L2** (pool leak + ghost tab) — trivial, measurable.
4. **H5** (SW reconnect guard) — closes the documented flap-cascade class.
5. **P1** (parse-once) + **P5** (async journal) — biggest CPU/latency wins under load.
6. **P9** (wire abortIntent) — saves real provider quota.
7. The C-tail in whatever order touches your current pain (C11 and C12 are the most user-visible of the small ones).
8. **H4** (Origin gate) before ever recommending `--host 0.0.0.0`.

---

## Appendix A — Verified reproduction outputs

```
# H1 — DELETE during in-flight turn (scripts/test-delete-race.mjs)
turn1 status: 200 registry size: 1
in-flight? registry busy: true size: 1
DELETE mid-turn status: 204
turn2 finished after delete, status: 200
registry size after turn completes: 0
journal rows on next boot: [ 'sess-A' ]  ← zombie (turns=2, chainLen=1)

# H2 — WS fragment flood (scripts/test-ws-flood2.mjs)
fragParts frames: 2000 retained: 120 MB
heap growth: 0 MB ← unbounded buffering, connection never punished

# H3 — unmasked frame (scripts/test-pool-ws.mjs)
T5a unmasked frame accepted: YES ← RFC 6455 violation

# L1 — fragSeen survives link drop (scripts/test-pool-ws.mjs)
fragSeen size after 1000 fragments: 1000
fragSeen size after link drop: 1000 ← LEAK

# L2 — ghost health tab (scripts/test-pool-ws.mjs)
tabHealth() after boot HEALTH = [{"state":"ok"}] ← tabId undefined

# L4 — aborted upload (scripts/test-aborted-body.mjs)
handleChat invoked for aborted body request: 0 ← readBody never settled

# P2 — holdback rescan cost (scripts/test-ws-flood-holdback.mjs)
ceiling=8192 → 1.8 ms | 32768 → 8.3 ms | 65536 → 25.1 ms (8-char fragments)

# Negative result — SSE client disconnect (scripts/test-sse-disconnect.mjs)
SURVIVED: no crash after client disconnect mid-stream
```

## Appendix B — Suggested regression tests (to keep the fixes honest)

```ts
// test/session-delete-race.test.ts
test("DELETE during in-flight turn returns 409 and does not resurrect the row", async () => {
  // start a scripted turn that blocks 300ms; DELETE mid-flight
  // expect: 409 {code:"session_busy"}; after turn ends: registry.list() empty;
  // store.load() has no row for the session.
});

// test/wsserver-limits.test.ts
test("fragmented-frame flood closes the connection with 1009", () => {
  // feed 2000 non-final continuations through WsConnection
  // expect: close event code 1009, fragParts bounded
});
test("unmasked client frame closes with 1002", () => { ... });

// test/pool-fragseen.test.ts
test("fragSeen is cleared when the worker link drops", () => { ... });

// test/health-ghost-tab.test.ts
test("tab-less HEALTH does not create a healthByTab entry", () => { ... });

// test/http-aborted-body.test.ts
test("aborted request body rejects readBody instead of leaking", () => { ... });

// test/engine-empty-output.test.ts
test("empty assistant output keeps tabHash consistent for the next tool round", () => { ... });
```

## Appendix C — Audit artifacts

| Artifact | Path |
|---|---|
| Full source dump (via repo's own `scripts/dump-files.sh`) | `/home/z/my-project/tab-bridge/dump.txt` (7 399 lines) |
| SSE disconnect probe | `/home/z/my-project/scripts/test-sse-disconnect.mjs` |
| DELETE-race probe | `/home/z/my-project/scripts/test-delete-race.mjs` |
| Pool/WS probes (ghost health, fragSeen, unmasked) | `/home/z/my-project/scripts/test-pool-ws.mjs` |
| Flood + holdback benchmark | `/home/z/my-project/scripts/test-ws-flood2.mjs`, `test-ws-flood-holdback.mjs` |
| Aborted-body probe | `/home/z/my-project/scripts/test-aborted-body.mjs` |

*Build/test baseline for all probes: Node v24.21.0, `tsc` clean build, 245/245 tests passing.*
