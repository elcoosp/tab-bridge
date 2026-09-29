// Latency-budget regression suite for extension/injector.js.
//
// Perceived "waiting" in a kod session has two parts:
//   1. Client-side dead time before the provider sees the submit
//      (waitStableSend + placeText + reply-baseline settle).
//   2. The provider's "thinking" phase before the first visible fragment.
//
// The provider's portion cannot be compressed from the client. The client's
// can, and these tests pin the constants we control so a future change
// cannot silently reintroduce seconds of dead time.
//
// Reading the source as text is honest: the injector is a browser content
// script and cannot be imported under Node. The budget checks are on the
// numeric literals that define the client-side cost.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../extension/injector.js"), "utf8");

function constNumber(name: string): number {
  const m = SRC.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`const ${name} not found in extension/injector.js`);
  return Number(m[1]);
}

test("latency budget: REPLY_BASELINE_SETTLE_MS stays <= 500ms", () => {
  const v = constNumber("REPLY_BASELINE_SETTLE_MS");
  assert.ok(
    v <= 500,
    `REPLY_BASELINE_SETTLE_MS is ${v}ms; must stay <= 500ms. ` +
      "Every millisecond here is dead time between a verified submit " +
      "and the streaming watchdogs starting up."
  );
});

test("latency budget: waitStableSend stability window stays <= 400ms", () => {
  const m = SRC.match(/Date\.now\(\)\s*-\s*stableSince\s*>=\s*(\d+)/);
  assert.ok(m, "waitStableSend stability comparison not found");
  const v = Number(m![1]);
  assert.ok(
    v <= 400,
    `waitStableSend stability window is ${v}ms; must stay <= 400ms. ` +
      "The live button state is re-checked before the click, so a longer " +
      "window is dead time."
  );
});

test("latency budget: placeText sleeps stay bounded", () => {
  const pasteM = SRC.match(/await sleep\((\d+)\);\s*\n\s*const pasted = readComposer/);
  assert.ok(pasteM, "paste path sleep not found in placeText");
  const pasteMs = Number(pasteM![1]);
  assert.ok(pasteMs <= 500, `paste path sleep is ${pasteMs}ms; must stay <= 500ms`);

  const inlineM = SRC.match(/setComposerValue\(composer, text\);\s*\n\s*await sleep\((\d+)\);/);
  assert.ok(inlineM, "inline path sleep not found in placeText");
  const inlineMs = Number(inlineM![1]);
  assert.ok(inlineMs <= 300, `inline path sleep is ${inlineMs}ms; must stay <= 300ms`);
});

test("latency: submitPrompt logs its elapsed time", () => {
  assert.match(
    SRC,
    /dbg\("submitted in "\s*\+\s*\(Date\.now\(\)\s*-\s*t\.startedAt\)/,
    "submitPrompt must log elapsed time to separate client from provider cost"
  );
});

test("latency: first-fragment logs its elapsed time", () => {
  assert.match(
    SRC,
    /dbg\("first fragment "\s*\+\s*\(Date\.now\(\)\s*-\s*t\.startedAt\)/,
    "first fragment must log elapsed time so TTFT is measurable from the tab console"
  );
});
