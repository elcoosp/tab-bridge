// P6 regression: after client disconnect, further writes must be dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SseStream } from "../src/facade/sse.js";

interface StubRes extends EventEmitter {
  destroyed: boolean;
  writableEnded: boolean;
  headersSent: boolean;
  writeHead(code: number, headers?: Record<string, string>): this;
  flushHeaders?(): void;
  write(chunk: string): boolean;
  end(chunk?: string): this;
}

function stubRes(): StubRes {
  const r = new EventEmitter() as StubRes;
  r.destroyed = false;
  r.writableEnded = false;
  r.headersSent = false;
  r.writeHead = function (this: StubRes) { this.headersSent = true; return this; };
  r.flushHeaders = () => {};
  r.write = () => true;
  r.end = function (this: StubRes) { this.writableEnded = true; return this; };
  return r;
}

test("P6: SseStream.clientGone reflects res.destroyed / writableEnded", () => {
  const res = stubRes();
  const sse = new SseStream(res as never);
  assert.equal(sse.clientGone, false);
  res.destroyed = true;
  assert.equal(sse.clientGone, true);
  res.destroyed = false;
  res.writableEnded = true;
  assert.equal(sse.clientGone, true);
});

test("P6: writes to a destroyed socket are dropped", () => {
  const res = stubRes();
  const sse = new SseStream(res as never);
  let calls = 0;
  res.write = () => { calls += 1; return true; };
  sse.sendChoice({ delta: { content: "a" }, finish_reason: null }, "m", "id", 0);
  assert.equal(calls, 1, "live socket: write should go through");
  res.destroyed = true;
  sse.sendChoice({ delta: { content: "b" }, finish_reason: null }, "m", "id", 0);
  assert.equal(calls, 1, "dead socket: write must be dropped");
});
