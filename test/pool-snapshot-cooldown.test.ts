// Regression: tabsSnapshot must lazily expire rate-limit cooldowns.
//
// 2026-10-01 log: after a 20-min rate-limit cooldown elapsed, the stateful
// session's row.tabId was still set, so ensureTabAndReady skipped BIND and
// went straight to adapter.ensureReady → pool.ping → worker's tabsSnapshot.
// The tab's st.health was still "rate_limited" because tabInCooldown (the
// only code that clears it on expiry) is called from allocateTab, and no
// BIND was sent. The harness saw provider-rate-limited three retries in a
// row, each in ~5 ms.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../extension/background.js"), "utf8");

test("tabsSnapshot calls tabInCooldown before reading st.health", () => {
  const idx = SRC.indexOf("function tabsSnapshot(");
  assert.notEqual(idx, -1, "tabsSnapshot not found");
  const end = SRC.indexOf("\n}", idx);
  const body = SRC.slice(idx, end + 2);
  assert.match(
    body,
    /tabInCooldown\(tabId, st\)/,
    "tabsSnapshot must call tabInCooldown so a PONG snapshot reflects post-cooldown state"
  );
  const callIdx = body.indexOf("tabInCooldown(tabId, st)");
  // Search for the property READ, not any mention of st.health (the doc
  // comment above describes the bug and mentions st.health in prose).
  const readIdx = body.indexOf("health: st.health");
  assert.notEqual(readIdx, -1, "the health property read must be present");
  assert.ok(
    callIdx < readIdx,
    "tabInCooldown must run before the health field is read"
  );
});
