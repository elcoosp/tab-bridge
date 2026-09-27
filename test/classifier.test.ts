import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, messageHash, type ClassifierRow } from "../src/core/classifier.js";
import { foldAll } from "../src/core/hashchain.js";
import type { ChatMessage } from "../src/core/canonical.js";

function row(partial: Partial<ClassifierRow> & { chain?: string[] }): ClassifierRow {
  return {
    hasRow: true,
    scheme: 1,
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
  assert.equal(classify(row({ scheme: 2, chain: [] }), [S, U1]).plan, "SEED");
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
  const chain = foldAll([S, U1]);
  const p = classify(row({ chain, tabHash: null }), [
    S,
    U1,
    { role: "assistant", content: "ghost" },
    { role: "user", content: "next" },
  ]);
  assert.equal(p.plan, "RESET_RESEED");
  assert.equal(p.reason, "unsupported-delta-shape");
});
