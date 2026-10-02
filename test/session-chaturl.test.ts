/**
 * Session↔chat-URL mapping: the injector captures DeepSeek's per-chat URL
 * (`/a/chat/s/<uuid>`, assigned after the first message), the worker forwards
 * it via USAGE meta, the bridge persists it on the session row, and the next
 * BIND for an evicted session carries it as a relaunch hint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SessionRegistry, isChatUrl } from "../src/core/registry.js";
import { WorkerPool } from "../src/pool/pool.js";
import { ScriptedAdapter } from "../src/adapter/scripted.js";
import { runTurn } from "../src/engine.js";

const CHAT = "https://chat.deepseek.com/a/chat/s/9aeab435-7179-4015-a332-8616617e64b9";

function freshRegistry(append?: (row: never) => void): SessionRegistry {
  return new SessionRegistry({
    mode: "stateful",
    ttlMs: 30 * 60_000,
    sweepIntervalMs: 0,
    ...(append ? { persist: { append: append as never } } : {}),
  });
}

test("isChatUrl accepts provider chat URLs and rejects home/other origins", () => {
  assert.equal(isChatUrl(CHAT), true);
  assert.equal(isChatUrl("https://chat.deepseek.com/"), false);
  assert.equal(isChatUrl("https://evil.com/a/chat/s/9aeab435-7179-4015-a332-8616617e64b9"), false);
  assert.equal(isChatUrl(null), false);
  assert.equal(isChatUrl(42), false);
});

test("noteChatUrl stores valid URLs, persists, and rejects junk", () => {
  const appended: string[] = [];
  const registry = freshRegistry((row) => {
    appended.push((row as { sessionId: string }).sessionId);
  });
  const row = registry.getOrCreate("s-url");
  assert.equal(registry.noteChatUrl(row, CHAT), true);
  assert.equal(row.chatUrl, CHAT);
  assert.ok(appended.includes("s-url"));
  // Idempotent: same URL is a no-op (no extra journal line).
  assert.equal(registry.noteChatUrl(row, CHAT), false);
  // Junk never stored.
  assert.equal(registry.noteChatUrl(row, "https://evil.com/x"), false);
  assert.equal(row.chatUrl, CHAT);
  // Ephemeral rows never persist.
  const eph = registry.getOrCreate("anon-x", true);
  assert.equal(registry.noteChatUrl(eph, CHAT), true);
  assert.equal(eph.chatUrl, CHAT);
  registry.dispose();
});

test("restore keeps valid chatUrls and clears invalid ones", () => {
  const registry = freshRegistry();
  registry.restore({
    sessionId: "s-good",
    tabId: null,
    chain: [],
    tabHash: null,
    turns: 1,
    state: "active",
    mode: "stateful",
    scheme: 3,
    createdAt: 1,
    lastUsed: 1,
    chatUrl: CHAT,
  });
  registry.restore({
    sessionId: "s-bad",
    tabId: null,
    chain: [],
    tabHash: null,
    turns: 1,
    state: "active",
    mode: "stateful",
    scheme: 3,
    createdAt: 1,
    lastUsed: 1,
    chatUrl: "https://evil.com/a/chat/s/abc",
  });
  assert.equal(registry.get("s-good")?.chatUrl, CHAT);
  assert.equal(registry.get("s-bad")?.chatUrl, null);
  registry.dispose();
});

test("pool.bind forwards the chatUrl hint in the BIND intent", async () => {
  const pool = new WorkerPool({ autoCreateTabs: true, managedOnly: true, warmTabs: 0 });
  const seen: Array<Record<string, unknown>> = [];
  const conn = new EventEmitter() as EventEmitter & {
    isOpen: boolean;
    sendText(t: string): void;
    close(): void;
  };
  conn.isOpen = true;
  conn.sendText = (text: string) => {
    const m = JSON.parse(text) as Record<string, unknown>;
    seen.push(m);
    if (m.t === "BIND") {
      setImmediate(() =>
        conn.emit("message", JSON.stringify({ t: "BOUND", sessionId: m.sessionId, tabId: 9, state: "ready" }))
      );
    }
  };
  conn.close = () => {
    conn.isOpen = false;
  };
  pool.attach(conn as never);
  const bound = await pool.bind("s-hint", 5000, { chatUrl: CHAT });
  assert.equal(bound.tabId, 9);
  const bind = seen.find((m) => m.t === "BIND");
  assert.equal(bind?.["chatUrl"], CHAT);
  // Without a hint the field is absent (old workers ignore unknown fields anyway).
  seen.length = 0;
  await pool.bind("s-plain", 5000);
  assert.equal(seen.find((m) => m.t === "BIND")?.["chatUrl"], undefined);
  pool.detach("test-done");
});

test("engine saves chat_url from usageMeta and passes it as the rebind hint", async () => {
  const registry = freshRegistry();
  const row = registry.getOrCreate("s-engine");
  const adapter = new ScriptedAdapter({
    replies: [{ text: "hello back", usageMeta: { chat_url: CHAT } }, { text: "again" }],
  });
  const hints: Array<{ chatUrl?: string | null } | undefined> = [];
  const bindTab = async (_sid: string, _ms: number, opts?: { chatUrl?: string | null }) => {
    hints.push(opts);
    return 21;
  };
  await runTurn({
    messages: [{ role: "user", content: "first message here" }],
    tools: [],
    think: false,
    row,
    registry,
    adapter,
    repairRounds: 0,
    turnTimeoutMs: 5000,
    bindTimeoutMs: 2000,
    bindTab,
  });
  assert.equal(row.chatUrl, CHAT);
  // Simulate post-eviction relaunch: tab released, chain kept.
  row.tabId = null;
  await runTurn({
    messages: [
      { role: "user", content: "first message here" },
      { role: "assistant", content: "hello back" },
      { role: "user", content: "second message here" },
    ],
    tools: [],
    think: false,
    row,
    registry,
    adapter,
    repairRounds: 0,
    turnTimeoutMs: 5000,
    bindTimeoutMs: 2000,
    bindTab,
  });
  assert.equal(hints[1]?.chatUrl, CHAT);
  registry.dispose();
});

test("injector captures location.href on TURN_DONE via currentChatUrl", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../../extension/injector.js"), "utf8");
  assert.match(src, /function currentChatUrl\(\)/);
  assert.match(src, /chat\.deepseek\.com/);
  assert.match(src, /a\/chat\/s|a\\\/chat\\\/s/);
});
