// Regression: DeepSeek's Continue button fires a POST to
// /api/v0/chat/continue — a DIFFERENT endpoint from the initial
// /api/v0/chat/completion. The SSE hook must arm for BOTH; otherwise the
// continuation stream is never attached and the partial answer is stranded.
//
// Reads extension/sse-hook.js as source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../extension/sse-hook.js"), "utf8");

function extractCompletionRegex(): RegExp {
  const m = SRC.match(/const\s+COMPLETION_RE\s*=\s*\/(.+)\/([a-z]*);/);
  if (!m) throw new Error("COMPLETION_RE declaration not found");
  return new RegExp(m[1], m[2]);
}

test("COMPLETION_RE matches the initial completion endpoint", () => {
  const re = extractCompletionRegex();
  assert.ok(re.test("https://chat.deepseek.com/api/v0/chat/completion"),
    "COMPLETION_RE must match /api/v0/chat/completion");
});

test("COMPLETION_RE matches the continue endpoint", () => {
  const re = extractCompletionRegex();
  assert.ok(re.test("https://chat.deepseek.com/api/v0/chat/continue"),
    "COMPLETION_RE must match /api/v0/chat/continue — otherwise the Continue button's resume stream is never captured");
});

test("COMPLETION_RE does NOT match unrelated endpoints", () => {
  const re = extractCompletionRegex();
  assert.equal(re.test("https://chat.deepseek.com/api/v0/user/me"), false);
  assert.equal(re.test("https://chat.deepseek.com/api/v0/chat/history"), false);
});
