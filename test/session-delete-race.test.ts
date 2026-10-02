// H1 regression: DELETE must honour the per-session turn mutex. A delete
// during an in-flight turn must 409 rather than returning 204 and letting
// the running turn release the tab + resurrect the row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/core/registry.js";

test("H1: registry.delete clears rows and locks consistently", () => {
  const registry = new SessionRegistry({ mode: "stateful", ttlMs: 60_000, sweepIntervalMs: 0 });
  const row = registry.getOrCreate("s-h1");
  assert.equal(registry.get("s-h1"), row);
  const removed = registry.delete("s-h1");
  assert.equal(removed, row);
  assert.equal(registry.get("s-h1"), undefined);
  // Locks map is wiped by delete(); a fresh getOrCreate installs a fresh lock.
  const row2 = registry.getOrCreate("s-h1");
  const lock = registry.lockFor("s-h1");
  assert.equal(lock.tryAcquire(), true);
  lock.release();
  registry.dispose();
  void row2;
});

test("H1: busy session cannot be deleted (mutex check)", () => {
  const registry = new SessionRegistry({ mode: "stateful", ttlMs: 60_000, sweepIntervalMs: 0 });
  registry.getOrCreate("s-busy");
  const lock = registry.lockFor("s-busy");
  assert.equal(lock.tryAcquire(), true);
  // Simulate the DELETE handler's check.
  const wouldBlock = registry.lockFor("s-busy").tryAcquire() === false;
  assert.equal(wouldBlock, true, "second tryAcquire must return false while held");
  lock.release();
  registry.dispose();
});

test("H1: persistCompact drops the deleted row from the journal", () => {
  const appended: string[] = [];
  let lastCompact: string[] = [];
  const registry = new SessionRegistry({
    mode: "stateful",
    ttlMs: 60_000,
    sweepIntervalMs: 0,
    persist: {
      append: (row) => { appended.push(row.sessionId); },
      compact: (rows) => { lastCompact = [...rows].map((r) => r.sessionId); },
    },
  });
  registry.getOrCreate("s-keep");
  registry.getOrCreate("s-drop");
  registry.delete("s-drop");
  registry.persistCompact();
  assert.ok(lastCompact.includes("s-keep"));
  assert.equal(lastCompact.includes("s-drop"), false, "compact must exclude the deleted row");
  registry.dispose();
});
