// H4 regression: the upgrade handler must reject web-page origins and accept
// extension or Origin-less clients.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WsServer, type WsConnection } from "../src/link/wsserver.js";

interface StubSocket extends EventEmitter {
  destroyed: boolean;
  written: string[];
  setNoDelay(): void;
  write(chunk: string): boolean;
  destroy(): void;
}

function stubSocket(): StubSocket {
  const s = new EventEmitter() as StubSocket;
  s.destroyed = false;
  s.written = [];
  s.setNoDelay = () => {};
  s.write = (chunk: string) => { s.written.push(chunk); return true; };
  s.destroy = () => { s.destroyed = true; };
  return s;
}

function makeReq(headers: Record<string, string>, url = "/worker"): unknown {
  return { url, headers, socket: { remoteAddress: "127.0.0.1" } };
}

function fire(http: EventEmitter, sock: StubSocket, headers: Record<string, string>): void {
  const key = Buffer.from("0123456789abcdef").toString("base64");
  http.emit("upgrade", makeReq({ ...headers, "sec-websocket-key": key, upgrade: "websocket" }), sock, Buffer.alloc(0));
}

test("H4: rejects http(s) origins", () => {
  const seen: WsConnection[] = [];
  const srv = new WsServer({ path: "/worker", onConnection: (c) => seen.push(c) });
  const http = new EventEmitter();
  srv.attach(http as never);
  const sock = stubSocket();
  fire(http, sock, { origin: "https://evil.example.com" });
  assert.equal(sock.destroyed, true);
  assert.ok(sock.written.some((w) => w.startsWith("HTTP/1.1 403")));
  assert.equal(seen.length, 0);
});

test("H4: accepts chrome-extension:// origins", () => {
  const seen: WsConnection[] = [];
  const srv = new WsServer({ path: "/worker", onConnection: (c) => seen.push(c) });
  const http = new EventEmitter();
  srv.attach(http as never);
  const sock = stubSocket();
  fire(http, sock, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
  assert.equal(seen.length, 1);
});

test("H4: accepts clients that omit Origin (non-browser)", () => {
  const seen: WsConnection[] = [];
  const srv = new WsServer({ path: "/worker", onConnection: (c) => seen.push(c) });
  const http = new EventEmitter();
  srv.attach(http as never);
  const sock = stubSocket();
  fire(http, sock, {});  // no origin
  assert.equal(seen.length, 1, "origin-less client must be accepted");
});

test("H4: explicit allow-list is strict — missing Origin is rejected", () => {
  const seen: WsConnection[] = [];
  const srv = new WsServer({
    path: "/worker",
    allowedOrigins: ["chrome-extension://only-this-one"],
    onConnection: (c) => seen.push(c),
  });
  const http = new EventEmitter();
  srv.attach(http as never);

  const a = stubSocket();
  fire(http, a, { origin: "chrome-extension://different-id" });
  assert.equal(a.destroyed, true, "unlisted extension rejected");

  const b = stubSocket();
  fire(http, b, {});
  assert.equal(b.destroyed, true, "missing Origin rejected under explicit allow-list");

  const c = stubSocket();
  fire(http, c, { origin: "chrome-extension://only-this-one" });
  assert.equal(seen.length, 1, "listed origin accepted");
});
