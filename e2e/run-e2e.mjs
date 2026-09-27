#!/usr/bin/env node
/**
 * Bridge-level E2E suite: spawns the REAL built bridge binary
 * (dist/src/index.js serve), connects a scripted fake extension over a REAL
 * WebSocket, and drives the REAL HTTP/SSE surface — the same stack kod hits,
 * minus the Chrome DOM layer.
 *
 *   node e2e/run-e2e.mjs [--port 8977] [--verbose] [--keep]
 *
 * Exit code 0 = every scenario passed. On failure, bridge logs are printed.
 * What this proves vs what it cannot: see TESTING.md (tiers).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeExtension } from "./fake-extension.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = join(ROOT, "dist", "src", "index.js");

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argOf("--port", 8977));
const VERBOSE = args.includes("--verbose") || args.includes("-v");
const KEEP = args.includes("--keep");
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/worker`;
const TURN_MS = 6000; // short turn deadline: failure drills stay fast

// ---- harness --------------------------------------------------------------
const results = [];
let current = "";

function ok(cond, label) {
  if (!cond) throw new Error(`assert failed: ${label}`);
  if (VERBOSE) console.log(`    ✓ ${label}`);
}

function eq(actual, expected, label) {
  const a = typeof expected === "string" ? JSON.stringify(actual) : String(actual);
  const e = typeof expected === "string" ? JSON.stringify(expected) : String(expected);
  if (actual !== expected) throw new Error(`assert failed: ${label}\n      expected: ${e}\n      actual:   ${a}`);
  if (VERBOSE) console.log(`    ✓ ${label}`);
}

async function scenario(name, fn) {
  current = name;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - t0 });
    console.log(`  PASS  ${name}  (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, pass: false, ms: Date.now() - t0, err: e });
    console.log(`  FAIL  ${name}  (${Date.now() - t0}ms)`);
    console.log(`        ${String(e.message ?? e).split("\n").join("\n        ")}`);
  }
}

async function req(method, path, { body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, headers: res.headers, json, raw };
}

/** Stream an SSE chat completion; returns parsed data frames + raw lines. */
async function sseChat(body, headers = {}) {
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const lines = [];
  const frames = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      lines.push(line);
      if (line.startsWith("data: ")) {
        const payload = line.slice(6);
        if (payload === "[DONE]") frames.push("[DONE]");
        else {
          try {
            frames.push(JSON.parse(payload));
          } catch {
            frames.push({ __unparsed: payload });
          }
        }
      }
    }
  }
  return { status: res.status, headers: res.headers, frames, lines };
}

const SYS = "You are a helpful weather assistant.";
const USER1 = "What is the weather in Paris?";

// fenced tool_call the fake tab emits (exactly what DeepSeek would print)
const fence = (name, args) =>
  "```tool_call\n" + JSON.stringify({ name, arguments: args }) + "\n```";

// obs[] that make the fake tab "speak" text then finish
const say = (text) => [
  { t: "STATUS", code: "submitting" },
  { t: "FRAGMENT", seq: 0, text },
  { t: "STATUS", code: "done" },
];

// ---- bridge process control ----------------------------------------------
let proc = null;
let dbPath = null;
let bridgeLog = "";

function startBridge(db) {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [
      BRIDGE,
      "serve",
      "--port", String(PORT),
      "--db", db,
      "--turn-timeout-ms", String(TURN_MS),
      "--bind-timeout-ms", "4000",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => (bridgeLog += d));
    proc.stderr.on("data", (d) => (bridgeLog += d));
    proc.on("exit", (code, sig) => {
      if (proc && proc.__expectExit !== true) {
        console.log(`  (bridge exited code=${code} sig=${sig})`);
      }
      proc = null;
    });
    const t0 = Date.now();
    (async function poll() {
      while (Date.now() - t0 < 8000) {
        try {
          const r = await fetch(`${BASE}/healthz`);
          if (r.ok) return resolve();
        } catch {
          /* not up yet */
        }
        await sleep(120);
      }
      reject(new Error("bridge did not become healthy in 8s\n" + bridgeLog));
    })();
  });
}

async function stopBridge() {
  if (!proc) return;
  const p = proc;
  p.__expectExit = true;
  p.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* */ }
      r();
    }, 3000);
    p.on("exit", () => { clearTimeout(t); r(); });
  });
  proc = null;
}

async function connectFake(script = null) {
  const fake = new FakeExtension({ url: WS, ext: "e2e-fake" });
  fake.turnScript = script;
  await fake.connect();
  return fake;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// scenarios
// ===========================================================================

async function main() {
  if (!existsSync(BRIDGE)) {
    console.error("dist/src/index.js missing — run `npm run build` first.");
    process.exit(2);
  }
  dbPath = join(mkdtempSync(join(tmpdir(), "tab-bridge-e2e-")), "sessions.jsonl");
  console.log(`\ntab-bridge E2E — port ${PORT}, db ${dbPath}\n`);

  let fake = null;
  await startBridge(dbPath);

  // -- S01 ------------------------------------------------------------------
  await scenario("S01 healthz before any worker (no worker, 0 sessions)", async () => {
    const r = await req("GET", "/healthz");
    eq(r.status, 200, "GET /healthz -> 200");
    eq(r.json.worker.connected, false, "no extension connected yet");
    eq(r.json.sessions, 0, "zero sessions");
    eq(r.json.stateful, true, "stateful mode (ADR-6 default)");
  });

  // -- S02 ------------------------------------------------------------------
  await scenario("S02 extension handshake over real WebSocket -> HELLO_OK", async () => {
    fake = await connectFake();
    ok(fake.helloOk, "HELLO_OK received");
    ok(typeof fake.helloOk.config?.autoCreateTabs === "boolean", "config.autoCreateTabs present");
    ok(Array.isArray(fake.helloOk.config?.warmTabs !== undefined ? [1] : []), "config shape ok");
    const h = await req("GET", "/healthz");
    eq(h.json.worker.ext, "e2e-fake", "healthz reports worker ext");
    eq(h.json.worker.connected, true, "worker connected");
  });

  // -- S03 ------------------------------------------------------------------
  await scenario("S03 GET /v1/models lists the two web models", async () => {
    const r = await req("GET", "/v1/models");
    eq(r.status, 200, "200 OK");
    const ids = r.json.data.map((m) => m.id).sort();
    eq(JSON.stringify(ids), JSON.stringify(["deepseek-web-chat", "deepseek-web-think"]), "model ids");
  });

  // -- S04 ------------------------------------------------------------------
  await scenario("S04 request validation: 404 unknown model, 400s for bad shapes", async () => {
    const unknown = await req("POST", "/v1/chat/completions", {
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    eq(unknown.status, 404, "unknown model -> 404");
    const n2 = await req("POST", "/v1/chat/completions", {
      body: { model: "deepseek-web-chat", messages: [{ role: "user", content: "hi" }], n: 2 },
    });
    eq(n2.status, 400, "n=2 -> 400 (a tab cannot branch)");
    const empty = await req("POST", "/v1/chat/completions", {
      body: { model: "deepseek-web-chat", messages: [] },
    });
    eq(empty.status, 400, "empty messages -> 400");
    const bad = await req("POST", "/v1/chat/completions", {
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    eq(bad.status, 400, "malformed JSON body -> 400");
    const nf = await req("DELETE", "/v1/sessions/does-not-exist");
    eq(nf.status, 404, "DELETE unknown session -> 404");
  });

  // -- S05 ------------------------------------------------------------------
  await scenario("S05 SEED turn (non-stream): full prompt compiled, usage synthesized", async () => {
    fake.turnScript = () => say("Hello from the fake DeepSeek tab.");
    const r = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-a" },
      body: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: USER1 },
        ],
        temperature: 0.7, // ignored params must be surfaced, not silently dropped
      },
    });
    eq(r.status, 200, "chat completion -> 200");
    eq(r.headers.get("x-bridge-ignored"), "temperature", "X-Bridge-Ignored header");
    const turn = await fake.waitForTurn((t) => t.text.includes(USER1));
    ok(turn.text.includes("=== TOOL PROTOCOL (tool-protocol: 1)"), "prompt has tool protocol block");
    ok(turn.text.includes("(no tools declared; answer in plain text)"), "no-tools note present");
    ok(turn.text.includes("=== TRANSCRIPT ==="), "prompt has transcript");
    ok(turn.text.includes(`### SYSTEM\n${SYS}`), "system message rendered");
    ok(turn.text.includes(`### USER\n${USER1}`), "user message rendered");
    ok(turn.text.includes("=== ASSISTANT CUE ==="), "assistant cue present");
    eq(r.json.choices[0].finish_reason, "stop", "finish_reason stop");
    eq(r.json.choices[0].message.content, "Hello from the fake DeepSeek tab.", "content streamed back");
    eq(r.json.usage.prompt_tokens, Math.ceil(turn.text.length / 4), "prompt tokens = chars/4");
    eq(
      r.json.usage.completion_tokens,
      Math.ceil("Hello from the fake DeepSeek tab.".length / 4),
      "completion tokens = chars/4"
    );
    const s = await req("GET", "/v1/sessions/e2e-a");
    eq(s.status, 200, "session visible via GET /v1/sessions/:id");
    eq(s.json.chain_length, 2, "chain = system + user");
  });

  // -- S06 ------------------------------------------------------------------
  await scenario("S06 second turn = INJECT_TEXT delta (echo-skip), no reset", async () => {
    const USER2 = "and in Berlin?";
    fake.turnScript = () => say("Berlin: 18C, cloudy.");
    const r = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-a" },
      body: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: USER1 },
          { role: "assistant", content: "Hello from the fake DeepSeek tab." },
          { role: "user", content: USER2 },
        ],
      },
    });
    eq(r.status, 200, "delta turn -> 200");
    const turn = await fake.waitForTurn((t) => t.text === USER2);
    eq(turn.text, USER2, "prompt is ONLY the new user text (echo skipped)");
    eq(fake.resets, 0, "no RESET intent (chain continuation, tab untouched)");
    const s = await req("GET", "/v1/sessions/e2e-a");
    eq(s.json.chain_length, 4, "chain grew to 4");
    eq(s.json.turns, 2, "two turns committed");
  });

  // -- S07 ------------------------------------------------------------------
  await scenario("S07 streaming SSE: role -> content deltas -> usage -> finish -> [DONE]", async () => {
    const text = "streamed answer part one, part two.";
    fake.turnScript = () => [
      { t: "STATUS", code: "submitting" },
      { t: "FRAGMENT", seq: 0, text: text.slice(0, 15) },
      { t: "FRAGMENT", seq: 1, text: text.slice(15) },
      { t: "STATUS", code: "done" },
    ];
    const s = await sseChat({
      model: "deepseek-web-chat",
      stream: true,
      messages: [{ role: "user", content: "hi streaming" }],
    }, { "x-session-id": "e2e-b" });
    eq(s.status, 200, "SSE stream -> 200");
    ok(s.frames.length >= 5, `got ${s.frames.length} frames`);
    eq(s.frames[0].choices[0].delta.role, "assistant", "first frame carries role");
    const content = s.frames
      .filter((f) => f !== "[DONE]" && f.choices?.[0]?.delta?.content)
      .map((f) => f.choices[0].delta.content)
      .join("");
    eq(content, text, "content deltas reassemble exactly");
    const finishFrame = s.frames.find((f) => f !== "[DONE]" && f.choices?.[0]?.finish_reason !== null && f.choices?.[0]?.finish_reason !== undefined);
    eq(finishFrame.choices[0].finish_reason, "stop", "finish_reason frame present");
    const usageFrame = s.frames.find((f) => f !== "[DONE]" && Array.isArray(f.choices) && f.choices.length === 0 && f.usage);
    ok(usageFrame?.usage?.total_tokens > 0, "usage chunk with empty choices");
    eq(s.frames[s.frames.length - 1], "[DONE]", "stream terminates with [DONE]");
  });

  // -- S08 ------------------------------------------------------------------
  await scenario("S08 tool round-trip: fenced call -> tool_calls -> INJECT_RESULTS", async () => {
    let n = 0;
    fake.turnScript = () => (n++ === 0 ? say(fence("get_weather", { city: "Paris" })) : say("Paris is 22C and sunny."));
    const r1 = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-c" },
      body: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: USER1 },
        ],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "current weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        }],
      },
    });
    eq(r1.status, 200, "tool turn -> 200");
    eq(r1.json.choices[0].finish_reason, "tool_calls", "finish_reason tool_calls");
    const call = r1.json.choices[0].message.tool_calls?.[0];
    ok(call, "tool_calls present");
    ok(call.id.startsWith("call_"), `synthetic id (${call.id})`);
    eq(call.function.name, "get_weather", "tool name");
    eq(call.function.arguments, '{"city":"Paris"}', "canonical arguments JSON");

    // kod-style continuation: assistant echo + tool result
    const r2 = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-c" },
      body: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: USER1 },
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: "22C sunny" },
        ],
        tools: [{
          type: "function",
          function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
        }],
      },
    });
    eq(r2.status, 200, "tool-result turn -> 200");
    const turn = await fake.waitForTurn((t) => t.text.includes("=== TOOL RESULTS ==="));
    ok(turn.text.includes(`### TOOL#${call.id}`), "tool result rendered with call id");
    ok(turn.text.includes("22C sunny"), "tool payload present");
    eq(fake.resets, 0, "INJECT_RESULTS fast path: no reset");
    eq(r2.json.choices[0].message.content, "Paris is 22C and sunny.", "final answer");
    eq(r2.json.choices[0].finish_reason, "stop", "finish stop");
  });

  // -- S09 ------------------------------------------------------------------
  await scenario("S09 same-session overlap -> 409 session_busy (never queued)", async () => {
    const held = {};
    fake.turnScript = (text, reqId) => new Promise((resolve) => {
      held[reqId] = resolve;
    });
    const first = req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-d" },
      body: { model: "deepseek-web-chat", messages: [{ role: "user", content: "slow one" }] },
    });
    await sleep(350); // let turn 1 take the mutex
    const second = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-d" },
      body: { model: "deepseek-web-chat", messages: [{ role: "user", content: "overlapping" }] },
    });
    eq(second.status, 409, "overlapping request -> 409");
    eq(second.json.error.code, "session_busy", "code session_busy");
    // release the held turn; it completes normally
    const key = Object.keys(held)[0];
    held[key]([{ t: "STATUS", code: "done" }]);
    const f1 = await first;
    eq(f1.status, 200, "first turn still completes 200 after release");
  });

  // -- S10 ------------------------------------------------------------------
  await scenario("S10 provider rate limit -> 429 + Retry-After 1200 -> next turn reseeds", async () => {
    let n = 0;
    fake.turnScript = () => {
      n += 1;
      if (n === 1) return [{ t: "ERROR", code: "rate_limited", detail: "Messages too frequent. Try again later.", retryAfterSec: 1200 }];
      return say("recovered after cooldown");
    };
    const r1 = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-e" },
      body: { model: "deepseek-web-chat", messages: [{ role: "user", content: USER1 }] },
    });
    eq(r1.status, 429, "rate_limited ERROR -> 429");
    eq(r1.headers.get("retry-after"), "1200", "Retry-After: 1200 (~20 min)");
    eq(r1.json.error.code, "rate_limited", "error code rate_limited");
    // retry: pendingReset forces RESET + full reseed so the orphan prompt is wiped
    const before = fake.resets;
    const r2 = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-e" },
      body: { model: "deepseek-web-chat", messages: [{ role: "user", content: USER1 }] },
    });
    eq(r2.status, 200, "retry after rate limit -> 200");
    eq(fake.resets, before + 1, "RESET intent issued before reseed");
    const turn = fake.turns[fake.turns.length - 1];
    ok(turn.text.includes("=== TOOL PROTOCOL"), "reseed prompt is a full SEED");
    ok(turn.text.includes(`### USER\n${USER1}`), "full transcript resent");
  });

  // -- S11 ------------------------------------------------------------------
  await scenario("S10b send-button-disabled ERROR -> actionable 502 (paste-to-file path)", async () => {
    fake.turnScript = () => [{ t: "ERROR", code: "send-button-disabled", detail: "composer never enabled" }];
    const r = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-sendbtn" },
      body: { model: "deepseek-web-chat", messages: [{ role: "user", content: "big paste test" }] },
    });
    eq(r.status, 502, "send-button-disabled -> 502 upstream_failure");
    ok(
      r.json.error.message.includes("send button"),
      "message explains the send-button/paste-to-file cause"
    );
  });

  // -- S11 ------------------------------------------------------------------
  await scenario("S11 worker link down -> 503 pool_exhausted; reconnect recovers", async () => {
    fake.close();
    await sleep(150);
    const r = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-no-worker" },
      body: { model: "deepseek-web-chat", messages: [{ role: "user", content: "anyone there?" }] },
    });
    eq(r.status, 503, "no worker -> 503");
    eq(r.json.error.code, "pool_exhausted", "code pool_exhausted");
    eq(r.headers.get("retry-after"), "5", "Retry-After 5s hint");
    fake = await connectFake();
    const h = await req("GET", "/healthz");
    eq(h.json.worker.connected, true, "reconnected");
  });

  // -- S12 ------------------------------------------------------------------
  await scenario("S12 link lost mid-stream -> 502 after turn deadline (failure drill)", async () => {
    fake.turnScript = () => new Promise(() => { /* never completes */ });
    const t0 = Date.now();
    const r = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-f" },
      body: { model: "deepseek-web-chat", messages: [{ role: "user", content: "die mid-turn" }] },
    });
    const dt = Date.now() - t0;
    eq(r.status, 502, "mid-turn worker death -> 502 upstream_failure");
    ok(dt >= TURN_MS - 500, `turn deadline respected (${dt}ms >= ${TURN_MS}ms)`);
    fake = await connectFake(); // fresh worker for the remaining scenarios
  });

  // -- S13 ------------------------------------------------------------------
  await scenario("S13 persistence: bridge restart keeps chains (echo-skip after reboot)", async () => {
    const USER3 = "and in Rome?";
    await stopBridge();
    await startBridge(dbPath); // same journal
    fake = await connectFake(() => say("Rome: 27C, clear."));
    const list = await req("GET", "/v1/sessions");
    const row = list.json.data.find((s) => s.session_id === "e2e-a");
    ok(row, "session e2e-a survived the restart");
    eq(row.chain_length, 4, "chain restored (4 messages)");
    const r = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-a" },
      body: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: USER1 },
          { role: "assistant", content: "Hello from the fake DeepSeek tab." },
          { role: "user", content: "and in Berlin?" },
          { role: "assistant", content: "Berlin: 18C, cloudy." },
          { role: "user", content: USER3 },
        ],
      },
    });
    eq(r.status, 200, "turn after restart -> 200");
    const turn = await fake.waitForTurn((t) => t.text === USER3);
    eq(turn.text, USER3, "delta-only prompt after restart (tabHash survived)");
    eq(fake.resets, 0, "no reset needed: journal replay restored full state");
    eq(r.json.choices[0].message.content, "Rome: 27C, clear.", "content correct");
  });

  // -- S14 ------------------------------------------------------------------
  await scenario("S14 DELETE session -> next turn is a full SEED (no reset of empty chain)", async () => {
    const d = await req("DELETE", "/v1/sessions/e2e-a");
    eq(d.status, 204, "DELETE -> 204");
    const gone = await req("GET", "/v1/sessions/e2e-a");
    eq(gone.status, 404, "session gone");
    fake.turnScript = () => say("fresh seed answer");
    const r = await req("POST", "/v1/chat/completions", {
      headers: { "x-session-id": "e2e-a" },
      body: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: "brand new conversation" },
        ],
      },
    });
    eq(r.status, 200, "turn after delete -> 200");
    const turn = await fake.waitForTurn((t) => t.text.includes("brand new conversation"));
    ok(turn.text.includes("=== TOOL PROTOCOL"), "full SEED prompt after delete");
    eq(fake.resets, 0, "no RESET: empty chain seeds without resetting the tab");
  });

  // ---- summary --------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${"=".repeat(64)}`);
  console.log(`  ${passed}/${results.length} scenarios passed${failed ? `  —  ${failed} FAILED` : "  —  ALL GREEN"}`);
  console.log(`${"=".repeat(64)}`);
  if (failed && (VERBOSE || args.includes("--print-log"))) {
    console.log("\n---- bridge log tail ----\n" + bridgeLog.split("\n").slice(-60).join("\n"));
  }
  return failed;
}

main()
  .then(async (failed) => {
    await stopBridge();
    if (!KEEP && dbPath && existsSync(dbPath)) {
      try { rmSync(dirname(dbPath), { recursive: true, force: true }); } catch { /* */ }
    }
    process.exit(failed ? 1 : 0);
  })
  .catch(async (e) => {
    console.error("e2e harness error:", e);
    console.error(bridgeLog.split("\n").slice(-40).join("\n"));
    await stopBridge();
    process.exit(2);
  });
