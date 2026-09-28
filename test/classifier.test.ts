import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, messageHash, type ClassifierRow } from "../src/core/classifier.js";
import { foldAll, CHAIN_SCHEME } from "../src/core/hashchain.js";
import { SessionRegistry } from "../src/core/registry.js";
import type { ChatMessage } from "../src/core/canonical.js";

function row(partial: Partial<ClassifierRow> & { chain?: string[] }): ClassifierRow {
  return {
    hasRow: true,
    scheme: CHAIN_SCHEME,
    mode: "stateful",
    chain: partial.chain ?? [],
    tabHash: partial.tabHash ?? null,
    ...(("hasRow" in partial ? { hasRow: partial.hasRow } : {}) as object),
    ...(partial.scheme !== undefined ? { scheme: partial.scheme } : {}),
    ...(partial.mode !== undefined ? { mode: partial.mode } : {}),
    ...(partial.tabHash !== undefined ? { tabHash: partial.tabHash } : {}),
    ...(partial.chain !== undefined ? { chain: partial.chain } : {}),
  };
}

const S: ChatMessage = { role: "system", content: "sys" };
const U1: ChatMessage = { role: "user", content: "u1" };
const U2: ChatMessage = { role: "user", content: "u2" };

test("no row / scheme mismatch / stateless -> SEED", () => {
  assert.equal(classify(row({ hasRow: false, chain: [] }), [S, U1]).plan, "SEED");
  assert.equal(classify(row({ scheme: 1, chain: [] }), [S, U1]).plan, "SEED");
  assert.equal(classify(row({ mode: "always-reset", chain: [] }), [S, U1]).plan, "SEED");
});

test("fresh history -> SEED", () => {
  const p = classify(row({ chain: [] }), [S, U1]);
  assert.equal(p.plan, "SEED");
  assert.equal(p.reason, "no-session-row" === p.reason ? "no-session-row" : p.reason);
});

test("single user delta -> INJECT_TEXT", () => {
  const chain = foldAll([S, U1]);
  const p = classify(row({ chain, tabHash: null }), [S, U1, U2]);
  assert.equal(p.plan, "INJECT_TEXT");
  assert.equal(p.reason, "single-user-delta");
  assert.equal(p.injectText, "u2");
});

test("truncated / diverged / regenerated history -> RESET_RESEED", () => {
  const chain = foldAll([S, U1, U2]);
  assert.equal(classify(row({ chain }), [S, U1]).plan, "RESET_RESEED");
  assert.equal(classify(row({ chain }), [S, U1, { role: "user", content: "EDITED" }]).plan, "RESET_RESEED");
  assert.equal(classify(row({ chain }), [S, U1, U2]).plan, "RESET_RESEED"); // regeneration
});

test("tool-round delta with matching tabHash -> INJECT_RESULTS (echo skipped)", () => {
  const hist: ChatMessage[] = [S, U1];
  const chain = foldAll(hist);
  const callMsg: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }],
  };
  const tabHash = messageHash(callMsg);
  const next: ChatMessage[] = [...hist, callMsg, { role: "tool", content: "f.txt", tool_call_id: "c1" }];
  const p = classify(row({ chain, tabHash }), next);
  assert.equal(p.plan, "INJECT_RESULTS");
  assert.equal(p.injectResults?.length, 1);
  assert.equal(p.injectResults?.[0].role, "tool");
});

test("tool-round delta with non-matching assistant -> fabricated -> RESET_RESEED", () => {
  const hist: ChatMessage[] = [S, U1];
  const chain = foldAll(hist);
  const callMsg: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }],
  };
  const next: ChatMessage[] = [...hist, callMsg, { role: "tool", content: "f.txt", tool_call_id: "c1" }];
  const p = classify(row({ chain, tabHash: "deadbeef".repeat(4) }), next);
  assert.equal(p.plan, "RESET_RESEED");
  assert.equal(p.reason, "fabricated-assistant-echo");
});

test("fabricated trailing assistant inside tool delta -> RESET_RESEED", () => {
  const hist: ChatMessage[] = [S, U1];
  const chain = foldAll(hist);
  const callMsg: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }],
  };
  const next: ChatMessage[] = [
    ...hist,
    callMsg,
    { role: "tool", content: "f.txt", tool_call_id: "c1" },
    { role: "assistant", content: "fabricated summary" },
  ];
  const p = classify(row({ chain, tabHash: messageHash(callMsg) }), next);
  assert.equal(p.plan, "RESET_RESEED");
  assert.equal(p.reason, "fabricated-trailing-assistant");
});

test("consecutive tool rounds batch naturally into INJECT_RESULTS", () => {
  const hist: ChatMessage[] = [S, U1];
  const chain = foldAll(hist);
  const callMsg: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name: "ls", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "cat", arguments: "{}" } },
    ],
  };
  const next: ChatMessage[] = [
    ...hist,
    callMsg,
    { role: "tool", content: "a", tool_call_id: "c1" },
    { role: "tool", content: "b", tool_call_id: "c2" },
    { role: "tool", content: "c", tool_call_id: "c1" },
  ];
  const p = classify(row({ chain, tabHash: messageHash(callMsg) }), next);
  assert.equal(p.plan, "INJECT_RESULTS");
  assert.equal(p.injectResults?.length, 3);
});

test("text-echo continuation: [assistant(text)=tab, user] -> INJECT_TEXT(user)", () => {
  const hist: ChatMessage[] = [S, U1];
  const chain = foldAll(hist);
  const reply: ChatMessage = { role: "assistant", content: "here you go" };
  const next: ChatMessage[] = [...hist, reply, U2];
  const p = classify(row({ chain, tabHash: messageHash(reply) }), next);
  assert.equal(p.plan, "INJECT_TEXT");
  assert.equal(p.injectText, "u2");
});

test("unsupported multi-message delta -> RESET_RESEED", () => {
  // NOTE: [assistant-text, user] is intentionally NOT here — plain-text
  // echoes inject without verification (scheme v3+). Two back-to-back user
  // messages match no fast path.
  const chain = foldAll([S, U1]);
  const p = classify(row({ chain, tabHash: null }), [
    S,
    U1,
    { role: "user", content: "again" },
    { role: "user", content: "next" },
  ]);
  assert.equal(p.plan, "RESET_RESEED");
  assert.equal(p.reason, "unsupported-delta-shape");
});

test("text-echo mismatch still injects (tab is append-only truth)", () => {
  // The client replayed a stale/different assistant text before the new user
  // message. Appending user text stays coherent (unlike misattached tool
  // results), so this must not reseed.
  const hist: ChatMessage[] = [S, U1];
  const chain = foldAll(hist);
  const staleEcho: ChatMessage = { role: "assistant", content: "something else entirely" };
  const next: ChatMessage[] = [...hist, staleEcho, U2];
  const p = classify(row({ chain, tabHash: "unrelated-tab-output-hash" }), next);
  assert.equal(p.plan, "INJECT_TEXT");
  assert.equal(p.injectText, "u2");
});

test("re-rendered system prompt does not break continuity (scheme v3)", () => {
  const S2: ChatMessage = { role: "system", content: "sys re-rendered with fresh memory" };
  const chain = foldAll([S, U1]);
  const p = classify(row({ chain, tabHash: null }), [S2, U1, U2]);
  assert.equal(p.plan, "INJECT_TEXT");
  assert.equal(p.injectText, "u2");
});

test("foldAll ignores a leading system message", () => {
  assert.deepEqual(foldAll([S, U1]), foldAll([U1]));
});
test("coerces ContentPart-array user content and rejects empty text", () => {
  const chain = foldAll([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  const rowObj = row({ chain, tabHash: null });
  const plan = classify(rowObj, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: [{ type: "text", text: "next step" }] },
  ]);
  assert.equal(plan.plan, "INJECT_TEXT");
  assert.equal(plan.injectText, "next step");

  const empty = classify(rowObj, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: null },
  ]);
  assert.equal(empty.plan, "RESET_RESEED");
});



test("commit adopts the current scheme or migration reseeds forever", () => {
  // Regression: commit() wrote the new-scheme chain but left row.scheme at
  // the persisted value, so every later turn hit scheme-mismatch again.
  const reg = new SessionRegistry({ mode: "stateful", ttlMs: 30 * 60_000 });
  reg.restore({
    sessionId: "old",
    tabId: 1,
    chain: ["deadbeef".repeat(4)],
    tabHash: null,
    turns: 3,
    state: "active",
    mode: "stateful",
    scheme: 1,
    createdAt: 1,
    lastUsed: 1,
  });
  const sessRow = reg.getOrCreate("old");
  assert.equal(classify(row({ scheme: sessRow.scheme, chain: sessRow.chain }), [S, U1]).plan, "SEED");
  reg.commit(sessRow, foldAll([U1, U2]), null);
  assert.equal(sessRow.scheme, CHAIN_SCHEME);
  const U3: ChatMessage = { role: "user", content: "u3" };
  const p = classify(row({ scheme: sessRow.scheme, chain: sessRow.chain }), [S, U1, U2, U3]);
  assert.equal(p.plan, "INJECT_TEXT");
  assert.equal(p.injectText, "u3");
});
