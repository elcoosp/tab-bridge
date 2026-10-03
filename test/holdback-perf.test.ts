// P2 regression: verify holdback push cost scales roughly linearly with the
// number of pushes, not quadratically. The audit measured ~25 ms per push at
// the default 64 KiB ceiling with the naive indexOf — over the ~8000 pushes
// in the loop below that is roughly 200 s of pure rescanning, whereas the
// fixed version completes in a few ms on an idle host.
//
// We use TWO assertions:
//   1. A shape check that compares small-N and large-N wall times. An O(n²)
//      implementation makes large/small scale with N; O(n) keeps it near 1.
//      This is host-load independent because both halves are measured on the
//      same machine at the same instant.
//   2. A very generous absolute cap (10 s) as a catastrophe net — well below
//      the O(n²) floor, well above any plausible O(n) time even on a loaded
//      CI host. This never flakes; it only fires when the fix is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HoldbackBuffer } from "../src/emulation/holdback.js";

function pushLoop(n: number): number {
  const hb = new HoldbackBuffer(65_536);
  hb.push("```tool_call\n");
  const chunk = "x".repeat(8);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) hb.push(chunk);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test("P2: holdback push cost scales linearly, not quadratically", () => {
  // Warm up JIT so the first measured run is not penalized.
  pushLoop(512);
  // Small N = 1024 pushes (~8 KiB held), large N = 8192 pushes (~64 KiB held).
  // Quadratic cost makes large/small ≈ 64; linear keeps it ≤ ~10 even on a
  // loaded host.
  const small = Math.max(pushLoop(1_024), 0.1);
  const large = pushLoop(8_192);
  const ratio = large / small;
  assert.ok(
    ratio < 30,
    `holdback scaling ratio (large/small) = ${ratio.toFixed(1)}; expected <30 (O(n^2) rescan regression?)`
  );
  // Catastrophe net: even a heavily loaded host finishes 8192 O(n) pushes
  // well under 10 s. The O(n^2) version takes ~200 s.
  assert.ok(large < 10_000, `large push loop took ${large.toFixed(0)}ms; expected <10000ms`);
});
