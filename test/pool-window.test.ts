// Regression suite for the 2026-09-29 "background-tab throttling slows the
// first fragment by 60–120 s" bug.
//
// Chrome intensively throttles timers in hidden tabs. DeepSeek's
// paste-to-file pipeline is driven by React + timers, so a managed tab
// created in the user's main window (and never activated) runs the
// attachment conversion at throttled speed: first fragment at 113 s
// instead of ~3 s. The fix puts managed tabs in a dedicated "pool window"
// created with focused:false — visible enough that its active tab is not
// intensively throttled, but never stealing OS focus. On every SEND the
// worker activates the target tab in the pool window. Reads
// extension/background.js as source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../extension/background.js"), "utf8");

test("regression: poolWindowId state is declared", () => {
  assert.match(SRC, /let\s+poolWindowId\s*=/, "poolWindowId state not declared");
});

test("regression: ensurePoolWindow creates a window with focused:false", () => {
  assert.match(SRC, /async\s+function\s+ensurePoolWindow/, "ensurePoolWindow not declared");
  // Match the create call with focused:false anywhere inside the helper.
  const idx = SRC.indexOf("async function ensurePoolWindow");
  const end = SRC.indexOf("\n}", idx);
  const body = SRC.slice(idx, end);
  assert.match(body, /chrome\.windows\.create/, "ensurePoolWindow must call chrome.windows.create");
  assert.match(body, /focused:\s*false/, "pool window must be created with focused:false");
});

test("regression: allocateTab routes managed tabs into the pool window", () => {
  const idx = SRC.indexOf("async function allocateTab");
  const end = SRC.indexOf("\n}", idx);
  const body = SRC.slice(idx, end);
  assert.match(body, /ensurePoolWindow\(\)/, "allocateTab must call ensurePoolWindow");
  assert.match(body, /windowId:\s*poolWin/, "allocateTab must pass windowId to chrome.tabs.create");
});

test("regression: SEND handler activates the target tab", () => {
  const idx = SRC.indexOf("function handleSend(");
  const end = SRC.indexOf("\n}", idx);
  const body = SRC.slice(idx, end);
  assert.match(
    body,
    /chrome\.tabs\.update\(useTab,\s*\{\s*active:\s*true\s*\}/,
    "SEND handler must activate the target tab so its timers run unthrottled"
  );
});

test("regression: pool window removal clears the cached id", () => {
  assert.match(
    SRC,
    /chrome\.windows\.onRemoved\.addListener/,
    "must handle pool window removal"
  );
  const idx = SRC.indexOf("chrome.windows.onRemoved.addListener");
  const body = SRC.slice(idx, idx + 600);
  assert.match(body, /poolWindowId\s*=\s*null/, "removal handler must clear poolWindowId");
});

test("regression: pool window id persists across SW restarts via storage.session", () => {
  assert.match(
    SRC,
    /chrome\.storage\.session\.get/,
    "pool window id must persist via chrome.storage.session"
  );
  assert.match(
    SRC,
    /chrome\.storage\.session\.set/,
    "pool window id must be written to chrome.storage.session"
  );
});
