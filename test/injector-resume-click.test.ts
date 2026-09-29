// Regression suite for the 2026-09-29 "Continue / Retry button visible but
// click does not resume generation" bug.
//
// v1.2.44: the primary click path is now a trusted click via
// chrome.debugger. The synthetic + keyboard fallback is preserved for
// handlers that do not check isTrusted. The focus-steal retry was removed
// as a wrong hypothesis.
//
// Reads extension/injector.js as source.

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

test("regression: dumpReactHandlers helper is declared", () => {
  assert.doesNotThrow(() => extractFunction("dumpReactHandlers"));
});

test("regression: findContinueButton also matches the icon-only retry button", () => {
  const fn = extractFunction("findContinueButton");
  assert.match(fn, /ds-button--warning/, "findContinueButton must also match --warning retry");
  assert.match(fn, /ds-button--circle/, "findContinueButton must require --circle");
  assert.match(
    fn,
    /querySelector\(\s*"svg"\s*\)/,
    "the icon-only retry path must require an svg child"
  );
});

test("regression: maybeContinue fires BOTH click and keyboard unconditionally", () => {
  const fn = extractFunction("maybeContinue");
  // Either the debugger path succeeds (no synthetic dispatch) or the
  // fallback runs both synthetic + keyboard. Either way, both activation
  // paths must be present in the source, and the keyboard fallback must
  // NOT be gated on `clicked` (el.click() never throws).
  assert.match(fn, /syntheticClick\(btn(Ref)?\)/, "maybeContinue must call syntheticClick(btn)");
  assert.match(fn, /keyboardActivate\(btn(Ref)?\)/, "maybeContinue must call keyboardActivate(btn)");
  assert.doesNotMatch(
    fn,
    /keyboardActivated\s*=\s*clicked\s*\?\s*false\s*:\s*keyboardActivate/,
    "keyboardActivate must NOT be gated on !clicked — el.click() never throws so the Enter fallback would never run"
  );
});

test("regression: maybeContinue emits always-on button diagnostics", () => {
  const fn = extractFunction("maybeContinue");
  assert.match(fn, /dumpReactHandlers\(btn\)/, "maybeContinue must dump React handlers");
  assert.match(fn, /dbg\(\s*"maybeContinue: button/, "button diagnostic must be dbg (always-on)");
  // Activation diagnostic is emitted either as "activated" or as
  // "synthetic fallback"; both are always-on dbg calls.
  assert.match(
    fn,
    /dbg\(\s*"maybeContinue: (activated|synthetic fallback)/,
    "activation diagnostic must be dbg (always-on)"
  );
  assert.match(fn, /maybeContinue: post-click state/, "post-click verification must be present");
  assert.match(fn, /JSON\.stringify\(/, "diagnostics must be JSON-stringified");
});

test("regression: window.__tabBridgeClickResume diagnostic is exposed", () => {
  assert.match(SRC, /window\.__tabBridgeClickResume\s*=/, "__tabBridgeClickResume not exposed");
});
