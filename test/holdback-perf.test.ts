// P2 regression: feed many fragments while holding; per-push cost must not
// scale with the whole buffer. The audit measured ~25 ms per push at the
// default 64 KiB ceiling with the naive indexOf — O(n²) over a full buffer.
// The bound here is generous (250 ms) so it only fires on catastrophic
// regressions; a true O(n²) at this size takes >100 s, so we catch it easily
// while tolerating a slow/loaded CI host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HoldbackBuffer } from "../src/emulation/holdback.js";

test("P2: holdback push cost stays near-linear in fragment size", () => {
  const ceiling = 65_536;
  const hb = new HoldbackBuffer(ceiling);
  hb.push("```tool_call\n");
  const chunk = "x".repeat(8);
  const N = (ceiling - 64) / chunk.length;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) hb.push(chunk);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(
    elapsedMs < 250,
    `holdback push loop took ${elapsedMs.toFixed(1)}ms; expected <250ms (O(n^2) rescan regression?)`
  );
});
