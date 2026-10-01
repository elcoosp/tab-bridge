// Regression: bounded rate-limit recovery with exponential backoff.
//
// DeepSeek's "Messages too frequent" flag is often transient — a burst hits
// the account window for seconds, then clears. Without a bounded retry, the
// worker marks the tab rate_limited for 20 minutes, forcing every subsequent
// turn through the cooldown. Three retries with exponential backoff absorb
// the transient burst in-place; only a persistent limit falls through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../extension/injector.js"), "utf8");

function extractFunction(name: string): string {
  const re = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = re.exec(SRC);
  if (!m) throw new Error(`function ${name}() not found — injector structure drifted`);
  let depth = 0;
  let started = false;
  for (let i = m.index; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return SRC.slice(m.index, i + 1); }
  }
  throw new Error(`closing brace for ${name}() not found`);
}

test("rate-limit constants: 4-minute window + exponential backoff", () => {
  // v1.2.67 — window and cap reduced from 5 min to 4 min so recovery
  // concludes before accumulated per-attempt timeouts at the harness layer
  // (each attempt's own 120s SSE-idle watchdog vs the recovery window's
  // total budget) can misfire. See 2026-09-30 log where a 5-min window was
  // pre-empted by a mid-recovery 120s timeout.
  assert.match(
    SRC,
    /const RATE_LIMIT_RETRY_WINDOW_MS = 4 \* 60_000;/,
    "must declare a 4-minute wall-clock window"
  );
  assert.match(
    SRC,
    /const RATE_LIMIT_BACKOFF_INITIAL_MS = 2_000;/,
    "must declare a 2s initial backoff"
  );
  assert.match(
    SRC,
    /const RATE_LIMIT_BACKOFF_MAX_MS = 4 \* 60_000;/,
    "must cap per-step backoff at the 4-minute window"
  );
});

test("attemptRateLimitRecovery is declared and prefers the on-screen retry affordance", () => {
  const fn = extractFunction("attemptRateLimitRecovery");
  assert.match(fn, /findContinueButton\(\)/, "must check for an on-screen retry button first");
  assert.match(fn, /maybeContinue\(t, "rate-limit-retry"\)/, "must click it via maybeContinue (trusted debugger path)");
});

test("attemptRateLimitRecovery falls back to re-submitting the stored prompt", () => {
  const fn = extractFunction("attemptRateLimitRecovery");
  assert.match(fn, /t\.promptText/, "must read the stored prompt text");
  assert.match(fn, /submitPrompt\(/, "must call submitPrompt on the fallback path");
  assert.match(fn, /hookArmSync\(/, "must re-arm the SSE hook before re-submitting");
});

test("attemptRateLimitRecovery debounces concurrent triggers", () => {
  const fn = extractFunction("attemptRateLimitRecovery");
  assert.match(fn, /t\.rateLimitRecoveryActive/, "must have a debounce flag");
  assert.match(fn, /if \(t\.rateLimitRecoveryActive\) return true;/, "must short-circuit when a retry is already scheduled");
});

test("attemptRateLimitRecovery is bounded by the 5-minute window", () => {
  const fn = extractFunction("attemptRateLimitRecovery");
  assert.match(
    fn,
    /elapsed >= RATE_LIMIT_RETRY_WINDOW_MS/,
    "must give up once the wall-clock window has elapsed"
  );
  assert.match(
    fn,
    /t\.rateLimitFirstAt/,
    "must stamp the wall-clock window start on the first retry"
  );
  assert.match(
    fn,
    /Math\.pow\(2, t\.rateLimitRetries - 1\)/,
    "backoff must double per retry"
  );
});

test("all five rate-limit finishTurn sites route through attemptRateLimitRecovery", () => {
  assert.match(SRC, /attemptRateLimitRecovery\(t, "sse-hint"/, "SSE hint-error must call the helper");
  assert.match(SRC, /attemptRateLimitRecovery\(t, "sse-complete-hint"/, "SSE complete hintError must call the helper");
  assert.match(SRC, /attemptRateLimitRecovery\(t, "http-429"/, "HTTP 429 must call the helper");
  assert.match(SRC, /attemptRateLimitRecovery\(t, "toast"/, "watchdog toast must call the helper");
  assert.match(SRC, /attemptRateLimitRecovery\(t, "submit-rejected"/, "submit rejection must call the helper");
});

test("turn-state carries the retry bookkeeping fields", () => {
  assert.match(SRC, /rateLimitRetries: 0,/, "turn state must init rateLimitRetries");
  assert.match(SRC, /rateLimitRecoveryActive: false,/, "turn state must init the debounce flag");
  assert.match(SRC, /promptText: typeof msg\.text === "string" \? msg\.text : ""/, "turn state must capture the prompt text");
});

test("regression: rate-limit recovery bumps the SSE idle clock", () => {
  // v1.2.66 — a recovery attempt is activity, not idle. Without this bump,
  // the watchdog's 120s SSE-idle timeout fires mid-recovery (DeepSeek's
  // empty 200 responses leave lastSseAt stale) and the harness gets
  // "timeout" instead of the eventual "rate_limited". See the 2026-09-30
  // log: retries #1..#6 spanned 126s of backoff while lastSseAt was still
  // the original submit timestamp, so the watchdog killed the turn at 67s
  // into the recovery window.
  const fn = extractFunction("attemptRateLimitRecovery");
  assert.match(
    fn,
    /t\.lastSseAt = now;/,
    "attemptRateLimitRecovery must bump t.lastSseAt so the SSE idle watchdog does not fire mid-recovery"
  );
});

test("regression: rate-limit-retry bypasses the MAX_CONTINUES ceiling", () => {
  // v1.2.67 — the SSE-halt path is bounded by MAX_CONTINUES; the rate-limit
  // recovery path is bounded by RATE_LIMIT_RETRY_WINDOW_MS. Sharing the
  // Continue counter capped recovery at 5 clicks and let the 120s SSE-idle
  // watchdog misfire mid-recovery (2026-09-30 log: retry #6 was rejected by
  // the ceiling, no POST fired, harness got "timeout" instead of
  // "rate_limited").
  const fn = extractFunction("maybeContinue");
  assert.match(fn, /isRateLimitRetry/, "maybeContinue must distinguish the rate-limit-retry path");
  assert.match(
    fn,
    /why === "rate-limit-retry"/,
    'the bypass must key off the exact reason string "rate-limit-retry"'
  );
  assert.match(
    fn,
    /!isRateLimitRetry && \(t\.continues \| 0\) >= MAX_CONTINUES/,
    "the MAX_CONTINUES ceiling must not apply to rate-limit-retry"
  );
});

test("regression: rate-limit window and backoff cap are both 4 minutes", () => {
  assert.match(SRC, /const RATE_LIMIT_RETRY_WINDOW_MS = 4 \* 60_000;/,
    "recovery window must be 4 min so it concludes before the harness's 120s-per-attempt timeout accumulates");
  assert.match(SRC, /const RATE_LIMIT_BACKOFF_MAX_MS = 4 \* 60_000;/,
    "per-step backoff cap must also be 4 min");
});
