// Regression suite for the 2026-09-29 "Continue / Retry button visible but
// click does not resume generation" bug.
//
// The log showed `clicking Continue (1/5, sse-complete)` firing twice and
// no `intercepting XHR completion POST` line in between — meaning the click
// dispatched but DeepSeek's handler never fired a follow-up request.
// Root causes addressed here:
//
//   1. keyboardActivate was gated on `!clicked`, but el.click() never
//      throws, so keyboard activation almost never ran. DeepSeek's
//      div[role=button][tabindex=0] controls are keyboard-activatable.
//   2. findContinueButton only matched labelled buttons — the icon-only
//      warning-circle retry button (no text) was never found, so the
//      watchdog never called maybeContinue for that halt shape.
//   3. The button diagnostics were trace-gated and never fired in a
//      normal repro.
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
  // The focus-steal rewrite captures the button as `btnRef`. Either name
  // is fine; what matters is both activation paths are called.
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
  // The diagnostics are emitted as JSON strings (never objects, which
  // DevTools collapses to "Object") via `dbg("..." + JSON.stringify(...))`.
  // Match the prefix of the string literal, with or without the trailing
  // space — either shape means the always-on dbg call is present.
  assert.match(fn, /dbg\(\s*"maybeContinue: button/, "button diagnostic must be dbg (always-on)");
  assert.match(fn, /dbg\(\s*"maybeContinue: activated/, "activation diagnostic must be dbg (always-on)");
  assert.match(fn, /maybeContinue: post-click state/, "post-click verification must be present");
  // And they must be JSON.stringify'd, so they cannot be collapsed.
  assert.match(fn, /JSON\.stringify\(/, "diagnostics must be JSON-stringified");
});

test("regression: window.__tabBridgeClickResume diagnostic is exposed", () => {
  assert.match(SRC, /window\.__tabBridgeClickResume\s*=/, "__tabBridgeClickResume not exposed");
});
