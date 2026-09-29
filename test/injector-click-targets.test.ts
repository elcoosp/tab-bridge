// Regression suite for the 2026-09-29 "Continue button found and 'clicked'
// but stays visible" bug.
//
// The log showed `maybeContinue: button Object / clicking Continue (1/5,
// sse-complete) / maybeContinue: activated Object` firing, but the button
// remained visible in the screenshot and no continuation POST followed.
// Two likely causes:
//
//   1. Object-arg logging collapses the diagnostic to "Object" in DevTools,
//      hiding clicked/keyboardActivated/reactHandlers from the operator.
//   2. A single el.click() on the outer div misses DeepSeek builds whose
//      handler lives on a nested element (the ds-button__content span) or
//      whose synthetic dispatch requires a raw Event("click") rather than
//      a MouseEvent.
//
// This suite reads extension/injector.js as source and asserts the
// invariant.

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

test("regression: syntheticClick fires against multiple targets", () => {
  const fn = extractFunction("syntheticClick");
  assert.match(
    fn,
    /span\.ds-button__content/,
    "syntheticClick must also target the design-system label span"
  );
  assert.match(fn, /for \(const target of targets\)/, "syntheticClick must loop over targets");
});

test("regression: syntheticClick dispatches a raw Event('click')", () => {
  const fn = extractFunction("syntheticClick");
  assert.match(
    fn,
    /new Event\(\s*"click"/,
    "syntheticClick must also dispatch a plain Event('click') for libraries that bypass MouseEvent"
  );
});

test("regression: syntheticClick includes view: window in MouseEvent init", () => {
  const fn = extractFunction("syntheticClick");
  assert.match(fn, /view:\s*window/, "syntheticClick must pass view: window");
});

test("regression: maybeContinue logs diagnostics as JSON strings", () => {
  const fn = extractFunction("maybeContinue");
  assert.match(
    fn,
    /dbg\(\s*"maybeContinue: button "\s*\+\s*JSON\.stringify\(/,
    "button diagnostic must be a JSON string, not an object (DevTools collapses objects)"
  );
  assert.match(
    fn,
    /dbg\(\s*"maybeContinue: activated "\s*\+\s*JSON\.stringify\(/,
    "activation diagnostic must be a JSON string"
  );
  assert.match(
    fn,
    /maybeContinue: post-click state "\s*\+\s*JSON\.stringify\(/,
    "post-click diagnostic must be a JSON string"
  );
});

test("regression: maybeContinue retries with focus + Enter when button persists", () => {
  const fn = extractFunction("maybeContinue");
  assert.match(
    fn,
    /focus \+ Enter only/,
    "maybeContinue must have a second-wave recovery that tries focus + Enter alone"
  );
  assert.match(
    fn,
    /btn2\.focus\(\)/,
    "second-wave recovery must focus the button before dispatching Enter"
  );
});
