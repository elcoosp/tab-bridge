// Regression suite for the 2026-09-29 "stuck on icon-only retry button" bug.
//
// DeepSeek's retry affordance after a mid-generation halt is sometimes an
// icon-only warning circle (no text label). RETRY_LABEL_RE matches on
// text, so the injector never detected it and the turn hung. The structural
// detector added alongside it matches the unique
// div[role=button].ds-button--warning.ds-button--circle shape with an svg
// child. This suite reads extension/injector.js as source and asserts the
// detector exists and is wired into generationFailedVisible.

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

test("regression: retryButtonStructuralVisible is declared", () => {
  assert.doesNotThrow(() => extractFunction("retryButtonStructuralVisible"));
});

test("regression: retryButtonStructuralVisible matches warning+circle", () => {
  const fn = extractFunction("retryButtonStructuralVisible");
  assert.match(fn, /ds-button--warning/, "structural detector must require --warning");
  assert.match(fn, /ds-button--circle/, "structural detector must require --circle");
  assert.match(fn, /querySelectorAll/, "structural detector must query the DOM");
});

test("regression: retryButtonStructuralVisible requires an svg child", () => {
  const fn = extractFunction("retryButtonStructuralVisible");
  assert.match(fn, /querySelector\(\s*"svg"\s*\)/, "structural detector must require an svg child");
});

test("regression: generationFailedVisible falls through to the structural detector", () => {
  const fn = extractFunction("generationFailedVisible");
  assert.match(
    fn,
    /retryButtonStructuralVisible\(\)/,
    "generationFailedVisible must call retryButtonStructuralVisible() as a fallback"
  );
});
