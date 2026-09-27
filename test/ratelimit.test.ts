// Rate-limit & failed-turn recovery tests (DeepSeek "Messages too frequent").
// Covers: ADR-7 mapping (429 + Retry-After ~20 min), pendingReset reseed
// (the tab keeps an orphan user message after accept-then-error), and the
// registry bookkeeping that survives restarts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mapTurnError, RATE_LIMIT_COOLDOWN_SEC } from "../src/facade/errors.js";
import { classify, messageHash, type ClassifierRow } from "../src/core/classifier.js";
import { SessionRegistry } from "../src/core/registry.js";
import { foldAll } from "../src/core/hashchain.js";
import { TabBridge } from "../src/bridge.js";
import { createHttpServer } from "../src/facade/http.js";
import { ScriptedAdapter } from "../src/adapter/scripted.js";
import type { Config } from "../src/config.js";
import type { ChatMessage } from "../src/core/canonical.js";

// ---------------------------------------------------------------------------
// error taxonomy mapping (ADR-7)
// ---------------------------------------------------------------------------

describe("mapTurnError: rate limits map to 429 with a ~20 min Retry-After", () => {
  test("worker-reported rate_limited -> 429 / rate_limited / 1200s", () => {
    const be = mapTurnError(new Error("turn-error:rate_limited:Messages too frequent. Try again later."));
    assert.equal(be.status, 429);
    assert.equal(be.code, "rate_limited");
    assert.equal(be.retryAfter, RATE_LIMIT_COOLDOWN_SEC);
    assert.equal(be.retryAfter, 1200);
  });

  test("ensureReady health rate_limited -> 429 / 1200s", () => {
    const be = mapTurnError(new Error("provider-rate-limited"));
    assert.equal(be.status, 429);
    assert.equal(be.retryAfter, 1200);
  });

  test("all tabs cooling down at bind -> 429 / 1200s", () => {
    const be = mapTurnError(new Error("bind-failed:rate-limited-cooldown"));
    assert.equal(be.status, 429);
    assert.equal(be.retryAfter, 1200);
  });

  test("send button never enabled -> 502 with actionable detail", () => {
    const be = mapTurnError(new Error("turn-error:send-button-disabled:waited 90000ms"));
    assert.equal(be.status, 502);
    assert.equal(be.code, "upstream_failure");
    assert.match(be.message, /send button|composer/i);
  });

  test("cf challenge stays a short 30s cooldown (challenge passes quickly)", () => {
    const be = mapTurnError(new Error("cf-challenge"));
    assert.equal(be.status, 429);
    assert.equal(be.retryAfter, 30);
  });
});

// ---------------------------------------------------------------------------
// classifier: pendingReset forces reseed
// ---------------------------------------------------------------------------

function row(partial: Partial<ClassifierRow> & { chain?: string[] }): ClassifierRow {
  return {
    hasRow: true,
    scheme: 1,
    mode: "stateful",
    chain: partial.chain ?? [],
    tabHash: partial.tabHash ?? null,
    ...(partial.hasRow !== undefined ? { hasRow: partial.hasRow } : {}),
    ...(partial.scheme !== undefined ? { scheme: partial.scheme } : {}),
    ...(partial.mode !== undefined ? { mode: partial.mode } : {}),
    ...(partial.tabHash !== undefined ? { tabHash: partial.tabHash } : {}),
    ...(partial.pendingReset !== undefined ? { pendingReset: partial.pendingReset } : {}),
  };
}

const S: ChatMessage = { role: "system", content: "sys" };
const U1: ChatMessage = { role: "user", content: "u1" };
const U2: ChatMessage = { role: "user", content: "u2" };

describe("classifier: pendingReset (orphan user message in tab)", () => {
  test("inject plan is overridden with RESET_RESEED", () => {
    const chain = foldAll([S, U1]);
    const base = classify(row({ chain }), [S, U1, U2]);
    assert.equal(base.plan, "INJECT_TEXT");
    const p = classify(row({ chain, pendingReset: true }), [S, U1, U2]);
    assert.equal(p.plan, "RESET_RESEED");
    assert.match(p.reason, /pending-reset/);
  });

  test("tool-round delta is also overridden", () => {
    const hist: ChatMessage[] = [S, U1];
    const chain = foldAll(hist);
    const callMsg: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }],
    };
    const toolMsg: ChatMessage = { role: "tool", tool_call_id: "c1", content: "out" };
    const tabHash = messageHash(callMsg);
    const base = classify(row({ chain, tabHash }), [S, U1, callMsg, toolMsg]);
    assert.equal(base.plan, "INJECT_RESULTS");
    const p = classify(row({ chain, tabHash, pendingReset: true }), [S, U1, callMsg, toolMsg]);
    assert.equal(p.plan, "RESET_RESEED");
    assert.match(p.reason, /pending-reset/);
  });

  test("empty chain stays SEED (engine performs the reset)", () => {
    const p = classify(row({ chain: [], pendingReset: true }), [S, U1]);
    assert.equal(p.plan, "SEED");
  });

  test("no pendingReset -> plans unchanged", () => {
    const chain = foldAll([S, U1]);
    assert.equal(classify(row({ chain }), [S, U1, U2]).plan, "INJECT_TEXT");
  });
});

// ---------------------------------------------------------------------------
// registry: markFailed persists, commit clears
// ---------------------------------------------------------------------------

describe("registry: failed-turn bookkeeping", () => {
  test("markFailed sets pendingReset and persists it; commit clears it", () => {
    const persisted: string[] = [];
    const reg = new SessionRegistry({
      mode: "stateful",
      ttlMs: 30 * 60_000,
      sweepIntervalMs: 3_600_000,
      persist: { append: (r) => persisted.push(JSON.stringify(r)) },
    });
    const r1 = reg.getOrCreate("s1");
    reg.markFailed(r1);
    assert.equal(r1.pendingReset, true);
    // persisted row carries the flag (restart-safe)
    const last = JSON.parse(persisted[persisted.length - 1]) as { pendingReset?: boolean };
    assert.equal(last.pendingReset, true);

    reg.commit(r1, ["h1"], null);
    assert.equal(r1.pendingReset, false);
    const last2 = JSON.parse(persisted[persisted.length - 1]) as { pendingReset?: boolean };
    assert.ok(!last2.pendingReset);
    reg.dispose();
  });
});

// ---------------------------------------------------------------------------
// contract: 429 over HTTP, then a clean reseed on the retry
// ---------------------------------------------------------------------------

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
    ...over,
  };
}

const RATE_LIMIT_TEXT = "Messages too frequent. Try again later.";

describe("contract: rate-limited turn -> 429 -> next request reseeds", () => {
  let dir: string;
  let adapter: ScriptedAdapter;
  let bridge: TabBridge;
  let server: Server;
  let base: string;

  test("setup", async () => {
    dir = mkdtempSync(join(tmpdir(), "tabbridge-rl-"));
    adapter = new ScriptedAdapter({ maxPromptChars: 4000 });
    bridge = new TabBridge(baseConfig(join(dir, "sessions.json")), adapter);
    server = createHttpServer({ bridge });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  test("turn 1 seeds normally", async () => {
    adapter.push({ text: "hello from the tab" });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "rl-session" },
      body: JSON.stringify({ model: "deepseek-web-chat", messages: [S, U1] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0].message.content, "hello from the tab");
    assert.equal(adapter.resetCount, 0);
  });

  test("turn 2 hits the provider rate limit -> HTTP 429 + retry-after 1200", async () => {
    adapter.push({ text: "", failText: `turn-error:rate_limited:${RATE_LIMIT_TEXT}` });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "rl-session" },
      body: JSON.stringify({ model: "deepseek-web-chat", messages: [S, U1, U2] }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "1200");
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "rate_limited");
    assert.match(body.error.message, /rate limit/i);
  });

  test("retrying the same request reseeds the tab (orphan message cleaned)", async () => {
    adapter.push({ text: "recovered" });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "rl-session" },
      body: JSON.stringify({ model: "deepseek-web-chat", messages: [S, U1, U2] }),
    });
    assert.equal(res.status, 200);
    // the INJECT plan was replaced by a full reset + reseed
    assert.equal(adapter.resetCount, 1);
    assert.equal(adapter.sentTexts.length, 3);
    const reseed = adapter.sentTexts[2];
    assert.ok(reseed.includes("u1"), "reseed must replay the full transcript");
    assert.ok(reseed.includes("u2"), "reseed must replay the full transcript");
  });

  test("streaming rate limit before the first frame -> clean 429, never an empty 200", async () => {
    adapter.push({ text: "", failText: `turn-error:rate_limited:${RATE_LIMIT_TEXT}` });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "rl-session" },
      body: JSON.stringify({ model: "deepseek-web-chat", messages: [S, U1, U2], stream: true }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "1200");
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "rate_limited");
  });

  test("teardown", () => {
    bridge.dispose();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
