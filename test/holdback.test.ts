import { test } from "node:test";
import assert from "node:assert/strict";
import { HoldbackBuffer, safeEmitLength } from "../src/emulation/holdback.js";
import type { HoldbackEvent } from "../src/emulation/types.js";

function join(events: HoldbackEvent[]): { content: string; calls: Array<{ name: string; argsJson: string }> } {
  let content = "";
  const calls: Array<{ name: string; argsJson: string }> = [];
  for (const e of events) {
    if (e.type === "content") content += e.text;
    else if (e.type === "invalid") content += e.text; // invalid fences flush as content
    else if (e.type === "call") calls.push({ name: e.name, argsJson: e.argsJson });
  }
  return { content, calls };
}

test("plain text streams through immediately", () => {
  const h = new HoldbackBuffer();
  const a = join(h.push("Hello, "));
  const b = join(h.push("world!"));
  const c = join(h.finish());
  assert.equal(a.content + b.content + c.content, "Hello, world!");
  assert.equal(a.calls.length + b.calls.length + c.calls.length, 0);
});

test("a full fence in one fragment becomes a call event", () => {
  const h = new HoldbackBuffer();
  const evs = h.push('```tool_call\n{"name":"ls","arguments":{"p":"a"}}\n```');
  const { calls } = join(evs);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "ls");
  assert.equal(calls[0].argsJson, '{"p":"a"}');
});

test("fence split across fragments resolves once closed", () => {
  const h = new HoldbackBuffer();
  const e1 = join(h.push("Working on it.\n```tool_call\n"));
  const e2 = join(h.push('{"name":"cat","arguments":{"path":"x"}}'));
  const e3 = join(h.push("\n```\ndone"));
  const e4 = join(h.finish());
  const all = { content: e1.content + e2.content + e3.content + e4.content, calls: [...e1.calls, ...e2.calls, ...e3.calls, ...e4.calls] };
  // Original text: "Working on it.\n```tool_call\n{...}\n```\ndone" — the
  // newline before the opener AND after the closer both remain.
  assert.equal(all.content, "Working on it.\n\ndone");
  assert.equal(all.calls.length, 1);
  assert.equal(all.calls[0].name, "cat");
});

test("partial opener at fragment tail is held back, not emitted", () => {
  const h = new HoldbackBuffer();
  const e1 = join(h.push("text ending with ```tool_c"));
  assert.equal(e1.content, "text ending with ");
  const e2 = join(h.push("all junk }" + "\n```"));
  // "```tool_c" + "all junk }" completes the opener; the pseudo-JSON fails
  // validation, so the whole held block flushes as content (invalid event).
  assert.ok(e2.content.includes("junk"));
});

test("backticks that never form a tool_call opener pass through", () => {
  const h = new HoldbackBuffer();
  const e = join(h.push("use ```js\nconsole.log(1);\n``` in your answer"));
  const fin = join(h.finish());
  assert.equal(e.content + fin.content, "use ```js\nconsole.log(1);\n``` in your answer");
});

test("ceiling overflow flushes held text as content", () => {
  const h = new HoldbackBuffer(50);
  const evs = h.push("```tool_call\n" + "x".repeat(80));
  const { content } = join(evs);
  assert.ok(content.startsWith("```tool_call"));
  assert.ok(content.includes("xxxx"));
});

test("two sequential fences produce two calls", () => {
  const h = new HoldbackBuffer();
  const evs = h.push(
    '```tool_call\n{"name":"a","arguments":{}}\n```' + '```tool_call\n{"name":"b","arguments":{}}\n```'
  );
  const { calls } = join(evs);
  assert.deepEqual(calls.map((c) => c.name), ["a", "b"]);
});

test("safeEmitLength holds back any suffix that could grow into an opener", () => {
  assert.equal(safeEmitLength("abc"), 3);
  assert.equal(safeEmitLength("abc`"), 3);
  assert.equal(safeEmitLength("abc``"), 3);
  assert.equal(safeEmitLength("abc```tool_call"), 3); // full-opener suffix is held
  assert.equal(safeEmitLength("abc```x"), 7); // trailing x breaks the opener -> emit all
});
