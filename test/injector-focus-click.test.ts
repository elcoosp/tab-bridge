// Regression suite for the 2026-09-29 "Continue click is dispatched but
// refused because the pool window is never focused" bug.
//
// Log: clicked: true, keyboardActivated: true, stillThere: true,
// streamAfterClick: false. Every activation attempt dispatched, none
// registered. The one signal a synthetic event cannot supply that a real
// click always carries is document.hasFocus(); the pool window is created
// with focused:false and the SEND handler only does chrome.tabs.update({
// active: true }) — intra-window activation, not OS focus. A defensive
// handler that guards on focus silently refuses every synthetic click.
//
// Fix: the injector asks the SW to briefly focus the pool window before
// dispatching, and restores the user's prior focus afterwards. Reads both
// extension/injector.js and extension/background.js as source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const INJ = readFileSync(join(here, "../../extension/injector.js"), "utf8");
const BG = readFileSync(join(here, "../../extension/background.js"), "utf8");

function extractFunction(src: string, name: string): string {
  const re = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name}() not found`);
  const end = src.indexOf("\n}", m.index);
  if (end === -1) throw new Error(`closing brace for ${name}() not found`);
  return src.slice(m.index, end + 2);
}

test("sw: priorFocusedWindowId state is declared", () => {
  assert.match(BG, /let\s+priorFocusedWindowId\s*=/, "priorFocusedWindowId not declared");
});

test("sw: focusPoolForInjection focuses the pool window", () => {
  const fn = extractFunction(BG, "focusPoolForInjection");
  assert.match(fn, /chrome\.windows\.getLastFocused/, "must capture the user's current window");
  assert.match(fn, /chrome\.windows\.update\(\s*poolWindowId\s*,\s*\{\s*focused:\s*true/, "must focus the pool window");
});

test("sw: restorePriorFocus restores the captured window", () => {
  const fn = extractFunction(BG, "restorePriorFocus");
  assert.match(fn, /chrome\.windows\.update/, "must call chrome.windows.update");
  assert.match(fn, /focused:\s*true/, "must focus the captured window");
});

test("sw: handleInjectorMessage intercepts FOCUS_POOL_WINDOW and RESTORE_FOCUS", () => {
  const idx = BG.indexOf("function handleInjectorMessage(");
  assert.notEqual(idx, -1);
  const body = BG.slice(idx, idx + 600);
  assert.match(body, /msg\.t\s*===\s*"FOCUS_POOL_WINDOW"/, "must intercept FOCUS_POOL_WINDOW");
  assert.match(body, /msg\.t\s*===\s*"RESTORE_FOCUS"/, "must intercept RESTORE_FOCUS");
  assert.match(body, /focusPoolForInjection\(\)/, "must call focusPoolForInjection");
  assert.match(body, /restorePriorFocus\(\)/, "must call restorePriorFocus");
});

test("injector: maybeContinue sends FOCUS_POOL_WINDOW before dispatching", () => {
  const fn = extractFunction(INJ, "maybeContinue");
  const focusIdx = fn.indexOf('report("FOCUS_POOL_WINDOW")');
  const clickIdx = fn.indexOf("syntheticClick(btnRef)");
  assert.notEqual(focusIdx, -1, "maybeContinue must send FOCUS_POOL_WINDOW");
  assert.notEqual(clickIdx, -1, "maybeContinue must call syntheticClick(btnRef)");
  assert.ok(
    focusIdx < clickIdx,
    "FOCUS_POOL_WINDOW must be sent BEFORE the click is dispatched, else the " +
      "click lands on a still-unfocused tab and is refused"
  );
});

test("injector: maybeContinue restores focus after dispatch", () => {
  const fn = extractFunction(INJ, "maybeContinue");
  assert.match(fn, /report\("RESTORE_FOCUS"\)/, "maybeContinue must send RESTORE_FOCUS");
});

test("injector: maybeContinue dispatches inside a setTimeout (waiting for focus)", () => {
  const fn = extractFunction(INJ, "maybeContinue");
  // The dispatch must be inside a setTimeout callback so the SW has time to
  // focus the pool window first.
  const focusIdx = fn.indexOf('report("FOCUS_POOL_WINDOW")');
  const setIdx = fn.indexOf("setTimeout(", focusIdx);
  const clickIdx = fn.indexOf("syntheticClick(btnRef)");
  assert.notEqual(setIdx, -1, "must have a setTimeout after FOCUS_POOL_WINDOW");
  assert.ok(
    setIdx < clickIdx,
    "syntheticClick must be inside the setTimeout callback that runs after focus"
  );
});
