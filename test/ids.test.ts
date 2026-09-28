import { test } from "node:test";
import assert from "node:assert/strict";
import { synthCallId } from "../src/emulation/ids.js";

test("identical parallel calls get distinct ids per occurrence", () => {
  const a = synthCallId("read_file", '{"path":"x"}', 0);
  const b = synthCallId("read_file", '{"path":"x"}', 1);
  assert.notEqual(a, b);
  assert.equal(synthCallId("read_file", '{"path":"x"}', 0), a); // still deterministic
});
