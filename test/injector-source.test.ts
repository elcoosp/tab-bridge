// Regression suite for the 2026-09-29 "Server is temporarily unavailable"
// misclassification bug.
//
// Observed failure:
//   1. DeepSeek rendered the outage banner and the reply bubble never grew.
//   2. The DOM tick's null path fired `submit-failed` because
//      serverDownVisible() lived only inside settleTurn() — with no bubble to
//      stabilize, settleTurn never ran.
//   3. The bridge saw submit_no_bubble:true and told the caller the tab was
//      untouched, when in fact the tool-results attachment WAS placed.
//      kod retried the identical request and burned a turn of provider quota
//      for a request that could not succeed while the provider was down.
//
// The injector runs in a browser and is not Node-importable, so this suite
// operates on the SOURCE TEXT:
//   * Behavioural tests evaluate the extracted `serverDownVisible` against
//     mock DOM shapes (banner in <div>, in <span>, with/without period, and
//     a false-positive guard for containers).
//   * Structural invariants assert which guards must run on which branches,
//     in which order — a regression that removed a check would be caught
//     even if the shape of the code shifted slightly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../extension/injector.js"), "utf8");

/**
 * Extract a top-level function declaration by name. Relies on the file's
 * convention that every top-level function closes with a `}` at column 0 —
 * which the injector has followed since inception.
 */
function extractFunction(name: string): string {
  const startRe = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = startRe.exec(SRC);
  if (!m) throw new Error(`function ${name}() not found in extension/injector.js — test needs updating if the declaration form changed`);
  const end = SRC.indexOf("\n}", m.index);
  if (end === -1) throw new Error(`closing brace for ${name}() not found`);
  return SRC.slice(m.index, end + 2);
}

/**
 * Build a sandboxed `serverDownVisible` bound to a mock document. The mock
 * only needs `querySelectorAll`, which must return objects shaped like
 * real elements: `{ children: any[], textContent: string }`.
 */
function makeServerDownVisible(
  documentMock: { querySelectorAll: (sel: string) => Array<{ children: unknown[]; textContent: string }> },
  // serverDownVisible consults findContinueButton() first (v1.2.55): a visible
  // Continue/retry affordance means the generation HALTED, not that the
  // provider is down. Default to "no button on screen" so the banner-scan
  // tests below still exercise the raw detection path unchanged.
  findContinueButtonMock: () => unknown = () => null
): () => boolean {
  const fn = extractFunction("serverDownVisible");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    "document",
    "findContinueButton",
    "trace",
    `${fn}\nreturn serverDownVisible;`
  );
  return factory(documentMock, findContinueButtonMock, () => {}) as () => boolean;
}

// ---------------------------------------------------------------------------
// Behavioural tests of the extracted detection logic.
// ---------------------------------------------------------------------------

test("regression: serverDownVisible detects the banner in a <div> (bug-trigger shape)", () => {
  // The bug on 2026-09-29: the current DeepSeek build renders the banner in a
  // <div>. The pre-fix implementation only queried <span>, so this exact
  // shape returned false and the turn was misclassified as submit-failed.
  const vis = makeServerDownVisible({
    querySelectorAll: () => [
      { children: [], textContent: "Server is temporarily unavailable." },
    ],
  });
  assert.equal(vis(), true, "banner in <div> must be detected");
});

test("regression: serverDownVisible detects the banner in a <span>", () => {
  const vis = makeServerDownVisible({
    querySelectorAll: () => [
      { children: [], textContent: "Server is temporarily unavailable." },
    ],
  });
  assert.equal(vis(), true, "banner in <span> must be detected");
});

test("regression: serverDownVisible detects the banner without its trailing period", () => {
  const vis = makeServerDownVisible({
    querySelectorAll: () => [
      { children: [], textContent: "Server is temporarily unavailable" },
    ],
  });
  assert.equal(vis(), true, "banner without a trailing period must still be detected");
});

test("regression: serverDownVisible ignores a large container that concatenates the banner with other text", () => {
  // A wrapper element whose textContent happens to include the sentence must
  // not be mistaken for the banner — otherwise a normal reply mentioning the
  // phrase would abort the turn.
  const vis = makeServerDownVisible({
    querySelectorAll: () => [
      {
        children: [{}, {}, {}], // > 2 children: treated as a container
        textContent: "Some assistant reply... Server is temporarily unavailable. ...etc",
      },
    ],
  });
  assert.equal(vis(), false, "containers with many children must not trigger the outage path");
});

test("regression: serverDownVisible ignores a long leaf that merely contains the phrase", () => {
  const vis = makeServerDownVisible({
    querySelectorAll: () => [
      {
        children: [],
        textContent: "x".repeat(200) + " Server is temporarily unavailable. " + "y".repeat(200),
      },
    ],
  });
  assert.equal(vis(), false, "long text blobs must not trigger the outage path");
});

test("regression: serverDownVisible returns false when the banner is absent", () => {
  const vis = makeServerDownVisible({
    querySelectorAll: () => [
      { children: [], textContent: "Here is the answer you asked for." },
    ],
  });
  assert.equal(vis(), false);
});

test("regression: serverDownVisible defers when a Continue button is on screen", () => {
  // v1.2.55: a visible Continue/retry affordance means the generation HALTED
  // mid-answer — the tab is healthy, just paused. serverDownVisible must
  // return false so the caller routes through maybeContinue instead of
  // misclassifying a resumable halt as a provider outage (which previously
  // triggered a RESET_RESEED and stranded the user's answer behind an
  // unclicked Continue button while the pool tab was emptied).
  const banner = { children: [], textContent: "Server is temporarily unavailable." };
  const vis = makeServerDownVisible(
    { querySelectorAll: () => [banner] },
    () => ({ tagName: "DIV" }) // findContinueButton returns a button node
  );
  assert.equal(
    vis(),
    false,
    "a visible Continue button must suppress the server-down signal, even when the banner is also present"
  );
});

test("regression: serverDownVisible falls through to the banner scan when no Continue button is on screen", () => {
  const banner = { children: [], textContent: "Server is temporarily unavailable." };
  const vis = makeServerDownVisible(
    { querySelectorAll: () => [banner] },
    () => null // no Continue button anywhere
  );
  assert.equal(vis(), true, "with no Continue button present, the banner must still classify as server-down");
});

// ---------------------------------------------------------------------------
// Structural invariants — the branches whose ORDER was the bug.
// ---------------------------------------------------------------------------

test("regression: retry affordance is clicked before failing onNoStream", () => {
  const idx = SRC.indexOf("async function onNoStream(");
  assert.notEqual(idx, -1, "onNoStream not found");
  const window = SRC.slice(idx, idx + 3000);
  const maybeIdx = window.indexOf('maybeContinue(t, "generation-failed-retry")');
  const failIdx = window.indexOf('"provider: generation failed (retry affordance visible)"');
  assert.notEqual(maybeIdx, -1, "onNoStream must call maybeContinue for the retry affordance");
  assert.notEqual(failIdx, -1, "onNoStream must still have the fail-fast fallback");
  assert.ok(
    maybeIdx < failIdx,
    "maybeContinue(generation-failed-retry) must run BEFORE the finishTurn fail-fast in onNoStream"
  );
});

test("regression: onNoStream checks serverDownVisible() before the re-submit branch", () => {
  const idx = SRC.indexOf("async function onNoStream(");
  assert.notEqual(idx, -1, "onNoStream not found — injector structure drifted");
  const body = SRC.slice(idx, idx + 2500);
  const serverDownIdx = body.indexOf("serverDownVisible()");
  const resubmitIdx = body.indexOf("submitPrompt(");
  assert.notEqual(serverDownIdx, -1, "serverDownVisible() not called in onNoStream");
  assert.notEqual(resubmitIdx, -1, "submitPrompt() re-submit branch not found in onNoStream");
  assert.ok(
    serverDownIdx < resubmitIdx,
    "serverDownVisible() must short-circuit onNoStream BEFORE the re-submit path, else a re-submit runs against a provider that is still down"
  );
});

test("regression: serverDownVisible queries span, div, and p — not span only", () => {
  const fn = extractFunction("serverDownVisible");
  assert.match(
    fn,
    /"span,\s*div,\s*p"|'span,\s*div,\s*p'/,
    "serverDownVisible must query span, div, and p — the banner is rendered in different element types across builds"
  );
});

test("regression: serverDownVisible accepts both punctuated and bare forms", () => {
  const fn = extractFunction("serverDownVisible");
  const acceptsBare = /t\s*===\s*needle\b/.test(fn);
  const acceptsPunct = /t\s*===\s*needle\s*\+\s*"\."/.test(fn);
  const acceptsPrefix = /t\.startsWith\(needle\)/.test(fn);
  assert.ok(
    acceptsBare || acceptsPrefix,
    "serverDownVisible must accept the bare sentence (some builds omit the period)"
  );
  assert.ok(
    acceptsPunct || acceptsPrefix,
    "serverDownVisible must accept the punctuated sentence"
  );
});

test("regression: findContinueButton caps label length so a reply cannot be misread as the button", () => {
  const fn = extractFunction("findContinueButton");
  assert.match(fn, /label\.length\s*>\s*\d+/, "findContinueButton must cap label length");
});

test("regression: CONTINUE_RE covers 'continue generating' and 'resume'", () => {
  const m = SRC.match(/const\s+CONTINUE_RE\s*=\s*\/[^\n]*\/[a-z]*\s*;/);
  assert.ok(m, "CONTINUE_RE declaration not found");
  const decl = m![0];
  assert.match(decl, /continue/, "CONTINUE_RE must include 'continue'");
  assert.match(decl, /continue\\s\+generating/, "CONTINUE_RE must accept 'continue generating'");
  assert.match(decl, /resume/, "CONTINUE_RE must accept 'resume'");
});

test("regression: composer and sendButton selectors do not depend on generated hash classes", () => {
  // Generated CSS-in-JS hashes look like `_52c986b` or `db183363` and change
  // on every DeepSeek deploy. They must never appear in a SELECTORS value.
  const selectorsBlock = SRC.slice(
    SRC.indexOf("const SELECTORS = {"),
    SRC.indexOf("};", SRC.indexOf("const SELECTORS = {"))
  );
  // Strip line comments before scanning — hashes in documentation are fine.
  const withoutComments = selectorsBlock
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  assert.doesNotMatch(
    withoutComments,
    /_\$?\{?[0-9a-f]{7,8}\b/,
    "SELECTORS must never reference generated hash class names"
  );
});

test("regression: serverDownVisible defers to a visible Continue button", () => {
  // A visible Continue / retry affordance means the generation halted with
  // more available — the tab is healthy, just paused. serverDownVisible must
  // return false so the turn routes through maybeContinue instead of being
  // misclassified as a provider outage (which triggers a RESET_RESEED and
  // strands the user's answer behind an unclicked Continue button).
  const fn = extractFunction("serverDownVisible");
  assert.match(fn, /findContinueButton\(\)/, "serverDownVisible must consult findContinueButton");
  const contIdx = fn.indexOf("findContinueButton()");
  const needleIdx = fn.indexOf("Server is temporarily unavailable");
  assert.notEqual(contIdx, -1, "must call findContinueButton");
  assert.notEqual(needleIdx, -1, "must still contain the server-down needle");
  assert.ok(
    contIdx < needleIdx,
    "the Continue-button guard must run BEFORE the server-down text scan"
  );
});
