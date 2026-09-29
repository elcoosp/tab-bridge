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
 *  - health sentinel
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

const SELECTOR_BUNDLE = "ds-3";

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
const PASTE_AS_FILE_THRESHOLD = 4000;
/** Longest wait for the send button to enable after a paste-to-file. */
const SUBMIT_READY_TIMEOUT_MS = 90_000;
/** If no send button was ever found, fall back to Enter after this long. */
const NO_BUTTON_FALLBACK_MS = 8000;
/** Window granted to the provider to start rendering the reply bubble. */
const REPLY_BASELINE_SETTLE_MS = 400;
/** If no completion stream attached this long after a verified submit,
 * hand capture over to the DOM observer. */
const SSE_FALLBACK_AFTER_MS = 15_000;
/** SSE stream silence allowed before the turn errors out (bridge deadline
 * remains the outer bound). */
const SSE_IDLE_TIMEOUT_MS = 120_000;

const RATE_LIMIT_RE =
  /(?:messages?\s*(?:are\s*)?too\s*frequent|too\s*many\s*messages|too\s*many\s*requests|rate[\s_-]*limits?(?:\s*(?:reached|exceeded|hit))?|消息发送过于频繁|发送消息过于频繁|发送太频繁|操作过于频繁|请求过于频繁|频率过高)/i;

/** DeepSeek concurrency refusal: a send is refused because the account
 * already has the maximum number of concurrent generations running
 * ("Another message is being generated"; observed limit: 2). Disjoint from
 * RATE_LIMIT_RE by construction. */
const CONCURRENCY_RE =
  /(?:another\s+(?:message|response|reply|request|generation)|already\s+(?:being\s+)?generated|generat\w*\s+(?:already\s+)?in\s+progress|one\s+(?:conversation|chat)\s+at\s+a\s+time|please\s+wait[^.\n]{0,40}(?:finish|complete)|已有一条消息|消息正在生成|正在生成中|请等待.{0,20}(?:完成|结束))/i;

/**
 * Labels for the "resume a halted answer" affordance. DeepSeek has shipped
 * several variants across builds/locales; match the ones we have seen plus
 * the obvious neighbours, and stay anchored (^…$) so a full assistant turn
 * that merely contains the word "continue" cannot be misread as the button.
 */
const CONTINUE_RE = /^\s*(continue|continue\s+generating|resume|继续|继续生成|继续回答|继续输出)\s*$/i;
/** Provider-side halt: clicking Continue resumes the same answer. */
const MAX_CONTINUES = 5;
/** Provider outage banner text (exact). */
const SERVER_DOWN_TEXT = "Server is temporarily unavailable.";

const SELECTORS = {
  // Anchor on stable attributes observed on chat.deepseek.com:
  //   <textarea name="search" placeholder="Message DeepSeek" rows="2" ...>
  // The legacy '#chat-input' id is kept only as a fallback for older builds.
  composer: [
    'textarea[name="search"]',
    'textarea[placeholder="Message DeepSeek"]',
    'textarea[placeholder*="Message"]',
    'textarea#chat-input',
    'textarea[placeholder]',
    'div[contenteditable="true"]',
  ],
  // DeepSeek design-system classes only — never generated _xxxxxx hashes.
  // The send control is the sole primary, filled, CIRCULAR ds-button:
  //   ds-button--primary + ds-button--filled + ds-button--circle.
  // Requiring --circle excludes the text-labelled buttons used elsewhere
  // (cookie banner "Accept all", edit-mode "Cancel"/"Send") which carry
  // --capsule instead.
  sendButton: [
    'div[role="button"].ds-button--primary.ds-button--circle',
    'div[role="button"].ds-button--primary.ds-button--filled.ds-button--circle',
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
  // The real "New chat" control is a <div tabindex="0"> whose container class
  // is a generated hash (e.g. _5a8ac7a) and whose only stable hook is the
  // visible "New chat" label. See findNewChatByLabel() below.
  messageNodes: [
    // Field-verified (ds-3): every chat bubble is div.ds-message inside the
    // virtual list. Legacy fragment selectors kept as fallback.
    'div.ds-message',
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

/**
 * The provider's Continue button (answer stopped mid-response):
 * div[role=button] whose ds-button__content label reads Continue.
 * Only one is ever present; invisible matches don't count.
 */
function findContinueButton() {
  let els;
  try {
    els = document.querySelectorAll('div[role="button"], button');
  } catch {
    return null;
  }
  for (const el of els) {
    if (!isVisible(el)) continue;
    let label = "";
    try {
      // Prefer the design-system label span; fall back to the element's own
      // text (some builds omit the wrapper span).
      const span = el.querySelector("span.ds-button__content");
      label = ((span || el).textContent || "").trim();
    } catch {
      continue;
    }
    if (!label) continue;
    // Hard cap: a real Continue control's label is 1-3 words. Anything
    // longer is an assistant turn that happens to contain the word.
    if (label.length > 40) continue;
    if (CONTINUE_RE.test(label)) return el;
  }
  return null;
}

/**
 * DeepSeek renders "New chat" as a div[tabindex="0"] whose label span reads
 * the localized "New chat" string; its container class is a generated hash.
 * The label text is the only stable hook, so scan for it. Covers the shipped
 * languages (en/zh + common locales) to be safe.
 */
const NEW_CHAT_LABEL_RE =
  /^(new\s*chat|新对话|新聊天|novo\s*chat|neuer\s*chat|nueva\s*conversación|nouvelle\s*conversation|nuova\s*chat)$/i;

function findNewChatByLabel() {
  let els;
  try {
    els = document.querySelectorAll('[tabindex="0"]');
  } catch {
    return null;
  }
  for (const el of els) {
    if (!isVisible(el)) continue;
    let text = "";
    try {
      text = (el.textContent || "").trim();
    } catch {
      continue;
    }
    if (!text || text.length > 40) continue;
    if (NEW_CHAT_LABEL_RE.test(text)) return el;
  }
  return null;
}

/**
 * Provider outage banner. Rendered in different element types across builds
 * (span / div / p), with or without the trailing period. A leaf-only size
 * guard prevents a false positive on a container whose textContent happens
 * to include the whole conversation.
 */
function serverDownVisible() {
  let els;
  try {
    els = document.querySelectorAll("span, div, p");
  } catch {
    return false;
  }
  const needle = "Server is temporarily unavailable";
  for (const el of els) {
    try {
      // Leaf-ish elements only: skip containers that concatenate many
      // children (which would include the banner inside a huge blob).
      if (el.children.length > 2) continue;
      const t = (el.textContent || "").trim();
      if (t.length > 120) continue;
      if (t === needle || t === needle + ".") return true;
      // Some builds append a short suffix; keep the prefix match tight
      // (must be within 4 chars of the bare sentence).
      if (t.startsWith(needle) && t.length <= needle.length + 4) return true;
    } catch {
      continue;
    }
  }
  return false;
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
  // Match a "disabled" class token in any form: bare "disabled", BEM
  // modifier "ds-button--disabled", or kebab "btn-disabled". The old
  // /(^|\s)disabled(\s|$)/ regex missed the BEM shape, letting a still-
  // disabled DeepSeek send button pass the gate and swallow the click.
  if (cls) {
    for (const tok of cls.split(/\s+/)) {
      if (tok && (tok === "disabled" || tok.endsWith("-disabled"))) return false;
    }
  }
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

/** Concurrency-refusal text visible in transient notice surfaces (mirrors
 * noticeRateLimitHit). */
function noticeConcurrencyHit() {
  for (const el of findAll(SELECTORS.noticeRegions)) {
    const t = (el.textContent || "").trim();
    if (t && t.length < 300 && CONCURRENCY_RE.test(t)) return true;
  }
  return false;
}

/** Broad submit-block scan for the concurrency refusal — notice surfaces AND
 * chat nodes that appeared after `preCount` (same shapes as
 * submitRateLimitHit: inline bubble, toast, or nothing at all when the send
 * is rejected server-side before render). */
function submitConcurrencyHit(preCount) {
  if (noticeConcurrencyHit()) return true;
  const nodes = conversationNodes();
  for (let i = Math.max(0, preCount); i < nodes.length; i++) {
    const t = (nodes[i].textContent || "").trim();
    if (t && t.length < 400 && CONCURRENCY_RE.test(t)) return true;
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
  for (let i = 0; i < 5 && scope.parentElement; i++) scope = scope.parentElement;
  return scope;
}

/**
 * Find the send control. Priority: explicit selectors anywhere, then icon
 * buttons scoped near the composer (send sits bottom-right => last match).
 */
/**
 * Detect DeepSeek's edit-message UI: a Cancel control rendered in the
 * composer's action bar. Editing a previous message reuses the composer
 * element; if a turn is dispatched while the tab is in edit mode, placeText
 * overwrites the edit draft and the submit never fires — the composer then
 * shows the tool-results text with Cancel/Send buttons and no reply streams.
 */
function composerInEditMode(composer) {
  if (!composer) return false;
  let scope;
  try {
    scope = composerScope(composer);
  } catch {
    return false;
  }
  let buttons;
  try {
    buttons = scope.querySelectorAll('button, div[role="button"], [role="button"]');
  } catch {
    return false;
  }
  for (const el of buttons) {
    if (!isVisible(el)) continue;
    let text = "";
    try {
      text = (el.textContent || "").trim().toLowerCase();
    } catch {
      continue;
    }
    if (text === "cancel" || text === "取消") return true;
  }
  return false;
}

/** Click the Cancel control in the composer action bar to exit edit mode. */
function exitEditMode(composer) {
  if (!composer) return false;
  let scope;
  try {
    scope = composerScope(composer);
  } catch {
    return false;
  }
  let buttons;
  try {
    buttons = scope.querySelectorAll('button, div[role="button"], [role="button"]');
  } catch {
    return false;
  }
  for (const el of buttons) {
    if (!isVisible(el)) continue;
    let text = "";
    try {
      text = (el.textContent || "").trim().toLowerCase();
    } catch {
      continue;
    }
    if (text === "cancel" || text === "取消") {
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Locate the SEND control, scoped STRICTLY to the composer's action bar.
 *
 * History: an earlier revision used a document-wide search for
 * `div[role="button"][aria-disabled]`, which ALSO matches every action
 * button on user message bubbles (Copy, Regenerate, EDIT, thumbs, speaker,
 * share). `direct[direct.length - 1]` returned the last such button in the
 * DOM — usually an edit affordance — and clicking it opened DeepSeek's
 * edit-message UI instead of submitting. The turn then hung: no POST fired,
 * no completion stream attached, no TURN_DONE ever reached the bridge.
 *
 * The scoped version below cannot leave the composer subtree.
 *
 * Preference order (all within composerScope(composer)):
 *   1. DeepSeek design-system send button (ds-button--primary + ds-button--circle)
 *      — the ds-* class names are public and stable; the trailing _xxxxxx
 *      tokens on the same element are generated CSS-in-JS hashes and are
 *      never relied on.
 *   2. a button whose class names it a send control (legacy DeepSeek builds)
 *   3. the LAST enabled SVG-bearing button in the composer action bar
 *      (the real send control sits at the end of that row)
 */
function findSendButton(composer) {
  if (!composer) return null;
  let scope;
  try {
    scope = composerScope(composer);
  } catch {
    return null;
  }

  // 1. DeepSeek design-system send button — never a generated hash.
  for (const sel of SELECTORS.sendButton) {
    try {
      const matches = [...scope.querySelectorAll(sel)].filter(isVisible);
      if (matches.length > 0) return matches[matches.length - 1];
    } catch {
      /* invalid selector for this DOM — try the next one */
    }
  }

  let candidates;
  try {
    candidates = [
      ...scope.querySelectorAll('button, div[role="button"], [role="button"]'),
    ].filter(isVisible);
  } catch {
    return null;
  }

  // 2. Legacy fallback: a class that names the element a send control.
  const isSendish = (el) => {
    const cls = typeof el.className === "string" ? el.className : "";
    return /(^|[\s-])send([\s_-]|$)/i.test(cls);
  };
  const classMatches = candidates.filter(isSendish);
  if (classMatches.length > 0) {
    const enabled = classMatches.filter(isEnabled);
    return enabled.length > 0 ? enabled[enabled.length - 1] : classMatches[classMatches.length - 1];
  }

  // 3. Last resort: the LAST enabled icon button in the action bar.
  const iconBtns = candidates.filter((el) => el.querySelector("svg"));
  if (iconBtns.length > 0) {
    const enabled = iconBtns.filter(isEnabled);
    if (enabled.length > 0) return enabled[enabled.length - 1];
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
    try {
      // Clear stale content first: insertText appends, so a left-over
      // composer would double the prompt (setComposerValue replaces).
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch {
      /* selection API unavailable — insert anyway */
    }
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
    await sleep(400);
    const pasted = readComposer(composer);
    if (pasted.length === 0) return "file"; // handler consumed it (attachment)
    if (pasted === text) return "inline";
  }
  setComposerValue(composer, text);
  await sleep(200);
  const val = readComposer(composer);
  if (val.length === 0 && text.length > 400) return "file"; // converted by the app
  if (val.length === 0) return "ignored";
  return "inline";
}

function clickSend(btn) {
  // Require the button to be CONNECTED and enabled at click time. A
  // reference captured by an earlier poll can point at a node React has
  // already swapped out; clicking it is a silent no-op.
  if (btn && btn.isConnected && isEnabled(btn)) {
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

/** Count of the field-verified DeepSeek bubble container (div.ds-message).
 * This is the only reliable "a message landed" signal for a background tab:
 * button[class*="stop"] and div[class*="markdown"] both false-positive on
 * unrelated UI (dev panels, code previews), which silently masked no-op
 * submits as "slow replies". */
function dsMessageCount() {
  try {
    return document.querySelectorAll("div.ds-message").length;
  } catch {
    return 0;
  }
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
async function verifySubmitted(composer, baseCount, baseDsCount, stopBefore, hadText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    await sleep(250);
    if (submitRateLimitHit(baseCount)) return "rate-limited";
    if (dsMessageCount() > baseDsCount) return true;
    if (!stopBefore && findFirst(SELECTORS.stopButton)) return true;
    if (hadText && readComposer(composer).length === 0) return true;
    if (Date.now() > deadline) return false;
  }
}

/**
 * Wait until the composer is genuinely ready to accept a fresh submit: the
 * stop control is gone AND the send button is enabled AND both stay that way
 * for ~1s. Guards the window right after a previous generation where the UI
 * swaps stop -> send asynchronously — without this the submit can fire into
 * a still-disabled button 15 ms after the prior stream closed and be
 * swallowed silently.
 */
/**
 * Wait for the tab to be in a state where a fresh submit can be placed.
 *
 * Scope: the ONLY thing this needs to guarantee is that a previous
 * generation has finished (its stop control is gone) and stayed gone for a
 * short stability window, so we do not append text to a composer that the
 * previous turn's completion handler is about to clear.
 *
 * The composer is legitimately EMPTY at this point — placeText() has not
 * run yet — and DeepSeek keeps the send button disabled by design until
 * there is content. The old condition `!stopBtn && isEnabled(sendBtn)`
 * therefore never became true on an empty composer, and the loop spun
 * until timeout: 8s primary + 3s grace re-check = ~11s of dead time on
 * every turn (measured: turn.accepted 11:38:54.752 -> first FRAGMENT
 * 11:39:08.757, 14.0s total, ~11s of which was this loop).
 *
 * The enabled-state gate on the send button belongs AFTER placeText, and
 * that is exactly what waitReadyToSubmit() does. This function must not
 * duplicate it.
 */
async function waitStableSend(composer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  for (; ;) {
    const stopBtn = findFirst(SELECTORS.stopButton);
    const ok = !stopBtn;
    if (ok) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince >= 300) return true;
    } else {
      stableSince = 0;
    }
    if (Date.now() > deadline) return false;
    await sleep(100);
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
  // If the composer is showing an edit draft (Cancel/Send in the action bar),
  // exit that mode FIRST. Otherwise placeText overwrites the draft and the
  // eventual click lands on the edit-send button, which the app rejects as
  // "no edit target" — no POST fires, no stream, and the turn hangs.
  if (composerInEditMode(composer)) {
    dbg("composer in edit mode — cancelling edit before placing text");
    if (exitEditMode(composer)) {
      await sleep(350);
      // Re-resolve the composer: the edit UI may have swapped the node.
      const again = findFirst(SELECTORS.composer);
      if (again) composer = again;
    }
  }
  // Guard against the window right after a previous generation where the
  // UI swaps stop -> send asynchronously. If the pre-check times out, give
  // the DOM one more grace window; if it is STILL unstable, proceed — the
  // downstream waitReadyToSubmit polls the live button and the post-click
  // verify is the real safety net.
  if (!(await waitStableSend(composer, 8000))) {
    dbg("waitStableSend timed out; grace re-check before placing text");
    await sleep(300);
    if (!(await waitStableSend(composer, 3000))) {
      dbg("waitStableSend still unstable after grace; proceeding");
    }
  }
  const mode = await placeText(composer, text);
  if (mode === "ignored") {
    if (submitRateLimitHit(preCount)) {
      return { ok: false, code: "rate_limited", detail: "composer rejected the prompt under a provider send block" };
    }
    if (submitConcurrencyHit(preCount)) {
      return { ok: false, code: "concurrency_blocked", detail: "composer rejected the prompt: another message is generating" };
    }
    return {
      ok: false,
      code: "submit-failed",
      detail: "composer rejected the prompt text",
      userBubbleRendered: conversationNodes().length > preCount,
    };
  }
  const ready = await waitReadyToSubmit(composer, preCount, readyTimeoutMs);
  if (!ready.ok) {
    if (submitConcurrencyHit(preCount)) {
      return {
        ok: false,
        code: "concurrency_blocked",
        detail: `${ready.detail || "provider notice: another message is generating"} (mode=${mode})`,
      };
    }
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
      userBubbleRendered: conversationNodes().length > preCount,
    };
  }
  const baseCount = conversationNodes().length;
  // baseDsCount uses the field-verified bubble container ONLY: broad legacy
  // selectors can grow on a stale render from the previous turn, and a
  // false-positive there was the root cause of the intermittent
  // "verified-submit-but-no-stream" failures.
  const baseDsCount = dsMessageCount();
  const stopBefore = !!findFirst(SELECTORS.stopButton);
  const hadText = readComposer(composer).length > 0;
  const rateLimitedResult = () => ({
    ok: false,
    code: "rate_limited",
    detail: "provider notice: messages too frequent (submit rejected)",
  });
  const concurrencyBlockedResult = () => ({
    ok: false,
    code: "concurrency_blocked",
    detail: "provider notice: another message is generating (submit rejected)",
  });
  // Method A: re-find and re-check right before clicking — a stale
  // reference survives React re-renders, and isEnabled() must read the
  // LIVE class list (BEM "--disabled" included).
  const btnA = findSendButton(composer);
  const a = clickSend(btnA) ? await verifySubmitted(composer, baseCount, baseDsCount, stopBefore, hadText, verifyMs) : false;
  if (a === "rate-limited" || (a !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
  if (a !== true && submitConcurrencyHit(preCount)) return concurrencyBlockedResult();
  if (a === true) return { ok: true, mode };
  // Method B: Enter on the composer.
  pressEnter(composer);
  const b = await verifySubmitted(composer, baseCount, baseDsCount, stopBefore, hadText, verifyMs);
  if (b === "rate-limited" || (b !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
  if (b !== true && submitConcurrencyHit(preCount)) return concurrencyBlockedResult();
  if (b === true) return { ok: true, mode };
  // Last resort: re-find the button (the DOM may have re-rendered after the
  // attachment finished processing) and click it if it is now enabled.
  const btn2 = findSendButton(composer);
  const c = clickSend(btn2) ? await verifySubmitted(composer, baseCount, baseDsCount, stopBefore, hadText, verifyMs) : false;
  if (c === "rate-limited" || (c !== true && submitRateLimitHit(preCount))) return rateLimitedResult();
  if (c !== true && submitConcurrencyHit(preCount)) return concurrencyBlockedResult();
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
    userBubbleRendered: conversationNodes().length > preCount,
  };
}

// ---------------------------------------------------------------------------
// reply capture (v1.2: SSE-primary, DOM fallback)
// ---------------------------------------------------------------------------

/** One active turn per tab. null when idle. */
let turn = null;
let sseHookPresent = false;
/** Timestamp when the last turn ended (settle-floor anchor for the next TURN). */
let lastTurnEndedAt = 0;

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
    dbg("first fragment " + (Date.now() - t.startedAt) + "ms after TURN for", t.reqId, `(mode=${t.mode}, ${text.length} chars)`);
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
function finishTurn(ok, code, detail, aborted, extra) {
  const t = turn;
  if (!t || t.finished) return;
  t.finished = true;
  if (t.fallbackTimer) clearTimeout(t.fallbackTimer);
  if (t.watchdog) clearInterval(t.watchdog);
  if (t.domObserver) t.domObserver.disconnect();
  if (t.domTick) clearInterval(t.domTick);
  hookPost({ type: "disarm" });
  turn = null;
  lastTurnEndedAt = Date.now();
  // Best-effort composer hygiene: if the turn ended with a leftover draft
  // (failed or unverified submit), leave the composer clean so the next
  // turn's readiness gate does not trip on stale content.
  try {
    const c = findFirst(SELECTORS.composer);
    if (c && readComposer(c).length > 0) {
      dbg("clearing leftover composer text after turn end");
      setComposerValue(c, "");
    }
  } catch {
    /* best effort */
  }
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
      ...(extra || {}),
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

/**
 * Provider stopped mid-answer with a Continue button on screen: click it and
 * keep the SAME turn going (same reqId, append-only deltas). The continuation
 * is a fresh completion POST, so the hook is re-armed to catch it. Bounded:
 * returns false when no button is present or the budget is spent.
 */
function maybeContinue(t, why) {
  if (!t || t.finished || (t.continues | 0) >= MAX_CONTINUES) return false;
  const btn = findContinueButton();
  if (!btn) return false;
  t.continues = (t.continues | 0) + 1;
  t.awaitContinue = Date.now();
  dbg("clicking Continue", `(${t.continues}/${MAX_CONTINUES}, ${why})`);
  try {
    btn.click();
  } catch {
    /* click-through fallback below */
  }
  // Re-arm: the continuation POST must be captured even though this arm
  // already spent its single capture. Async delivery is fine — DeepSeek
  // takes well over an event-loop turn to fire the request.
  hookPost({ type: "arm", turnId: t.reqId, timeoutMs: t.opts.timeoutMs || 240000 });
  return true;
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

  /** Reply text: only nodes that appeared AFTER our prompt was submitted.
   * Prefers the dedicated answer node (thinking excluded structurally);
   * otherwise strips thinking subtrees from a clone (never mutates the page).
   * Our own injected prompt (TOOL RESULTS / ASSISTANT CUE block) is never a
   * reply, even when it renders after the baseline. */
  function replyText() {
    const nodes = conversationNodes();
    if (nodes.length <= t.baseCount) return null; // no reply bubble yet
    const last = nodes[nodes.length - 1];
    let text = "";
    try {
      const main =
        last.querySelector && last.querySelector("div.ds-assistant-message-main-content");
      if (main) {
        text = main.textContent || "";
      } else {
        const clone = last.cloneNode(true);
        const thinkers = clone.querySelectorAll("div.ds-think-content");
        thinkers.forEach((n) => {
          try {
            n.remove();
          } catch {
            /* noop */
          }
        });
        text = clone.textContent || "";
      }
    } catch {
      return null;
    }
    if (text.startsWith("=== TOOL RESULTS ===")) return null; // our own echo
    return text;
  }

  const domDone = () => {
    const composer = findFirst(SELECTORS.composer);
    const sendBtn = composer ? findSendButton(composer) : null;
    const stopBtn = findFirst(SELECTORS.stopButton);
    // done = generation over: stop control gone AND send enabled again.
    // A Continue button means halted, not done (handled before this).
    if (findContinueButton()) return false;
    return !stopBtn && sendBtn && isEnabled(sendBtn);
  };

  /** Stable text + done controls: Continue first, server-down next, else done. */
  const settleTurn = () => {
    if (maybeContinue(t, "dom-settled")) {
      stableSince = 0;
      tickStableSince = 0;
      return;
    }
    if (serverDownVisible()) {
      finishTurn(false, "dom-error", "provider: server temporarily unavailable");
      return;
    }
    finishTurn(true);
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
      else if (Date.now() - stableSince > 400 && domDone()) settleTurn();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Secondary completion detector: a reply that finishes entirely inside the
  // baseline-settle window never shows growth to the observer, so the tick
  // checks "text settled + stop control gone + send enabled" on its own.
  // It also bounds the silent case: a reply bubble that never appears at all
  // (submitted but the provider never rendered) fails here within 60s
  // instead of hanging to the turn deadline.
  let nullSince = 0;
  const tick = setInterval(() => {
    if (t.finished) {
      clearInterval(tick);
      return;
    }
    const text = replyText();
    if (text === null) {
      // Provider outage check FIRST. DeepSeek renders
      // "Server is temporarily unavailable." as a system notice and the
      // reply bubble never grows. Report the specific provider error so the
      // bridge maps it to a retryable 502 — NOT submit-failed with
      // submit_no_bubble=true, which wrongly tells the caller the tab was
      // untouched when the tool-results attachment WAS placed.
      if (serverDownVisible()) {
        finishTurn(false, "dom-error", "provider: server temporarily unavailable");
        return;
      }
      if (!nullSince) nullSince = Date.now();
      else {
        // No user bubble ever appeared (baseCount === submitCount) means the
        // submit never landed — fail fast instead of riding the full 60 s.
        const limit = t.baseCount === t.submitCount ? 5000 : 60000;
        if (Date.now() - nullSince > limit) {
          // Enrich the failure with the state we saw, so the bridge log
          // pins down whether the composer was in edit mode, a Continue
          // button was on-screen, or the tab simply never responded.
          let diag = "";
          try {
            const c = findFirst(SELECTORS.composer);
            diag = ` [editMode=${composerInEditMode(c) ? "y" : "n"}, continueBtn=${findContinueButton() ? "y" : "n"}, composerLen=${c ? readComposer(c).length : -1}]`;
          } catch {
            /* diagnostic only */
          }
          finishTurn(
            false,
            "submit-failed",
            `reply bubble never appeared within ${limit / 1000}s of submit${diag}`,
            false,
            { userBubbleRendered: conversationNodes().length > t.submitCount }
          );
        }
      }
      return;
    }
    nullSince = 0;
    if (text.length !== tickLen) {
      tickLen = text.length;
      tickStableSince = Date.now();
      return;
    }
    if (tickStableSince && Date.now() - tickStableSince > 600 && text.length > 0 && domDone()) {
      settleTurn();
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
      } else if (CONCURRENCY_RE.test(d.finishReason || "") || CONCURRENCY_RE.test(d.content || "")) {
        finishTurn(false, "concurrency_blocked", d.content || "provider: another message is being generated");
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
      if (
        d.hintError &&
        (CONCURRENCY_RE.test(d.hintError.finishReason || "") ||
          CONCURRENCY_RE.test(d.hintError.content || ""))
      ) {
        finishTurn(false, "concurrency_blocked", d.hintError.content || "provider: another message is being generated");
        break;
      }
      if (!finalText && t.emitted.length === 0) {
        if (serverDownVisible()) {
          finishTurn(false, "dom-error", "provider: server temporarily unavailable");
          break;
        }
        if (submitConcurrencyHit(t.submitCount)) {
          finishTurn(false, "concurrency_blocked", "provider notice: another message is generating");
          break;
        }
        fallbackToDom(t, "completion stream closed without text");
        break;
      }
      // Provider halted mid-answer with more available: resume in this turn.
      if (maybeContinue(t, "sse-complete")) break;
      if (d.hintError && /length|max_tokens|truncat|too_long/i.test(d.hintError.finishReason || "")) {
        // Length halt but no button on screen yet (it renders late): hold the
        // turn open briefly. Backdated so the watchdog re-checks in ~10s —
        // clicks if it appeared, else finishes with the partial answer.
        dbg("length halt, waiting for Continue button");
        t.awaitContinue = Date.now() - 20000;
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
    if (submitConcurrencyHit(t.submitCount)) {
      finishTurn(false, "concurrency_blocked", "provider notice: another message is generating");
      return;
    }
    if (now > t.deadline) {
      finishTurn(false, "timeout", `turn exceeded ${t.opts.timeoutMs || 240000}ms`);
      return;
    }
    if (t.mode === "sse" && t.lastSseAt && now - t.lastSseAt > SSE_IDLE_TIMEOUT_MS) {
      // A visible Continue means halted, not dead: resume instead of timing out.
      if (!maybeContinue(t, "sse-idle")) {
        finishTurn(false, "timeout", "SSE stream idle >120s");
      }
      return;
    }
    // A Continue click that produced no stream within 30s: the click either
    // missed the hook window or the provider stalled. Button back: try again
    // (bounded); button gone with nothing new: end with what we captured.
    // Stream activity after the click disarms this entirely.
    if (t.awaitContinue && t.lastSseAt < t.awaitContinue && now - t.awaitContinue > 30000) {
      t.awaitContinue = 0;
      if (!maybeContinue(t, "continue-no-stream")) {
        if (t.emitted.length > 0) finishTurn(true);
        else fallbackToDom(t, "continuation produced no stream");
      }
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

/**
 * 15s no-stream window handler. If the bubble container grew (a slow render
 * beat the stream), hand capture to the DOM observer. Otherwise, when the
 * composer still holds the text and no bubble rendered, self-heal by
 * re-running the submit pipeline once (idempotent — no bubble means nothing
 * to duplicate). Only after the retry does the turn actually fail.
 */
async function onNoStream(t, composer, originalText, isRetry) {
  if (turn !== t || t.finished || t.mode !== "sse-await") return;
  // Provider outage wins over every other diagnostic: DeepSeek shows
  // "Server is temporarily unavailable." instead of a reply stream, and a
  // re-submit cannot help until the provider recovers. Report the specific
  // error so the bridge maps it to a retryable 502 rather than treating the
  // tool-results attachment as a successful submit.
  if (serverDownVisible()) {
    finishTurn(false, "dom-error", "provider: server temporarily unavailable");
    return;
  }
  const domEvidence = dsMessageCount() > (t.dsMessageBase ?? t.submitCount);
  if (domEvidence) {
    fallbackToDom(
      t,
      isRetry ? "no completion stream within 15s (retry)" : "no completion stream within 15s"
    );
    return;
  }
  if (!isRetry) {
    const composerNow = findFirst(SELECTORS.composer);
    const heldText = composerNow ? readComposer(composerNow) : "";
    if (composerNow && heldText.length > 0) {
      dbg("submit-failed: no stream/bubble after 15s — re-submitting (composer still holds text)");
      if (sseHookPresent) {
        hookPost({ type: "arm", turnId: t.reqId, timeoutMs: t.opts.timeoutMs || 240000 });
      }
      const retry = await submitPrompt(
        composerNow,
        heldText,
        t.opts.submitWaitMs || SUBMIT_READY_TIMEOUT_MS,
        true
      );
      if (turn === t && !t.finished) {
        if (retry.ok) {
          dbg("re-submit accepted; awaiting stream");
          t.unverified = retry.unverified === true;
          scheduleNoStreamFallback(t, composerNow, heldText, true);
          return;
        }
        dbg("re-submit not verified by DOM:", retry.detail || retry.code);
      }
    }
  }
  diagnoseSubmit(composer, originalText);
  finishTurn(
    false,
    "submit-failed",
    isRetry
      ? "re-submit failed: no completion stream and no ds-message growth"
      : "submit not confirmed: no completion stream within 15s and no ds-message growth",
    false,
    { userBubbleRendered: false }
  );
}

function scheduleNoStreamFallback(t, composer, originalText, isRetry) {
  t.fallbackTimer = setTimeout(() => {
    void onNoStream(t, composer, originalText, isRetry);
  }, SSE_FALLBACK_AFTER_MS);
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
  const sinceLastTurn = Date.now() - lastTurnEndedAt;
  if (lastTurnEndedAt > 0 && sinceLastTurn < 300) {
    await sleep(300 - sinceLastTurn);
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
    continues: 0, // provider Continue clicks this turn (bounded)
    awaitContinue: 0, // timestamp of the last Continue click awaiting stream
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
    t.dsMessageBase = dsMessageCount();
    const submitted = await submitPrompt(
      composer,
      msg.text,
      opts.submitWaitMs || SUBMIT_READY_TIMEOUT_MS,
      t.mode === "sse-await"
    );
    if (!submitted.ok) {
      finishTurn(false, submitted.code || "submit-failed", submitted.detail, false, {
        ...(typeof submitted.userBubbleRendered === "boolean"
          ? { userBubbleRendered: submitted.userBubbleRendered }
          : {}),
      });
      return;
    }
    t.unverified = submitted.unverified === true;
    dbg("submitted in " + (Date.now() - t.startedAt) + "ms (paste-mode=" + submitted.mode + ", capture=" + t.mode + (t.unverified ? ", unverified" : "") + ")");
    // Let the user bubble render before freezing the reply baseline.
    await sleep(REPLY_BASELINE_SETTLE_MS);
    t.baseCount = conversationNodes().length;
    if (t.mode === "dom") {
      startDomObserver(t);
    } else {
      scheduleNoStreamFallback(t, composer, msg.text, false);
    }
    startWatchdog(t);
  } catch (e) {
    finishTurn(false, "dom-error", String(e && e.message));
  }
}

async function handleReset(msg) {
  const fresh = !!(msg && msg.fresh);
  try {
    const link = findFirst(SELECTORS.newChat) || findNewChatByLabel();
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
      // No control: try the app's new-chat keyboard shortcut before giving
      // up. A successful shortcut resets in place — no navigation, no tab
      // reload, no bfcache churn (navigation churn correlates 1:1 with
      // worker-link deaths). Verified exactly like a click; on failure the
      // worker falls back to navigate-home as before.
      if (await tryShortcutReset()) return;
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
 * New-chat via the app's keyboard shortcut (Ctrl+Shift+O on DeepSeek web).
 * Synthetic key events only reach page listeners, never browser UI, so the
 * worst case is a no-op — and the verify loop below rejects anything but an
 * actually-emptied conversation. Returns true on verified reset.
 */
async function tryShortcutReset() {
  try {
    const target = document.activeElement || document.body;
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "O",
        code: "KeyO",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  } catch {
    return false;
  }
  const deadline = Date.now() + 8000;
  for (;;) {
    await sleep(300);
    try {
      const now = conversationNodes().length;
      const onHome = location.pathname === "/";
      if (now === 0 || onHome) {
        dbg("reset confirmed via keyboard shortcut");
        report("RESET_OK", {});
        return true;
      }
    } catch {
      /* DOM in flux — keep waiting */
    }
    if (Date.now() > deadline) break;
  }
  return false;
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

connectPort();

// Probe the MAIN-world hook. Its install-time "hello" was posted before this
// script ran (document_start vs document_idle), so ask it to re-announce.
hookPost({ type: "ping" });
setTimeout(() => {
  if (!sseHookPresent) dbg("SSE hook not detected — turns will use DOM capture");
}, 2000);
