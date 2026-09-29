# tab-bridge — handoff for the Continue-button resume bug

**Snapshot:** 2026-09-29, immediately after a session that chased the
"DeepSeek halts mid-generation, paints a Continue button, and the injector
fails to click it" bug.

**Repo:** `github.com/elcoosp/tab-bridge`
**Local path used in this session:** `/Users/adm/Documents/Repos/tab-bridge`
**Stack:** TypeScript (Node ≥ 20) + Chrome MV3 extension. Zero runtime deps.
**Build / test:** `pnpm install && pnpm test` (build + `node --test dist/test/*.test.js`)
**E2E:** `pnpm run e2e` (spawns real bridge, real WebSocket worker, real HTTP/SSE)

---

## 1. What tab-bridge is, in one paragraph

An OpenAI-compatible HTTP facade over a stateful DeepSeek web chat tab.
`kod` (a Rust coding-agent harness) posts OpenAI chat-completion requests to
the bridge; the bridge compiles each request into flat prompt text, submits
it into a managed DeepSeek tab via a Chrome extension, reads the reply back
off the completion SSE stream, and returns OpenAI-shaped responses. Five
strict layers (facade → session/reconciliation → tool-call emulation →
provider adapter → browser runtime). See `docs/SPEC.md` for the full design.

---

## 2. The bug being chased

DeepSeek's web UI halts mid-generation (token budget, provider hiccup,
reasoning-window cap) and renders a **Continue** button next to the last
message. Clicking it resumes the same generation and fires a second
`POST /api/v0/chat/completion`, whose stream the injector's SSE hook can
capture with a re-arm.

The injector's watchdog is supposed to click Continue automatically within
~3 s of the stream going quiet (see `CONTINUE_IDLE_THRESHOLD_MS`). It finds
the button and reports `clicked: true, keyboardActivated: true`, but the
button stays in the DOM (`stillThere: true`) and no continuation POST is
seen (`streamAfterClick: false`). The turn ends with the partial text.

**Key asymmetry:** the *send* button (same `div[role="button"]` shape)
accepts our synthetic click. The *Continue* button does not. Same dispatch
code, different outcome. The leading hypothesis is that the Continue
handler checks `event.isTrusted === true` — the one property JavaScript
cannot forge.

---

## 3. The Continue button DOM (from a live dump)

```html
<div role="button"
     class="ds-button ds-button--outlinedNeutral ds-button--outlined
            ds-button--capsule ds-button--s ds-button--icon-relative-m
            ds-button--min-width _6eef0b0"
     tabindex="0">
  <div class="ds-button__background"></div>
  <div class="ds-button__border"></div>
  <span class="ds-button__content">Continue</span>
</div>
```

Notable: no React props on the element itself. `dumpReactHandlers` walks
ancestors up to 20 hops and still reports `(no react props)`. The button
is likely rendered by a portal or via a non-React path (or through a fiber
that does not expose `__reactProps$` in this DeepSeek build).

There is also an **icon-only retry** variant (warning-coloured circle,
reload-arrow svg, no label) rendered after a different class of halt. Both
shapes must be clickable. `findContinueButton` already matches both via
label and structural selectors.

---

## 4. Current on-disk state

**Version:** 1.2.43 in `package.json`, `extension/manifest.json`,
`extension/sse-hook.js`.

**Last successful build + test:** 213 tests, 210 pass, **3 fail** (all
stale `maybeContinue` shape assertions — see §6).

**Uncommitted since the last green commit** (the tree is dirty):

- `extension/background.js`: `focusPoolForInjection()` / `restorePriorFocus()`
  plus `FOCUS_POOL_WINDOW` / `RESTORE_FOCUS` intent handlers. These were a
  *wrong hypothesis* (focus-steal) and are now dead code — the next fix
  removes them from `maybeContinue` and can leave the SW helpers in place
  or strip them.
- `extension/injector.js`: `maybeContinue` rewritten to steal focus
  before clicking; also has the multi-target `syntheticClick`,
  `detail: 1`, `dumpReactHandlers` ancestor-walking, and `hookArmSync`.
- `extension/injector.js`: `deepReactActivate` exists but the last patch
  script that tried to re-insert its call into the second-wave recovery
  **failed on a whitespace anchor**, so the call is currently missing.
- `extension/manifest.json`: only the version bump (no `debugger`
  permission yet — see §7).

**Failing tests** (they will fail until the next patch updates them):
- `test/injector-instrumentation.test.ts` — asserts `syntheticClick(btn)`,
  but the current code uses `syntheticClick(btnRef)`.
- `test/injector-resume-click.test.ts` — same.
- `test/injector-fiber-activate.test.ts` — asserts
  `deepReactActivate(btn2)` is called in the second-wave recovery; the
  call is currently absent.

---

## 5. What has been tried, and what was learned

Listed chronologically. All the ones marked *landed* are on disk in 1.2.43.
None of the "not effective" items are wrong; they simply do not address the
`isTrusted` gate.

| Attempt | Status | What we learned |
|---|---|---|
| `serverDownVisible()` broadening | landed | separate bug (provider outage); fixed |
| `generationFailedVisible()` structural detector | landed | separate bug (failed generation); fixed |
| Fast Continue detection at 3 s | landed | watchdog now checks Continue before the 120 s idle net |
| `hookArmSync` (synchronous cross-world arm via CustomEvent + dataset) | landed | closes the race where the continuation POST fired before the async arm landed |
| `syntheticClick` multi-target + `Event('click')` + `detail: 1` | landed, **not effective** | the button survives all synthetic dispatch |
| `deepReactActivate` (fiber-return walk, invokes `onClick` etc.) | landed, **not effective** | target has no React props; fiber not found |
| `dumpReactHandlers` ancestor walking | landed | reports `(no react props)` on the element AND all 20 ancestors |
| Focus-steal (`FOCUS_POOL_WINDOW` / `RESTORE_FOCUS`) | **wrong hypothesis** | the focus-steal does not change the outcome; it also has the UX cost of briefly stealing the user's window focus |

**Diagnostic from the last real repro** (verbatim, from the SW console):

```
[tab-bridge] maybeContinue: button {"why":"sse-complete", ..., "reactHandlers":"(no react props)"}
[tab-bridge] clicking Continue (1/5, sse-complete)
[tab-bridge] maybeContinue: activated {"why":"sse-complete","continues":1,"clicked":true,"keyboardActivated":true,"label":"Continue"}
[tab-bridge] maybeContinue: post-click state {"reqId":"req_b5f0dc0d7d06b220","stillThere":true,"label":"Continue","streamAfterClick":false}
[tab-bridge] maybeContinue: retrying with focus + Enter only
```

Every activation dispatched. Nothing registered.

---

## 6. The next fix to apply (proposed but not yet on disk)

**Use `chrome.debugger` + CDP `Input.dispatchMouseEvent` to produce a
genuinely trusted click.** This is the same primitive Puppeteer, Cypress,
and Playwright use for input injection. Events delivered this way carry
`isTrusted: true` by construction, so any handler that refuses synthetic
events will accept them.

### 6.1 The full patch

The complete bash script is in the session transcript as the last
assistant message before this handoff. Re-run it verbatim — it does:

1. Adds `"debugger"` to `permissions` in `extension/manifest.json`.
2. Adds `debuggerClick(tabId, x, y)` + `DEBUGGER_CLICK` interception to
   `extension/background.js`.
3. Rewrites `maybeContinue` in `extension/injector.js` to:
   - compute the button's bounding-rect center,
   - arm the SSE hook synchronously (as before),
   - request a trusted click via `chrome.debugger` through the SW,
   - fall back to `syntheticClick` + `keyboardActivate` on debugger failure,
   - log a 500 ms post-click state.
   - **remove** the `FOCUS_POOL_WINDOW` / `RESTORE_FOCUS` dance.
4. Bumps the version to `1.2.44`.

### 6.2 Companion test fixes (NOT in the debugger script)

The three failing tests still assert on the current `maybeContinue` shape.
The debugger patch uses `syntheticClick(btnRef)` and no `deepReactActivate`,
so those tests will still fail after the patch runs. Patch them by
loosening the assertions:

**`test/injector-instrumentation.test.ts`** — replace the
`syntheticClick\(btn\)` / `keyboardActivate\(btn\)` assertions with
`syntheticClick\(btn(Ref)?\)` / `keyboardActivate\(btn(Ref)?\)`.

**`test/injector-resume-click.test.ts`** — same change; drop the
`deepReactActivate(btn2)` assertion or change it to
`deepReactActivate\(btn(Ref)?\)` if the fallback is kept.

**`test/injector-fiber-activate.test.ts`** — either delete the test that
asserts `deepReactActivate(btn2)` or make the test pass by adding the
call back in the second-wave block. Whichever path is taken, be explicit:
the fiber-walking hack is now a dead letter for this DeepSeek build, so
the cleanest is to delete the assertion and leave `deepReactActivate` in
place as an unused-but-available helper.

### 6.3 The manifest permission gotcha

Adding `"debugger"` to `permissions` causes Chrome to mark the extension
as **disabled pending user approval** after the extension is reloaded. The
user must click "Re-enable" in `chrome://extensions` and confirm the new
permission warning. The debugger-based click will not work until this is
done. Mention this to whoever runs the patch.

### 6.4 The DevTools conflict

`chrome.debugger.attach` fails if another debugger is already attached to
the target tab — i.e. if DevTools is open on the pool tab. In that case
the injector falls back to synthetic dispatch (which we already know does
not work for the isTrusted-strict Continue handler). The diagnostic line
`maybeContinue: debugger click result {"ok":false,"error":"attach: ..."}`
makes this case explicit. Tell the user to close DevTools on the pool tab
when reproducing.

---

## 7. Order of operations for the next agent

1. **Read this handoff, then read the debugger patch script in the
   transcript.** Re-run the script verbatim.
2. **Fix the three tests.** See §6.2. Do not weaken them further than the
   `btn|btnRef` looseness.
3. **`pnpm test`.** Expect 213/213 green. If the debugger patch left any
   `deepReactActivate` reference in a test that no longer matches, remove
   the reference (the helper itself can stay).
4. **Commit** with a message like
   `fix(worker+injector): trusted click via chrome.debugger for Continue`.
5. **Tell the user** to reload the extension, accept the debugger
   permission, close DevTools on the pool tab, F5 the DeepSeek tab, and
   reproduce.
6. **Verify from the log** that the next halt produces:
   ```
   [tab-bridge] maybeContinue: debugger click result {"ok":true}
   [tab-bridge] maybeContinue: post-click state {"stillThere":false,"streamAfterClick":true}
   ```
   If `ok:false` on attach, DevTools is open somewhere on that tab.
   If `ok:true` but `stillThere:true` after 500 ms, the handler is not
   gated on `isTrusted` and we are out of easy answers — the next step
   would be to inspect the button's own fiber on a live page (React
   DevTools "Inspect" on the element) and to consider a page-level
   keyboard shortcut for resume.
7. **If green in a real repro**, do a full `pnpm run e2e` and one full
   `kod` agent loop to confirm the fix holds under load.

---

## 8. Things not to do

- **Do not re-attempt the focus-steal.** It was tried; it does not fix
  the outcome. If the SW helpers `focusPoolForInjection` /
  `restorePriorFocus` are still in `background.js`, they can be left or
  removed — they are unreferenced by the new `maybeContinue` and cause no
  harm.
- **Do not re-attempt `deepReactActivate` in the primary path.** It
  returns `false` for this button in every observed case. Leave it in
  place as a last-resort helper; do not rely on it.
- **Do not broaden the label regex further.** `CONTINUE_RE` already
  covers "Continue", "continue generating", "resume", and the CJK
  variants. Adding more labels will not help — the button is *found*; the
  problem is the *click*.
- **Do not touch `hookArmSync` or the SSE hook's synchronous arm path.**
  That fix is load-bearing: it closes the race where the continuation
  POST fires before the async arm lands, and it is the only reason the
  debugger click's follow-up POST will be capturable.

---

## 9. Where things live

| Concern | File | Anchor |
|---|---|---|
| Continue detection + click | `extension/injector.js` | `maybeContinue`, `findContinueButton`, `syntheticClick`, `keyboardActivate`, `hookArmSync`, `debuggerClickViaSW` |
| Pool window + debugger CDP | `extension/background.js` | `handleInjectorMessage`, `debuggerClick`, `focusPoolForInjection` (dead) |
| SSE capture | `extension/sse-hook.js` | `attachXhrCapture`, `pumpSse`, `tab-bridge-sse-arm-sync` listener |
| Reconciliation / classifier | `src/core/classifier.ts` | `classify`, `classifyBase` |
| Turn engine | `src/engine.ts` | `runTurn`, `observePass` |
| Error taxonomy | `src/facade/errors.ts` | `mapTurnError` |
| HTTP/SSE facade | `src/facade/http.ts`, `src/facade/sse.ts` | `handleChat` |

### Test files added during this session (all still on disk)

- `test/injector-source.test.ts` — server-down / Continue-label invariants
- `test/injector-failed-generation.test.ts` — retry-affordance detection
- `test/injector-waitsend-regression.test.ts` — `waitStableSend` correctness
- `test/injector-latency-budget.test.ts` — client-side dead-time ceilings
- `test/injector-instrumentation.test.ts` — trace helpers, **one stale assertion**
- `test/injector-resume-click.test.ts` — dumpReactHandlers, **one stale assertion**
- `test/injector-sync-arm.test.ts` — `hookArmSync` correctness
- `test/injector-click-targets.test.ts` — multi-target click + JSON logs
- `test/injector-fiber-activate.test.ts` — `deepReactActivate`, **one stale assertion**
- `test/injector-focus-click.test.ts` — focus-steal; **now describes dead behaviour, remove if the focus path is stripped**
- `test/pool-window.test.ts` — pool window invariants
- `test/worker-ws-lifecycle.test.ts` — SW flap detection
- `test/injector-continue-fast.test.ts` — fast Continue idle threshold
- `test/injector-retry-structural.test.ts` — icon-only retry detection

The other suites in `test/` (`canonical`, `classifier`, `compiler`,
`contract`, `gate`, `hashchain`, `holdback`, `ids`, `parser`,
`pool-bind`, `queue`, `ratelimit`, `ws-link`) are untouched and green.

---

## 10. Baseline expectations

If nothing has changed on disk since this handoff was written:

- `pnpm run typecheck` → 0 errors.
- `pnpm test` → 213 tests, **210 pass, 3 fail** (the three listed in §4).
- After the debugger patch + the test loosening in §6.2 → all green.
- `pnpm run e2e` → 15/15 scenarios green (unaffected by any of this).

If a fresh clone shows a different number, the tree has been reset and the
whole patch sequence needs to be re-applied from git history up to the
last green commit plus the debugger patch.
