// Regression suite for the 2026-09-29 "stuck on Continue button" bug.
//
// Observed: DeepSeek halted mid-thinking, rendered a "Stopped" header on
// the think block and a Continue button at the bottom of the message, and
// went silent on the SSE stream without sending a `complete`. The injector
// only checked for Continue on the `complete` event or after 120s of SSE
// silence, so the caller saw a stuck turn for up to two minutes.
//
// Fix: the watchdog now checks for the Continue button on every 2s tick,
// clicking it as soon as the SSE stream has been quiet for
// CONTINUE_IDLE_THRESHOLD_MS (3s). This suite reads
// extension/injector.js as source and asserts the invariant whose
// violation WAS the two-minute stall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../extension/injector.js"), "utf8");

test("regression: CONTINUE_IDLE_THRESHOLD_MS is declared and small", () => {
  const m = SRC.match(/const\s+CONTINUE_IDLE_THRESHOLD_MS\s*=\s*(\d[\d_]*)/);
  assert.ok(m, "CONTINUE_IDLE_THRESHOLD_MS not declared");
  const v = Number(m![1].replace(/_/g, ""));
  assert.ok(
    v > 0 && v <= 10_000,
    `CONTINUE_IDLE_THRESHOLD_MS is ${v}ms; must be > 0 and <= 10s — a ` +
      `longer threshold reintroduces the two-minute stuck-on-Continue stall`
  );
});

test("regression: watchdog checks Continue on the fast path", () => {
  const idx = SRC.indexOf("function startWatchdog(");
  assert.notEqual(idx, -1, "startWatchdog() not found");
  const end = SRC.indexOf("\n}", idx);
  const body = SRC.slice(idx, end);

  const fastIdx = body.indexOf("sse-quiet-continue");
  const slowIdx = body.indexOf("sse-idle");
  assert.notEqual(fastIdx, -1, "watchdog must have a fast Continue path (sse-quiet-continue)");
  assert.notEqual(slowIdx, -1, "watchdog must still have the slow 120s idle path");
  assert.ok(
    fastIdx < slowIdx,
    "the fast Continue path must be checked BEFORE the slow SSE_IDLE_TIMEOUT_MS path, " +
      "else the fast path never fires"
  );
  assert.match(
    body,
    /now\s*-\s*t\.lastSseAt\s*>\s*CONTINUE_IDLE_THRESHOLD_MS/,
    "the fast path must compare against CONTINUE_IDLE_THRESHOLD_MS"
  );
});

test("regression: fast Continue path is gated on SSE mode + no in-flight continue", () => {
  const idx = SRC.indexOf("function startWatchdog(");
  const end = SRC.indexOf("\n}", idx);
  const body = SRC.slice(idx, end);

  // Extract just the fast-path block: from the first `t.mode === "sse"` after
  // CONTINUE_IDLE_THRESHOLD_MS to the closing brace of that if.
  const fastStart = body.indexOf("sse-quiet-continue");
  assert.notEqual(fastStart, -1);
  // Take a window around the fast path.
  const window = body.slice(Math.max(0, fastStart - 600), fastStart + 200);
  assert.match(window, /t\.mode\s*===\s*"sse"/, "fast path must be gated on sse mode");
  assert.match(window, /!t\.awaitContinue/, "fast path must not re-fire while a continue is in flight");
  assert.match(window, /t\.lastSseAt/, "fast path must require SSE has actually started");
});

test("regression: maybeContinue still re-arms the SSE hook", () => {
  const idx = SRC.indexOf("function maybeContinue(");
  assert.notEqual(idx, -1, "maybeContinue() not found");
  const end = SRC.indexOf("\n}", idx);
  const body = SRC.slice(idx, end);
  assert.match(
    body,
    /hookPost\(\s*\{\s*type:\s*"arm"/,
    "maybeContinue must re-arm the SSE hook so the continuation POST is captured"
  );
});

test("regression: the existing 120s idle path is preserved as a safety net", () => {
  const m = SRC.match(/const\s+SSE_IDLE_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
  assert.ok(m, "SSE_IDLE_TIMEOUT_MS not declared");
  const v = Number(m![1].replace(/_/g, ""));
  assert.ok(
    v >= 30_000,
    `SSE_IDLE_TIMEOUT_MS is ${v}ms — it should stay generous (>=30s) as the ` +
      `last-resort bound; the fast Continue path handles the common case`
  );
});
