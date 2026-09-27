import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResponse } from "../src/emulation/parser.js";
import type { ToolSpec } from "../src/emulation/types.js";
import { synthCallId } from "../src/emulation/ids.js";

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, timeout_secs: { type: "number" } },
        required: ["cmd"],
      },
    },
  },
  { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

test("parses a single fenced tool_call; content outside is kept", () => {
  const text = 'Let me check.\n```tool_call\n{"name": "execute_command", "arguments": {"cmd": "ls -la"}}\n```\n';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].name, "execute_command");
  assert.equal(out.calls[0].arguments, '{"cmd":"ls -la"}');
  assert.ok(out.content.includes("Let me check."));
  assert.equal(out.warnings.length, 0);
});

test("parses parallel calls (back-to-back fences)", () => {
  const text =
    '```tool_call\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```' +
    '```tool_call\n{"name": "read_file", "arguments": {"path": "b.txt"}}\n```';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 2);
  assert.equal(out.calls[0].arguments, '{"path":"a.txt"}');
  assert.equal(out.calls[1].arguments, '{"path":"b.txt"}');
});

test("call ids are deterministic across parses", () => {
  const args = '{"cmd":"ls"}';
  const text = `\`\`\`tool_call\n{"name": "execute_command", "arguments": ${args}}\n\`\`\``;
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls[0].id, synthCallId("execute_command", args));
  const out2 = parseResponse(text, TOOLS);
  assert.equal(out.calls[0].id, out2.calls[0].id);
});

test("malformed JSON block flushes as content with a warning", () => {
  const text = '```tool_call\n{"name": "execute_command", "arguments": {"cmd" }}\n```';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 0);
  assert.equal(out.content, text);
  assert.ok(out.warnings[0].startsWith("malformed JSON"));
});

test("unknown tool is rejected as content", () => {
  const text = '```tool_call\n{"name": "rm_rf", "arguments": {}}\n```';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 0);
  assert.ok(out.warnings[0].includes('unknown tool "rm_rf"'));
});

test("missing required argument is rejected as content", () => {
  const text = '```tool_call\n{"name": "execute_command", "arguments": {"timeout_secs": 5}}\n```';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 0);
  assert.ok(out.warnings[0].includes('missing required argument "cmd"'));
});

test("optional args of wrong primitive type are rejected", () => {
  const text = '```tool_call\n{"name": "execute_command", "arguments": {"cmd": "ls", "timeout_secs": "five"}}\n```';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 0);
  assert.ok(out.warnings[0].includes("must be number"));
});

test("plain text with no fences is content with no warnings", () => {
  const out = parseResponse("Just a plain answer with `ticks` and even ```js code blocks.", TOOLS);
  assert.equal(out.calls.length, 0);
  assert.equal(out.warnings.length, 0);
  assert.equal(out.content, "Just a plain answer with `ticks` and even ```js code blocks.");
});

test("legacy [tool_call id=.. name=..] convention parses through the same validator", () => {
  const text = '[tool_call id=zz name=execute_command] {"cmd":"pwd"}';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].name, "execute_command");
  assert.ok(out.warnings.some((w) => w.includes("legacy")));
});

test("unterminated fence is treated as content (no crash)", () => {
  const text = 'answer ```tool_call\n{"name": "execute_command"';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 0);
  assert.equal(out.warnings.length, 0);
});

test("arguments may arrive as a JSON string", () => {
  const text = '```tool_call\n{"name": "execute_command", "arguments": "{\\"cmd\\": \\"ls\\"}"}\n```';
  const out = parseResponse(text, TOOLS);
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].arguments, '{"cmd":"ls"}');
});
