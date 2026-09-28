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
