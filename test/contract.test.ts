// Contract tests: full bridge (L4->L2) driven through HTTP with a ScriptedAdapter.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TabBridge } from "../src/bridge.js";
import { createHttpServer } from "../src/facade/http.js";
import { ScriptedAdapter } from "../src/adapter/scripted.js";
import type { Config } from "../src/config.js";

function baseConfig(db: string, over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    apiKey: null,
    stateful: true,
    autoCreateTabs: false,
    managedOnly: true,
    ttlMs: 30 * 60_000,
    repairRounds: 1,
    warmTabs: 0,
    dbPath: db,
    turnTimeoutMs: 5_000,
    bindTimeoutMs: 2_000,
    maxPromptChars: 1_000_000,
    ...over,
  };
}

const FENCE = (name: string, args: Record<string, unknown>) =>
  `\`\`\`tool_call\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;

let dir: string;
let adapter: ScriptedAdapter;
let bridge: TabBridge;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tabbridge-test-"));
  adapter = new ScriptedAdapter({ maxPromptChars: 4000 });
  bridge = new TabBridge(baseConfig(join(dir, "sessions.json")), adapter);
  server = createHttpServer({ bridge });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  bridge.dispose();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function sseFrames(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d) as Record<string, unknown>);
}

async function chat(body: Record<string, unknown>, headers: Record<string, string> = {}, useSession = true) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // default session affinity so multi-request scenarios share one session
      ...(useSession ? { "x-session-id": "test-session" } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("GET /v1/models lists the two web models (R1)", async () => {
  const res = await fetch(`${base}/v1/models`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(body.data.map((m) => m.id).sort(), ["deepseek-web-chat", "deepseek-web-think"]);
});

test("unknown model -> 404; bad messages -> 400; n>1 -> 400 with X-Bridge-Ignored", async () => {
  const r1 = await chat({ model: "nope", messages: [{ role: "user", content: "x" }] });
  assert.equal(r1.status, 404);

  const r2 = await chat({ model: "deepseek-web-chat", messages: [] });
  assert.equal(r2.status, 400);

  const r3 = await chat({
    model: "deepseek-web-chat",
    messages: [{ role: "user", content: "x" }],
    n: 2,
    temperature: 0.7,
  });
  assert.equal(r3.status, 400);
  assert.equal(r3.headers.get("x-bridge-ignored"), "temperature");
  const b3 = (await r3.json()) as { error: { code: string } };
  assert.equal(b3.error.code, "bad_request");
});

test("auth: wrong bearer -> 401 with a JSON body (ADR-7)", async () => {
  const b2 = new TabBridge(baseConfig(join(dir, "s2.json"), { apiKey: "sekrit" }), adapter);
  const s2 = createHttpServer({ bridge: b2 });
  await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
  const a2 = s2.address() as AddressInfo;
  try {
    const bad = await fetch(`http://127.0.0.1:${a2.port}/v1/models`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(bad.status, 401);
    const body = (await bad.json()) as { error: { type: string } };
    assert.equal(body.error.type, "tab_bridge_error");
    const ok = await fetch(`http://127.0.0.1:${a2.port}/v1/models`, {
      headers: { authorization: "Bearer sekrit" },
    });
    assert.equal(ok.status, 200);
  } finally {
    b2.dispose();
    s2.close();
  }
});

test("non-stream chat round-trips with usage; prompt content includes protocol block", async () => {
  adapter.push({ text: "Hello from the tab." });
  const res = await chat({
    model: "deepseek-web-chat",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    usage: { total_tokens: number };
  };
  assert.equal(body.choices[0].message.content, "Hello from the tab.");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(body.usage.total_tokens > 0);
  // Seed prompt carried the tool protocol + transcript
  const sent = adapter.sentTexts[0];
  assert.ok(sent.includes("=== TOOL PROTOCOL (tool-protocol: 1) ==="));
  assert.ok(sent.includes("### USER\nhi"));
});

test("tool loop: tool_calls finish, then INJECT_RESULTS without reset (ADR-4)", async () => {
  adapter.push({ text: FENCE("execute_command", { cmd: "ls -la" }) });
  adapter.push({ text: "The directory contains: main.rs" });

  const callMsg = {
    role: "user",
    content: "list the files",
  };

  const r1 = await chat({
    model: "deepseek-web-chat",
    messages: [callMsg],
    tools: [
      {
        type: "function",
        function: {
          name: "execute_command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      },
    ],
  });
  const j1 = (await r1.json()) as {
    choices: Array<{ message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>; content: string | null }; finish_reason: string }>;
  };
  assert.equal(j1.choices[0].finish_reason, "tool_calls");
  const call = j1.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "execute_command");
  assert.equal(call.function.arguments, '{"cmd":"ls -la"}');
  assert.match(call.id, /^call_[0-9a-f]{10}$/);
  assert.equal(j1.choices[0].message.content, null);

  // Round 2: full history + tool result -> INJECT_RESULTS (echo skipped, no reset)
  const r2 = await chat({
    model: "deepseek-web-chat",
    messages: [
      callMsg,
      {
        role: "assistant",
        content: null,
        tool_calls: [call],
      },
      { role: "tool", content: "main.rs", tool_call_id: call.id },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "execute_command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      },
    ],
  });
  const j2 = (await r2.json()) as { choices: Array<{ message: { content: string }; finish_reason: string }> };
  assert.equal(j2.choices[0].message.content, "The directory contains: main.rs");

  // The second submission was ONLY the rendered tool results (no reseed).
  const secondPrompt = adapter.sentTexts[1];
  assert.ok(secondPrompt.includes("=== TOOL RESULTS ==="));
  assert.ok(secondPrompt.includes("### TOOL#"));
  assert.ok(!secondPrompt.includes("=== TRANSCRIPT ==="));
  // And no RESET was issued across the two rounds.
  assert.equal(adapter.resetCount, 0);
});

test("text-echo continuation injects only the new user text", async () => {
  adapter.push({ text: "first answer" });
  adapter.push({ text: "second answer" });
  await chat({ model: "deepseek-web-chat", messages: [{ role: "user", content: "q1" }] });
  const r2 = await chat({
    model: "deepseek-web-chat",
    messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "q2 please" },
    ],
  });
  const j2 = (await r2.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(j2.choices[0].message.content, "second answer");
  assert.equal(adapter.sentTexts[1], "q2 please");
});

test("divergence (edited history) forces RESET_RESEED with full transcript", async () => {
  adapter.push({ text: "a1" });
  adapter.push({ text: "a2" });
  await chat({ model: "deepseek-web-chat", messages: [{ role: "user", content: "q1" }] });
  const r2 = await chat({
    model: "deepseek-web-chat",
    messages: [{ role: "user", content: "q1 EDITED" }],
  });
  assert.equal(r2.status, 200);
  assert.equal(adapter.resetCount, 1);
  const reseed = adapter.sentTexts[1];
  assert.ok(reseed.includes("=== TRANSCRIPT ==="));
  assert.ok(reseed.includes("q1 EDITED"));
});

test("streaming SSE: role frame, content deltas, finish_reason, usage, [DONE] (R4)", async () => {
  adapter.push({ text: "abcdef ghij", fragmentSize: 3 });
  const res = await chat({
    model: "deepseek-web-chat",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));
  const raw = await res.text();
  const frames = sseFrames(raw);
  assert.ok(raw.trimEnd().endsWith("data: [DONE]"));
  const first = frames[0] as { choices: Array<{ delta: { role: string } }> };
  assert.equal(first.choices[0].delta.role, "assistant");
  const contents = frames
    .filter((f) => (f.choices as Array<{ delta: { content?: string } }> | undefined)?.[0]?.delta?.content)
    .map((f) => (f.choices as Array<{ delta: { content: string } }>)[0].delta.content)
    .join("");
  assert.equal(contents, "abcdef ghij");
  const finish = frames.find((f) => (f.choices as Array<{ finish_reason: string }>)?.[0]?.finish_reason);
  assert.equal((finish?.choices as Array<{ finish_reason: string }>)[0].finish_reason, "stop");
  const usage = frames.find((f) => f.usage);
  assert.ok(usage && (usage.usage as { total_tokens: number }).total_tokens > 0);
});

test("streaming tool calls emit index-keyed tool_call deltas then finish tool_calls", async () => {
  adapter.push({ text: FENCE("read_file", { path: "a.ts" }) });
  const res = await chat({
    model: "deepseek-web-chat",
    messages: [{ role: "user", content: "read a.ts" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ],
    stream: true,
  });
  const frames = sseFrames(await res.text());
  const callFrame = frames.find((f) =>
    (f.choices as Array<{ delta: { tool_calls?: unknown[] } }> | undefined)?.[0]?.delta?.tool_calls
  ) as { choices: Array<{ delta: { tool_calls: Array<{ index: number; id: string; function: { name: string; arguments: string } }> } }> };
  const tc = callFrame.choices[0].delta.tool_calls[0];
  assert.equal(tc.index, 0);
  assert.equal(tc.function.name, "read_file");
  assert.equal(tc.function.arguments, '{"path":"a.ts"}');
  const finish = frames.find((f) => (f.choices as Array<{ finish_reason: string }>)?.[0]?.finish_reason);
  assert.equal((finish?.choices as Array<{ finish_reason: string }>)[0].finish_reason, "tool_calls");
});

test("repair round recovers a malformed protocol violation (ADR-5)", async () => {
  adapter.push({ text: '```tool_call\n{"name": "execute_command" "cmd": "ls"}\n```' }); // invalid JSON
  adapter.push({ text: FENCE("execute_command", { cmd: "ls" }) }); // repaired
  const res = await chat({
    model: "deepseek-web-chat",
    messages: [{ role: "user", content: "run ls" }],
    tools: [
      {
        type: "function",
        function: {
          name: "execute_command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      },
    ],
  });
  const j = (await res.json()) as {
    choices: Array<{ finish_reason: string; message: { tool_calls: unknown[] } }>;
    x_bridge_warning?: string[];
  };
  assert.equal(j.choices[0].finish_reason, "tool_calls");
  assert.equal(j.choices[0].message.tool_calls.length, 1);
  assert.ok(adapter.sentTexts.some((t) => t.includes("PROTOCOL REMINDER")));
});

test("repair exhausted -> text completion + x_bridge_warning, never a hang", async () => {
  const bad = '```tool_call\n{"name": "execute_command" "cmd": "ls"}\n```';
  adapter.push({ text: bad });
  adapter.push({ text: bad });
  const res = await chat({
    model: "deepseek-web-chat",
    messages: [{ role: "user", content: "run ls" }],
    tools: [
      {
        type: "function",
        function: {
          name: "execute_command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      },
    ],
  });
  const j = (await res.json()) as {
    choices: Array<{ finish_reason: string; message: { content: string } }>;
    x_bridge_warning?: string[];
  };
  assert.equal(j.choices[0].finish_reason, "stop");
  assert.ok(j.x_bridge_warning?.some((w) => w.includes("repair round exhausted")));
});

test("same-session overlap -> 409, never queued (R6/ADR-7)", async () => {
  // A slow scripted reply keeps the session mutex held.
  const slow = new ScriptedAdapter();
  const orig = slow.streamResponse.bind(slow);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  slow.push({ text: "slow" });
  slow.streamResponse = async (tab, sink) => {
    await gate;
    return orig(tab, sink);
  };
  const b2 = new TabBridge(baseConfig(join(dir, "s3.json")), slow);
  const s2 = createHttpServer({ bridge: b2 });
  await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
  const a2 = s2.address() as AddressInfo;
  const b2u = `http://127.0.0.1:${a2.port}`;
  try {
    const p1 = fetch(`${b2u}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "one" }],
      }),
      headers: { "x-session-id": "overlap-1", "content-type": "application/json" },
    });
    // give the first request time to acquire the mutex
    await new Promise((r) => setTimeout(r, 80));
    const p2 = fetch(`${b2u}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-session-id": "overlap-1", "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "two" }],
      }),
    });
    const r2 = await p2;
    assert.equal(r2.status, 409);
    const j = (await r2.json()) as { error: { code: string } };
    assert.equal(j.error.code, "session_busy");
    (release as () => void)();
    const r1 = await p1;
    assert.equal(r1.status, 200);
  } finally {
    b2.dispose();
    s2.close();
  }
});

test("sessions lifecycle: create, list, delete(204), 404 after delete", async () => {
  const created = await fetch(`${base}/v1/sessions`, { method: "POST" });
  assert.equal(created.status, 201);
  const { session_id } = (await created.json()) as { session_id: string };

  const list = await fetch(`${base}/v1/sessions`);
  const lj = (await list.json()) as { data: Array<{ session_id: string }> };
  assert.ok(lj.data.some((s) => s.session_id === session_id));

  const del = await fetch(`${base}/v1/sessions/${session_id}`, { method: "DELETE" });
  assert.equal(del.status, 204);

  const after = await fetch(`${base}/v1/sessions/${session_id}`);
  assert.equal(after.status, 404);
});

test("healthz echoes the effective configuration (ADR-6 visibility)", async () => {
  const res = await fetch(`${base}/healthz`);
  const j = (await res.json()) as { stateful: boolean; mode: string; repair_rounds: number };
  assert.equal(j.stateful, true);
  assert.equal(j.mode, "stateful");
  assert.equal(j.repair_rounds, 1);
});

test("stateless legacy path (no session affinity) works and leaves no rows", async () => {
  adapter.push({ text: "one" });
  adapter.push({ text: "two" });
  const r1 = await chat({ model: "deepseek-web-chat", messages: [{ role: "user", content: "x" }] }, {}, false);
  const r2 = await chat({ model: "deepseek-web-chat", messages: [{ role: "user", content: "y" }] }, {}, false);
  assert.equal(((await r1.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, "one");
  assert.equal(((await r2.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, "two");
  const list = (await (await fetch(`${base}/v1/sessions`)).json()) as { data: unknown[] };
  assert.equal(list.data.length, 0);
});

test("always-reset mode (--stateful=false) seeds every turn (ADR-6)", async () => {
  const b2 = new TabBridge(baseConfig(join(dir, "s4.json"), { stateful: false }), adapter);
  const s2 = createHttpServer({ bridge: b2 });
  await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
  const a2 = s2.address() as AddressInfo;
  try {
    adapter.push({ text: "x" });
    adapter.push({ text: "y" });
    const h = { "content-type": "application/json", "x-session-id": "reset-mode" };
    await fetch(`http://127.0.0.1:${a2.port}/v1/chat/completions`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ model: "deepseek-web-chat", messages: [{ role: "user", content: "1" }] }),
    });
    await fetch(`http://127.0.0.1:${a2.port}/v1/chat/completions`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        model: "deepseek-web-chat",
        messages: [
          { role: "user", content: "1" },
          { role: "assistant", content: "x" },
          { role: "user", content: "2" },
        ],
      }),
    });
    // both turns were seeds carrying the full transcript
    assert.equal(adapter.sentTexts.length, 2);
    assert.ok(adapter.sentTexts[0].includes("=== TRANSCRIPT ==="));
    assert.ok(adapter.sentTexts[1].includes("=== TRANSCRIPT ==="));
  } finally {
    b2.dispose();
    s2.close();
  }
});

test("bridge restart replays chains from the journal without storing text (ADR-3)", async () => {
  const db = join(dir, "restart.json");
  adapter.push({ text: "resp" });
  const b1 = new TabBridge(baseConfig(db), adapter);
  const s1 = createHttpServer({ bridge: b1 });
  await new Promise<void>((resolve) => s1.listen(0, "127.0.0.1", resolve));
  const a1 = s1.address() as AddressInfo;
  await fetch(`http://127.0.0.1:${a1.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": "persist-1" },
    body: JSON.stringify({
      model: "deepseek-web-chat",
      messages: [{ role: "user", content: "persist me" }],
    }),
  });
  b1.dispose();
  s1.close();

  const b2 = new TabBridge(baseConfig(db), adapter);
  const row = b2.registry.get === undefined ? null : undefined;
  void row;
  // restored: a follow-up turn with matching history + echo continues the chain
  // (i.e. NOT a reseed) because the chain and tabHash survived.
  adapter.push({ text: "resp2" });
  const s2 = createHttpServer({ bridge: b2 });
  await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
  const a2 = s2.address() as AddressInfo;
  const r = await fetch(`http://127.0.0.1:${a2.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": "persist-1" },
    body: JSON.stringify({
      model: "deepseek-web-chat",
      messages: [
        { role: "user", content: "persist me" },
        { role: "assistant", content: "resp" },
        { role: "user", content: "next" },
      ],
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(adapter.sentTexts.at(-1), "next"); // echo-skip inject, not a reseed
  b2.dispose();
  s2.close();
});

test("prompt larger than adapter cap -> 400 (composer limit is a contract)", async () => {
  const small = new ScriptedAdapter({ maxPromptChars: 50 });
  const b2 = new TabBridge(baseConfig(join(dir, "s5.json")), small);
  const s2 = createHttpServer({ bridge: b2 });
  await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
  const a2 = s2.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${a2.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "z".repeat(5000) }],
      }),
    });
    assert.equal(res.status, 400);
  } finally {
    b2.dispose();
    s2.close();
  }
});
