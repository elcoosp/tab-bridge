/**
 * Minimal RFC 6455 WebSocket server (zero runtime dependencies).
 * Text frames only for protocol traffic; ping/pong/close handled; client
 * fragmentation is reassembled before "message" is emitted.
 */
import { EventEmitter } from "node:events";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

export type WsMessage = { data: string };

/** How a worker socket died: WS close code + where it was observed. */
export interface WsCloseInfo {
  code: number | null;
  source: string;
}

export class WsConnection extends EventEmitter {
  private socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragParts: Buffer[] = [];
  private fragOpcode = -1;
  private _open = true;
  private closeCode: number | null = null;
  private closeSource = "";
  readonly remoteAddress: string;
  readonly url: string;

  /** H2: DoS guards. A remote peer must not be able to grow bridge memory
   * without bound: three caps close the socket when exceeded. */
  private static readonly MAX_BUFFER_BYTES = 1 << 20;   // 1 MiB raw backlog
  private static readonly MAX_MESSAGE_BYTES = 8 << 20;  // 8 MiB reassembled
  private static readonly MAX_FRAGMENTS = 1024;         // per message

  constructor(socket: Duplex, req: IncomingMessage) {
    super();
    this.socket = socket;
    this.remoteAddress = req.socket.remoteAddress ?? "unknown";
    this.url = req.url ?? "/";
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: unknown) =>
      this.doClose(1011, `socket-error: ${(err as Error)?.message ?? "unknown"}`)
    );
    socket.on("close", (hadError: boolean) =>
      this.doClose(hadError ? 1006 : 1000, hadError ? "tcp-error" : "tcp-close")
    );
    socket.on("end", () => this.doClose(1000, "tcp-end"));
  }

  get isOpen(): boolean {
    return this._open;
  }

  sendText(text: string): void {
    if (!this._open) return;
    this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  sendPing(payload: Buffer = Buffer.alloc(0)): void {
    if (!this._open) return;
    this.writeFrame(0x9, payload);
  }

  close(code = 1000, reason = ""): void {
    if (!this._open) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try {
      this.writeFrame(0x8, body);
    } catch {
      /* ignore */
    }
    this.doClose(code, reason || "local-close");
  }

  /** Close reason tracking: first signal wins. */
  private doClose(code: number | null = null, source = ""): void {
    if (!this._open) return;
    this._open = false;
    if (code !== null) this.closeCode = code;
    if (source) this.closeSource = source;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    const info: WsCloseInfo = { code: this.closeCode, source: this.closeSource || "unknown" };
    this.emit("close", info);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    const header: number[] = [0x80 | opcode];
    if (len < 126) {
      header.push(len);
    } else if (len < 65536) {
      header.push(126, (len >> 8) & 0xff, len & 0xff);
    } else {
      header.push(127);
      for (let shift = 56; shift >= 0; shift -= 8) header.push((len >> shift) & 0xff);
    }
    this.socket.write(Buffer.concat([Buffer.from(header), payload]));
  }

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

  private tryParseFrame():
    | { opcode: number; payload: Buffer; final: boolean }
    | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    if (!masked) {
      // H3 — RFC 6455 §5.1: client-to-server frames MUST be masked.
      this.close(1002, "unmasked client frame");
      return null;
    }
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(64 * 1024 * 1024)) {
        this.close(1009);
        return null;
      }
      len = Number(big);
      offset += 8;
    }
    if (buf.length < offset + 4) return null;
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    // L5: copy the remainder — a subarray view would pin the parent buffer.
    this.buffer = Buffer.from(buf.subarray(offset + len));
    return { opcode, payload, final: fin };
  }

  private handleFrame(f: { opcode: number; payload: Buffer; final: boolean }): void {
    switch (f.opcode) {
      case 0x0: {
        // continuation — H2: reject without a started message, cap size/count.
        if (this.fragOpcode === -1) {
          this.close(1002, "unexpected continuation");
          break;
        }
        this.fragParts.push(f.payload);
        let total = 0;
        for (const p of this.fragParts) total += p.length;
        if (
          total > WsConnection.MAX_MESSAGE_BYTES ||
          this.fragParts.length > WsConnection.MAX_FRAGMENTS
        ) {
          this.close(1009, "reassembled message too large");
          break;
        }
        if (f.final) {
          const whole = Buffer.concat(this.fragParts);
          const op = this.fragOpcode;
          this.fragParts = [];
          this.fragOpcode = -1;
          if (op === 0x1) this.emit("message", whole.toString("utf8"));
        }
        break;
      }
      case 0x1:
      case 0x2: {
        if (f.payload.length > WsConnection.MAX_MESSAGE_BYTES) {
          this.close(1009, "message too large");
          break;
        }
        if (!f.final) {
          // H2: a new fragmented message while one is in flight is a protocol error.
          if (this.fragOpcode !== -1) {
            this.close(1002, "interleaved fragmentation");
            break;
          }
          this.fragOpcode = f.opcode;
          this.fragParts = [f.payload];
          break;
        }
        if (f.opcode === 0x1) this.emit("message", f.payload.toString("utf8"));
        break;
      }
      case 0x8: {
        let code: number | null = null;
        let reason = "close-frame";
        if (f.payload.length >= 2) {
          code = f.payload.readUInt16BE(0);
          reason = f.payload.subarray(2).toString("utf8").slice(0, 120) || "close-frame";
        }
        this.close(code ?? 1005, reason);
        break;
      }
      case 0x9:
        this.writeFrame(0xa, f.payload); // pong
        break;
      case 0xa:
        this.emit("pong");
        break;
      default:
        this.close(1002);
    }
  }
}

export interface WsServerOptions {
  path?: string;
  /** Reject upgrade when set and the query param `token` does not match. */
  token?: string | null;
  /**
   * H4: browser-origin gate.
   *
   * A web page can open a cross-origin WebSocket to 127.0.0.1 and, when no
   * API key is configured, seize the single worker slot with a valid HELLO
   * — corrupting in-flight turns or blocking the real extension.
   *
   * Policy:
   *   - No Origin header → ACCEPT. Non-browser clients (Node scripts, tests,
   *     CLI tooling) do not send Origin and are not a CSWSH vector.
   *   - Origin matches `chrome-extension://...` → ACCEPT (default policy).
   *   - Origin `http(s)://...`, `file://`, or anything else → REJECT.
   *   - When `allowedOrigins` is set, accept only listed values; a missing
   *     Origin is REJECTED under an explicit allow-list (the operator
   *     opted into strict behavior).
   */
  allowedOrigins?: string[];
  onConnection(conn: WsConnection): void;
}

/** Attaches to an existing http.Server via the `upgrade` event. */
export class WsServer {
  private readonly opts: WsServerOptions;

  constructor(opts: WsServerOptions) {
    this.opts = opts;
  }

  attach(server: { on(event: "upgrade", cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void }): void {
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = this.opts.path ?? "/worker";
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    if (pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // H4: Origin gate. Non-browser clients (no Origin) are accepted; browser
    // pages are rejected unless their Origin is chrome-extension:// (default)
    // or is present in an explicit allow-list.
    const origin = req.headers.origin;
    const allowed = this.opts.allowedOrigins;
    let originOk: boolean;
    if (allowed) {
      originOk = typeof origin === "string" && allowed.includes(origin);
    } else if (typeof origin !== "string") {
      // No Origin header — non-browser client. Not a CSWSH vector.
      originOk = true;
    } else {
      originOk = /^chrome-extension:\/\//i.test(origin);
    }
    if (!originOk) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (this.opts.token) {
      const q = new URLSearchParams(url.split("?")[1] ?? "");
      const got = Buffer.from(q.get("token") ?? "", "utf8");
      const want = Buffer.from(this.opts.token, "utf8");
      // H4: constant-time compare; guard length mismatch before
      // timingSafeEqual (which throws on different lengths).
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const key = req.headers["sec-websocket-key"];
    const upgrade = req.headers["upgrade"];
    if (!key || typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = acceptKey(key);
    const headers =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n";
    socket.write(headers);
    (socket as import("node:net").Socket).setNoDelay(true);
    const conn = new WsConnection(socket, req);
    if (head && head.length > 0) {
      (conn as unknown as { onData(c: Buffer): void }).onData(head);
    }
    this.opts.onConnection(conn);
  }
}
