import { test } from "node:test";
import assert from "node:assert/strict";
import { foldAll, firstMismatch, hashCanonical, ChainFolder, blake2b16 } from "../src/core/hashchain.js";
import type { ChatMessage } from "../src/core/canonical.js";

const A: ChatMessage = { role: "user", content: "alpha" };
const B: ChatMessage = { role: "assistant", content: "beta" };
const C: ChatMessage = { role: "user", content: "gamma" };

test("blake2b16 produces 16 bytes / 32 hex chars deterministically", () => {
  const h1 = blake2b16("hello");
  const h2 = blake2b16("hello");
  assert.equal(h1.length, 16);
  assert.equal(h1.toString("hex"), h2.toString("hex"));
  assert.notEqual(h1.toString("hex"), blake2b16("hellp").toString("hex"));
});

test("chain covers content and position", () => {
  const chain1 = foldAll([A, B]);
  const chain2 = foldAll([A, B, C]);
  // prefix property: first two digests identical
  assert.deepEqual(chain2.slice(0, 2), chain1);
  // reordered history produces a different chain (not a false match)
  const reordered = foldAll([B, A]);
  assert.notEqual(reordered[1], chain1[1]);
  // edited message changes every subsequent digest
  const edited = foldAll([A, { role: "assistant", content: "beta!" }]);
  assert.notEqual(edited[1], chain1[1]);
});

test("firstMismatch finds the earliest divergence", () => {
  const chain = foldAll([A, B, C]);
  assert.equal(firstMismatch(chain, [A, B, C]), -1);
  assert.equal(firstMismatch(chain, [A, B, { role: "user", content: "GAMMA" }]), 2);
  assert.equal(firstMismatch(chain, [{ role: "user", content: "X" }, B, C]), 0);
  // longer history with matching prefix -> no mismatch (delta handled by caller)
  assert.equal(firstMismatch(chain, [A, B, C, { role: "assistant", content: "d" }]), -1);
});

test("ChainFolder folds incrementally to the same head as foldAll", () => {
  const f = new ChainFolder();
  const h1 = f.push(A);
  const h2 = f.push(B);
  const all = foldAll([A, B]);
  assert.equal(h1, all[0]);
  assert.equal(h2, all[1]);
  assert.equal(f.head, all[1]);
  assert.equal(f.length, 2);
});

test("hashCanonical chains: prev participates in digest", () => {
  const a = hashCanonical(null, "S|x");
  const b = hashCanonical(a, "U|y");
  const b2 = hashCanonical(null, "U|y");
  assert.notEqual(b, b2);
});
