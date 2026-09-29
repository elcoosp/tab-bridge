// Regression suite for the 2026-09-29 "React-less Continue button never
// activates" bug.
//
// Diagnostic output from v1.2.41 showed:
//   reactHandlers: "(no react props)"
//   maybeContinue: post-click state {"stillThere":true,"streamAfterClick":false}
//
// The button survived every dispatched event and its own node had no React
// props. This suite asserts the countermeasures exist and are wired in.
//
// The "second-wave deepReactActivate" test was removed in v1.2.44: the
// fiber-walking hack returns false for this DeepSeek build and the primary
// path is now a trusted click via chrome.debugger. deepReactActivate is
// kept as an unused-but-available helper.
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

test("regression: syntheticClick sets detail: 1 (real-mouse signal)", () => {
  const fn = extractFunction("syntheticClick");
  assert.match(fn, /detail:\s*1/, "syntheticClick must set detail: 1 so handlers guarded on event.detail fire");
});

test("regression: dumpReactHandlers walks ancestors when self has no props", () => {
  const fn = extractFunction("dumpReactHandlers");
  assert.match(fn, /parentElement/, "dumpReactHandlers must walk to parentElement");
  assert.match(fn, /ancestor\+/, "dumpReactHandlers must report an ancestor hit");
  assert.match(fn, /ancestor-fiber\+/, "dumpReactHandlers must report an ancestor-fiber hit");
});

test("regression: deepReactActivate is declared", () => {
  assert.doesNotThrow(() => extractFunction("deepReactActivate"));
});

test("regression: deepReactActivate walks the fiber return chain", () => {
  const fn = extractFunction("deepReactActivate");
  assert.match(fn, /__reactFiber/, "deepReactActivate must detect a React fiber key");
  assert.match(fn, /\.stateNode/, "deepReactActivate must match the fiber by stateNode");
  assert.match(fn, /\.return/, "deepReactActivate must walk the fiber's return chain");
  assert.match(fn, /onClick/, "deepReactActivate must look for onClick");
  assert.match(fn, /onPointerUp/, "deepReactActivate must look for onPointerUp");
});

test("regression: button diagnostic includes hitAtCenter and focus state", () => {
  const fn = extractFunction("maybeContinue");
  assert.match(fn, /hitAtCenter/, "button diagnostic must report hitAtCenter");
  assert.match(fn, /hasFocus|docFocus/, "button diagnostic must report document focus state");
  assert.match(fn, /visibilityState|visibility/, "button diagnostic must report visibilityState");
});
