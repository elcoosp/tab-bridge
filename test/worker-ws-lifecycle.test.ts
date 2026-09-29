// Regression suite for the 2026-09-29 worker-WS flapping metronome.
//
// Observed: the SW reconnects, gets HELLO_OK, then dies ~500ms later with
// `read ECONNRESET` on the bridge. Because HELLO_OK reset the reconnect
// backoff to 1s, the loop repeated every ~1s. Root cause is an uncaught
// throw in a port.onMessage handler (RESET_OK path) terminating the SW,
// which closes the WS abruptly. This suite reads extension/background.js
// as source text and asserts the invariants whose violation WAS the loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../extension/background.js"), "utf8");

test("regression: send() wraps ws.send in try/catch", () => {
  // The send helper is the SW's only outbound WS path. If a send throws
  // (readyState race, buffer full), the uncaught error terminates the SW
  // and the WS dies. The try/catch is the guard against that.
  const m = SRC.match(/function\s+send\s*\(obj\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, "send() not found in background.js");
  assert.match(m![0], /try\s*\{[\s\S]*ws\.send\(/, "send() must wrap ws.send in try/catch");
  assert.match(m![0], /catch\s*\(/, "send() must catch the ws.send failure");
});

test("regression: port.onMessage wraps the handler in try/catch", () => {
  // The flapping trigger was an uncaught throw in a port message handler
  // terminating the SW. Every port message must be dispatched via a
  // try/catch wrapper.
  const idx = SRC.indexOf("port.onMessage.addListener");
  assert.notEqual(idx, -1, "port.onMessage.addListener not found");
  const window = SRC.slice(idx, idx + 500);
  assert.match(
    window,
    /try\s*\{/,
    "port.onMessage listener must wrap its body in try/catch so one bad message cannot terminate the SW"
  );
  assert.match(
    window,
    /catch\s*\(/,
    "port.onMessage listener must have a catch clause"
  );
});

test("regression: backoff does NOT reset on HELLO_OK", () => {
  // Resetting backoff on HELLO_OK makes a flapping connection reconnect
  // every 1s forever. The reset must live in the close handler, gated on
  // connection uptime.
  const idx = SRC.indexOf('m.t === "HELLO_OK"');
  assert.notEqual(idx, -1, 'HELLO_OK branch not found');
  const window = SRC.slice(idx, idx + 400);
  assert.doesNotMatch(
    window,
    /backoff\s*=\s*RECONNECT_MIN_MS/,
    "HELLO_OK must NOT reset backoff — a connection that dies shortly after " +
      "HELLO_OK is a flap and must grow backoff, or the worker reconnects " +
      "every 1s forever"
  );
});

test("regression: close handler distinguishes flap from stable close", () => {
  const idx = SRC.indexOf('ws.addEventListener("close"');
  assert.notEqual(idx, -1, "WS close handler not found");
  const window = SRC.slice(idx, idx + 1500);
  assert.match(
    window,
    /STABLE_CONNECTION_MS/,
    "close handler must reference STABLE_CONNECTION_MS to distinguish flap from stable close"
  );
  assert.match(
    window,
    /connectedAt/,
    "close handler must compute uptime from connectedAt"
  );
  assert.match(
    window,
    /backoff\s*=\s*RECONNECT_MIN_MS/,
    "close handler must reset backoff on a stable close"
  );
});

test("regression: STABLE_CONNECTION_MS is defined and reasonable", () => {
  const m = SRC.match(/const\s+STABLE_CONNECTION_MS\s*=\s*(\d+)/);
  assert.ok(m, "STABLE_CONNECTION_MS not declared");
  const v = Number(m![1]);
  assert.ok(
    v >= 1000 && v <= 30000,
    `STABLE_CONNECTION_MS is ${v}ms — must be between 1s and 30s to cleanly ` +
      `separate the flap regime (~500ms connections) from the stable regime ` +
      `(seconds-to-minutes)`
  );
});
