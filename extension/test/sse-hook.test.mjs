/**
 * Unit tests for the MAIN-world SSE hook pure internals
 * (extension/sse-hook.js). The hook file is a classic script in the browser
 * but importable under Node: with `window` undefined it only exposes
 * `globalThis.__tabBridgeSseInternals`.
 *
 * Run: node --test extension/test/*.test.mjs  (wired into `pnpm test`)
 */
import test from "node:test";
import assert from "node:assert/strict";

import "../sse-hook.js";

const I = globalThis.__tabBridgeSseInternals;
assert.ok(I, "internals exposed under Node");

// ---------------------------------------------------------------------------
// frameData
// ---------------------------------------------------------------------------

test("frameData: parses event + data lines", () => {
  const f = I.frameData("event: hint\ndata: {\"a\":1}");
  assert.equal(f.event, "hint");
  assert.equal(f.data, '{"a":1}');
});

test("frameData: strips exactly one leading space after data:", () => {
  const f = I.frameData("data: hello");
  assert.equal(f.data, "hello");
});

test("frameData: joins multi-line data with newline (SSE spec)", () => {
  const f = I.frameData("data: line1\ndata:line2");
  assert.equal(f.data, "line1\nline2");
});

test("frameData: skips comments, tolerates data without colon", () => {
  const f = I.frameData(": keep-alive\ndata");
  assert.equal(f.data, "");
});

// ---------------------------------------------------------------------------
// extractFromFrame — DeepSeek web shape
// ---------------------------------------------------------------------------

test("extractFromFrame: {v:\"text\"} delta", () => {
  assert.deepEqual(I.extractFromFrame({ v: "hello " }), { delta: "hello " });
});

test("extractFromFrame: bare string delta", () => {
  assert.deepEqual(I.extractFromFrame("raw"), { delta: "raw" });
});

test("extractFromFrame: {v:{...}} metadata without done", () => {
  const r = I.extractFromFrame({ v: { request_id: "r1", message_id: "m1" } });
  assert.equal(r.done, false);
  assert.equal(r.meta.request_id, "r1");
});

test("extractFromFrame: {v:{status:'finished'}} signals done", () => {
  const r = I.extractFromFrame({ v: { status: "finished" } });
  assert.equal(r.done, true);
});

test("extractFromFrame: {v:{finish_reason}} signals done", () => {
  const r = I.extractFromFrame({ v: { finish_reason: "stop" } });
  assert.equal(r.done, true);
});

test("extractFromFrame: OpenAI chunk delta + finish_reason", () => {
  const r = I.extractFromFrame({
    choices: [{ delta: { content: "abc" }, finish_reason: null }],
  });
  assert.equal(r.delta, "abc");
  const r2 = I.extractFromFrame({ choices: [{ delta: {}, finish_reason: "stop" }] });
  assert.equal(r2.done, true);
  assert.equal(r2.finishReason, "stop");
});

test("extractFromFrame: reasoning_content is marked as think, not delta", () => {
  const r = I.extractFromFrame({ choices: [{ delta: { reasoning_content: "pondering" } }] });
  assert.equal(r.think, "pondering");
  assert.equal(r.delta, undefined);
});

test("extractFromFrame: {type:'error'} payload never becomes answer text", () => {
  const r = I.extractFromFrame({
    type: "error",
    content: "Messages too frequent. Try again later.",
    finish_reason: "rate_limit_reached",
  });
  assert.match(r.error, /too frequent/);
  assert.equal(r.finishReason, "rate_limit_reached");
});

test("extractFromFrame: {error:{message}} payload", () => {
  const r = I.extractFromFrame({ error: { message: "boom" } });
  assert.equal(r.error, "boom");
});

test("extractFromFrame: generic content and message.content shapes", () => {
  assert.equal(I.extractFromFrame({ content: "x" }).delta, "x");
  assert.equal(I.extractFromFrame({ message: { content: "y" } }).delta, "y");
});

test("extractFromFrame: array chunks merge", () => {
  const r = I.extractFromFrame([{ v: "a" }, { v: "b" }]);
  assert.equal(r.delta, "ab");
});

// ---------------------------------------------------------------------------
// holdLen + think filter
// ---------------------------------------------------------------------------

test("holdLen: detects partial tag suffixes", () => {
  assert.equal(I.holdLen("abc<thi", "<think>"), 4);
  assert.equal(I.holdLen("abc</th", "</think>"), 4);
  assert.equal(I.holdLen("abc", "<think>"), 0);
  assert.equal(I.holdLen("<think", "<think>"), 6);
});

test("think filter: passes plain text, holds partial open tags", () => {
  const tf = I.createThinkFilter();
  assert.equal(tf.feed("hello "), "hello ");
  assert.equal(tf.feed("wor"), "wor");
  assert.equal(tf.feed("<thi"), ""); // held: could grow into <think>
  assert.equal(tf.feed("nk>"), ""); // now inside think: suppressed
  assert.equal(tf.feed("secret"), "");
  assert.equal(tf.feed("</th"), "");
  assert.equal(tf.feed("ink>"), "");
  assert.equal(tf.feed("answer"), "answer");
  assert.equal(tf.end(), "");
});

test("think filter: unclosed think flushes at end (transparent)", () => {
  const tf = I.createThinkFilter();
  assert.equal(tf.feed("<think>partial"), "");
  assert.equal(tf.end(), "partial");
});

test("think filter: multiple think blocks", () => {
  const tf = I.createThinkFilter();
  const out =
    tf.feed("<think>a</think>") + tf.feed("one") + tf.feed("<think>b</think>two") + tf.end();
  assert.equal(out, "onetwo");
});

// ---------------------------------------------------------------------------
// createSseParser — end-to-end streaming
// ---------------------------------------------------------------------------

/** Feed a whole SSE transcript in given chunk sizes; return final state. */
function runStream(transcript, chunkSize) {
  const p = I.createSseParser();
  const all = { deltas: [], hintErrors: [], doneSeen: false };
  for (let i = 0; i < transcript.length; i += chunkSize) {
    const res = p.feed(transcript.slice(i, i + chunkSize));
    all.deltas.push(...res.deltas);
    if (res.hintError) all.hintErrors.push(res.hintError);
    if (res.done) all.doneSeen = true;
  }
  return { ...p.end(), streamDeltas: all.deltas, streamHintErrors: all.hintErrors, doneSeen: all.doneSeen };
}

const DEEPSEEK_LIKE = [
  'event: message\ndata: {"v": {"request_id": "r1", "message_id": "m1"}}\n\n',
  'event: message\ndata: {"v": "BRIDGE"}\n\n',
  'event: message\ndata: {"v": " OK"}\n\n',
  "event: close\ndata: {\"click_behavior\":\"retry\",\"auto_resume\":false}\n\n",
].join("");

test("sse parser: DeepSeek-shaped stream reassembles deltas; close ends it", () => {
  for (const size of [1, 3, 7, 64, 4096]) {
    const fin = runStream(DEEPSEEK_LIKE, size);
    assert.equal(fin.text, "BRIDGE OK", `chunk size ${size}`);
    assert.equal(fin.sawAny, true, `chunk size ${size}`);
    assert.equal(fin.sawDoneMarker, false, `chunk size ${size}`);
  }
});

test("sse parser: byte-level \\r\\n splitting never fakes a frame boundary", () => {
  // The transcript below contains \r\n terminators; chunks cut exactly
  // between \r and \n must not produce spurious frame splits.
  const t = 'data: {"v":"one"}\r\n\r\ndata: {"v":"two"}\r\n\r\n';
  for (const size of [1, 2, 5]) {
    const fin = runStream(t, size);
    assert.equal(fin.text, "onetwo", `chunk size ${size}`);
  }
});

test("sse parser: [DONE] marker sets done", () => {
  const fin = runStream('data: {"v":"x"}\n\ndata: [DONE]\n\n', 32);
  assert.equal(fin.text, "x");
  assert.equal(fin.sawDoneMarker, true);
});

test("sse parser: hint event with rate_limit_reached is captured, never emitted", () => {
  const t = [
    "event: ready\ndata: {\"v\":{\"request_id\":\"r\"}}\n\n",
    'event: hint\ndata: {"type":"error","content":"Messages too frequent. Try again later.","finish_reason":"rate_limit_reached"}\n\n',
    "event: close\ndata: {}\n\n",
  ].join("");
  for (const size of [1, 11, 256]) {
    const fin = runStream(t, size);
    assert.equal(fin.text, "", `chunk size ${size}: hint content must not leak as answer`);
    assert.equal(fin.streamHintErrors.length >= 1, true, `chunk size ${size}: hint captured`);
    const h = fin.streamHintErrors[0];
    assert.match(h.content, /too frequent/);
    assert.equal(h.finishReason, "rate_limit_reached");
  }
});

test("sse parser: error data payload terminates the stream", () => {
  const fin = runStream('data: {"error":{"message":"kaput"}}\n\n', 8);
  assert.equal(fin.streamHintErrors[0].content, "kaput");
});

test("sse parser: think-tagged stream suppresses reasoning from the visible text", () => {
  const t = [
    'data: {"v":"<th"}\n\n',
    'data: {"v":"ink>let me think..."}\n\n',
    'data: {"v":"</think>final answer"}\n\n',
  ].join("");
  for (const size of [1, 4, 17, 512]) {
    const fin = runStream(t, size);
    assert.equal(fin.text, "final answer", `chunk size ${size}`);
  }
});

test("sse parser: OpenAI-style reasoning_content stream", () => {
  const t = [
    'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"vis"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ible"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  ].join("");
  for (const size of [1, 9, 128]) {
    const fin = runStream(t, size);
    assert.equal(fin.text, "visible", `chunk size ${size}`);
    assert.equal(fin.sawFinish, true, `chunk size ${size}`);
  }
});

test("sse parser: tool_call fence inside answer passes through untouched", () => {
  const body = 'data: {"v":"```tool_call\\n{\\"name\\": \\"get_weather\\", \\"arguments\\": {\\"city\\": \\"Oslo\\"}}\\n```"}\n\n';
  const fin = runStream(body, 5);
  assert.ok(fin.text.includes("tool_call"), "fence preserved for the bridge parser");
  assert.ok(fin.text.includes("get_weather"));
});

test("sse parser: garbage frames are ignored, parser keeps working", () => {
  const t = [
    "data: {not json\n\n",
    "event: weird\ndata: 42\n\n",
    'data: {"v":"ok"}\n\n',
  ].join("");
  const fin = runStream(t, 3);
  assert.equal(fin.text, "ok");
});

test("sse parser: multi-line data frames concatenate per SSE spec", () => {
  const fin = runStream('data: {"v":\ndata: "split"}\n\n', 6);
  assert.equal(fin.text, "split");
});
