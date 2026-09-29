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
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(badRequest("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (e) => reject(e));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(headers ?? {}),
  });
  res.end(JSON.stringify(body));
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
    if (rec.content !== undefined) msg.content = rec.content as ChatMessage["content"];
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
      { ...headers, "x-bridge-queued-ms": String(out.gateWaitMs ?? 0) }
    );
    return;
  }

  // ---- streaming path ------------------------------------------------------
  const sse = new SseStream(res);
  try {
    let roleSent = false;
    let toolIndex = 0;
    const events = {
      onContent: (text: string) => {
        if (!roleSent) {
          sse.sendChoice({ delta: { role: "assistant", content: "" }, finish_reason: null }, model, id, created);
          roleSent = true;
        }
        if (text.length > 0) {
          sse.sendChoice({ delta: { content: text }, finish_reason: null }, model, id, created);
        }
      },
      onCall: (call: { id: string; name: string; arguments: string }) => {
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
      if (force && bridge.registry.size > 64) {
        bridge.registry.evictOldestIdle();
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
    const row = bridge.registry.delete(sessionId);
    if (!row) throw notFound(`no such session: ${sessionId}`);
    try {
      await bridge.pool.release(sessionId, 5_000);
    } catch {
      /* worker may be gone; the row is cleared regardless */
    }
    res.writeHead(204);
    res.end();
    return;
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
    });
    return;
  }

  throw badRequest(`unsupported method ${method} for /v1/sessions/:id`);
}
