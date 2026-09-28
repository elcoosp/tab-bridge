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
    holdbackCeiling: 65_536,
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
  const health = (await (await fetch(`${base}/healthz`)).json()) as {
    turn_gate: { active: number; waiting: number; max_concurrent: number };
  };
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
  // fragmentSize large enough that the answer lands in a single frame and
  // stays contiguous in the SSE body (ScriptedAdapter default splits at 7).
  adapter.push({ text: "held-answer", fragmentSize: 100 }, { text: "streamed-answer", fragmentSize: 100 });
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
  const health = (await (await fetch(`${base}/healthz`)).json()) as {
    turn_gate: { active: number; waiting: number; max_concurrent: number };
  };
  assert.equal(health.turn_gate.active, 1);
  assert.equal(health.turn_gate.waiting, 1);
  assert.equal(health.turn_gate.max_concurrent, 1);
  await Promise.all([ph, pq]);
  const after = (await (await fetch(`${base}/healthz`)).json()) as {
    turn_gate: { active: number; waiting: number; max_concurrent: number };
  };
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
