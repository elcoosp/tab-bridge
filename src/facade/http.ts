/**
 * L4 Protocol Facade (Chapter 8): exact OpenAI wire shapes, SSE framing,
 * error taxonomy, /v1/sessions lifecycle, /healthz. JSON error bodies only.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { TabBridge, MODELS, MODEL_THINK, type ChatParams } from "../bridge.js";
import type { ChatMessage, ToolCall } from "../core/canonical.js";
import type { ToolSpec } from "../emulation/types.js";
import { SseStream } from "./sse.js";
import {
  BridgeError,
  badRequest,
  unauthorized,
  notFound,
  mapTurnError,
} from "./errors.js";
import { PROBE_PATH, PROBE_RESULT_PATH } from "../fleet/probe.js";
import { randomId } from "../util/async.js";
import { log } from "../log.js";

const BODY_LIMIT = 32 * 1024 * 1024;
const IGNORED_PARAMS = ["temperature", "top_p", "max_tokens", "stop"];

export interface HttpFacadeOptions {
  bridge: TabBridge;
}

export function createHttpServer(opts: HttpFacadeOptions): Server {
  const { bridge } = opts;
  const server = createServer((req, res) => {
    handle(bridge, req, res).catch((e) => {
      const be = e instanceof BridgeError ? e : mapTurnError(e);
      if (!res.headersSent) {
        res.writeHead(be.status, {
          "content-type": "application/json; charset=utf-8",
          ...(be.headers ?? {}),
          ...(be.retryAfter !== undefined ? { "retry-after": String(be.retryAfter) } : {}),
        });
      }
      res.end(JSON.stringify(be.body()));
    });
  });
  server.keepAliveTimeout = 65_000;
  return server;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        done(() => reject(badRequest("request body too large")));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => done(() => resolve(Buffer.concat(chunks))));
    req.on("error", (e) => done(() => reject(e)));
    // L4: a client that aborts mid-upload never emits "end" or (on some Node
    // versions) "error" — the promise stayed pending forever, retaining the
    // request/response/handler chain until the 300s server timeout. Settle
    // explicitly on early close. The thrown error carries code "client_gone"
    // so handleChat's existing guard treats it as a silent drop.
    req.on("close", () => {
      if (!req.readableEnded) {
        done(() => {
          const err = Object.assign(new Error("request aborted"), { code: "client_gone" as const });
          reject(err);
        });
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(headers ?? {}),
  });
  res.end(JSON.stringify(body));
}

/** True when the request originated from a same-machine origin. Used to
 * gate the probe routes, which are intentionally auth-exempt (the probe
 * page is a browser document and cannot present a bearer token).
 *
 * Bug-hunt fix: previously loopback-only, which rejected the probe when the
 * bridge was bound to a specific non-loopback address (`--host 10.0.0.5`):
 * the profile's Chrome connects FROM that address, not from 127.0.0.1. Now
 * accept loopback plus any explicitly configured bind host. */
function isLocalRequest(req: IncomingMessage, extraHosts: string[] = []): boolean {
  const a = req.socket.remoteAddress ?? "";
  if (a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1") return true;
  // `a` may carry the IPv4-mapped IPv6 prefix when the server listens on ::
  const bare = a.startsWith("::ffff:") ? a.slice(7) : a;
  for (const h of extraHosts) {
    if (!h || h === "0.0.0.0" || h === "::") continue;
    if (bare === h) return true;
  }
  return false;
}

function authOk(bridge: TabBridge, req: IncomingMessage): boolean {
  if (!bridge.config.apiKey) return true;
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${bridge.config.apiKey}`;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function ignoredHeader(ignored: string[]): Record<string, string> | undefined {
  if (ignored.length === 0) return undefined;
  return { "x-bridge-ignored": ignored.join(",") };
}

async function handle(bridge: TabBridge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? "/").split("?")[0];
  const method = (req.method ?? "GET").toUpperCase();
  const query = new URLSearchParams((req.url ?? "/").split("?")[1] ?? "");

  log.info("http.request", { method, url });

  // ---- public health endpoint (no auth) -----------------------------------
  if (method === "GET" && url === "/healthz") {
    sendJson(res, 200, bridge.health());
    return;
  }

  // ---- fingerprint probe (ADR-18, §7.3): loopback-only, no auth -----------
  // The probe page is served by this bridge and loaded by the operator's own
  // Chrome; it cannot present a bearer token, so these two routes are auth-
  // exempt. Loopback-only enforcement keeps non-local callers out.
  if (method === "GET" && url === PROBE_PATH) {
    if (!isLocalRequest(req, [bridge.config.host])) throw notFound();
    bridge.serveProbeHtml(res, query.get("id") ?? "", query.get("token") ?? "");
    return;
  }
  if (method === "POST" && url === PROBE_RESULT_PATH) {
    if (!isLocalRequest(req, [bridge.config.host])) throw notFound();
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      throw badRequest("body is not valid JSON");
    }
    const r = bridge.fleetRecordProbeResult(body);
    if (!r.ok) throw badRequest(`probe result rejected: ${r.reason ?? "unknown"}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authOk(bridge, req)) {
    throw unauthorized();
  }

  // ---- /v1/models ----------------------------------------------------------
  if (method === "GET" && url === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: MODELS.map((id) => ({ id, object: "model", owned_by: "tab-bridge" })),
    });
    return;
  }

  // ---- /v1/chat/completions -------------------------------------------------
  if (method === "POST" && url === "/v1/chat/completions") {
    await handleChat(bridge, req, res);
    return;
  }

  // ---- /v1/accounts (fleet view) ---------------------------------------------
  // Bug-hunt B8: this endpoint is behind the normal auth gate (see the
  // `if (!authOk(...))` check above) — it never returns proxy URLs or
  // credentials, only booleans and observed exit IPs. When the bridge is
  // started WITHOUT an api-key env, every authenticated endpoint (this one
  // included) is open by design; that is the operator's choice, documented
  // in the README's security section.
  if (method === "GET" && url === "/v1/accounts") {
    sendJson(res, 200, bridge.fleetStatus());
    return;
  }

  // ---- /v1/fleet/* (CLI surface; see src/fleet-cli.ts) -----------------------
  if (url.startsWith("/v1/fleet/")) {
    await handleFleet(bridge, req, res, url, method);
    return;
  }

  // ---- /v1/sessions ----------------------------------------------------------
  if (url === "/v1/sessions" || url.startsWith("/v1/sessions/")) {
    await handleSessions(bridge, req, res, url, method, query);
    return;
  }

  throw notFound(`no such endpoint: ${method} ${url}`);
}

// ---------------------------------------------------------------------------
// chat completions
// ---------------------------------------------------------------------------

interface ChatRequestBody {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
  n?: unknown;
  user?: unknown;
  metadata?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_tokens?: unknown;
  stop?: unknown;
  logprobs?: unknown;
  response_format?: unknown;
}

function parseMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest("messages must be a non-empty array");
  }
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (m === null || typeof m !== "object") throw badRequest("each message must be an object");
    const rec = m as Record<string, unknown>;
    if (typeof rec.role !== "string") throw badRequest("message.role must be a string");
    const role = rec.role as ChatMessage["role"];
    if (!["system", "user", "assistant", "tool", "developer"].includes(role)) {
      throw badRequest(`unsupported message role: ${role}`);
    }
    const msg: ChatMessage = { role, content: null };
    if (rec.content !== undefined) {
      // C2: reject non-string/array content as 400 not 500. textOf() calls
      // .filter on the content in canonicalization, so a number or object
      // would TypeError deep inside the turn, mapping to a 500 for what is
      // really a client bug.
      const c = rec.content;
      const ok =
        c === null ||
        typeof c === "string" ||
        (Array.isArray(c) &&
          c.every(
            (p) =>
              p !== null &&
              typeof p === "object" &&
              (p as Record<string, unknown>).type === "text"
          ));
      if (!ok) {
        throw badRequest("message.content must be a string, null, or an array of {type:'text'} parts");
      }
      msg.content = c as ChatMessage["content"];
    }
    if (role === "tool") {
      if (rec.tool_call_id !== undefined && typeof rec.tool_call_id !== "string") {
        throw badRequest("tool_call_id must be a string");
      }
      if (rec.tool_call_id !== undefined) msg.tool_call_id = rec.tool_call_id;
    }
    if (role === "assistant" && Array.isArray(rec.tool_calls)) {
      const calls: ToolCall[] = [];
      for (const tc of rec.tool_calls) {
        if (tc === null || typeof tc !== "object") throw badRequest("tool_calls entries must be objects");
        const t = tc as Record<string, unknown>;
        if (t.type !== "function" || typeof t.function !== "object" || t.function === null) {
          throw badRequest('tool_calls entries must have type:"function" and a function object');
        }
        const fn = t.function as Record<string, unknown>;
        if (typeof fn.name !== "string" || typeof fn.arguments !== "string") {
          throw badRequest("tool_call.function needs string name and string arguments");
        }
        calls.push({
          ...(typeof t.id === "string" ? { id: t.id } : {}),
          type: "function",
          function: { name: fn.name, arguments: fn.arguments },
        });
      }
      msg.tool_calls = calls;
    }
    out.push(msg);
  }
  return out;
}

function parseTools(raw: unknown): ToolSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest("tools must be an array");
  const out: ToolSpec[] = [];
  for (const t of raw) {
    if (t === null || typeof t !== "object") throw badRequest("each tool must be an object");
    const rec = t as Record<string, unknown>;
    if (rec.type !== "function" || typeof rec.function !== "object" || rec.function === null) {
      throw badRequest('tools entries must have type:"function"');
    }
    const fn = rec.function as Record<string, unknown>;
    if (typeof fn.name !== "string") throw badRequest("tool.function.name must be a string");
    out.push({
      type: "function",
      function: {
        name: fn.name,
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        ...(fn.parameters !== undefined ? { parameters: fn.parameters as ToolSpec["function"]["parameters"] } : {}),
      },
    });
  }
  return out;
}

function resolveSessionKey(req: IncomingMessage, body: ChatRequestBody): string | null {
  const header = req.headers["x-session-id"];
  if (typeof header === "string" && header.length > 0) return header;
  if (typeof body.user === "string" && body.user.length > 0) return body.user;
  if (body.metadata && typeof body.metadata === "object") {
    const meta = body.metadata as Record<string, unknown>;
    if (typeof meta.session_id === "string" && meta.session_id.length > 0) return meta.session_id;
  }
  return null;
}

async function handleChat(bridge: TabBridge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: ChatRequestBody;
  try {
    body = JSON.parse(raw.toString("utf8") || "{}") as ChatRequestBody;
  } catch {
    throw badRequest("request body is not valid JSON");
  }

  const ignored: string[] = [];
  for (const p of IGNORED_PARAMS) {
    if (body[p as keyof ChatRequestBody] !== undefined) ignored.push(p);
  }
  const headers = ignoredHeader(ignored);

  if (body.n !== undefined && body.n !== 1 && body.n !== null) {
    throw badRequest("n > 1 is not supported: a tab cannot branch", headers);
  }
  if (body.logprobs !== undefined && body.logprobs !== false && body.logprobs !== null) {
    throw badRequest("logprobs is not supported in v1", headers);
  }
  if (
    body.response_format &&
    typeof body.response_format === "object" &&
    (body.response_format as Record<string, unknown>).type === "json_object"
  ) {
    throw badRequest("response_format json_object is not supported in v1", headers);
  }

  const model = typeof body.model === "string" ? body.model : "";
  if (!MODELS.includes(model)) {
    throw notFound(`model "${model}" is not available (use one of: ${MODELS.join(", ")})`);
  }
  const think = model === MODEL_THINK;
  const messages = parseMessages(body.messages);
  const tools = parseTools(body.tools);
  const stream = body.stream === true;
  const sessionId = resolveSessionKey(req, body);
  // E5: kod background-class traffic (metadata.tab_bridge_class =
  // "background") binds with noCreate when ephemeral, so background load can
  // never ratchet the tab count.
  const background =
    body.metadata !== null &&
    typeof body.metadata === "object" &&
    (body.metadata as Record<string, unknown>).tab_bridge_class === "background";

  // 'close' fires on premature disconnect AND after a normal finish; the
  // generation gate only consults the signal while the request is queued,
  // so a late abort is a harmless no-op.
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  const id = `chatcmpl-${randomId(12)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    let out: Awaited<ReturnType<TabBridge["handleChat"]>>;
    try {
      out = await bridge.handleChat({
        messages,
        tools,
        think,
        sessionId,
        signal: ac.signal,
        ...(background ? { background: true as const } : {}),
      } satisfies ChatParams);
    } catch (e) {
      if (e instanceof BridgeError && e.code === "client_gone") {
        log.info("http.client-gone", { id, stream: false });
        return;
      }
      throw e;
    }
    const message: Record<string, unknown> = { role: "assistant" };
    message.content = out.content || null;
    if (out.calls.length > 0) {
      message.tool_calls = out.calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    const warnings = out.warnings;
    // X-Fleet-Account (v4): the account id that served this turn, so an
    // operator can tell which Chrome profile (jar) produced the completion.
    const accountHeader: Record<string, string> =
      out.accountId !== undefined ? { "x-fleet-account": out.accountId } : {};
    sendJson(
      res,
      200,
      {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: out.finish,
          },
        ],
        usage: out.usage,
        ...(warnings.length > 0 ? { x_bridge_warning: warnings } : {}),
      },
      { ...headers, "x-bridge-queued-ms": String(out.gateWaitMs ?? 0), ...accountHeader }
    );
    return;
  }

  // ---- streaming path ------------------------------------------------------
  const sse = new SseStream(res);
  try {
    let roleSent = false;
    let toolIndex = 0;
    const events = {
      // v4 §10.3: SSE comment frame carrying X-Fleet-Account as soon as
      // the account is known — universal-compatibility metadata channel.
      onAccount: (accountId: string) => {
        // Pass the model so sendMeta can start() the stream with the
        // correct SSE headers BEFORE writing the comment frame (C10).
        sse.sendMeta({ "x-fleet-account": accountId }, model);
      },
      onContent: (text: string) => {
        // P6: a client that has gone away cannot read the stream — stop
        // stringifying and writing for a turn whose output goes nowhere.
        if (sse.clientGone) return;
        if (!roleSent) {
          sse.sendChoice({ delta: { role: "assistant", content: "" }, finish_reason: null }, model, id, created);
          roleSent = true;
        }
        if (text.length > 0) {
          sse.sendChoice({ delta: { content: text }, finish_reason: null }, model, id, created);
        }
      },
      onCall: (call: { id: string; name: string; arguments: string }) => {
        if (sse.clientGone) return;
        if (!roleSent) {
          sse.sendChoice({ delta: { role: "assistant", content: "" }, finish_reason: null }, model, id, created);
          roleSent = true;
        }
        sse.sendChoice(
          {
            delta: {
              tool_calls: [
                {
                  index: toolIndex++,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                },
              ],
            },
            finish_reason: null,
          },
          model,
          id,
          created
        );
      },
    };
    const out = await bridge.handleChat({
      messages,
      tools,
      think,
      sessionId,
      events,
      signal: ac.signal,
      ...(background ? { background: true as const } : {}),
    } satisfies ChatParams);
    // Final frames: usage chunk with empty choices, then finish_reason, [DONE].
    sse.sendChoice(
      {
        delta: {},
        finish_reason: out.finish,
      },
      model,
      id,
      created
    );
    sse.sendUsage(
      model,
      id,
      created,
      out.usage,
      out.warnings.length > 0 ? { x_bridge_warning: out.warnings } : undefined
    );
    sse.done();
    sse.close();
  } catch (e) {
    if (e instanceof BridgeError && e.code === "client_gone") {
      log.info("http.client-gone", { id, stream: true });
      return;
    }
    // Preserve typed errors (409 session_busy, 429 rate_limited): flattening
    // them through mapTurnError turns a non-retryable 409 into a retryable
    // 500, and callers retry into their own running turn.
    const be = e instanceof BridgeError ? e : mapTurnError(e);
    sse.fail(be.status, be.body(), be.retryAfter);
  }
}

// ---------------------------------------------------------------------------
// sessions lifecycle
// ---------------------------------------------------------------------------

async function handleSessions(
  bridge: TabBridge,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  query: URLSearchParams
): Promise<void> {
  if (url === "/v1/sessions") {
    if (method === "POST") {
      const force = query.get("force") === "true";
      if (force) {
        // C8: evict in a loop until under the threshold (previous code
        // evicted at most one session per call, so a POST could still be
        // over the threshold with a long backlog of stale rows).
        let guard = 128;
        while (bridge.registry.size > 64 && guard-- > 0) {
          if (!bridge.registry.evictOldestIdle()) break;
        }
      }
      const sessionId = `sess-${randomId(8)}`;
      bridge.createSession(sessionId);
      sendJson(res, 201, { session_id: sessionId });
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, {
        object: "list",
        data: bridge.registry.list().map((r) => ({
          session_id: r.sessionId,
          tab_id: r.tabId,
          state: r.state,
          turns: r.turns,
          chain_length: r.chain.length,
          created: r.createdAt,
          last_used: r.lastUsed,
          mode: r.mode,
          ...(typeof r.chatUrl === "string" ? { chat_url: r.chatUrl } : {}),
        })),
      });
      return;
    }
    throw badRequest(`unsupported method ${method} for /v1/sessions`);
  }

  const parts = url.split("/");
  const sessionId = parts[3] ?? "";
  if (!sessionId) throw badRequest("missing session id");

  if (method === "DELETE") {
    // H1: honour the per-session turn mutex. Deleting mid-turn otherwise
    // (a) returns 204 while the turn keeps running, (b) releases the physical
    // tab back to the allocatable pool while a turn is still using it —
    // two sessions can end up driving one tab — and (c) lets the in-flight
    // commit() re-persist the deleted row as a zombie on next boot.
    const existing = bridge.registry.get(sessionId);
    if (!existing) throw notFound(`no such session: ${sessionId}`);
    const mutex = bridge.registry.lockFor(sessionId);
    if (!mutex.tryAcquire()) {
      throw new BridgeError({
        status: 409,
        code: "session_busy",
        message: `session ${sessionId} has a turn in flight; retry the delete`,
      });
    }
    try {
      // Fleet bookkeeping: drop the session's slot on its account (ADR-13v3).
      bridge.releaseSession(sessionId);
      const row = bridge.registry.delete(sessionId);
      if (!row) throw notFound(`no such session: ${sessionId}`);
      try {
        await bridge.pool.release(sessionId, 5_000);
      } catch {
        /* worker may be gone; the row is cleared regardless */
      }
      // Compact the journal without this row. A late commit() from the
      // in-flight turn would otherwise append the removed row back; the
      // compact makes the on-disk state match the in-memory state.
      bridge.registry.persistCompact();
      res.writeHead(204);
      res.end();
      return;
    } finally {
      // delete() already removed the lock entry from the registry map, but
      // we still hold a reference to the mutex object; releasing it keeps
      // the object consistent if a future request somehow reuses the id.
      mutex.release();
    }
  }

  if (method === "GET") {
    const row = bridge.registry.get(sessionId);
    if (!row || row.ephemeral) throw notFound(`no such session: ${sessionId}`);
    sendJson(res, 200, {
      session_id: row.sessionId,
      tab_id: row.tabId,
      state: row.state,
      turns: row.turns,
      chain_length: row.chain.length,
      created: row.createdAt,
      last_used: row.lastUsed,
      mode: row.mode,
      ...(typeof row.chatUrl === "string" ? { chat_url: row.chatUrl } : {}),
    });
    return;
  }

  throw badRequest(`unsupported method ${method} for /v1/sessions/:id`);
}

// ---------------------------------------------------------------------------
// /v1/fleet/* handlers
// ---------------------------------------------------------------------------

interface FleetEnrollBody {
  id?: unknown;
  label?: unknown;
  proxy?: unknown;
  surface?: unknown;
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function handleFleet(
  bridge: TabBridge,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string
): Promise<void> {
  const parts = url.split("/").filter(Boolean); // ["v1","fleet",id?,sub?]
  // /v1/fleet/enroll
  if (parts.length === 3 && parts[2] === "enroll" && method === "POST") {
    const raw = await readBody(req);
    let body: FleetEnrollBody;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as FleetEnrollBody;
    } catch {
      throw badRequest("body is not valid JSON");
    }
    const id = readString(body.id);
    if (!id) throw badRequest("fleet enroll requires id");
    const surface =
      body.surface !== null && typeof body.surface === "object"
        ? (body.surface as Record<string, unknown>)
        : undefined;
    let result: { id: string };
    try {
      result = bridge.fleetEnroll({
        id,
        ...(readString(body.label) !== undefined ? { label: readString(body.label)! } : {}),
        ...(readString(body.proxy) !== undefined ? { proxy: readString(body.proxy)! } : {}),
        ...(surface !== undefined ? { surface: surface as never } : {}),
      });
    } catch (e) {
      // Bug-hunt C19: enrollment conflicts are caller errors, not 500s.
      // Translate the EnrollmentManager's generic Errors into a typed 409.
      const msg = e instanceof Error ? e.message : String(e);
      if (/enrollment already open|already exists/.test(msg)) {
        throw new BridgeError({
          status: 409,
          code: "enroll_conflict",
          message: msg,
        });
      }
      throw e;
    }
    sendJson(res, 201, { ok: true, accountId: result.id });
    return;
  }

  // All other endpoints take an :id
  if (parts.length < 4) throw badRequest(`unknown fleet endpoint: ${method} ${url}`);
  const id = parts[2];
  const sub = parts[3];

  // Operator-only debug endpoint: returns the account's RAW proxy string so
  // the `fleet doctor` CLI can run an exit-IP probe through the actual
  // endpoint. Never returns the value in any other response, never logs it,
  // and never persists it expanded (ADR-10v2 hygiene): the raw value may
  // contain env-var references which the CLI expands through process.env
  // before probing.
  //
  // Bug-hunt fix: require the request to originate on this machine. The
  // endpoint is a debugging convenience — it should not be reachable from
  // off-host even when the bridge runs without --api-key-env.
  if (method === "GET" && sub === "_debug_proxy") {
    if (!isLocalRequest(req, [bridge.config.host])) {
      throw new BridgeError({
        status: 403,
        code: "non_local",
        message: "the debug proxy endpoint is loopback-only",
      });
    }
    const raw = bridge.fleetRawProxy(id);
    sendJson(res, 200, { proxy: raw });
    return;
  }

  if (method === "POST" && sub === "open") {
    bridge.fleetOpenWindow(id);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "POST" && sub === "relogin") {
    bridge.fleetOpenWindow(id);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "POST" && sub === "proxy") {
    const raw = await readBody(req);
    let body: { proxy?: unknown; force?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as { proxy?: unknown; force?: unknown };
    } catch {
      throw badRequest("body is not valid JSON");
    }
    const value = body.proxy;
    if (value !== null && typeof value !== "string") {
      throw badRequest("proxy must be a string or null");
    }
    bridge.fleetSetProxy(id, value as string | null, body.force === true);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "POST" && sub === "surface") {
    const raw = await readBody(req);
    let body: { surface?: unknown; force?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as { surface?: unknown; force?: unknown };
    } catch {
      throw badRequest("body is not valid JSON");
    }
    const value = body.surface;
    if (value !== null && typeof value !== "object") {
      throw badRequest("surface must be an object or null");
    }
    bridge.fleetSetSurface(id, (value ?? null) as never, body.force === true);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "POST" && sub === "remove") {
    const removed = bridge.fleetRemove(id);
    sendJson(res, 200, { ok: true, removed });
    return;
  }
  if (method === "GET" && sub === "checkup-history") {
    const history = bridge.fleetCheckupHistory(id);
    sendJson(res, 200, { ok: true, history });
    return;
  }
  if (method === "POST" && sub === "checkup") {
    const entry = await bridge.fleetCheckup(id);
    sendJson(res, 200, { ok: true, checkup: entry });
    return;
  }
  if (method === "POST" && sub === "drain") {
    const raw = await readBody(req);
    let body: { to?: unknown; dryRun?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as { to?: unknown; dryRun?: unknown };
    } catch {
      throw badRequest("body is not valid JSON");
    }
    const to = typeof body.to === "string" && body.to.length > 0 ? body.to : "auto";
    const dryRun = body.dryRun === true;
    const result = bridge.fleetDrain(id, to, dryRun);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }
  throw badRequest(`unknown fleet endpoint: ${method} ${url}`);
}
