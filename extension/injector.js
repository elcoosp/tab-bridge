/**
 * Tab Bridge — DeepSeek injector content script (L0 DOM driver, spec 7.4,
 * v1.2.0 capture redesign).
 *
 * Responsibilities:
 *  - composer readiness polling, text placement, submit gating and verification
 *  - reply capture via the MAIN-world SSE hook (extension/sse-hook.js):
 *    the assistant answer is read from the completion network stream, which
 *    works regardless of tab focus/visibility (MutationObserver + timers are
 *    throttled in background tabs and were the v1.1 root cause of "message
 *    sent but response never returns")
 *  - DOM observation kept as a FALLBACK when the hook is absent or the
 *    completion stream is not seen within 15 s of a verified submit
 *  - verifiable "New chat" reset (confirms the conversation actually changed)
 *  - provider rate-limit detection (HTTP 429 / `event: hint` rate_limit_reached
 *    on the SSE stream, plus the classic toast scan as a secondary net)
 *  - DS session-id observation (user-claimed-tab guard) and health sentinel
 *
 * Capture invariants (bridge-side holdback safety):
 *  - fragments are exact, append-only deltas — a `full: true` resync is NEVER
 *    sent once content has flowed (the bridge's holdback buffer cannot rewind)
 *  - one capture mode owns the turn (sse or dom); modes never mix mid-turn
 *
 * DeepSeek composer quirks this driver explicitly handles (field-verified):
 *  1. Large pastes are converted into a file attachment named
 *     "Pasted Content_<timestamp>.txt". The composer then empties and the send
 *     button stays DISABLED until the attachment finishes processing — sending
 *     must wait for the button to become enabled (waitReadyToSubmit).
 *  2. The send control is a div[role=button]/button whose enabled state flips
 *     via aria-disabled / pointer-events, so "clickable" != "enabled".
 *  3. Rate limits surface after the request is accepted (SSE hint frame or
 *     toast) — reported as code "rate_limited", never a normal completion.
 *
 * Selector bundle version "ds-2": all DeepSeek-specific selectors live in
 * SELECTORS so a DOM drift is a one-bundle change (ADR-8 containment).
 */

const SELECTOR_BUNDLE = "ds-2";

/** Extension version, read live from the manifest so the tab console always
 * shows which code is actually running (stale-tab confusion burner). */
const INJECTOR_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "dev";
  }
})();

/** Prompts at or above this length go through a synthetic paste event so
 * DeepSeek's own paste pipeline (including its paste-to-file conversion)
 * decides how to carry the payload. */
const PASTE_AS_FILE_THRESHOLD = 8000;
/** Longest wait for the send button to enable after a paste-to-file. */
const SUBMIT_READY_TIMEOUT_MS = 90_000;
/** If no send button was ever found, fall back to Enter after this long. */
const NO_BUTTON_FALLBACK_MS = 8000;
/** Window granted to the provider to start rendering the reply bubble. */
const REPLY_BASELINE_SETTLE_MS = 1000;
/** If no completion stream attached this long after a verified submit,
 * hand capture over to the DOM observer. */
const SSE_FALLBACK_AFTER_MS = 15_000;
/** SSE stream silence allowed before the turn errors out (bridge deadline
 * remains the outer bound). */
const SSE_IDLE_TIMEOUT_MS = 120_000;

const RATE_LIMIT_RE =
  /(?:messages?\s*(?:are\s*)?too\s*frequent|too\s*many\s*messages|too\s*many\s*requests|rate[\s_-]*limits?(?:\s*(?:reached|exceeded|hit))?|消息发送过于频繁|发送消息过于频繁|发送太频繁|操作过于频繁|请求过于频繁|频率过高)/i;

const SELECTORS = {
  composer: [
    'textarea#chat-input',
    'textarea[placeholder]',
    'div[contenteditable="true"]',
  ],
  sendButton: [
    'div[role="button"][aria-disabled]',
    'button[class*="send"]',
    'div[class*="send-button"]',
    'button:has(svg)',
  ],
  stopButton: [
    'button[class*="stop"]',
    'div[class*="stop-button"]',
    'div[role="button"][class*="stop"]',
  ],
  newChat: [
    'a[href="/"]',
    'div[class*="new-chat"] button',
    'button[class*="new-chat"]',
  ],
  messageNodes: [
    'div[class*="message-content"]',
    'div[class*="markdown"]',
  ],
  /** Transient surfaces a rate-limit / system notice can appear in. */
  noticeRegions: [
    '[role="alert"]',
    '[class*="toast"]',
    '[class*="Toast"]',
    '[class*="hint"]',
    '[class*="notice"]',
  ],
  loginWall: ['div[class*="login"], button[class*="login"]'],
  cfMarker: ['iframe[src*="challenges.cloudflare.com"]'],
};

function findFirst(selectorList) {
  for (const sel of selectorList) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch {
      /* invalid selector for this DOM — skip */
    }
  }
  return null;
}

function findAll(selectorList) {
  const out = [];
  for (const sel of selectorList) {
    try {
      out.push(...document.querySelectorAll(sel));
    } catch {
      /* invalid selector for this DOM — skip */
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dbg(...args) {
  try {
    // console.log, not debug: debug/verbose is hidden by default in DevTools,
    // which made stuck turns show "no logs". Turn-lifecycle lines only.
    console.log("[tab-bridge]", ...args);
  } catch {
    /* noop */
  }
}

function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * "Enabled" for the send control: not [disabled], not aria-disabled, not
 * pointer-events:none. A disabled send button means "not sendable yet" —
 * empty input, or an attachment still processing.
 */
function isEnabled(el) {
  if (!el) return false;
  if (el.tagName === "BUTTON" && el.disabled) return false;
  if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
  const cls = typeof el.className === "string" ? el.className : "";
  if (/(^|\s)disabled(\s|$)/.test(cls)) return false;
  const st = getComputedStyle(el);
  if (st.pointerEvents === "none") return false;
  if (st.visibility === "hidden" || st.display === "none") return false;
  return true;
}

// ---------------------------------------------------------------------------
// port plumbing (with SW-restart reconnection)
// ---------------------------------------------------------------------------

let port = null;
let seq = 0;
let portRetry = 0;

function connectPort() {
  let p;
  try {
    p = chrome.runtime.connect({ name: "injector" });
  } catch (e) {
    // Extension context invalidated (extension reloaded): keep a slow
    // backoff; a fresh page load will get the new injector anyway.
    dbg("runtime.connect failed:", String(e && e.message));
    schedulePortReconnect();
    return;
  }
  port = p;
  portRetry = 0;
  p.onMessage.addListener(onPortMessage);
  p.onDisconnect.addListener(() => {
    if (port !== p) return; // stale disconnect from a replaced port
    port = null;
    dbg("SW port lost — reconnecting");
    schedulePortReconnect();
  });
  dbg(`injector ${INJECTOR_VERSION} (bundle ${SELECTOR_BUNDLE}) connected`);
  report("HEALTH", { state: "ok" });
}

function schedulePortReconnect() {
  const delay = Math.min(1000 * Math.pow(2, portRetry++), 15000);
  setTimeout(() => {
    if (port === null) connectPort();
  }, delay);
}

function report(t, extra) {
  if (!port) return false;
  try {
    port.postMessage({ t, ...extra });
    return true;
  } catch {
    return false;
  }
}

function reportHealth(state, detail) {
  report("HEALTH", { state, detail });
}

// ---------------------------------------------------------------------------
// health sentinel (CF challenge / login wall / transient rate-limit notices)
// ---------------------------------------------------------------------------

let lastHealth = "ok";
function checkHealth() {
  let state = "ok";
  if (findFirst(SELECTORS.cfMarker) || /just a moment/i.test(document.title)) state = "cf_challenge";
  else if (findFirst(SELECTORS.loginWall)) state = "auth_invalid";
  else if (noticeRateLimitHit()) state = "rate_limited";
  if (state !== lastHealth) {
    lastHealth = state;
    reportHealth(state);
  }
}

/** Rate-limit text visible in transient notice surfaces (never chat nodes —
 * error bubbles in the transcript are the watchdog's job). */
function noticeRateLimitHit() {
  for (const el of findAll(SELECTORS.noticeRegions)) {
    const t = (el.textContent || "").trim();
    if (t && t.length < 300 && RATE_LIMIT_RE.test(t)) return true;
  }
  return false;
}

/**
 * Broad submit-block scan: notice surfaces AND chat nodes that appeared after
 * `preCount` (DeepSeek renders "Messages too frequent" as an inline bubble,
 * not a toast, when the send is rejected pre-flight — no POST fires, so the
 * SSE hint path never exists). Length guards keep a user prompt that merely
 * mentions rate limits from matching: only short system-looking bubbles.
 */
function submitRateLimitHit(preCount) {
  if (noticeRateLimitHit()) return true;
  const nodes = conversationNodes();
  for (let i = Math.max(0, preCount); i < nodes.length; i++) {
    const t = (nodes[i].textContent || "").trim();
    if (t && t.length < 400 && RATE_LIMIT_RE.test(t)) return true;
  }
  return false;
}

setInterval(checkHealth, 3000);
checkHealth();

// ---------------------------------------------------------------------------
// composer interaction
// ---------------------------------------------------------------------------

async function waitComposer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    const el = findFirst(SELECTORS.composer);
    if (el && !el.disabled) return el;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

function readComposer(el) {
  if (!el) return "";
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
  return el.textContent || "";
}

/** The composer's probable action bar: walk up a few container levels. */
function composerScope(el) {
  let scope = el;
  for (let i = 0; i < 3 && scope.parentElement; i++) scope = scope.parentElement;
  return scope;
}

/**
 * Find the send control. Priority: explicit selectors anywhere, then icon
 * buttons scoped near the composer (send sits bottom-right => last match).
 */
function findSendButton(composer) {
  const direct = findAll(SELECTORS.sendButton).filter(isVisible);
  if (direct.length > 0) return direct[direct.length - 1];
  if (composer) {
    try {
      const scoped = [
        ...composerScope(composer).querySelectorAll('button, div[role="button"], [role="button"]'),
      ].filter(isVisible);
      const iconBtns = scoped.filter((el) => el.querySelector("svg"));
      if (iconBtns.length > 0) return iconBtns[iconBtns.length - 1];
      if (scoped.length > 0) return scoped[scoped.length - 1];
    } catch {
      /* DOM shape drift — fall through */
    }
  }
  return null;
}

/**
 * Wait until the send control is actually enabled. Returns
 * { ok, btn?, detail?, rateLimited? }. Handles the paste-to-file case: the composer is
 * empty but a "Pasted Content_*.txt" attachment is still processing and the
 * button stays disabled until DeepSeek finishes with it.
 * A provider "Messages too frequent" notice aborts the wait immediately as
 * rate-limited (the button never enables under a send block).
 */
async function waitReadyToSubmit(composer, preCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawButton = false;
  let lastDetail = "send control not found";
  for (; ;) {
    if (submitRateLimitHit(preCount)) {
      return { ok: false, rateLimited: true, detail: "provider notice: messages too frequent" };
    }
    const btn = findSendButton(composer);
    if (btn) {
      sawButton = true;
      if (isEnabled(btn)) return { ok: true, btn };
      lastDetail = "send button present but disabled (attachment processing or empty input)";
    }
    const elapsed = Date.now() - (deadline - timeoutMs);
    // Never waste the whole budget when the button simply is not in this DOM:
    // fall back to the Enter path once the composer clearly holds content.
    if (!sawButton && elapsed > NO_BUTTON_FALLBACK_MS && readComposer(composer).length > 0) {
      return { ok: true, btn: null, via: "enter-fallback" };
    }
    if (Date.now() > deadline) {
      return { ok: false, detail: `${lastDetail}; waited ${timeoutMs}ms` };
    }
    await sleep(200);
  }
}

/** React-compatible value set for controlled inputs. */
function setComposerValue(el, text) {
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    el.focus();
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * Large payloads go through a synthetic paste so DeepSeek's native paste
 * pipeline runs (it converts big text into a "Pasted Content_<ts>.txt"
 * attachment by itself). Small payloads use the direct value setter.
 * Returns "file" | "inline" | "ignored".
 */
async function placeText(composer, text) {
  if (text.length >= PASTE_AS_FILE_THRESHOLD) {
    composer.focus();
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      composer.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })
      );
    } catch {
      /* ClipboardEvent/DataTransfer unavailable — fall back below */
    }
    await sleep(500);
    const pasted = readComposer(composer);
    if (pasted.length === 0) return "file"; // handler consumed it (attachment)
    if (pasted === text) return "inline";
  }
  setComposerValue(composer, text);
  await sleep(350);
  const val = readComposer(composer);
  if (val.length === 0 && text.length > 400) return "file"; // converted by the app
  if (val.length === 0) return "ignored";
  return "inline";
}

function clickSend(btn) {
  if (btn && isEnabled(btn)) {
    try {
      btn.click();
      return true;
    } catch {
      /* fall through to Enter */
    }
  }
  return false;
}

function pressEnter(composer) {
  composer.focus();
  composer.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    })
  );
}

function conversationNodes() {
  return document.querySelectorAll(SELECTORS.messageNodes.join(","));
}

/**
 * Failure-path self-diagnosis: per-selector match counts plus the ancestor
 * chain of the element actually holding our prompt text. When the selector
 * bundle drifts, this output IS the corrected bundle — no browser spelunking
 * needed. Runs only on submit failure, never on the hot path.
 */
function diagnoseSubmit(composer, sampleText) {
  try {
    const counts = {};
    for (const sel of SELECTORS.messageNodes) {
      try {
        counts[`msg:${sel}`] = document.querySelectorAll(sel).length;
      } catch {
        counts[`msg:${sel}`] = -1;
      }
    }
    for (const sel of SELECTORS.stopButton) {
      try {
        counts[`stop:${sel}`] = document.querySelectorAll(sel).length;
      } catch {
        counts[`stop:${sel}`] = -1;
      }
    }
    counts.composerTextLen = readComposer(composer).length;
    dbg("selector census:", JSON.stringify(counts));
    const sample = (sampleText || "").slice(0, 24);
    if (!sample) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let scanned = 0;
    while (node && scanned < 4000) {
      scanned++;
      if (node.nodeValue && node.nodeValue.includes(sample)) {
        const chain = [];
        let el = node.parentElement;
        for (let i = 0; i < 4 && el; i++) {
          const cls =
            el.className && typeof el.className === "string"
              ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
              : "";
          chain.push(`${el.tagName.toLowerCase()}${cls}${el.id ? "#" + el.id : ""}`);
          el = el.parentElement;
        }
        dbg("bubble ancestor chain for prompt text:", chain.join(" < "));
        return;
      }
      node = walker.nextNode();
    }
    dbg("prompt text not found in DOM text nodes");
  } catch (e) {
    dbg("diagnose failed:", String((e && e.message) || e));
  }
}

/** Did the tab react to the submit? (composer cleared / stop shown / bubble).
 * Returns true, false, or "rate-limited" when the provider blocked the send
 * (the notice is transient, so it is scanned inside the poll loop). */
async function verifySubmitted(composer, baseCount, hadText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    await sleep(250);
    if (submitRateLimitHit(baseCount)) return "rate-limited";
    if (findFirst(SELECTORS.stopButton)) return true;
    if (conversationNodes().length > baseCount) return true;
    if (hadText && readComposer(composer).length === 0) return true;
    if (Date.now() > deadline) return false;
  }
}

/**
 * Place the prompt, WAIT FOR THE SEND BUTTON TO BE ENABLED, submit and verify
 * the tab actually started the turn (one retry via the alternate method).
 *
 * `quickVerify` (SSE armed): DOM proof is only a hint — a background tab may
 * not render for seconds while the network already streams. Verifies are
 * short, and total DOM silence degrades to `unverified: true` instead of
 * failing: the attaching completion stream is objective proof the submit
 * landed, and the fallback timer fails the turn if neither ever appears.
 * DOM-only turns keep the strict verifies (no second witness exists).
 */
async function submitPrompt(composer, text, readyTimeoutMs, quickVerify) {
  const verifyMs = quickVerify ? 2500 : 6000;
  const preCount = conversationNodes().length;
  const mode = await placeText(composer, text);
  if (mode === "ignored") {
    if (submitRateLimitHit(preCount)) {
      return { ok: false, code: "rate_limited", detail: "composer rejected the prompt under a provider send block" };
    }
    return { ok: false, code: "submit-failed", detail: "composer rejected the prompt text" };
  }
  const ready = await waitReadyToSubmit(composer, preCount, readyTimeoutMs);
  if (!ready.ok) {
    if (ready.rateLimited || submitRateLimitHit(preCount)) {
      return {
        ok: false,
        code: "rate_limited",
        detail: `${ready.detail || "provider notice: messages too frequent"} (mode=${mode})`,
      };
    }
    return {
      ok: false,
      code: "send-button-disabled",
      detail: `${ready.detail} (mode=${mode})`,
    };
  }
  const baseCount = conversationNodes().length;
  const hadText = readComposer(composer).length > 0;
  const rateLimitedResult = () => ({
    ok: false,
    code: "rate_limited",
    detail: "provider notice: messages too frequent (submit rejected)",
  });
  // Method A: the enabled send button.
  const a = clickSend(ready.btn) ? await verifySubmitted(composer, baseCount, hadText, verifyMs) : false;
  if (a === "rate-limited" || (a !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
  if (a === true) return { ok: true, mode };
  // Method B: Enter on the composer.
  pressEnter(composer);
  const b = await verifySubmitted(composer, baseCount, hadText, verifyMs);
  if (b === "rate-limited" || (b !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
  if (b === true) return { ok: true, mode };
  // Last resort: re-find the button (the DOM may have re-rendered after the
  // attachment finished processing) and click it if it is now enabled.
  const btn2 = findSendButton(composer);
  const c = clickSend(btn2) ? await verifySubmitted(composer, baseCount, hadText, verifyMs) : false;
  if (c === "rate-limited" || (c !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
  if (c === true) return { ok: true, mode };
  if (quickVerify) {
    dbg("submit unverified by DOM (background tab?) — proceeding; the completion stream will confirm");
    return { ok: true, mode, unverified: true };
  }
  diagnoseSubmit(composer, text);
  return {
    ok: false,
    code: "submit-failed",
    detail: "submit not confirmed: no stop button, no new bubble, composer not cleared",
  };
}

// ---------------------------------------------------------------------------
// reply capture (v1.2: SSE-primary, DOM fallback)
// ---------------------------------------------------------------------------

/** One active turn per tab. null when idle. */
let turn = null;
let sseHookPresent = false;

/** Control-channel sender for the MAIN-world hook. */
function hookPost(msg) {
  try {
    window.postMessage({ source: "tab-bridge-sse-control", ...msg }, window.location.origin);
  } catch {
    /* page navigating */
  }
}

function emitDelta(t, text) {
  if (!text) return;
  t.emitted += text;
  if (!t.loggedFirst) {
    t.loggedFirst = true;
    dbg("first fragment for", t.reqId, `(mode=${t.mode}, ${text.length} chars)`);
  }
  report("FRAGMENT", { reqId: t.reqId, seq: ++seq, text });
}

/**
 * Snapshot-oriented <think> stripper for DOM-sourced text (the MAIN-world
 * hook filters the stream incrementally; the isolated world cannot reuse
 * it). Removes complete blocks and a trailing unclosed block (generation
 * still in flight). Applied to EVERY snapshot before diffing so lastSent
 * and deltas stay mutually consistent.
 */
function stripThinkBlocks(text) {
  if (!text || text.indexOf("<think") === -1) return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "");
}

/**
 * Close the turn exactly once. Every path (SSE complete/error, DOM observer,
 * watchdog, abort) funnels here; the first caller wins.
 */
function finishTurn(ok, code, detail, aborted) {
  const t = turn;
  if (!t || t.finished) return;
  t.finished = true;
  if (t.fallbackTimer) clearTimeout(t.fallbackTimer);
  if (t.watchdog) clearInterval(t.watchdog);
  if (t.domObserver) t.domObserver.disconnect();
  if (t.domTick) clearInterval(t.domTick);
  hookPost({ type: "disarm" });
  turn = null;
  if (ok) {
    dbg("turn done:", t.reqId, `chars=${t.emitted.length}`, `mode=${t.mode}`);
    report("TURN_DONE", { reqId: t.reqId });
  } else if (aborted) {
    dbg("turn aborted:", t.reqId);
    report("TURN_ABORTED", { reqId: t.reqId });
  } else {
    dbg("turn error:", t.reqId, code, detail || "");
    report("TURN_ERROR", {
      reqId: t.reqId,
      code: code || "dom-error",
      ...(detail ? { detail } : {}),
    });
  }
}

/** Hand capture over to the DOM observer (only while nothing was emitted). */
function fallbackToDom(t, why) {
  if (t.mode === "dom" || t.finished) return;
  dbg("DOM fallback engaged:", why, `(hook ${sseHookPresent ? "present" : "ABSENT"})`);
  t.mode = "dom";
  if (t.fallbackTimer) {
    clearTimeout(t.fallbackTimer);
    t.fallbackTimer = null;
  }
  startDomObserver(t);
}

/** Legacy DOM capture (v1.1 logic): observer + stability tick. Used only
 * when the SSE hook is absent or produced nothing. */
function startDomObserver(t) {
  if (t.domObserver) return;
  let lastLen = -1;
  let sawGrowth = false;
  let stableSince = 0;
  let lastSent = "";
  let tickLen = -1;
  let tickStableSince = 0;

  const emitText = (text) => {
    // DOM scraping sees RENDERED markdown: the thinking block leaks as plain
    // text (tags are elements, not text) and code fences lose their backticks.
    // Strip thinking here so DOM fallback never emits Chain-of-Thought. Fence
    // fidelity is unrecoverable from DOM — tool turns must ride SSE (the
    // 1.2.6 boot-race fix); this is only a prose safety net.
    text = stripThinkBlocks(text);
    if (text.startsWith(lastSent)) {
      const delta = text.slice(lastSent.length);
      if (delta) {
        lastSent = text;
        emitDelta(t, delta);
      }
    } else if (t.emitted.length === 0) {
      // Non-prefix re-read before anything was emitted: safe to adopt.
      lastSent = text;
      emitDelta(t, text);
    }
    // After content has flowed a non-prefix re-read cannot be resynced
    // without corrupting the bridge's holdback buffer — ignore it.
  };

  /** Reply text: only nodes that appeared AFTER our prompt was submitted. */
  function replyText() {
    const nodes = conversationNodes();
    if (nodes.length > t.baseCount) {
      return nodes[nodes.length - 1].textContent || "";
    }
    return null; // no reply bubble yet
  }

  const domDone = () => {
    const composer = findFirst(SELECTORS.composer);
    const sendBtn = composer ? findSendButton(composer) : null;
    const stopBtn = findFirst(SELECTORS.stopButton);
    // done = generation over: stop control gone AND send enabled again
    return !stopBtn && sendBtn && isEnabled(sendBtn);
  };

  const observer = new MutationObserver(() => {
    if (t.finished) return;
    const text = replyText();
    if (text === null) return;
    if (text.length > lastLen) {
      if (lastLen >= 0) sawGrowth = true;
      lastLen = text.length;
      emitText(text);
      stableSince = 0;
    } else if (text.length === lastLen && sawGrowth) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince > 400 && domDone()) finishTurn(true);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Secondary completion detector: a reply that finishes entirely inside the
  // baseline-settle window never shows growth to the observer, so the tick
  // checks "text settled + stop control gone + send enabled" on its own.
  const tick = setInterval(() => {
    if (t.finished) {
      clearInterval(tick);
      return;
    }
    const text = replyText();
    if (text === null) return;
    if (text.length !== tickLen) {
      tickLen = text.length;
      tickStableSince = Date.now();
      return;
    }
    if (tickStableSince && Date.now() - tickStableSince > 600 && text.length > 0 && domDone()) {
      finishTurn(true);
    }
  }, 1000);

  t.domObserver = observer;
  t.domTick = tick;
}

// ---------------------------------------------------------------------------
// MAIN-world hook observations (window messages)
// ---------------------------------------------------------------------------

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== "tab-bridge-sse") return;
  if (d.type === "hello") {
    const wasAbsent = !sseHookPresent;
    sseHookPresent = true;
    if (wasAbsent) dbg("SSE hook present (MAIN world)");
    // Late-installing hook vs in-flight arm: if this turn armed before the
    // hook's listener existed, the arm was lost. Re-arm while no stream has
    // attached yet; once bytes flow (or DOM took over) leave it alone.
    const t0 = turn;
    if (t0 && !t0.finished && t0.mode === "sse-await" && !t0.lastSseAt) {
      hookPost({ type: "arm", turnId: t0.reqId, timeoutMs: t0.opts.timeoutMs || 240000 });
      dbg("re-armed late-installing hook for", t0.reqId);
    }
    return;
  }
  if (d.type === "arm-ack") {
    dbg("SSE hook armed");
    return;
  }
  const t = turn;
  if (!t || t.finished || d.turnId !== t.reqId) return;
  switch (d.type) {
    case "stream-start":
      t.lastSseAt = Date.now();
      if (t.mode === "sse-await") {
        if (t.fallbackTimer) {
          clearTimeout(t.fallbackTimer);
          t.fallbackTimer = null;
        }
        t.mode = "sse";
        dbg("SSE stream attached (status", d.status, String(d.contentType || "") + ")");
      }
      break;
    case "delta":
      t.lastSseAt = Date.now();
      if (t.mode !== "dom") emitDelta(t, d.text);
      break;
    case "hint-error":
      t.lastSseAt = Date.now();
      if (/rate_limit/i.test(d.finishReason || "")) {
        finishTurn(false, "rate_limited", d.content || "provider rate limit (stream hint)");
      }
      // non-rate hints: keep waiting — stream close / complete decides
      break;
    case "complete": {
      t.lastSseAt = Date.now();
      if (t.mode === "dom") break;
      const finalText = typeof d.text === "string" ? d.text : "";
      // Belt & braces: emit any suffix the delta stream missed (the parser's
      // think-filter guarantees finalText === emitted, so this is a no-op in
      // practice; a prefix-mismatched tail is dropped, never resynced).
      if (finalText.startsWith(t.emitted) && finalText.length > t.emitted.length) {
        emitDelta(t, finalText.slice(t.emitted.length));
      }
      if (d.hintError && /rate_limit/i.test(d.hintError.finishReason || "")) {
        finishTurn(false, "rate_limited", d.hintError.content || "provider rate limit");
        break;
      }
      if (!finalText && t.emitted.length === 0) {
        fallbackToDom(t, "completion stream closed without text");
        break;
      }
      finishTurn(true);
      break;
    }
    case "http-error": {
      const s = d.status | 0;
      const detail = `completion HTTP ${s}${d.snippet ? ": " + d.snippet : ""}`;
      if (s === 429) finishTurn(false, "rate_limited", detail);
      else finishTurn(false, "dom-error", detail);
      break;
    }
    case "stream-error":
    case "hook-error":
    case "fetch-rejected":
      if (t.mode === "dom") break;
      if (t.emitted.length > 0) {
        finishTurn(false, "dom-error", "capture failed after partial stream: " + (d.error || d.type));
      } else {
        fallbackToDom(t, `${d.type}: ${d.error || "capture failed"}`);
      }
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// watchdog: deadline + rate-limit toast scan + SSE idle detection
// ---------------------------------------------------------------------------

function startWatchdog(t) {
  t.watchdog = setInterval(() => {
    if (t.finished || turn !== t) {
      clearInterval(t.watchdog);
      return;
    }
    const now = Date.now();
    const hit = submitRateLimitHit(t.submitCount);
    if (hit) {
      finishTurn(false, "rate_limited", "provider notice: messages too frequent");
      return;
    }
    if (now > t.deadline) {
      finishTurn(false, "timeout", `turn exceeded ${t.opts.timeoutMs || 240000}ms`);
      return;
    }
    if (t.mode === "sse" && t.lastSseAt && now - t.lastSseAt > SSE_IDLE_TIMEOUT_MS) {
      finishTurn(false, "timeout", "SSE stream idle >120s");
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// port protocol (worker intents)
// ---------------------------------------------------------------------------

function onPortMessage(msg) {
  if (msg.t === "TURN") {
    void handleTurn(msg);
  } else if (msg.t === "RESET") {
    void handleReset(msg);
  } else if (msg.t === "ABORT") {
    if (turn && !turn.finished && (!msg.reqId || msg.reqId === turn.reqId)) {
      finishTurn(false, null, null, true);
    }
  }
}

async function handleTurn(msg) {
  if (turn && !turn.finished) {
    report("TURN_ERROR", {
      reqId: msg.reqId,
      code: "submit-failed",
      detail: "another turn is still active in this tab",
    });
    return;
  }
  const opts = msg.opts || {};
  const t = {
    reqId: msg.reqId,
    opts,
    mode: "idle", // idle -> sse-await -> sse  |  idle -> dom
    finished: false,
    emitted: "",
    startedAt: Date.now(),
    deadline: Date.now() + (opts.timeoutMs || 240000),
    lastSseAt: 0,
    baseCount: -1,
    fallbackTimer: null,
    watchdog: null,
    domObserver: null,
    domTick: null,
  };
  turn = t;
  dbg("TURN", msg.reqId, `chars=${(msg.text || "").length}`);
  try {
    const composer = await waitComposer(15000);
    if (!composer) {
      finishTurn(false, "submit-failed", "composer not ready");
      return;
    }
    // Arm BEFORE the submit so the completion POST cannot slip past the hook.
    // Fresh-tab race: this TURN can arrive while the page (and the
    // MAIN-world hook) is still booting, so wait briefly for the hello
    // instead of locking into DOM mode while the hook is on its way.
    if (!sseHookPresent) {
      hookPost({ type: "ping" });
      const helloBy = Date.now() + 3000;
      while (!sseHookPresent && Date.now() < helloBy) await sleep(100);
      if (!sseHookPresent) dbg("SSE hook still absent after 3s — DOM-only capture");
    }
    if (sseHookPresent) {
      hookPost({ type: "arm", turnId: msg.reqId, timeoutMs: opts.timeoutMs || 240000 });
      t.mode = "sse-await";
    } else {
      t.mode = "dom";
    }
    // Frozen BEFORE the submit: the submit-block scan only looks at nodes
    // that appear after this point, so our own prompt echo can't match.
    t.submitCount = conversationNodes().length;
    const submitted = await submitPrompt(
      composer,
      msg.text,
      opts.submitWaitMs || SUBMIT_READY_TIMEOUT_MS,
      t.mode === "sse-await"
    );
    if (!submitted.ok) {
      finishTurn(false, submitted.code || "submit-failed", submitted.detail);
      return;
    }
    t.unverified = submitted.unverified === true;
    dbg("submitted (paste-mode=" + submitted.mode + ", capture=" + t.mode + (t.unverified ? ", unverified" : "") + ")");
    // Let the user bubble render before freezing the reply baseline.
    await sleep(REPLY_BASELINE_SETTLE_MS);
    t.baseCount = conversationNodes().length;
    if (t.mode === "dom") {
      startDomObserver(t);
    } else {
      t.fallbackTimer = setTimeout(() => {
        if (turn === t && !t.finished && t.mode === "sse-await") {
          // SSE never attached: DOM evidence is the second witness. If even
          // that is absent the submit genuinely failed — fail now rather
          // than scraping an unrelated bubble.
          const domEvidence =
            findFirst(SELECTORS.stopButton) !== null ||
            conversationNodes().length > t.submitCount;
          if (domEvidence) {
            fallbackToDom(t, "no completion stream within 15s");
          } else {
            diagnoseSubmit(composer, msg.text);
            finishTurn(
              false,
              "submit-failed",
              "submit not confirmed: no completion stream within 15s and no DOM evidence of submit"
            );
          }
        }
      }, SSE_FALLBACK_AFTER_MS);
    }
    startWatchdog(t);
  } catch (e) {
    finishTurn(false, "dom-error", String(e && e.message));
  }
}

async function handleReset(msg) {
  const fresh = !!(msg && msg.fresh);
  try {
    const link = findFirst(SELECTORS.newChat);
    if (!link) {
      if (fresh && location.pathname === "/") {
        // The worker navigated this tab home as the reset action itself
        // (see background navigate-home fallback): the URL is the
        // verification — no selectors involved, no lie possible, since the
        // worker performed the navigation seconds ago on this tab.
        dbg("reset confirmed: worker-navigated home, no control needed");
        report("RESET_OK", {});
        return;
      }
      diagnoseReset();
      report("RESET_FAILED", { detail: "new-chat control not found" });
      return;
    }
    link.click();
    // verify the conversation actually changed (spec 7.4 contract obligation)
    const deadline = Date.now() + 8000;
    for (; ;) {
      await sleep(300);
      const now = conversationNodes().length;
      const onHome = location.pathname === "/";
      if (now === 0 || onHome) {
        report("RESET_OK", {});
        return;
      }
      if (Date.now() > deadline) break;
    }
    report("RESET_FAILED", { detail: "conversation did not change" });
  } catch (e) {
    report("RESET_FAILED", { detail: String(e && e.message) });
  }
}

/**
 * Reset-path diagnosis: log visible new-chat-ish controls (links home,
 * buttons mentioning new/start, plus-marked icon buttons) so the next paste
 * yields the corrected newChat bundle. Failure path only.
 */
function diagnoseReset() {
  try {
    const cands = [];
    const els = document.querySelectorAll("a, button, div[role='button']");
    for (let i = 0; i < els.length && cands.length < 10; i++) {
      const el = els[i];
      if (!isVisible(el)) continue;
      const text = (el.textContent || "").trim().slice(0, 24);
      const href = el.getAttribute ? el.getAttribute("href") || "" : "";
      if (
        href === "/" ||
        /new\s*chat|新对话|开始新|start/i.test(text) ||
        (text.length <= 2 && el.querySelector("svg"))
      ) {
        const cls =
          el.className && typeof el.className === "string"
            ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
            : "";
        cands.push(`${el.tagName.toLowerCase()}${cls}${href ? `[href=${href}]` : ""} text=${JSON.stringify(text)}`);
      }
    }
    dbg("new-chat candidates:", cands.length ? cands.join(" | ") : "(none)");
  } catch (e) {
    dbg("reset diagnose failed:", String((e && e.message) || e));
  }
}

// DS session-id observation: powers the user-claimed-tab guard.
let lastDsSession = null;
setInterval(() => {
  try {
    const m = location.pathname.match(/\/a\/chat\/s\/([0-9a-f-]+)/i);
    const dsSession = m ? m[1] : null;
    if (dsSession && dsSession !== lastDsSession) {
      lastDsSession = dsSession;
      report("SESSION_OBSERVED", { dsSessionId: dsSession, selectorBundle: SELECTOR_BUNDLE });
    }
  } catch {
    /* noop */
  }
}, 2000);

connectPort();

// Probe the MAIN-world hook. Its install-time "hello" was posted before this
// script ran (document_start vs document_idle), so ask it to re-announce.
hookPost({ type: "ping" });
setTimeout(() => {
  if (!sseHookPresent) dbg("SSE hook not detected — turns will use DOM capture");
}, 2000);
