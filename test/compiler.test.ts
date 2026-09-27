import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileSeed,
  compileInjectResults,
  compileInjectText,
  compileRegenerate,
  compileRepair,
  renderToolSpec,
} from "../src/emulation/compiler.js";
import type { ToolSpec } from "../src/emulation/types.js";
import type { ChatMessage } from "../src/core/canonical.js";

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, timeout_secs: { type: "number" } },
        required: ["cmd"],
      },
    },
  },
];

test("seed output contains the versioned protocol block, tools, transcript, cue", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];
  const seed = compileSeed(msgs, TOOLS);
  assert.ok(seed.includes("=== TOOL PROTOCOL (tool-protocol: 1) ==="));
  assert.ok(seed.includes("```tool_call"));
  assert.ok(seed.includes("[execute_command] Run a shell command."));
  assert.ok(seed.includes("cmd (string, required)"));
  assert.ok(seed.includes("timeout_secs (number)"));
  assert.ok(seed.includes("=== TRANSCRIPT ==="));
  assert.ok(seed.includes("### SYSTEM\nsys"));
  assert.ok(seed.includes("### USER\nhi"));
  assert.ok(seed.includes("=== ASSISTANT CUE ==="));
});

test("compiler is deterministic (ADR-4 obligation)", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  assert.equal(compileSeed(msgs, TOOLS), compileSeed(msgs, TOOLS));
  assert.equal(compileInjectResults([{ role: "tool", content: "x", tool_call_id: "t" }]),
    compileInjectResults([{ role: "tool", content: "x", tool_call_id: "t" }]));
});

test("tool results render in the transcript format with TOOL#id headers", () => {
  const out = compileInjectResults([
    { role: "tool", content: "file-a", tool_call_id: "call_x" },
    { role: "tool", content: "file-b", tool_call_id: "call_y" },
  ]);
  assert.ok(out.includes("=== TOOL RESULTS ==="));
  assert.ok(out.includes("### TOOL#call_x\nfile-a"));
  assert.ok(out.includes("### TOOL#call_y\nfile-b"));
  assert.ok(out.includes("=== ASSISTANT CUE ==="));
});

test("assistant tool_calls render with name and args in transcript", () => {
  const msgs: ChatMessage[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: '{"p":1}' } }],
    },
  ];
  const seed = compileSeed(msgs, []);
  assert.ok(seed.includes('call ls({"p":1})#c1'));
});

test("inject text passes through verbatim; regenerate appends the redo note", () => {
  assert.equal(compileInjectText("hello"), "hello");
  const regen = compileRegenerate([{ role: "user", content: "q" }], []);
  assert.ok(regen.includes("being regenerated"));
});

test("repair prompt quotes the offending output and names the error", () => {
  const r = compileRepair("bad output", 'unknown tool "x"');
  assert.ok(r.includes("PROTOCOL REMINDER"));
  assert.ok(r.includes('unknown tool "x"'));
  assert.ok(r.includes("bad output"));
});

test("tool schema renderer truncates at budget", () => {
  const big: ToolSpec = {
    type: "function",
    function: {
      name: "big",
      description: "x".repeat(3000),
    },
  };
  const rendered = renderToolSpec(big, 100);
  assert.ok(rendered.length <= 100);
  assert.ok(rendered.endsWith("…"));
});
