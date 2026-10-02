// P1 regression: the pool must emit the PARSED observation on "raw".
// Re-parsing per listener was O(K+1) JSON.parse per message under load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WorkerPool } from "../src/pool/pool.js";

interface StubConn extends EventEmitter {
  isOpen: boolean;
  sendText(text: string): void;
  close(code?: number): void;
}

function stubConn(onSend: (m: Record<string, unknown>) => void): StubConn {
  const sock = new EventEmitter() as StubConn;
  sock.isOpen = true;
  sock.sendText = (text: string) => onSend(JSON.parse(text) as Record<string, unknown>);
  sock.close = () => { sock.isOpen = false; };
  return sock;
}

test("P1: pool emits a parsed observation on 'raw', not a string", async () => {
  const pool = new WorkerPool({ autoCreateTabs: true, managedOnly: true, warmTabs: 0 });
  const conn = stubConn(() => { /* swallow outbound */ });
  const seen: unknown[] = [];
  pool.on("raw", (o: unknown) => seen.push(o));
  pool.attach(conn as never);
  await new Promise((r) => setTimeout(r, 10));
  // Inject a real observation from the worker side.
  conn.emit("message", JSON.stringify({ t: "PONG", seq: 7 }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.length > 0, "raw event must have been emitted");
  const first = seen[0] as { t?: string };
  assert.equal(typeof first, "object", "'raw' payload must be a parsed object");
  assert.equal(first.t, "PONG");
  pool.detach("test-done");
});
