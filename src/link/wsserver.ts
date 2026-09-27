/**
 * Minimal RFC 6455 WebSocket server (zero runtime dependencies).
 * Text frames only for protocol traffic; ping/pong/close handled; client
 * fragmentation is reassembled before "message" is emitted.
 */
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

export type WsMessage = { data: string };

export class WsConnection extends EventEmitter {
  private socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragParts: Buffer[] = [];
  private fragOpcode = -1;
  private _open = true;
  readonly remoteAddress: string;
  readonly url: string;

  constructor(socket: Duplex, req: IncomingMessage) {
    super();
    this.socket = socket;
    this.remoteAddress = req.socket.remoteAddress ?? "unknown";
    this.url = req.url ?? "/";
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.doClose());
    socket.on("close", () => this.doClose());
    socket.on("end", () => this.doClose());
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

  close(code = 1000): void {
    if (!this._open) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try {
      this.writeFrame(0x8, body);
    } catch {
      /* ignore */
    }
    this.doClose();
  }

  private doClose(): void {
    if (!this._open) return;
    this._open = false;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.emit("close");
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
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = buf.subarray(offset + len);
    return { opcode, payload, final: fin };
  }

  private handleFrame(f: { opcode: number; payload: Buffer; final: boolean }): void {
    switch (f.opcode) {
      case 0x0: {
        // continuation
        this.fragParts.push(f.payload);
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
        if (!f.final) {
          this.fragOpcode = f.opcode;
          this.fragParts = [f.payload];
          break;
        }
        if (f.opcode === 0x1) this.emit("message", f.payload.toString("utf8"));
        break;
      }
      case 0x8:
        this.close();
        break;
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
    if (this.opts.token) {
      const q = new URLSearchParams(url.split("?")[1] ?? "");
      if (q.get("token") !== this.opts.token) {
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
