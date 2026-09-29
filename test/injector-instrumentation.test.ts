// Regression + instrumentation suite for extension/injector.js.
//
// Two things are asserted:
//   1. The instrumentation hooks the stuck-turn repro depends on exist:
//      `trace`, `syntheticClick`, `keyboardActivate`, `window.__tabBridgeState`,
//      `window.__tabBridgeForceContinue`.
//   2. `maybeContinue` uses the robust activation path (syntheticClick with
//      a keyboardActivate fallback), not a bare `el.click()`.
//
// Reads extension/injector.js as source — the file is a browser content
// script and cannot be imported under Node.

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

test("instrumentation: trace helper is declared", () => {
  assert.match(SRC, /const\s+trace\s*=\s*\(\.\.\.a\)\s*=>/, "trace helper not declared");
  assert.match(SRC, /__tabBridgeTrace\s*===\s*true/, "trace must be gated on window.__tabBridgeTrace");
});

test("instrumentation: syntheticClick dispatches the full pointer sequence", () => {
  const fn = extractFunction("syntheticClick");
  // The implementation iterates over multiple targets (the outer button and
  // the ds-button__content label span), so the native click call is
  // `target.click()` rather than `el.click()`. Either name is acceptable —
  // what matters is that the native click method is invoked at all.
  assert.match(fn, /\.click\(\)/, "syntheticClick must call the native .click() method");
  assert.match(fn, /"pointerdown"/, "syntheticClick must dispatch pointerdown");
  assert.match(fn, /"pointerup"/, "syntheticClick must dispatch pointerup");
  assert.match(fn, /"mousedown"/, "syntheticClick must dispatch mousedown");
  assert.match(fn, /"mouseup"/, "syntheticClick must dispatch mouseup");
  // And it must iterate over multiple targets: the outer element plus the
  // design-system label span, so a build that routes onClick through the
  // label span is still activated.
  assert.match(fn, /for \(const target of targets\)/, "syntheticClick must loop over targets");
  assert.match(fn, /span\.ds-button__content/, "syntheticClick must target the ds-button__content span");
});

test("instrumentation: keyboardActivate fires Enter keydown/keyup", () => {
  const fn = extractFunction("keyboardActivate");
  assert.match(fn, /key:\s*"Enter"/, "keyboardActivate must use Enter");
  assert.match(fn, /el\.focus\(\)/, "keyboardActivate must focus the element first");
});

test("instrumentation: window.__tabBridgeState and __tabBridgeForceContinue are exposed", () => {
  assert.match(SRC, /window\.__tabBridgeState\s*=/, "__tabBridgeState not exposed");
  assert.match(SRC, /window\.__tabBridgeForceContinue\s*=/, "__tabBridgeForceContinue not exposed");
});

test("instrumentation: maybeContinue uses syntheticClick and keyboard fallback", () => {
  const fn = extractFunction("maybeContinue");
  // The focus-steal rewrite captures the button as `btnRef` so it can be
  // re-checked inside a setTimeout. Either name is fine.
  assert.match(fn, /syntheticClick\(btn(Ref)?\)/, "maybeContinue must call syntheticClick(btn)");
  assert.match(fn, /keyboardActivate\(btn(Ref)?\)/, "maybeContinue must call keyboardActivate(btn)");
  assert.doesNotMatch(
    fn,
    /btn\.click\(\)/,
    "maybeContinue must not use a bare btn.click() — it skips the pointer sequence DeepSeek's div[role=button] handlers expect"
  );
});

test("instrumentation: findContinueButton logs a miss census", () => {
  const fn = extractFunction("findContinueButton");
  assert.match(fn, /findContinueButton:\s*miss/, "findContinueButton must log a miss census");
  assert.match(fn, /findContinueButton:\s*hit/, "findContinueButton must log a hit");
});

test("instrumentation: watchdog tick logs a state snapshot", () => {
  const idx = SRC.indexOf("function startWatchdog(");
  assert.notEqual(idx, -1);
  const end = SRC.indexOf("\n}", idx);
  const body = SRC.slice(idx, end);
  assert.match(body, /trace\("watchdog tick"/, "watchdog must emit a tick trace");
});

test("instrumentation: SSE message handler traces every message", () => {
  assert.match(SRC, /trace\("sse-hook"/, "SSE message handler must trace every incoming hook message");
});

test("instrumentation: finishTurn traces the closing (ok, code, detail)", () => {
  const fn = extractFunction("finishTurn");
  assert.match(fn, /trace\("finishTurn"/, "finishTurn must trace the closing state");
});
