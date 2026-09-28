/**
 * WorkerPool.bind patience: a transient BIND_FAILED (no-tab-available) does
 * not reject — the worker may be mid-handshake — while rate-limited-cooldown
 * still fails fast so callers map it to 429 without burning the deadline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WorkerPool } from "../src/pool/pool.js";

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

test("bind waits through no-tab-available until BOUND arrives", async () => {
  const pool = new WorkerPool({ autoCreateTabs: true, managedOnly: true, warmTabs: 0 });
  const conn = stubConn((m) => {
    if (m.t === "BIND") {
      setImmediate(() => {
        sockEmit("message", JSON.stringify({ t: "BIND_FAILED", sessionId: m.sessionId, code: "no-tab-available" }));
        setImmediate(() => {
          sockEmit("message", JSON.stringify({ t: "BOUND", sessionId: m.sessionId, tabId: 7, state: "ready" }));
        });
      });
    }
  });
  const sockEmit = (ev: string, data: string) => conn.emit(ev, data);
  pool.attach(conn as never);
  const bound = await pool.bind("s-patience", 5000);
  assert.equal(bound.tabId, 7);
  pool.detach("test-done");
});

test("bind fails fast on rate-limited-cooldown", async () => {
  const pool = new WorkerPool({ autoCreateTabs: true, managedOnly: true, warmTabs: 0 });
  const conn = stubConn((m) => {
    if (m.t === "BIND") {
      setImmediate(() => {
        conn.emit(
          "message",
          JSON.stringify({ t: "BIND_FAILED", sessionId: m.sessionId, code: "rate-limited-cooldown" })
        );
      });
    }
  });
  pool.attach(conn as never);
  await assert.rejects(() => pool.bind("s-cool", 5000), /bind-failed: rate-limited-cooldown/);
  pool.detach("test-done");
});
