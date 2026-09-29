// Regression suite for the 2026-09-29 "~11s dead time before the prompt
// appeared in the composer" bug.
//
// waitStableSend runs BEFORE placeText, at which point the composer is
// empty. The pre-fix condition was `!stopBtn && isEnabled(sendBtn)`. On an
// empty composer DeepSeek keeps the send button disabled by design, so
// isEnabled(sendBtn) was false, stableSince reset to 0, and the loop spun
// until the 8000ms timeout fired and the 3000ms grace re-check also
// expired. Every turn paid ~11s of client-side dead time:
//   turn.accepted 11:38:54.752 -> first FRAGMENT 11:39:08.757 (14.0s).
//
// The v1.2.33 fix gates only on `!stopBtn` — the previous generation's
// stop control — since the empty composer's disabled send button is
// expected, not a reason to wait. The post-placeText enabled-state gate
// lives in waitReadyToSubmit().
//
// Two invariants are checked here:
//   1. STRUCTURAL: waitStableSend does not call isEnabled() or
//      findSendButton() — reintroducing either would bring back the spin.
//   2. BEHAVIOURAL: given no stop button, waitStableSend returns within a
//      few hundred milliseconds, regardless of its timeout ceiling. This
//      is what the fix actually promises.

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

/**
 * Sandbox that lets us run the real `waitStableSend` source against a
 * virtual clock. `Date`, `findFirst`, `SELECTORS`, and `sleep` are all
 * passed in as parameters to the factory — the only outside references
 * the function body needs.
 */
function makeSandbox(opts: { stopButtonPresent: boolean }) {
  let virtualNow = 0;
  const sleepCalls: number[] = [];
  const mockDate = { now: () => virtualNow };
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    virtualNow += ms;
  };
  const mockFindFirst = (sels: unknown) =>
    opts.stopButtonPresent && Array.isArray(sels) && (sels as string[]).includes("STOP") ? {} : null;
  const fn = extractFunction("waitStableSend");
  const factory = new Function(
    "Date", "findFirst", "SELECTORS", "sleep",
    `${fn}\nreturn waitStableSend;`
  );
  const waitStableSend = factory(
    mockDate,
    mockFindFirst,
    { stopButton: ["STOP"] },
    mockSleep
  ) as (composer: unknown, timeoutMs: number) => Promise<boolean>;
  return { waitStableSend, sleepCalls, getNow: () => virtualNow };
}

// ---------------------------------------------------------------------------
// Behavioural: the fix's actual promise.
// ---------------------------------------------------------------------------

test("regression: waitStableSend returns fast when no stop button is present", async () => {
  const sb = makeSandbox({ stopButtonPresent: false });
  const start = sb.getNow();
  // Use the real on-disk ceiling (8000ms) — pre-fix, this call would have
  // consumed the full budget; post-fix, it must return after the 300ms
  // stability window (three consecutive 100ms polls).
  const ok = await sb.waitStableSend({}, 8000);
  const elapsed = sb.getNow() - start;
  assert.equal(ok, true, "waitStableSend must succeed when the stop control is absent");
  assert.ok(
    elapsed <= 500,
    `waitStableSend took ${elapsed}ms of virtual time when no stop button was ` +
      `present — must be ~300ms (3 consecutive 100ms polls). The v1.2.33 fix ` +
      `gates on the stop control only; if this regresses, an empty composer ` +
      `will once again spin to the timeout.`
  );
});


// ---------------------------------------------------------------------------
// Structural: the ordering invariants whose violation WAS the bug.
// ---------------------------------------------------------------------------

test("regression: waitStableSend does not call isEnabled() or findSendButton()", () => {
  const fn = extractFunction("waitStableSend");
  assert.doesNotMatch(
    fn,
    /isEnabled\s*\(/,
    "waitStableSend must not call isEnabled() — the composer is empty at this " +
      "point, so a disabled send button is expected, not a reason to wait"
  );
  assert.doesNotMatch(
    fn,
    /findSendButton\s*\(/,
    "waitStableSend must not call findSendButton() — its enabled-state check " +
      "belongs in waitReadyToSubmit(), after placeText"
  );
});

test("regression: waitStableSend's condition references the stop control", () => {
  const fn = extractFunction("waitStableSend");
  assert.match(
    fn,
    /!stopBtn|!findFirst\(SELECTORS\.stopButton\)/,
    "waitStableSend must gate on the absence of the stop control"
  );
});

test("regression: waitReadyToSubmit still does the post-placeText enabled-state gate", () => {
  const fn = extractFunction("waitReadyToSubmit");
  assert.match(
    fn,
    /isEnabled\s*\(/,
    "waitReadyToSubmit must still gate on the send control being enabled — " +
      "that is the correct place for that check"
  );
});

test("regression: waitStableSend's ceiling stays under the submit-ready timeout", () => {
  // Sanity ceiling only: the primary timeout must be clearly smaller than
  // the 90s submit-ready budget, so a genuine issue surfaces promptly.
  // The behavioural test above is the real proof; this is a sniff test that
  // a future edit did not accidentally pass 90000 to the pre-placeText wait.
  const spIdx = SRC.indexOf("async function submitPrompt(");
  assert.notEqual(spIdx, -1, "submitPrompt not found");
  const spEnd = SRC.indexOf("\n}", spIdx);
  const body = SRC.slice(spIdx, spEnd);
  const calls = [...body.matchAll(/waitStableSend\(\s*composer\s*,\s*(\d+)\s*\)/g)];
  assert.ok(calls.length > 0, "no waitStableSend() calls found in submitPrompt");
  for (const m of calls) {
    const ms = Number(m[1]);
    assert.ok(
      ms < 30000,
      `waitStableSend called with ${ms}ms — the pre-placeText wait must stay ` +
        `well under the 90s submit-ready budget`
    );
  }
});
