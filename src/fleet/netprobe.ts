/**
 * Native exit-IP probe: fetches the profile's public exit IP through an
 * HTTP, HTTPS, or SOCKS5 proxy without depending on an external `curl`
 * binary. Used by `fleet doctor` (and P2 analytics) to answer the one
 * question a shared-path finding always provokes: which IP does this
 * account actually wear?
 *
 * Design notes:
 *  - Only HTTP CONNECT / GET (http, https) and SOCKS5 (no-auth) are
 *    supported. SOCKS5 username/password auth is out of scope: the ADR-17
 *    operator pattern is a local forwarder for authenticated upstreams,
 *    and the forwarder port is what this client dials.
 *  - The probe target is fixed (api.ipify.org) and small; any failure is
 *    reported, never thrown. Reachability and identity are the operator's
 *    evidence, not a hard requirement.
 *  - No credentials ever leave this module: the caller passes an already-
 *    expanded endpoint (which may embed userinfo for HTTP CONNECT), and
 *    the module never logs it.
 */

import { createConnection, type Socket } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

const IPIFY_HOST = "api.ipify.org";
const IPIFY_PORT = 443;
const TIMEOUT_MS = 8000;

export interface ExitIpResult {
  ip: string | null;
  /** Human-readable status: "ok" | "timeout" | "refused" | "no-proxy" |
   * "invalid-endpoint" | "<error message>". Never a secret. */
  status: string;
}

/** Parse `scheme://[user:pass@]host:port` (or `host:port`) into parts. The
 * scheme set is limited to what we know how to speak. */
function parseEndpoint(endpoint: string): {
  scheme: "http" | "https" | "socks5" | "socks5h" | "direct";
  host: string;
  port: number;
  auth: string | null;
} | null {
  if (endpoint === "(direct)" || endpoint === "direct" || endpoint === "") {
    return { scheme: "direct", host: "", port: 0, auth: null };
  }
  const m = /^(socks5h|socks5|https|http):\/\/(?:([^@]*)@)?([^:/]+)(?::(\d+))?\/?$/i.exec(endpoint.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase() as "http" | "https" | "socks5" | "socks5h";
  const auth = m[2] !== undefined ? m[2] : null;
  const host = m[3];
  const port = m[4] !== undefined ? Number(m[4]) : scheme === "https" ? 443 : 80;
  return { scheme, host, port, auth };
}

/** Open a socket with a bounded timeout, return null on any failure. */
function dial(host: string, port: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(null);
    }, TIMEOUT_MS);
    timer.unref?.();
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** SOCKS5 (no-auth) CONNECT to `host:port`. Returns a plain socket that
 * behaves like a direct TCP connection to `host:port`. */
async function socks5Connect(
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number
): Promise<Socket | null> {
  const sock = await dial(proxyHost, proxyPort);
  if (!sock) return null;

  const step = (send: Buffer, expectLen: number): Promise<Buffer | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const onData = (d: Buffer) => {
        chunks.push(d);
        total += d.length;
        if (total >= expectLen) {
          sock.off("data", onData);
          resolve(Buffer.concat(chunks, total));
        }
      };
      sock.on("data", onData);
      sock.once("error", () => { sock.off("data", onData); resolve(null); });
      sock.once("close", () => { sock.off("data", onData); resolve(null); });
      sock.write(send);
    });

  // Greeting: version 5, one method (no-auth).
  const greet = await step(Buffer.from([0x05, 0x01, 0x00]), 2);
  if (!greet || greet[0] !== 0x05 || greet[1] !== 0x00) { try { sock.destroy(); } catch { /* ignore */ } return null; }

  // CONNECT request: version 5, cmd 0x01, rsv, atyp (0x03 = domain).
  const hostBuf = Buffer.from(targetHost, "utf8");
  const connectReq = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
    hostBuf,
    Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
  ]);
  // First two bytes are the reply header, then variable atyp + address + port.
  const replyHeader = await step(connectReq, 4);
  if (!replyHeader || replyHeader[0] !== 0x05 || replyHeader[1] !== 0x00) {
    try { sock.destroy(); } catch { /* ignore */ }
    return null;
  }
  // We've already consumed 4 bytes; finish reading the bind address per atyp.
  const atyp = replyHeader[3];
  let remaining = 0;
  if (atyp === 0x01) remaining = 4 + 2; // IPv4 + port
  else if (atyp === 0x03) {
    // 1 byte length + address + 2 port. We don't know the length yet; read 1.
    const lenBuf = await step(Buffer.alloc(0) as unknown as Buffer, 0); // no-op
    void lenBuf;
    // Read the length byte then the address + port.
    const lb = await new Promise<Buffer | null>((resolve) => {
      const on = (d: Buffer) => { sock.off("data", on); resolve(d); };
      sock.on("data", on);
      sock.once("error", () => { sock.off("data", on); resolve(null); });
      sock.once("close", () => { sock.off("data", on); resolve(null); });
    });
    if (!lb || lb.length === 0) { try { sock.destroy(); } catch { /* ignore */ } return null; }
    remaining = lb[0] + 2;
  } else if (atyp === 0x04) remaining = 16 + 2; // IPv6 + port
  else { try { sock.destroy(); } catch { /* ignore */ } return null; }

  if (remaining > 0) {
    const tail = await new Promise<Buffer | null>((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const on = (d: Buffer) => {
        chunks.push(d); total += d.length;
        if (total >= remaining) { sock.off("data", on); resolve(Buffer.concat(chunks, total)); }
      };
      sock.on("data", on);
      sock.once("error", () => { sock.off("data", on); resolve(null); });
      sock.once("close", () => { sock.off("data", on); resolve(null); });
    });
    if (!tail) { try { sock.destroy(); } catch { /* ignore */ } return null; }
  }
  return sock;
}

/** Read the exit IP via the specified proxy endpoint (or direct when the
 * endpoint is "(direct)"/""/null). Never throws. */
export async function probeExitIpNative(endpoint: string | null | undefined): Promise<ExitIpResult> {
  try {
    if (endpoint === null || endpoint === undefined || endpoint === "" || endpoint === "(direct)") {
      // Direct: plain HTTPS GET.
      return await httpsGetDirect();
    }
    const parsed = parseEndpoint(endpoint);
    if (!parsed) return { ip: null, status: "invalid-endpoint" };

    if (parsed.scheme === "socks5" || parsed.scheme === "socks5h") {
      const sock = await socks5Connect(parsed.host, parsed.port, IPIFY_HOST, IPIFY_PORT);
      if (!sock) return { ip: null, status: "socks5-failed" };
      return await httpsOverSocket(sock);
    }
    if (parsed.scheme === "http" || parsed.scheme === "https") {
      // For HTTP(S) proxies we use the built-in http.request with the
      // proxy as the transport; CONNECT tunnelling is what Node's client
      // does for https:// targets by default.
      return await httpProxyGet(parsed);
    }
    return { ip: null, status: "unsupported-scheme" };
  } catch (e) {
    return { ip: null, status: (e as Error).message || "probe-failed" };
  }
}

function httpsGetDirect(): Promise<ExitIpResult> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      { host: IPIFY_HOST, port: IPIFY_PORT, path: "/", method: "GET" },
      (res) => finish(res, resolve)
    );
    req.setTimeout(TIMEOUT_MS, () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ip: null, status: "timeout" }); });
    req.on("error", (e) => resolve({ ip: null, status: e.message }));
    req.end();
  });
}

function httpsOverSocket(sock: Socket): Promise<ExitIpResult> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: IPIFY_HOST,
        port: IPIFY_PORT,
        path: "/",
        method: "GET",
        createConnection: () => sock,
      },
      (res) => finish(res, resolve)
    );
    req.setTimeout(TIMEOUT_MS, () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ip: null, status: "timeout" }); });
    req.on("error", (e) => { try { sock.destroy(); } catch { /* ignore */ } resolve({ ip: null, status: e.message }); });
    req.end();
  });
}

function httpProxyGet(parsed: { host: string; port: number; auth: string | null }): Promise<ExitIpResult> {
  // Node's http.request with proxy CONNECT is not built-in; the simplest
  // portable thing is a plain HTTP CONNECT establishment followed by TLS.
  return new Promise((resolve) => {
    const req = httpRequest({
      host: parsed.host,
      port: parsed.port,
      method: "CONNECT",
      path: `${IPIFY_HOST}:${IPIFY_PORT}`,
      ...(parsed.auth ? { headers: { "proxy-authorization": `Basic ${Buffer.from(parsed.auth).toString("base64")}` } } : {}),
    });
    req.setTimeout(TIMEOUT_MS, () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ip: null, status: "timeout" }); });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch { /* ignore */ }
        resolve({ ip: null, status: `proxy-refused-${res.statusCode}` });
        return;
      }
      // Now perform TLS over the tunnel.
      void httpsOverSocket(socket as Socket).then(resolve);
    });
    req.on("error", (e) => resolve({ ip: null, status: e.message }));
    req.end();
  });
}

function finish(res: IncomingMessage, resolve: (r: ExitIpResult) => void): void {
  let body = "";
  res.on("data", (b: Buffer) => { body += b.toString("utf8"); });
  res.on("end", () => {
    const ip = body.trim();
    // Minimal sanity check: an IPv4 or IPv6 string. Anything else and we
    // prefer to say so than pass along arbitrary text.
    if (/^[0-9a-fA-F:.]+$/.test(ip) && ip.length > 0) resolve({ ip, status: "ok" });
    else resolve({ ip: null, status: `unexpected-body:${ip.slice(0, 60)}` });
  });
  res.on("error", (e) => resolve({ ip: null, status: e.message }));
}
