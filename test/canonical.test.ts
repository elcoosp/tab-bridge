import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonical,
  rewriteLegacyAssistant,
  normalizeMessages,
  textOf,
  type ChatMessage,
} from "../src/core/canonical.js";

test("canonical forms for each role", () => {
  assert.equal(canonical({ role: "system", content: "be brief" }), "S|be brief");
  assert.equal(canonical({ role: "user", content: "hello" }), "U|hello");
  assert.equal(canonical({ role: "assistant", content: "hi there" }), "A|hi there");
  assert.equal(canonical({ role: "tool", content: "out", tool_call_id: "call_1" }), "T#call_1|out");
  assert.equal(canonical({ role: "tool", content: "out" }), "T#-|out");
});

test("assistant with tool_calls renders wire-independently", () => {
  const m: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_ab",
        type: "function",
        function: { name: "ls", arguments: '{"b":2,"a":1}' },
      },
    ],
  };
  // args are canonically sorted: position-independent and deterministic
  assert.equal(canonical(m), 'A|=> call ls({"a":1,"b":2})#call_ab');
});

test("array content joins text parts with newline", () => {
  const m: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ],
  };
  assert.equal(canonical(m), "U|one\ntwo");
  assert.equal(textOf(m.content), "one\ntwo");
});

test("legacy [tool_call] assistant text is rewritten to native calls", () => {
  const raw: ChatMessage = {
    role: "assistant",
    content: '[tool_call id=abc name=execute_command] {"cmd":"ls -la"}',
  };
  const fixed = rewriteLegacyAssistant(raw);
  assert.equal(fixed.tool_calls?.length, 1);
  assert.equal(fixed.tool_calls?.[0].id, "abc");
  assert.equal(fixed.tool_calls?.[0].function.name, "execute_command");
  assert.ok(fixed.tool_calls?.[0].function.arguments.includes('"cmd"'));
});

test("legacy rewrite: text outside blocks is preserved as content", () => {
  const raw: ChatMessage = {
    role: "assistant",
    content: 'Let me check.\n[tool_call id=x name=ls] {}\nDone proposing.',
  };
  const fixed = rewriteLegacyAssistant(raw);
  assert.equal(fixed.tool_calls?.length, 1);
  assert.ok((fixed.content as string).includes("Let me check."));
  assert.ok((fixed.content as string).includes("Done proposing."));
});

test("normalizeMessages leaves plain messages untouched", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const out = normalizeMessages(msgs);
  assert.equal(out[0], msgs[0]);
  assert.equal(out[1], msgs[1]);
});

test("normalizeMessages rewrites legacy inside a history", () => {
  const out = normalizeMessages([
    { role: "user", content: "run ls" },
    { role: "assistant", content: "[tool_call id=n1 name=ls] {}" },
    { role: "tool", content: "file.txt", tool_call_id: "n1" },
  ]);
  assert.equal(out[1].tool_calls?.length, 1);
  assert.equal(out[2].role, "tool");
});
