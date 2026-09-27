/**
 * Tab Bridge — DeepSeek injector content script (L0 DOM driver, spec 7.4).
 *
 * Responsibilities:
 *  - composer readiness polling, text placement, submit gating and verification
 *  - fragment scraping of the streaming reply (MutationObserver, UTF-8 safe:
 *    fragments are computed from JS strings, never raw bytes)
 *  - verifiable "New chat" reset (confirms the conversation actually changed)
 *  - provider rate-limit detection ("Messages too frequent" -> 429 + ~20 min)
 *  - DS session-id observation (user-claimed-tab guard) and health sentinel
 *
 * DeepSeek composer quirks this driver explicitly handles (field-verified):
 *  1. Large pastes are converted into a file attachment named
 *     "Pasted Content_<timestamp>.txt". The composer then empties and the send
 *     button stays DISABLED until the attachment finishes processing — sending
 *     must wait for the button to become enabled (waitReadyToSubmit).
 *  2. The send control is a div[role=button]/button whose enabled state flips
 *     via aria-disabled / pointer-events, so "clickable" != "enabled".
 *  3. Rate limits surface as a short error bubble/toast AFTER the request is
 *     accepted (event: ready then hint finish_reason=rate_limit_reached), so
 *     the tab keeps an orphan user message — reported as code "rate_limited"
 *     and never mistaken for a normal completion.
 *
 * Selector bundle version "ds-2": all DeepSeek-specific selectors live in
 * SELECTORS so a DOM drift is a one-bundle change (ADR-8 containment).
 */

const SELECTOR_BUNDLE = "ds-2";

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

const RATE_LIMIT_RE =
  /(?:messages?\s*(?:are\s*)?too\s*frequent|too\s*many\s*messages|消息发送过于频繁|发送消息过于频繁|发送太频繁|操作过于频繁|请求过于频繁|频率过高)/i;

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

const port = chrome.runtime.connect({ name: "injector" });
let seq = 0;
let aborted = false;

function report(t, extra) {
  try {
    port.postMessage({ t, ...extra });
  } catch {
    /* port closing */
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
 * error bubbles in the transcript are the turn observer's job). */
function noticeRateLimitHit() {
  for (const el of findAll(SELECTORS.noticeRegions)) {
    const t = (el.textContent || "").trim();
    if (t && t.length < 300 && RATE_LIMIT_RE.test(t)) return true;
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
  for (;;) {
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
 * { ok, btn?, detail? }. Handles the paste-to-file case: the composer is
 * empty but a "Pasted Content_*.txt" attachment is still processing and the
 * button stays disabled until DeepSeek finishes with it.
 */
async function waitReadyToSubmit(composer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawButton = false;
  let lastDetail = "send control not found";
  for (;;) {
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

/** Did the tab react to the submit? (composer cleared / stop shown / bubble) */
async function verifySubmitted(composer, baseCount, hadText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(250);
    if (findFirst(SELECTORS.stopButton)) return true;
    if (conversationNodes().length > baseCount) return true;
    if (hadText && readComposer(composer).length === 0) return true;
    if (Date.now() > deadline) return false;
  }
}

/**
 * Place the prompt, WAIT FOR THE SEND BUTTON TO BE ENABLED, submit and verify
 * the tab actually started the turn (one retry via the alternate method).
 */
async function submitPrompt(composer, text, readyTimeoutMs) {
  const mode = await placeText(composer, text);
  if (mode === "ignored") {
    return { ok: false, code: "submit-failed", detail: "composer rejected the prompt text" };
  }
  const ready = await waitReadyToSubmit(composer, readyTimeoutMs);
  if (!ready.ok) {
    return {
      ok: false,
      code: "send-button-disabled",
      detail: `${ready.detail} (mode=${mode})`,
    };
  }
  const baseCount = conversationNodes().length;
  const hadText = readComposer(composer).length > 0;
  // Method A: the enabled send button.
  if (clickSend(ready.btn) && (await verifySubmitted(composer, baseCount, hadText, 6000))) {
    return { ok: true, mode };
  }
  // Method B: Enter on the composer.
  pressEnter(composer);
  if (await verifySubmitted(composer, baseCount, hadText, 6000)) {
    return { ok: true, mode };
  }
  // Last resort: re-find the button (the DOM may have re-rendered after the
  // attachment finished processing) and click it if it is now enabled.
  const btn2 = findSendButton(composer);
  if (clickSend(btn2) && (await verifySubmitted(composer, baseCount, hadText, 6000))) {
    return { ok: true, mode };
  }
  return {
    ok: false,
    code: "submit-failed",
    detail: "submit not confirmed: no stop button, no new bubble, composer not cleared",
  };
}

// ---------------------------------------------------------------------------
// reply observation
// ---------------------------------------------------------------------------

/**
 * Stream the reply for one turn. `baseCount` is the message-node count right
 * after submission: our own prompt bubble is pre-baseline and never scraped,
 * which also keeps tool-result echoes in INJECT_RESULTS prompts out of the
 * rate-limit scan.
 */
function observeReply(reqId, opts, baseCount) {
  aborted = false;
  let lastSent = ""; // resync baseline for FRAGMENT diffs
  const timeoutMs = (opts && opts.timeoutMs) || 240000;
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  let lastLen = -1;
  let sawGrowth = false;
  let lastRateScan = 0;
  let finished = false;

  const finish = (ok, code, detail) => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    clearInterval(tick);
    if (ok) report("TURN_DONE", { reqId });
    else report("TURN_ERROR", { reqId, code: code || "dom-error", ...(detail ? { detail } : {}) });
  };

  /** Reply text: only nodes that appeared AFTER our prompt was submitted. */
  function replyText() {
    const nodes = conversationNodes();
    if (nodes.length > baseCount) {
      return nodes[nodes.length - 1].textContent || "";
    }
    return null; // no reply bubble yet
  }

  /** New-node + notice scan for the provider rate-limit bubble. */
  function rateLimitHit() {
    for (const el of findAll(SELECTORS.noticeRegions)) {
      const t = (el.textContent || "").trim();
      if (t && t.length < 300 && RATE_LIMIT_RE.test(t)) return t;
    }
    const nodes = conversationNodes();
    for (let i = baseCount; i < nodes.length; i++) {
      const t = (nodes[i].textContent || "").trim();
      if (t && t.length < 400 && RATE_LIMIT_RE.test(t)) return t;
    }
    return null;
  }

  const observer = new MutationObserver(() => {
    if (finished) return;
    if (aborted) return finish(false, "aborted");
    const text = replyText();
    if (text === null) return;
    if (text.length > lastLen) {
      if (lastLen >= 0) sawGrowth = true;
      lastLen = text.length;
      // emit only the suffix the bridge has not seen (prefix assumption),
      // otherwise a full resync snapshot
      if (text.startsWith(lastSent)) {
        const delta = text.slice(lastSent.length);
        if (delta) {
          lastSent = text;
          report("FRAGMENT", { reqId, seq: ++seq, text: delta });
        }
      } else {
        lastSent = text;
        report("FRAGMENT", { reqId, seq: ++seq, text, full: true });
      }
      stableSince = 0;
    } else if (text.length === lastLen && sawGrowth) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince > 400) {
        const composer = findFirst(SELECTORS.composer);
        const sendBtn = composer ? findSendButton(composer) : null;
        const stopBtn = findFirst(SELECTORS.stopButton);
        // done = generation over: stop control gone AND send enabled again
        if (!stopBtn && sendBtn && isEnabled(sendBtn)) finish(true);
      }
    }
    const now = Date.now();
    if (now - lastRateScan > 900) {
      lastRateScan = now;
      const hit = rateLimitHit();
      if (hit) finish(false, "rate_limited", hit.slice(0, 200));
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Secondary completion detector: a reply that finishes entirely inside the
  // baseline-settle window never shows growth to the observer, so the tick
  // checks "text settled + stop control gone + send enabled" on its own.
  let tickLen = -1;
  let tickStableSince = 0;

  const tick = setInterval(() => {
    if (finished) return;
    if (aborted) return finish(false, "aborted");
    if (Date.now() > deadline) return finish(false, "timeout");
    const hit = rateLimitHit();
    if (hit) return finish(false, "rate_limited", hit.slice(0, 200));
    const text = replyText();
    if (text === null) return;
    if (text.length !== tickLen) {
      tickLen = text.length;
      tickStableSince = Date.now();
      return;
    }
    if (tickStableSince && Date.now() - tickStableSince > 600 && text.length > 0) {
      const composer = findFirst(SELECTORS.composer);
      const sendBtn = composer ? findSendButton(composer) : null;
      const stopBtn = findFirst(SELECTORS.stopButton);
      if (!stopBtn && sendBtn && isEnabled(sendBtn)) finish(true);
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// port protocol
// ---------------------------------------------------------------------------

port.onMessage.addListener(async (msg) => {
  if (msg.t === "TURN") {
    try {
      const composer = await waitComposer(15000);
      if (!composer) {
        report("TURN_ERROR", { reqId: msg.reqId, code: "submit-failed", detail: "composer not ready" });
        return;
      }
      const submitted = await submitPrompt(
        composer,
        msg.text,
        (msg.opts && msg.opts.submitWaitMs) || SUBMIT_READY_TIMEOUT_MS
      );
      if (!submitted.ok) {
        report("TURN_ERROR", {
          reqId: msg.reqId,
          code: submitted.code || "submit-failed",
          ...(submitted.detail ? { detail: submitted.detail } : {}),
        });
        return;
      }
      // Let the user bubble render before freezing the reply baseline.
      await sleep(REPLY_BASELINE_SETTLE_MS);
      observeReply(msg.reqId, msg.opts, conversationNodes().length);
    } catch (e) {
      report("TURN_ERROR", { reqId: msg.reqId, code: "dom-error", detail: String(e && e.message) });
    }
  } else if (msg.t === "RESET") {
    try {
      const link = findFirst(SELECTORS.newChat);
      if (!link) {
        report("RESET_FAILED", { detail: "new-chat control not found" });
        return;
      }
      link.click();
      // verify the conversation actually changed (spec 7.4 contract obligation)
      const deadline = Date.now() + 8000;
      for (;;) {
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
  } else if (msg.t === "ABORT") {
    aborted = true;
  }
});

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

report("HEALTH", { state: "ok" });
