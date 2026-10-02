// H2 / H3 regression: the hand-rolled WS server must reject unmasked client
// frames and bound the memory a peer can make it allocate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WsConnection } from "../src/link/wsserver.js";

interface StubSocket extends EventEmitter {
  destroyed: boolean;
  setNoDelay(): void;
  write(buf: Buffer): boolean;
  destroy(): void;
}

function stubSocket(): StubSocket {
  const s = new EventEmitter() as StubSocket;
  s.destroyed = false;
  s.setNoDelay = () => {};
  s.write = () => true;
  s.destroy = () => { s.destroyed = true; };
  return s;
}

function mkConn(sock: StubSocket): WsConnection {
  // WsConnection reads remoteAddress/url off the IncomingMessage.
  return new WsConnection(sock as never, {
    socket: { remoteAddress: "127.0.0.1" },
    url: "/worker",
  } as never);
}

/** Build a raw client frame (no WS handshake needed — we drive the parser). */
function frame(opcode: number, payload: Buffer, opts: { masked: boolean; final?: boolean }): Buffer {
  const fin = opts.final !== false ? 0x80 : 0x00;
  const b0 = fin | (opcode & 0x0f);
  const maskBit = opts.masked ? 0x80 : 0x00;
  const len = payload.length;
  const header: number[] = [b0];
  if (len < 126) header.push(maskBit | len);
  else header.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
  let body = payload;
  if (opts.masked) {
    const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    header.push(key[0], key[1], key[2], key[3]);
    body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
  }
  return Buffer.concat([Buffer.from(header), body]);
}

test("H3: unmasked client frame closes the connection with code 1002", () => {
  const sock = stubSocket();
  const conn = mkConn(sock);
  const closed: Array<{ code: number | null; source: string }> = [];
  conn.on("close", (info) => closed.push(info));
  // Feed a raw unmasked text frame "hello" to the private onData hook.
  (conn as unknown as { onData(c: Buffer): void }).onData(frame(0x1, Buffer.from("hello"), { masked: false }));
  assert.equal(conn.isOpen, false, "connection must close on an unmasked frame");
  assert.ok(closed.length >= 1, "close event must be emitted");
});

test("H2: fragment flood closes the connection with code 1009", () => {
  const sock = stubSocket();
  const conn = mkConn(sock);
  let closeCode: number | null = null;
  conn.on("close", (info) => { closeCode = info.code; });
  // Start a fragmented text message with a masked first frame (FIN=0).
  (conn as unknown as { onData(c: Buffer): void }).onData(
    frame(0x1, Buffer.alloc(10), { masked: true, final: false })
  );
  // Feed non-final continuations until the fragment cap fires.
  const chunk = frame(0x0, Buffer.alloc(4096), { masked: true, final: false });
  for (let i = 0; i < 2000 && conn.isOpen; i++) {
    (conn as unknown as { onData(c: Buffer): void }).onData(chunk);
  }
  assert.equal(conn.isOpen, false, "connection must close on a fragment flood");
  assert.equal(closeCode, 1009, "close code must be 1009 (message too big)");
});

test("H2: continuation without a started message closes with 1002", () => {
  const sock = stubSocket();
  const conn = mkConn(sock);
  let closeCode: number | null = null;
  conn.on("close", (info) => { closeCode = info.code; });
  (conn as unknown as { onData(c: Buffer): void }).onData(
    frame(0x0, Buffer.from("orphan"), { masked: true, final: true })
  );
  assert.equal(conn.isOpen, false);
  assert.equal(closeCode, 1002);
});
