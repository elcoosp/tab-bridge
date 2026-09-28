// Worker-link integration tests: a fake Chrome extension service worker
// connects over a real WebSocket and drives the full stack (L0<->L4).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TabBridge } from "../src/bridge.js";
import { createHttpServer } from "../src/facade/http.js";
import type { Config } from "../src/config.js";

const FENCE = (name: string, args: Record<string, unknown>) =>
  `\`\`\`tool_call\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;

/** Minimal fake extension service worker speaking the bridge protocol. */
class FakeWorker {
  ws: WebSocket | null = null;
  url: string;
  tabSeq = 100;
  bound = new Map<string, number>();
  lastSendText: string | null = null;
  resets = 0;
  released: string[] = [];
  private openWaiter: Promise<void>;

  constructor(url: string) {
    this.url = url;
    this.openWaiter = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ t: "HELLO", v: 1, ext: "fake-ext" }));
        resolve();
      });
      ws.addEventListener("error", (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`)));
      ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    });
  }

  static async connect(url: string): Promise<FakeWorker> {
    const w = new FakeWorker(url);
    await w.openWaiter;
    return w;
  }

  private onMessage(raw: string): void {
    const m = JSON.parse(raw) as Record<string, unknown>;
    const ws = this.ws as WebSocket;
    switch (m.t) {
      case "HELLO_OK":
        break;
      case "BIND": {
        const tabId = ++this.tabSeq;
        this.bound.set(String(m.sessionId), tabId);
        ws.send(JSON.stringify({ t: "BOUND", sessionId: m.sessionId, tabId, state: "ready" }));
        break;
      }
      case "SEND": {
        const reqId = String(m.reqId);
        this.lastSendText = String(m.text);
        ws.send(JSON.stringify({ t: "ACCEPTED", reqId }));
        ws.send(JSON.stringify({ t: "STATUS", reqId, code: "submitting" }));
        const text = this.reply ?? "";
        // stream in two fragments to exercise reassembly
        const mid = Math.ceil(text.length / 2);
        for (const part of [text.slice(0, mid), text.slice(mid)]) {
          if (part.length > 0) {
            ws.send(JSON.stringify({ t: "FRAGMENT", reqId, seq: 1, text: part }));
          }
        }
        ws.send(JSON.stringify({ t: "STATUS", reqId, code: "done" }));
        break;
      }
      case "RESET": {
        this.resets += 1;
        ws.send(JSON.stringify({ t: "RESET_OK", reqId: m.reqId }));
        break;
      }
      case "PING": {
        ws.send(
          JSON.stringify({
            t: "PONG",
            seq: m.seq,
            tabs: [...this.bound.values()].map((tabId) => ({ tabId, state: "ready", health: "ok" })),
          })
        );
        break;
      }
      case "RELEASE": {
        this.released.push(String(m.sessionId));
        ws.send(JSON.stringify({ t: "RELEASED", sessionId: m.sessionId }));
        break;
      }
      case "ABORT":
        break;
      default:
        break;
    }
  }

  reply = "";

  close(): void {
    this.ws?.close();
  }
}

let dir: string;
let bridge: TabBridge;
let server: Server;
let base: string;
let wsBase: string;

function config(db: string, over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    apiKey: null,
    stateful: true,
    autoCreateTabs: true,
    managedOnly: true,
    ttlMs: 30 * 60_000,
    repairRounds: 1,
    warmTabs: 0,
    dbPath: db,
    turnTimeoutMs: 5_000,
    bindTimeoutMs: 3_000,
    maxPromptChars: 1_000_000,
    holdbackCeiling: 65_536,
    maxConcurrentTurns: 2,
    queueCapacity: 32,
    queueTimeoutMs: 600_000,
    ...over,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tabbridge-ws-"));
  bridge = new TabBridge(config(join(dir, "sessions.json")));
  server = createHttpServer({ bridge });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  bridge.attachWorkerLink(server);
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}/worker`;
});

afterEach(() => {
  bridge.dispose();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("end-to-end: worker link + bind + seed turn over WebSocket", async () => {
  const worker = await FakeWorker.connect(wsBase);
  worker.reply = "The tab says hi";
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "ws-sess-1" },
      body: JSON.stringify({
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello tab" }],
      }),
    });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(j.choices[0].message.content, "The tab says hi");
    // seed text carried the transcript
    assert.ok(worker.lastSendText?.includes("### USER\nhello tab"));

    // session row visible with a bound tab
    const list = (await (await fetch(`${base}/v1/sessions`)).json()) as {
      data: Array<{ session_id: string; tab_id: number; chain_length: number }>;
    };
    const row = list.data.find((s) => s.session_id === "ws-sess-1");
    assert.ok(row);
    assert.equal(row.tab_id, 101);
    assert.equal(row.chain_length, 1); // history was a single user message
  } finally {
    worker.close();
  }
});

test("tool round-trip over the worker link: fenced call -> tool result -> answer", async () => {
  const worker = await FakeWorker.connect(wsBase);
  worker.reply = FENCE("execute_command", { cmd: "ls" });
  const tools = [
    {
      type: "function",
      function: {
        name: "execute_command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
    },
  ];
  try {
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "ws-tool" },
      body: JSON.stringify({ model: "deepseek-web-chat", messages: [{ role: "user", content: "ls" }], tools }),
    });
    const j1 = (await r1.json()) as {
      choices: Array<{ message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    const call = j1.choices[0].message.tool_calls[0];
    assert.equal(call.function.arguments, '{"cmd":"ls"}');

    // Round 2: kod-style re-request with the tool result.
    worker.reply = "listing: a.txt b.txt";
    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "ws-tool" },
      body: JSON.stringify({
        model: "deepseek-web-chat",
        messages: [
          { role: "user", content: "ls" },
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", content: "a.txt\nb.txt", tool_call_id: call.id },
        ],
        tools,
      }),
    });
    assert.equal(r2.status, 200);
    const j2 = (await r2.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(j2.choices[0].message.content, "listing: a.txt b.txt");
    // inject path: only the tool results were sent to the tab
    assert.ok(worker.lastSendText?.includes("=== TOOL RESULTS ==="));
    assert.ok(worker.lastSendText?.includes("### TOOL#" + call.id));
    assert.equal(worker.resets, 0);
  } finally {
    worker.close();
  }
});

test("RESET_RESEED over the link: edited history resets the tab first", async () => {
  const worker = await FakeWorker.connect(wsBase);
  worker.reply = "one";
  try {
    const h = { "content-type": "application/json", "x-session-id": "ws-reset" };
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ model: "deepseek-web-chat", messages: [{ role: "user", content: "v1" }] }),
    });
    worker.reply = "two";
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ model: "deepseek-web-chat", messages: [{ role: "user", content: "v2 EDITED" }] }),
    });
    assert.equal(worker.resets, 1);
    assert.ok(worker.lastSendText?.includes("v2 EDITED"));
  } finally {
    worker.close();
  }
});

test("DELETE /v1/sessions releases the tab over the link", async () => {
  const worker = await FakeWorker.connect(wsBase);
  try {
    await fetch(`${base}/v1/sessions`, { method: "POST" });
    const list = (await (await fetch(`${base}/v1/sessions`)).json()) as { data: Array<{ session_id: string }> };
    const id = list.data[0].session_id;
    const del = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
    assert.equal(del.status, 204);
    assert.deepEqual(worker.released, [id]);
  } finally {
    worker.close();
  }
});

test("no worker connected -> 503 pool_exhausted with Retry-After (ADR-7)", async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-web-chat", messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(res.status, 503);
  assert.ok(res.headers.get("retry-after"));
  const j = (await res.json()) as { error: { code: string } };
  assert.equal(j.error.code, "pool_exhausted");
});

test("worker link auth: bad token is refused at upgrade", async () => {
  bridge.dispose();
  server.close();
  bridge = new TabBridge(config(join(dir, "auth.json"), { apiKey: "topsecret" }));
  server = createHttpServer({ bridge });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  bridge.attachWorkerLink(server);
  const addr = server.address() as AddressInfo;
  const bad = `ws://127.0.0.1:${addr.port}/worker?token=WRONG`;
  const good = `ws://127.0.0.1:${addr.port}/worker?token=topsecret`;

  await assert.rejects(() => FakeWorker.connect(bad));
  const w = await FakeWorker.connect(good);
  w.close();

  // HTTP auth matches too
  const ok = await fetch(`http://127.0.0.1:${addr.port}/v1/models`, {
    headers: { authorization: "Bearer topsecret" },
  });
  assert.equal(ok.status, 200);
  const no = await fetch(`http://127.0.0.1:${addr.port}/v1/models`);
  assert.equal(no.status, 401);
});

test("streaming through the link produces SSE frames from fragments", async () => {
  const worker = await FakeWorker.connect(wsBase);
  worker.reply = "streamed answer";
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "ws-stream" },
      body: JSON.stringify({
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "go" }],
        stream: true,
      }),
    });
    const raw = await res.text();
    assert.ok(raw.trimEnd().endsWith("data: [DONE]"));
    // join the content deltas and verify the full answer arrived
    const contents = raw
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> })
      .map((f) => f.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.equal(contents, "streamed answer");
  } finally {
    worker.close();
  }
});
