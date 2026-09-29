// Regression suite for the 2026-09-29 "Continue button found and 'clicked'
// but stays visible" bug.
//
// The log showed `maybeContinue: button Object / clicking Continue (1/5,
// sse-complete) / maybeContinue: activated Object` firing, but the button
// remained visible in the screenshot and no continuation POST followed.
//
// v1.2.44 switches the primary click path to chrome.debugger +
// CDP Input.dispatchMouseEvent, which produces isTrusted: true events.
// The old synthetic fallback remains for handlers that do not check
// isTrusted. The focus-steal retry test was removed: the hypothesis was
// wrong and the focus path was stripped from maybeContinue.
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
  // Activation diagnostic is emitted either as "activated" (synthetic
  // fallback succeeded) or "synthetic fallback" (debugger path failed).
  // Both shapes must be JSON-stringified so DevTools cannot collapse them.
  assert.match(
    fn,
    /dbg\(\s*"maybeContinue: (activated|synthetic fallback) "\s*\+\s*JSON\.stringify\(/,
    "activation diagnostic must be a JSON string"
  );
  assert.match(
    fn,
    /maybeContinue: post-click state "\s*\+\s*JSON\.stringify\(/,
    "post-click diagnostic must be a JSON string"
  );
});
