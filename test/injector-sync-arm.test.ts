// Regression suite for the 2026-09-29 "Continue click produces no stream"
// bug.
//
// window.postMessage is asynchronous. The Continue click handler fires a
// continuation POST synchronously, in the same task as the click. The old
// flow re-armed the SSE hook via postMessage AFTER syntheticClick returned
// — by which time the fetch had already fired against an unarmed hook and
// slipped past. Result: no continuation stream attaches, the turn hangs.
//
// Fix: a CustomEvent on window crosses the isolated/main-world boundary
// synchronously. hookArmSync stashes the arm payload in a dataset attribute
// and dispatches the event; the MAIN-world listener runs within
// dispatchEvent, so the hook is armed before the click handler executes.
// This suite reads extension/injector.js and extension/sse-hook.js as
// source and asserts the invariant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const INJ = readFileSync(join(here, "../../extension/injector.js"), "utf8");
const HOOK = readFileSync(join(here, "../../extension/sse-hook.js"), "utf8");

function extractFunction(src: string, name: string): string {
  const re = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name}() not found`);
  const end = src.indexOf("\n}", m.index);
  if (end === -1) throw new Error(`closing brace for ${name}() not found`);
  return src.slice(m.index, end + 2);
}

test("regression: injector declares hookArmSync", () => {
  assert.doesNotThrow(() => extractFunction(INJ, "hookArmSync"));
});

test("regression: hookArmSync uses CustomEvent on window (synchronous cross-world)", () => {
  const fn = extractFunction(INJ, "hookArmSync");
  assert.match(fn, /new Event\(\s*"tab-bridge-sse-arm-sync"/, "hookArmSync must dispatch the sync arm event");
  assert.match(fn, /window\.dispatchEvent/, "hookArmSync must dispatch the event on window");
  assert.match(fn, /dataset\.tabBridgeArm/, "hookArmSync must stash the payload on a dataset attribute");
});

test("regression: sse-hook listens for the sync arm event", () => {
  assert.match(
    HOOK,
    /addEventListener\(\s*"tab-bridge-sse-arm-sync"/,
    "sse-hook must listen for the sync arm event"
  );
  // And the listener must read the payload from the dataset attribute.
  const idx = HOOK.indexOf('addEventListener("tab-bridge-sse-arm-sync"');
  assert.notEqual(idx, -1);
  const window = HOOK.slice(idx, idx + 1500);
  assert.match(window, /dataset\.tabBridgeArm/, "listener must read dataset.tabBridgeArm");
  assert.match(window, /armed\s*=/, "listener must set the armed state");
});

test("regression: maybeContinue arms synchronously BEFORE clicking", () => {
  const fn = extractFunction(INJ, "maybeContinue");
  const armIdx = fn.indexOf("hookArmSync(");
  const clickIdx = fn.indexOf("syntheticClick(");
  assert.notEqual(armIdx, -1, "maybeContinue must call hookArmSync");
  assert.notEqual(clickIdx, -1, "maybeContinue must call syntheticClick");
  assert.ok(
    armIdx < clickIdx,
    "hookArmSync must be called BEFORE syntheticClick, else the continuation POST " +
      "fires against an unarmed hook and slips past"
  );
});

test("regression: continue-no-stream recovery window is short (<= 10s)", () => {
  // The recovery window lives inside startWatchdog.
  const idx = INJ.indexOf("continue-no-stream recovery firing");
  assert.notEqual(idx, -1, "continue-no-stream trace not found");
  const window = INJ.slice(Math.max(0, idx - 500), idx + 200);
  const m = window.match(/now\s*-\s*t\.awaitContinue\s*>\s*(\d+)/);
  assert.ok(m, "continue-no-stream comparison not found");
  const v = Number(m![1]);
  assert.ok(
    v > 0 && v <= 10_000,
    `continue-no-stream window is ${v}ms; must be <= 10s so a failed Continue click cannot ` +
      `hang the caller for the old 30s per-attempt cycle`
  );
});

test("regression: no infinite Continue loop (recovery is bounded)", () => {
  const idx = INJ.indexOf("continue-no-stream recovery firing");
  const window = INJ.slice(idx, idx + 1200);
  assert.match(
    window,
    /finishTurn\(true\)/,
    "recovery must end the turn with the captured text when the Continue click never " +
      "produces a stream, instead of looping indefinitely"
  );
});
