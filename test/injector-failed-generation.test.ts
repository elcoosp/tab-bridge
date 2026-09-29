// Regression suite for the 2026-09-29 "stuck on retry, no reply" bug.
//
// DeepSeek accepted an INJECT_RESULTS submit, committed the user bubble,
// then silently refused to generate — the retry affordance painted in the
// tab is the only tell. No existing injector fallback recognised it:
// serverDownVisible() matched only the "Server is temporarily unavailable."
// banner; the DOM tick's null path waited out its 60s nullSince budget and
// then reported a generic submit-failed. The bridge classified the turn as
// a client submit failure and the caller retried the identical request.
//
// Fix: generationFailedVisible() detects the retry affordance directly and
// short-circuits both the DOM tick's null path and onNoStream before the
// generic 60s fallback. This suite reads extension/injector.js as source
// and asserts the invariant whose violation WAS the silent 60s wait.

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
  const end = SRC.indexOf("\n}", m.index);
  if (end === -1) throw new Error(`closing brace for ${name}() not found`);
  return SRC.slice(m.index, end + 2);
}

test("regression: generationFailedVisible helper exists", () => {
  assert.doesNotThrow(() => extractFunction("generationFailedVisible"));
});

test("regression: generationFailedVisible scans button-like elements", () => {
  const fn = extractFunction("generationFailedVisible");
  assert.match(
    fn,
    /querySelectorAll\(['"]button,\s*div\[role="button"\],\s*\[role="button"\]/,
    "generationFailedVisible must scan buttons and role=button elements"
  );
});

test("regression: RETRY_LABEL_RE covers the obvious retry labels", () => {
  const m = SRC.match(/const\s+RETRY_LABEL_RE\s*=\s*\/[^\n]*\/[a-z]*\s*;/);
  assert.ok(m, "RETRY_LABEL_RE declaration not found");
  const decl = m![0];
  assert.match(decl, /retry/, "RETRY_LABEL_RE must include 'retry'");
  assert.match(decl, /regenerate/, "RETRY_LABEL_RE must include 'regenerate'");
  assert.match(decl, /重试/, "RETRY_LABEL_RE must include the CJK 'retry' label");
});

test("regression: onNoStream checks generationFailedVisible()", () => {
  const idx = SRC.indexOf("async function onNoStream(");
  assert.notEqual(idx, -1, "onNoStream not found");
  const body = SRC.slice(idx, idx + 3000);
  assert.match(
    body,
    /generationFailedVisible\(\)/,
    "onNoStream must check generationFailedVisible() to short-circuit re-submits under a failed generation"
  );
});

test("regression: failed-generation error message names the provider cause", () => {
  assert.match(
    SRC,
    /provider: generation failed \(retry affordance visible\)/,
    "the failed-generation error message must clearly name the provider cause"
  );
});
