/**
 * kod ↔ tab-bridge fix plan (WS-D, WS-E E1/E5): dirty-SEED reset policy,
 * pool bind dirtiness + noCreate fail-fast, and new serve flags.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseServeArgs, DEFAULTS } from "../src/config.js";
import { WorkerPool } from "../src/pool/pool.js";
import { SessionRegistry } from "../src/core/registry.js";
import { ScriptedAdapter } from "../src/adapter/scripted.js";
import { runTurn } from "../src/engine.js";

interface StubConn extends EventEmitter {
  isOpen: boolean;
  sendText(text: string): void;
  close(code?: number): void;
}

function stubConn(onSend: (msg: Record<string, unknown>) => void): StubConn {
  const sock = new EventEmitter() as StubConn;
  sock.isOpen = true;
  sock.sendText = (text: string) => {
    onSend(JSON.parse(text) as Record<string, unknown>);
  };
  sock.close = () => {
    sock.isOpen = false;
  };
  return sock;
}

// ---- config surface -------------------------------------------------------

test("serve flags: defaults preserve legacy behavior", () => {
  const cfg = parseServeArgs([]);
  assert.equal(cfg.resetOnSeed, DEFAULTS.resetOnSeed);
  assert.equal(cfg.maxTabs, 4);
  assert.equal(cfg.tabIdleCloseMs, 15 * 60_000);
});

test("serve flags: --reset-on-seed/--max-tabs/--tab-idle-close parse", () => {
  const cfg = parseServeArgs(["--reset-on-seed=always", "--max-tabs=2", "--tab-idle-close=5m"]);
  assert.equal(cfg.resetOnSeed, "always");
  assert.equal(cfg.maxTabs, 2);
  assert.equal(cfg.tabIdleCloseMs, 5 * 60_000);
  assert.throws(() => parseServeArgs(["--reset-on-seed=sometimes"]), /reset-on-seed/);
  assert.throws(() => parseServeArgs(["--max-tabs=-1"]), /max-tabs/);
});

// ---- pool bind: dirty passthrough + noCreate fail-fast ---------------------

test("bind surfaces worker dirty flag", async () => {
  const pool = new WorkerPool({ autoCreateTabs: true, managedOnly: true, warmTabs: 0 });
  const conn = stubConn((m) => {
    if (m.t === "BIND") {
      setImmediate(() => {
        conn.emit(
          "message",
          JSON.stringify({ t: "BOUND", sessionId: m.sessionId, tabId: 9, state: "ready", dirty: true })
        );
      });
    }
  });
  pool.attach(conn as never);
  const bound = await pool.bind("s-dirty", 5000);
  assert.equal(bound.tabId, 9);
  assert.equal(bound.dirty, true);
  pool.detach("test-done");
});

test("bind without dirty flag defaults to clean", async () => {
  const pool = new WorkerPool({ autoCreateTabs: true, managedOnly: true, warmTabs: 0 });
  const conn = stubConn((m) => {
    if (m.t === "BIND") {
      setImmediate(() => {
        conn.emit(
          "message",
          JSON.stringify({ t: "BOUND", sessionId: m.sessionId, tabId: 3, state: "ready" })
        );
      });
    }
  });
  pool.attach(conn as never);
  const bound = await pool.bind("s-clean", 5000);
  assert.equal(bound.dirty, false);
  pool.detach("test-done");
});

test("bind with noCreate fails fast instead of waiting out the deadline", async () => {
  const pool = new WorkerPool({ autoCreateTabs: true, managedOnly: true, warmTabs: 0 });
  let binds = 0;
  const conn = stubConn((m) => {
    if (m.t === "BIND") {
      binds += 1;
      assert.equal(m.noCreate, true);
      setImmediate(() => {
        conn.emit(
          "message",
          JSON.stringify({ t: "BIND_FAILED", sessionId: m.sessionId, code: "no-tab-available" })
        );
      });
    }
  });
  pool.attach(conn as never);
  const start = Date.now();
  await assert.rejects(() => pool.bind("s-bg", 5000, { noCreate: true }), /bind-failed: no-tab-available/);
  assert.ok(Date.now() - start < 4000, "noCreate must fail fast");
  assert.equal(binds, 1);
  pool.detach("test-done");
});

// ---- engine: WS-D dirty-SEED reset ------------------------------------------

function freshRegistry(): SessionRegistry {
  return new SessionRegistry({ mode: "stateful", ttlMs: 30 * 60_000, sweepIntervalMs: 0 });
}

const USER_TURN = [{ role: "user", content: "hello world, some content here" } as const].map((m) => ({
  ...m,
}));

test("SEED into a dirty tab resets first (auto)", async () => {
  const registry = freshRegistry();
  const row = registry.getOrCreate("s-dirty-seed");
  const adapter = new ScriptedAdapter({ replies: [{ text: "ok reply" }] });
  const out = await runTurn({
    messages: USER_TURN,
    tools: [],
    think: false,
    row,
    registry,
    adapter,
    repairRounds: 0,
    turnTimeoutMs: 5000,
    bindTimeoutMs: 2000,
    bindTab: async () => ({ tabId: 11, dirty: true }),
    resetOnSeed: "auto",
  });
  assert.equal(out.plan, "SEED");
  assert.equal(adapter.resetCount, 1);
  registry.dispose();
});

test("SEED into a clean fresh tab does not reset (auto)", async () => {
  const registry = freshRegistry();
  const row = registry.getOrCreate("s-clean-seed");
  const adapter = new ScriptedAdapter({ replies: [{ text: "ok reply" }] });
  const out = await runTurn({
    messages: USER_TURN,
    tools: [],
    think: false,
    row,
    registry,
    adapter,
    repairRounds: 0,
    turnTimeoutMs: 5000,
    bindTimeoutMs: 2000,
    bindTab: async () => 12,
    resetOnSeed: "auto",
  });
  assert.equal(out.plan, "SEED");
  assert.equal(adapter.resetCount, 0);
  registry.dispose();
});

test("resetOnSeed=never preserves legacy behavior on dirty tabs", async () => {
  const registry = freshRegistry();
  const row = registry.getOrCreate("s-never");
  const adapter = new ScriptedAdapter({ replies: [{ text: "ok reply" }] });
  await runTurn({
    messages: USER_TURN,
    tools: [],
    think: false,
    row,
    registry,
    adapter,
    repairRounds: 0,
    turnTimeoutMs: 5000,
    bindTimeoutMs: 2000,
    bindTab: async () => ({ tabId: 13, dirty: true }),
    resetOnSeed: "never",
  });
  assert.equal(adapter.resetCount, 0);
  registry.dispose();
});

test("resetOnSeed=always resets even clean fresh tabs", async () => {
  const registry = freshRegistry();
  const row = registry.getOrCreate("s-always");
  const adapter = new ScriptedAdapter({ replies: [{ text: "ok reply" }] });
  await runTurn({
    messages: USER_TURN,
    tools: [],
    think: false,
    row,
    registry,
    adapter,
    repairRounds: 0,
    turnTimeoutMs: 5000,
    bindTimeoutMs: 2000,
    bindTab: async () => 14,
    resetOnSeed: "always",
  });
  assert.equal(adapter.resetCount, 1);
  registry.dispose();
});
