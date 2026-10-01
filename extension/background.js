/**
 * Tab Bridge — Chrome extension service worker (L0 worker-side, spec 7.3).
 *
 * Connects to the Node bridge over WebSocket (ws://127.0.0.1:8789/worker),
 * speaks the v1 worker protocol (intents in, observations out) and drives the
 * per-tab injector content scripts through runtime ports.
 *
 * State held here (per ADR-2 this is ONLY pool/binding/health state — never
 * conversation state):
 *   tabState    : tabId -> { state, health, sessionId }
 *   sessionTab  : sessionId -> tabId
 *   portByTab   : tabId -> runtime Port to the injector
 *   turnByReq   : reqId  -> { tabId, port, timer }
 */

const DEFAULT_WS_URL = "ws://127.0.0.1:8789/worker";
const PROTOCOL_VERSION = 1;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** Minimum WS uptime for a close to count as "stable" (backoff resets) rather
 * than a "flap" (backoff grows). 5s cleanly separates the two regimes: a
 * bridge-refused duplicate dies within milliseconds; a healthy link that
 * later drops because Chrome reclaimed the SW lives for seconds-to-minutes. */
const STABLE_CONNECTION_MS = 5000;
/**
 * Chrome MV3 suspends an extension service worker after 30 s of no activity.
 * The activity that counts is: extension-API calls, port messages, and
 * INBOUND WebSocket messages. OUTBOUND WS frames do NOT reset the timer on
 * their own — the bridge must answer our PING with a PONG for the frame
 * to do us any good (see WorkerPool.onMessage).
 *
 * The bridge now answers every PING with a PONG, so a 10 s interval gives
 * three inbound frames inside the 30 s window even with one lost delivery.
 * Reduced from 15 s (v1.2.64) after the previous version saw the SW still
 * killed at ~28.5 s — right at the threshold — while the bridge silently
 * dropped our PINGs.
 */
const PING_INTERVAL_MS = 10000;
/**
 * v1.2.61: was 45_000. Chrome MV3 reclaims an idle service worker well
 * before 45s of no extension-API activity; the RESET wait (which uses no
 * chrome.* API while the SW awaits the injector reply) was losing its
 * timer and dying mid-reset, then reconnecting, receiving the same RESET
 * from the bridge, and dying again — the flap cascade. Keep the timeout
 * below the idle horizon AND drive a keepalive tick during the wait.
 */
const RESET_TIMEOUT_MS = 20_000;
const START_URL = "https://chat.deepseek.com/";
/**
 * DeepSeek "Messages too frequent. Try again later." cooldown. The provider
 * enforces a per-account send-frequency window (~20 min observed); while a tab
 * cools down it is not allocated to any session.
 */
const RATE_LIMIT_COOLDOWN_MS = 20 * 60 * 1000;

let ws = null;
let wsUrl = DEFAULT_WS_URL;
let backoff = RECONNECT_MIN_MS;
/** Timestamp of the last successful WS open; used to distinguish a flap
 * (short-lived connection → grow backoff) from a stable close (reset). */
let connectedAt = 0;
/**
 * Dedicated pool window for managed tabs. Managed DeepSeek tabs live here
 * instead of the user's main window, so activating one (which un-throttles
 * its timers and its DeepSeek paste-to-file pipeline) does not steal OS
 * focus from whatever the user is looking at in their own window. Created
 * lazily; persisted in chrome.storage.session across SW restarts but NOT
 * across browser restarts (stale window IDs would otherwise point at a
 * different window after Chrome reassigns them).
 */
let poolWindowId = null;
/** Window id that had OS focus before we briefly focused the pool window,
 * so we can restore it after the injector's Continue click. Null when we
 * have not stolen focus. */
let priorFocusedWindowId = null;
let poolConfig = { autoCreateTabs: false, managedOnly: true, warmTabs: 0, maxTabs: 4, tabIdleCloseMs: 15 * 60 * 1000 };
let helloOk = false;
// Stable per-profile identity (loaded from storage.local at boot, default
// while the async load is in flight). Sent in HELLO so the bridge log can
// distinguish one looping worker from several live duplicates.
let instanceId = "w-booting";
const helloQueue = []; // intents arriving before HELLO_OK (never handle on defaults)
let seq = 0;

// Visible-by-default SW log (console.debug is hidden unless Verbose is on).
function blog(...a) {
  try {
    console.log("[tab-bridge-worker]", ...a);
  } catch {
    /* noop */
  }
}
// Per-request fragment counters (reqId -> {n, chars}); capped ring.
const fragStats = new Map();
function fragNote(reqId, text) {
  let s = fragStats.get(reqId);
  if (!s) {
    s = { n: 0, chars: 0 };
    fragStats.set(reqId, s);
    if (fragStats.size > 50) fragStats.delete(fragStats.keys().next().value);
  }
  s.n += 1;
  s.chars += (text || "").length;
  return s;
}

const tabState = new Map(); // tabId -> { state, health, sessionId, rateLimitedUntil? }
const sessionTab = new Map(); // sessionId -> tabId
const portByTab = new Map(); // tabId -> Port
const readyWaiters = new Map(); // tabId -> [resolve]
const turnByReq = new Map(); // reqId -> { tabId, timer }

/**
 * Tabs this worker created (persisted across service-worker restarts).
 * ONLY these are ever allocated to bridge sessions. Foreign tabs — the
 * user's own DeepSeek tabs — also connect injectors, but their ports are
 * ignored entirely: allocating one would drive the user's personal
 * conversation with bridge prompts.
 */
const managedTabs = new Set();
let managedLoaded = false;
const pendingPorts = []; // injector ports arriving before the managed set loads

function saveManaged() {
  try {
    chrome.storage.local.set({ managedTabs: [...managedTabs] });
  } catch {
    /* storage unavailable */
  }
}

chrome.storage.local.get({ managedTabs: [], workerInstance: null }, (res) => {
  try {
    for (const id of res.managedTabs || []) {
      if (typeof id === "number") managedTabs.add(id);
    }
  } catch {
    /* corrupted entry — start empty */
  }
  // v1.2.49: re-attach on boot. debuggerAttached is a per-SW Set, so a
  // worker restart clears it; without this, the first Continue click
  // after a restart pays the handshake again. Fire-and-forget.
  for (const id of managedTabs) eagerAttachDebugger(id);
  // Stable per-profile worker identity, shared with the bridge in HELLO.
  // Successive log lines with DIFFERENT ids prove distinct live workers
  // (profiles/browsers); the SAME id repeating proves one worker looping.
  try {
    instanceId =
      typeof res.workerInstance === "string" && res.workerInstance
        ? res.workerInstance
        : "w-" + Math.random().toString(36).slice(2, 10);
    chrome.storage.local.set({ workerInstance: instanceId });
  } catch {
    instanceId = "w-ephemeral";
  }
  managedLoaded = true;
  for (const p of pendingPorts.splice(0)) handleInjectorConnect(p.port, p.tabId);
});

// ---------------------------------------------------------------------------
// websocket link
// ---------------------------------------------------------------------------

try {
  self.addEventListener("unhandledrejection", (ev) => {
    try {
      const r = ev && ev.reason;
      console.error("[tab-bridge-worker] unhandled rejection:", String((r && (r.stack || r.message)) || r));
    } catch {
      /* noop */
    }
  });
} catch {
  /* noop */
}
try {
  self.addEventListener("error", (ev) => {
    try {
      console.error("[tab-bridge-worker] uncaught error:", String((ev && (ev.message || ev.error)) || ev));
    } catch {
      /* noop */
    }
  });
} catch {
  /* noop */
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      // An uncaught throw here would terminate the service worker, which
      // closes the WS abruptly (read: read ECONNRESET on the bridge) and
      // starts a reconnect metronome. Swallow and log instead.
      blog("send failed:", String((e && e.message) || e));
      return false;
    }
  }
  return false;
}

function connect() {
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    // NOTE: backoff does NOT reset here. It resets only when a connection
    // closes after a stable uptime — see the close handler below.
    connectedAt = Date.now();
    blog("worker link open ->", wsUrl);
    let extVersion = "unknown";
    try {
      extVersion = chrome.runtime.getManifest().version || "unknown";
    } catch {
      /* noop */
    }
    send({ t: "HELLO", v: PROTOCOL_VERSION, ext: "deepseek-web", extVersion, instance: instanceId });
    startPingLoop();
  });
  ws.addEventListener("message", (ev) => {
    let m = null;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m && m.t === "HELLO_OK") {
      // Do NOT reset backoff here. A connection that dies shortly after
      // HELLO_OK is a flap and must grow backoff; see the close handler.
      helloOk = true;
      poolConfig = { maxTabs: 4, tabIdleCloseMs: 15 * 60 * 1000, ...(m.config || poolConfig) };
      blog("bridge HELLO_OK", JSON.stringify(poolConfig));
      // E4: warm tabs become real — pre-create once the handshake completes.
      void ensureWarmTabs().catch((e) => blog("warm tabs failed:", String((e && e.message) || e)));
      // Flush intents that arrived during the handshake: they must run under
      // the real pool config, never the default-deny one (otherwise BIND
      // fails spuriously with no-tab-available despite autoCreateTabs).
      // Capped: without a handshake these would pile up unboundedly.
      const queued = helloQueue.splice(0, 20);
      for (const q of queued) {
        // routeIntent can throw synchronously (a sync intent handler hitting
        // a dead port, a bad state); an uncaught throw here terminates the
        // whole service worker, which the bridge reads as ECONNRESET ~1 s
        // after every connect — the metronome the RCA traced through every
        // RESET -> reseed cycle.
        try {
          routeIntent(q);
        } catch (e) {
          blog("queued intent dispatch failed:", String((e && e.message) || e));
        }
      }
      return;
    }
    if (m && m.t === "HELLO_REFUSED") {
      // Another worker holds the bridge link (duplicate extension install:
      // second profile, second Chrome channel). Retrying fast only spams;
      // back off hard so a transient duplicate resolves itself, and say
      // loudly which end must be disabled.
      backoff = 60_000;
      blog(
        "bridge refused this worker:",
        m.reason,
        "— disable the Tab Bridge Worker extension in every OTHER Chrome profile/channel; this copy will retry in 60s"
      );
      return;
    }
    // Every intent handler below can throw (dead ports, closed tabs, racing
    // disconnects). An uncaught throw here terminates the whole service
    // worker, which the bridge reads as ECONNRESET ~1s after connect.
    // Intents arriving before HELLO_OK are parked, never handled under the
    // default-deny pool config.
    try {
      if (!helloOk && m && ["BIND", "SEND", "RESET", "ABORT", "RELEASE", "PING"].includes(m.t)) {
        if (helloQueue.length < 20) helloQueue.push(m);
        else blog("dropping pre-handshake intent (queue full):", m.t);
        return;
      }
      if (m) routeIntent(m);
    } catch (e) {
      blog("intent dispatch failed:", String((e && e.message) || e));
    }
  });
  ws.addEventListener("close", (ev) => {
    const uptime = connectedAt > 0 ? Date.now() - connectedAt : 0;
    connectedAt = 0;
    const code = ev && typeof ev.code === "number" ? ev.code : null;
    const reason = ev && typeof ev.reason === "string" ? ev.reason : "";
    if (uptime >= STABLE_CONNECTION_MS) {
      // Connection was healthy for a while: this is a normal disconnect,
      // reset the backoff so the next attempt fires quickly.
      backoff = RECONNECT_MIN_MS;
      blog("worker link closed after " + uptime + "ms uptime (code=" + code + ")" +
           (reason ? " reason=" + reason : "") +
           " — reconnecting in", backoff, "ms");
    } else {
      // Flap: the connection died soon after opening. Do NOT reset backoff
      // — the next reconnect delay is already doubled by scheduleReconnect.
      blog("worker link flapped after " + uptime + "ms (code=" + code + ")" +
           (reason ? " reason=" + reason : "") +
           " — reconnecting in", backoff, "ms");
    }
    stopPingLoop();
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {}
  });
}

function routeIntent(m) {
  if (m.t === "BIND") {
    void handleBind(m).catch((e) => {
      // A failed BIND must still answer: otherwise the bridge hangs the full
      // bind timeout. Include a stack — mystery throwers like "No SW" get
      // exactly one more chance to stay anonymous.
      const err = String((e && e.stack) || (e && e.message) || e);
      blog("BIND failed:", err.split("\n").slice(0, 4).join(" | "));
      send({ t: "BIND_FAILED", sessionId: m.sessionId, code: "worker-error", detail: err.slice(0, 300) });
    });
  }
  else if (m.t === "SEND") handleSend(m);
  else if (m.t === "RESET") handleReset(m);
  else if (m.t === "ABORT") handleAbort(m);
  else if (m.t === "PING") handlePing(m);
  else if (m.t === "RELEASE") handleRelease(m);
}

function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
}

let pingTimer = null;
/**
 * WebSocket-activity SW keepalive.
 *
 * Sends a PING intent every PING_INTERVAL_MS AND makes a trivial chrome.*
 * call in the same tick. Two reasons for both:
 *
 *   1. Chrome 116+ extends SW lifetime on WebSocket activity, but only if
 *      messages are exchanged more frequently than every 30s. The PING
 *      itself qualifies; the bridge answers PONG, so both directions flow.
 *   2. The docs are ambiguous about whether a pure send-only exchange
 *      counts. A cheap chrome.runtime.getPlatformInfo() call is a
 *      documented no-op that Chrome counts as extension activity, so it
 *      guarantees the SW stays alive even if (1) is not honoured on some
 *      Chrome channel.
 *
 * This is the supported, documented pattern. It is not a hack: it is the
 * exact mechanism Google publishes for WebSocket-bearing MV3 extensions.
 * It replaces the previous chrome.storage.session.get() tick, which (a)
 * used an API Chrome does not count as keepalive activity, and (b) only
 * ran while there was pending work — i.e. it stopped exactly when the SW
 * went idle, which is when Chrome suspends it.
 */
function startPingLoop() {
  stopPingLoop();
  pingTimer = setInterval(() => {
    send({ t: "PING", seq: ++seq });
    try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch { /* noop */ }
  }, PING_INTERVAL_MS);
}
function stopPingLoop() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

// ---------------------------------------------------------------------------
// tab pool
// ---------------------------------------------------------------------------

function tabsSnapshot() {
  // v1.2.69 — lazily expire rate-limit cooldowns while building the snapshot.
  //
  // The 2026-10-01 log showed the harness could not recover from a rate
  // limit even after the 20-minute cooldown had passed: the stateful session
  // still had row.tabId set, so `ensureTabAndReady` skipped the BIND and went
  // straight to adapter.ensureReady → pool.ping → this function. The tab's
  // st.health was still "rate_limited" from 20 minutes earlier because
  // `tabInCooldown` (the only code that clears it on expiry) is called from
  // `allocateTab`, and allocateTab only runs on BIND. No BIND → no expiry →
  // ensureReady reported the stale health → harness got "provider-rate-limited"
  // in 5 ms, three retries in a row.
  //
  // Calling tabInCooldown here means any tabsSnapshot (and therefore any
  // PONG snapshot the bridge polls) reflects the current cooldown status,
  // not the last-observed one. tabInCooldown also emits the correct HEALTH
  // observation when it clears the state, so the bridge's healthByTab is
  // updated in the same tick.
  return [...tabState.entries()].map(([tabId, st]) => {
    tabInCooldown(tabId, st);
    return {
      tabId,
      state: st.state,
      health: st.health || "ok",
    };
  });
}

function markHealth(tabId, health, detail) {
  const st = tabState.get(tabId);
  if (st) st.health = health;
  send({ t: "HEALTH", tabId, state: health, ...(detail ? { detail } : {}) });
}

/**
 * Return the pool window id, creating the window if needed. A "pool window"
 * is a normal Chrome window created with focused:false — visible (so its
 * active tab is NOT intensively throttled) but never stealing OS focus
 * from the user's own window. Managed tabs are created inside it.
 */
async function ensurePoolWindow() {
  // Cached and still alive?
  if (poolWindowId !== null) {
    try {
      await chrome.windows.get(poolWindowId);
      return poolWindowId;
    } catch {
      poolWindowId = null;
    }
  }
  // Recover from storage.session (survives SW restart, cleared at browser exit).
  try {
    const stored = await chrome.storage.session.get({ poolWindowId: null });
    if (typeof stored.poolWindowId === "number") {
      await chrome.windows.get(stored.poolWindowId);
      poolWindowId = stored.poolWindowId;
      blog("pool window recovered:", poolWindowId);
      return poolWindowId;
    }
  } catch {
    /* stale id — fall through and create a new window */
  }
  // Create it. No URL: the caller (allocateTab) will open its own tab.
  let win;
  try {
    win = await chrome.windows.create({ focused: false, type: "normal" });
  } catch (e) {
    blog("pool window create failed:", String((e && e.message) || e));
    return null;
  }
  poolWindowId = win.id;
  try {
    await chrome.storage.session.set({ poolWindowId });
  } catch {
    /* session storage unavailable — in-memory only */
  }
  blog("pool window created:", poolWindowId);
  return poolWindowId;
}

/**
 * Briefly focus the pool window so the DeepSeek tab's document.hasFocus()
 * returns true. A synthetic click from an unfocused window is refused by
 * many defensive handlers — this is the one signal a synthetic event
 * cannot otherwise provide. Restored by restorePriorFocus() once the
 * injector has finished dispatching.
 */
async function focusPoolForInjection() {
  if (poolWindowId === null) return;
  try {
    const current = await chrome.windows.getLastFocused();
    if (current && typeof current.id === "number" && current.id !== poolWindowId) {
      priorFocusedWindowId = current.id;
    }
    await chrome.windows.update(poolWindowId, { focused: true });
    blog("pool window focused for injection:", poolWindowId);
  } catch (e) {
    blog("focus pool window failed:", String((e && e.message) || e));
  }
}

async function restorePriorFocus() {
  const target = priorFocusedWindowId;
  priorFocusedWindowId = null;
  if (target === null) return;
  try {
    await chrome.windows.update(target, { focused: true });
    blog("focus restored to window:", target);
  } catch {
    /* window may have been closed — ignore */
  }
}

async function allocateTab(sessionId, opts = {}) {
  // 1) re-use a free managed tab (skipping rate-limit cooldowns).
  // Foreign tabs are never in tabState, and the managedTabs check below is
  // belt-and-braces for the same invariant.
  for (const [tabId, st] of tabState) {
    if (
      st.state === "ready" &&
      !st.sessionId &&
      !tabInCooldown(tabId, st) &&
      managedTabs.has(tabId)
    )
      return tabId;
  }
  // 2) every free tab is cooling down -> tell the bridge it is a rate-limit,
  //    not a generic capacity miss (maps to 429 + Retry-After ~20 min)
  const freeTabs = [...tabState.values()].filter((st) => st.state === "ready" && !st.sessionId);
  if (freeTabs.length > 0 && freeTabs.every((st) => st.health === "rate_limited")) {
    return "rate-limited-cooldown";
  }
  // 3) create one if allowed
  if (!poolConfig.autoCreateTabs) {
    blog("BIND", "(allocate) autoCreateTabs off — no free managed tab");
    return null;
  }
  // E5: background-class ephemeral binds must never grow the pool.
  if (opts.noCreate) {
    blog("BIND", "(allocate) noCreate — refusing to create a tab for background traffic");
    return null;
  }
  // E2: cap the pool at maxTabs (0 = unbounded). Prefer closing the
  // least-recently-released free tab before creating a new one; if nothing
  // is closable, refuse so the bridge surfaces a clean 503/429.
  if (poolConfig.maxTabs > 0 && managedTabs.size >= poolConfig.maxTabs) {
    const victim = oldestReleasedFreeTab();
    if (victim !== null) {
      blog("BIND", "(allocate) at maxTabs — closing LRU free tab", victim);
      await closeManagedTab(victim);
    } else {
      blog("BIND", "(allocate) at maxTabs with no closable tab");
      return "at-capacity";
    }
  }
  blog("BIND", "(allocate) creating managed tab...");
  let created;
  try {
    const poolWin = await ensurePoolWindow();
    created = poolWin !== null
      ? await chrome.tabs.create({ windowId: poolWin, url: START_URL, active: false })
      : await chrome.tabs.create({ url: START_URL, active: false });
  } catch (e) {
    blog("BIND", "(allocate) chrome.tabs.create threw:", String((e && e.message) || e));
    throw e;
  }
  if (!created || typeof created.id !== "number") {
    blog("BIND", "(allocate) chrome.tabs.create returned no tab id");
    throw new Error("tab-create returned no usable tab");
  }
  blog("BIND", "(allocate) created tab", created.id, "— waiting for load");
  managedTabs.add(created.id);
  saveManaged();
  tabState.set(created.id, { state: "connecting", health: "ok", dirty: false });
  // v1.2.49: attach the CDP debugger now so the first Continue click does
  // not pay the attach handshake (Chrome allows only one debugger per tab).
  eagerAttachDebugger(created.id);
  // Cold-tab grace: the injector port connects before the SPA finishes
  // booting, and submits into a half-loaded app silently go nowhere (first
  // turn fails, retry succeeds). Wait for the document load first.
  const loaded = await waitForLoaded(created.id, 30000);
  if (!loaded) {
    blog("BIND", "(allocate) tab", created.id, "document never finished loading within 30s");
    tabState.set(created.id, { state: "dead", health: "degraded" });
    return null;
  }
  const ok = await waitForReady(created.id, 20000);
  if (!ok) {
    blog("BIND", "(allocate) tab", created.id, "injector never connected within 20s");
    tabState.set(created.id, { state: "dead", health: "degraded" });
    return null;
  }
  tabState.get(created.id).state = "ready";
  blog("BIND", "(allocate) tab", created.id, "ready");
  return created.id;
}

/** Resolve when the tab's document reaches complete status (or timeout). */
function waitForLoaded(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      try {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError || !tab) return resolve(false);
          if (tab.status === "complete") return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, 500);
        });
      } catch {
        return resolve(false);
      }
    };
    poll();
  });
}

function tabInCooldown(tabId, st) {
  if (!st.rateLimitedUntil) return false;
  if (Date.now() >= st.rateLimitedUntil) {
    // cooldown expired: restore the tab to the allocatable pool
    delete st.rateLimitedUntil;
    st.health = "ok";
    send({ t: "HEALTH", tabId, state: "ok", detail: "rate-limit cooldown expired" });
    return false;
  }
  return true;
}

/** Longest remaining rate-limit cooldown across known tabs, in seconds. */
function maxCooldownRemainingSecs() {
  let max = 0;
  for (const st of tabState.values()) {
    if (st.rateLimitedUntil && st.rateLimitedUntil > Date.now()) {
      max = Math.max(max, st.rateLimitedUntil - Date.now());
    }
  }
  return Math.ceil(max / 1000);
}

/**
 * Crash-proof port send. postMessage on a dead port THROWS synchronously,
 * and an uncaught throw inside the WS message handler terminates the whole
 * service worker — which reads on the bridge as ECONNRESET ~1s after every
 * connect (the metronome). Returns false and drops the stale port instead.
 */
function safePost(tabId, msg) {
  const port = portByTab.get(tabId);
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    if (portByTab.get(tabId) === port) portByTab.delete(tabId);
    return false;
  }
}

function waitForReady(tabId, timeoutMs) {
  const existing = portByTab.get(tabId);
  if (existing) return Promise.resolve(true);
  return new Promise((resolve) => {
    const list = readyWaiters.get(tabId) || [];
    list.push(resolve);
    readyWaiters.set(tabId, list);
    setTimeout(() => {
      // drop the stale waiter so a late injector connect can't fire it twice
      const cur = readyWaiters.get(tabId) || [];
      const i = cur.indexOf(resolve);
      if (i !== -1) cur.splice(i, 1);
      resolve(false);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// intent handlers
// ---------------------------------------------------------------------------

async function handleBind(m) {
  const tabId = await allocateTab(m.sessionId, { noCreate: m.noCreate === true });
  if (tabId === "rate-limited-cooldown") {
    blog("BIND", m.sessionId, "-> rate-limited-cooldown");
    send({
      t: "BIND_FAILED",
      sessionId: m.sessionId,
      code: "rate-limited-cooldown",
      retryAfterSec: Math.max(30, maxCooldownRemainingSecs()),
    });
    return;
  }
  if (tabId === null || tabId === undefined || tabId === "at-capacity") {
    const atCap = tabId === "at-capacity";
    blog("BIND", m.sessionId, atCap ? "-> no-tab-available (at maxTabs)" : "-> no-tab-available");
    send({ t: "BIND_FAILED", sessionId: m.sessionId, code: "no-tab-available", ...(atCap ? { detail: "at-capacity: pool at maxTabs" } : {}) });
    return;
  }
  const st = tabState.get(tabId) || { state: "ready", health: "ok", dirty: true };
  // Unknown dirtiness (re-registered tab with no record) is treated as dirty
  // by the bridge; default true when the flag was never set.
  if (st.dirty === undefined) st.dirty = true;
  st.sessionId = m.sessionId;
  st.releasedAt = undefined;
  tabState.set(tabId, st);
  sessionTab.set(m.sessionId, tabId);
  blog("BIND", m.sessionId, "-> tab", tabId, `(${st.state},dirty=${st.dirty})`);
  send({ t: "BOUND", sessionId: m.sessionId, tabId, state: st.state, dirty: st.dirty === true });
}

function handleSend(m) {
  // The bridge includes the bound tabId (optional per protocol); fall back to
  // the single-bound-tab scan for minimal workers.
  let useTab = typeof m.tabId === "number" ? m.tabId : undefined;
  if (useTab === undefined) {
    for (const tid of sessionTab.values()) {
      const st = tabState.get(tid);
      if (st && st.state !== "dead") {
        useTab = tid;
        break;
      }
    }
  }
  if (useTab === undefined) {
    send({ t: "ERROR", reqId: m.reqId, code: "submit-failed", detail: "no bound tab" });
    return;
  }
  const port = portByTab.get(useTab);
  if (!port) {
    blog("SEND", m.reqId, "-> port-lost (tab", useTab, ")");
    send({ t: "ERROR", reqId: m.reqId, code: "port-lost", detail: "injector port missing" });
    markHealth(useTab, "degraded", "port-missing");
    return;
  }
  const timer = setTimeout(() => {
    const rec = turnByReq.get(m.reqId);
    if (rec && !rec.finished) {
      rec.finished = true;
      if (rec.quietTimer) clearTimeout(rec.quietTimer);
      send({ t: "ERROR", reqId: m.reqId, code: "timeout", detail: "turn exceeded deadline" });
      turnByReq.delete(m.reqId);
    }
  }, (m.opts && m.opts.timeoutMs) || 240000);
  const rec = { tabId: useTab, timer, finished: false, quietTimer: null };
  turnByReq.set(m.reqId, rec);
  rec.quietTimer = setTimeout(() => {
    const r = turnByReq.get(m.reqId);
    if (r && !r.finished && (fragStats.get(m.reqId)?.n || 0) === 0) {
      blog(
        "SEND", m.reqId, "-> tab", useTab,
        "was sent 30s ago with no FRAGMENT/TURN_DONE/TURN_ERROR yet —",
        "check the tab console for [tab-bridge]/[tab-bridge:sse] lines and",
        "evaluate __tabBridgeSseDiag (census shows the streaming transport)"
      );
    }
  }, 30000);
  blog("SEND", m.reqId, "-> tab", useTab, `(${(m.text || "").length} chars)`);
  // Activate the tab within its window. The pool window is created with
  // focused:false, so this does not steal OS focus — but the tab becomes
  // the active tab of a visible window, which is the tier Chrome does NOT
  // intensively throttle. Without this, DeepSeek's paste-to-file pipeline
  // (which drives the attachment conversion through React + timers) runs
  // at throttled speed in a hidden tab, adding 60–120 s to the first
  // fragment of large prompts.
  try {
    chrome.tabs.update(useTab, { active: true }, () => void chrome.runtime.lastError);
  } catch {
    /* tab gone — safePost below will surface it */
  }
  if (!safePost(useTab, { t: "TURN", reqId: m.reqId, text: m.text, opts: m.opts || {} })) {
    blog("SEND", m.reqId, "-> port died between lookup and send (tab", useTab, ")");
    send({ t: "ERROR", reqId: m.reqId, code: "port-lost", detail: "injector port died on send" });
    markHealth(useTab, "degraded", "port-died-on-send");
    const rec0 = turnByReq.get(m.reqId);
    if (rec0) {
      rec0.finished = true;
      clearTimeout(rec0.timer);
      if (rec0.quietTimer) clearTimeout(rec0.quietTimer);
      turnByReq.delete(m.reqId);
    }
    return;
  }
  // Ack the take-over: the bridge's adapter blocks until ACCEPTED/ERROR, so
  // this must arrive even though the injector is still working.
  send({ t: "ACCEPTED", reqId: m.reqId });
}

/**
 * Pending resets by bridge reqId. Keyed independently of port objects:
 * clicking "new chat" navigates the tab, killing the injector (and its
 * port) mid-reset — the reply then arrives on the reconnected port, which
 * the old per-port listener never saw (hence RESET_TIMEOUT on success).
 */
const resetStates = new Map(); // reqId -> { targets: Set<tabId>, pending: Set<tabId>, navigated: Set<tabId>, fresh, timer, done }

function handleReset(m) {
  // A session-scoped reset addresses its own tab; the legacy broadcast form
  // (no tabId) still fans out to all bound tabs.
  const targets =
    typeof m.tabId === "number" ? [m.tabId] : [...sessionTab.values()];
  if (targets.length === 0) {
    send({ t: "RESET_OK", reqId: m.reqId }); // nothing bound: trivially reset
    return;
  }
  const st = {
    targets: new Set(targets),
    pending: new Set(targets),
    navigated: new Set(),
    fresh: false,
    timer: null,
    done: false,
  };
  resetStates.set(m.reqId, st);
  st.timer = setTimeout(() => {
    if (st.done) return;
    st.done = true;
    resetStates.delete(m.reqId);
    blog("RESET", m.reqId, "timed out waiting for injector reply");
    send({ t: "RESET_TIMEOUT", reqId: m.reqId });
  }, RESET_TIMEOUT_MS);
  blog("RESET", m.reqId, "-> tabs", targets.join(","));
  let posted = 0;
  for (const tabId of targets) {
    if (safePost(tabId, { t: "RESET" })) {
      posted++;
    } else {
      blog("RESET", m.reqId, "no live port for tab", tabId);
    }
  }
  if (posted === 0) {
    // Nothing will ever reply (no ports, no reconnects to re-arm): fail fast
    // instead of hanging the bridge on the full reset timeout.
    finishResetFailed(m.reqId, "no live injector ports for reset targets");
  }
}

/** First OK wins (historical semantics); failures resolve per tab below. */
function finishResetOk(reqId) {
  const st = resetStates.get(reqId);
  if (!st || st.done) return;
  st.done = true;
  clearTimeout(st.timer);
  resetStates.delete(reqId);
  // WS-D: a successful reset leaves every target tab clean.
  for (const tabId of st.targets) {
    const tst = tabState.get(tabId);
    if (tst) tst.dirty = false;
  }
  blog("RESET", reqId, "ok");
  send({ t: "RESET_OK", reqId });
}

function finishResetFailed(reqId, detail) {
  const st = resetStates.get(reqId);
  if (!st || st.done) return;
  st.done = true;
  clearTimeout(st.timer);
  resetStates.delete(reqId);
  blog("RESET", reqId, `failed (${detail || "no detail"})`);
  send({ t: "RESET_TIMEOUT", reqId });
}

/** Route an injector reset reply to its reset state, whichever port it came on. */
function onResetReply(tabId, msg) {
  for (const [reqId, st] of resetStates) {
    if (st.done || !st.targets.has(tabId)) continue;
    if (msg.t !== "RESET_OK" && msg.t !== "RESET_FAILED") continue;
    if (msg.t === "RESET_OK") {
      finishResetOk(reqId);
      return;
    }
    // No new-chat control (selector drift): navigate this tab home as the
    // reset action itself, once per tab. The reconnect re-post carries
    // fresh:true so the injector confirms by URL, no selectors involved.
    // Other tabs keep their own pending replies; only the last outstanding
    // failure without recovery ends the reset.
    if (/new-chat control not found/i.test(msg.detail || "") && !st.navigated.has(tabId)) {
      st.navigated.add(tabId);
      st.fresh = true;
      blog("RESET", reqId, "no new-chat control — navigating tab", tabId, "home as the reset");
      try {
        // Floating this promise kills the worker: an unhandled tabs.update
        // rejection terminates the whole service worker, which the bridge
        // reads as ECONNRESET ~1s after connect — the metronome.
        const r = chrome.tabs.update(tabId, { url: START_URL });
        if (r && typeof r.catch === "function") {
          r.catch((e) => blog("RESET", reqId, "navigate failed for tab", tabId, String((e && e.message) || e)));
        }
      } catch (e) {
        blog("RESET", reqId, "navigate failed for tab", tabId, String((e && e.message) || e));
      }
      return; // keep pending; the reconnect re-post completes it
    }
    st.pending.delete(tabId);
    if (st.pending.size === 0) finishResetFailed(reqId, msg.detail);
    else blog("RESET", reqId, `tab ${tabId} failed, still waiting for ${[...st.pending].join(",")}`);
  }
}

function handleAbort(m) {
  const rec = turnByReq.get(m.reqId);
  if (rec) {
    safePost(rec.tabId, { t: "ABORT", reqId: m.reqId });
  }
}

function handlePing(m) {
  send({ t: "PONG", seq: m.seq, tabs: tabsSnapshot() });
}

function handleRelease(m) {
  // E1 cross-version safety: older bridges sent `evict:<id>`; strip it.
  const raw = m.sessionId;
  const sid = typeof raw === "string" && raw.startsWith("evict:") ? raw.slice("evict:".length) : raw;
  const tabId = sessionTab.get(sid);
  sessionTab.delete(sid);
  // Also clear the prefixed key in case a peer stored it verbatim.
  if (sid !== raw) sessionTab.delete(raw);
  if (tabId !== undefined) {
    const st = tabState.get(tabId);
    if (st) {
      st.sessionId = null;
      st.state = "ready";
      // E3: record when the tab became free for the idle-close sweep.
      // Dirtiness is kept — the tab still shows the old conversation.
      st.releasedAt = Date.now();
    }
  }
  send({ t: "RELEASED", sessionId: raw });
}

// ---------------------------------------------------------------------------
// injector port plumbing
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  if (tabId === null || port.name !== "injector") return;
  if (!managedLoaded) {
    // Storage hasn't delivered the managed set yet: park the port, decide
    // once we know (prevents a foreign tab winning a race at boot).
    pendingPorts.push({ port, tabId });
    return;
  }
  handleInjectorConnect(port, tabId);
});

function handleInjectorConnect(port, tabId) {
  if (!managedTabs.has(tabId)) {
    // Foreign tab (the user's own DeepSeek tab, or a managed tab from
    // before the registry existed): never tracked, never allocated. Its
    // injector keeps the page untouched.
    blog("ignoring foreign tab", tabId, "(not worker-created; never allocated)");
    return;
  }
  blog("injector connected (tab", tabId + ")");
  portByTab.set(tabId, port);
  const st = tabState.get(tabId);
  if (st && st.state === "connecting") st.state = "ready";
  else if (!st) {
    // Service-worker restart wiped our tables while a managed tab (and its
    // injector) survived: re-register it so PONG snapshots — and therefore
    // the bridge's ensureReady — see it again. Session affinity is
    // re-established by the bridge's next BIND.
    // WS-D: dirtiness is unknown after a restart, so report dirty — the
    // bridge resets before SEED rather than appending into a stale chat.
    tabState.set(tabId, { state: "ready", health: "ok", dirty: true });
    blog("injector reconnected managed tab", tabId, "(unknown state — marked dirty)");
  }
  const waiters = readyWaiters.get(tabId) || [];
  readyWaiters.set(tabId, []);
  waiters.forEach((fn) => fn(true));
  // A reconnect mid-reset means the navigation killed the injector before it
  // could reply: re-arm the fresh port so its reply completes the reset.
  // After a navigate-home fallback the re-post carries fresh:true (URL check).
  // Only tabs still awaiting a reply are re-armed — never already-resolved ones.
  for (const [reqId, rst] of resetStates) {
    if (!rst.done && rst.pending.has(tabId)) {
      blog("re-posting RESET", reqId, "to reconnected tab", tabId, rst.fresh ? "(fresh)" : "");
      safePost(tabId, rst.fresh ? { t: "RESET", fresh: true } : { t: "RESET" });
    }
  }

  port.onMessage.addListener((msg) => {
    try {
      handleInjectorMessage(tabId, port, msg);
    } catch (e) {
      // An uncaught throw here terminates the service worker, which kills
      // the WS to the bridge. Swallow and log so the SW survives one bad
      // message.
      blog("port message handler threw:", String((e && e.stack) || (e && e.message) || e));
    }
  });
  port.onDisconnect.addListener(() => {
    if (portByTab.get(tabId) === port) portByTab.delete(tabId);
    blog("injector disconnected (tab", tabId + ")");
    markHealth(tabId, "degraded", "port-disconnected");
    // Fail every in-flight turn on this tab now — the injector can no
    // longer answer, and letting them ride to the deadline turns a tab
    // crash into a 4-minute hang.
    for (const [reqId, rec] of [...turnByReq]) {
      if (rec.tabId === tabId && !rec.finished) {
        rec.finished = true;
        clearTimeout(rec.timer);
        if (rec.quietTimer) clearTimeout(rec.quietTimer);
        turnByReq.delete(reqId);
        send({ t: "ERROR", reqId, code: "port-lost", detail: "injector port disconnected mid-turn" });
      }
    }
  });
}

/**
 * Trusted click via chrome.debugger + CDP Input.dispatchMouseEvent.
 *
 * A synthetic click produces a MouseEvent with isTrusted: false; some
 * handlers refuse such events on principle. chrome.debugger sends the
 * event through Chrome's own input pipeline, so isTrusted is true — the
 * same primitive Puppeteer uses. Attach is per-tab and short-lived: we
 * attach, dispatch mouseMoved + mousePressed + mouseReleased, then
 * detach. If DevTools is already attached to the target tab, attach
 * fails with "Another debugger is already attached" — the injector falls
 * back to a synthetic click in that case.
 */
function debuggerAttach(target, version) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}
function debuggerSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}
function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      // Ignore lastError — detach is best-effort.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}
// v1.2.48 — attach the CDP debugger ONCE per pool tab and keep it attached
// for the tab's lifetime. The previous per-click attach/detach added ~1s
// to every Continue click (attach handshake + detach handshake per press).
// Chrome detaches automatically when the tab is destroyed.
const debuggerAttached = new Set();

// v1.2.49 — eager attach: pay the CDP handshake ONCE per pool tab,
// at tab creation and on service-worker boot, instead of lazily on the
// first Continue click. Fire-and-forget: a failure (DevTools open on the
// tab, permission revoked, tab already gone) logs and is swallowed, and
// the lazy path inside debuggerClick still retries on demand.
function eagerAttachDebugger(tabId) {
  if (typeof tabId !== "number") return;
  if (debuggerAttached.has(tabId)) return;
  void debuggerEnsureAttached({ tabId }).then(
    () => blog("debugger attached (eager)", tabId),
    (e) => blog("debugger eager attach failed", tabId, String((e && e.message) || e))
  );
}

async function debuggerEnsureAttached(target) {
  if (debuggerAttached.has(target.tabId)) return;
  try {
    await debuggerAttach(target, "1.3");
    debuggerAttached.add(target.tabId);
    return;
  } catch (e) {
    const msg = String((e && e.message) || e);
    // "Another debugger is already attached" — could be a prior attach
    // of ours (the Set is per-SW, lost on restart) or DevTools. Proceed
    // optimistically; a real DevTools conflict surfaces on the dispatch.
    if (/already attached/i.test(msg)) {
      debuggerAttached.add(target.tabId);
      return;
    }
    throw e;
  }
}

async function debuggerClick(tabId, x, y) {
  const target = { tabId };
  try {
    await debuggerEnsureAttached(target);
  } catch (e) {
    return { ok: false, error: "attach: " + String((e && e.message) || e) };
  }
  try {
    const base = { x, y, button: "left", clickCount: 1, buttons: 1 };
    await debuggerSend(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", clickCount: 0, buttons: 0,
    });
    await debuggerSend(target, "Input.dispatchMouseEvent", {
      ...base, type: "mousePressed",
    });
    await debuggerSend(target, "Input.dispatchMouseEvent", {
      ...base, type: "mouseReleased", buttons: 0,
    });
    return { ok: true };
  } catch (e) {
    // Attach may have been revoked silently (DevTools opened, SW restart).
    // Drop the cached flag so the next call re-attaches.
    debuggerAttached.delete(tabId);
    return { ok: false, error: "dispatch: " + String((e && e.message) || e) };
  }
}

function handleInjectorMessage(tabId, port, msg) {
  if (msg.t === "DEBUGGER_CLICK") {
    void debuggerClick(tabId, msg.x, msg.y).then((r) => {
      try {
        port.postMessage({
          t: "DEBUGGER_CLICK_RESULT",
          reqId: msg.reqId,
          ok: !!r.ok,
          error: r.error || null,
        });
      } catch { /* port closed */ }
    });
    return;
  }
  // Focus-management messages are handled out of band: they are not turn
  // events and must not go through the turn state machine.
  if (msg.t === "FOCUS_POOL_WINDOW") {
    void focusPoolForInjection();
    return;
  }
  if (msg.t === "RESTORE_FOCUS") {
    void restorePriorFocus();
    return;
  }
    switch (msg.t) {
      case "FRAGMENT": {
        const s = fragNote(msg.reqId, msg.text);
        if (s.n === 1) blog("first FRAGMENT", msg.reqId, `(${(msg.text || "").length} chars)`);
        send({
          t: "FRAGMENT",
          reqId: msg.reqId,
          seq: msg.seq,
          text: msg.text,
          ...(msg.full ? { full: true } : {}),
        });
        break;
      }
      case "TURN_DONE":
      case "TURN_ABORTED": {
        const rec = turnByReq.get(msg.reqId);
        if (rec && !rec.finished) {
          rec.finished = true;
          clearTimeout(rec.timer);
          if (rec.quietTimer) clearTimeout(rec.quietTimer);
          turnByReq.delete(msg.reqId);
        }
        const st = tabState.get(tabId);
        if (st) {
          st.submitFails = 0; // healthy turn clears the wedge counter
          st.dirty = true; // WS-D: tab now shows this turn's conversation
        }
        const s = fragStats.get(msg.reqId);
        blog(msg.t, msg.reqId, s ? `(${s.n} fragments, ${s.chars} chars)` : "(no fragments)");
        fragStats.delete(msg.reqId);
        // v1.2.56: emit USAGE before STATUS done when the injector forwarded
        // the provider-reported token delta. The deepseek adapter reads
        // ev.t === "USAGE" and stashes meta onto TurnResult.usageMeta.
        if (typeof msg.usageTokens === "number" && msg.usageTokens > 0) {
          send({ t: "USAGE", reqId: msg.reqId, meta: { total_tokens: msg.usageTokens } });
        }
        send({ t: "STATUS", reqId: msg.reqId, code: msg.t === "TURN_DONE" ? "done" : "aborted" });
        break;
      }
      case "TURN_ERROR": {
        const rec = turnByReq.get(msg.reqId);
        if (rec && !rec.finished) {
          rec.finished = true;
          clearTimeout(rec.timer);
          if (rec.quietTimer) clearTimeout(rec.quietTimer);
          turnByReq.delete(msg.reqId);
        }
        if (msg.code === "rate_limited") {
          applyRateLimitCooldown(tabId);
        }
        // Even a failed turn may have placed content; mark dirty unless the
        // injector confirms no user bubble rendered (tab untouched).
        const turnSt = tabState.get(tabId);
        if (turnSt && msg.userBubbleRendered !== false) turnSt.dirty = true;
        if (msg.code === "submit-failed" || msg.code === "send-button-disabled") {
          noteSubmitFail(tabId, msg.code);
        }
        const s = fragStats.get(msg.reqId);
        blog("TURN_ERROR", msg.reqId, msg.code, msg.detail || "", s ? `(${s.n} frags, ${s.chars} chars)` : "(no fragments)");
        fragStats.delete(msg.reqId);
        send({
          t: "ERROR",
          reqId: msg.reqId,
          code: msg.code || "dom-error",
          ...(msg.detail ? { detail: msg.detail } : {}),
          ...(msg.code === "rate_limited" ? { retryAfterSec: 1200 } : {}),
          // Report whether a user bubble actually rendered. A submit that
          // never placed one leaves the tab state untouched and must NOT
          // poison the session with a pendingReset + null tabHash (RCA
          // stage 2 — the poisoned-session loop).
          ...(typeof msg.userBubbleRendered === "boolean"
            ? { userBubbleRendered: msg.userBubbleRendered }
            : {}),
        });
        break;
      }
      case "HEALTH":
        markHealth(tabId, msg.state, msg.detail);
        break;
      case "RESET_OK":
      case "RESET_FAILED":
        onResetReply(tabId, msg);
        break;
      default:
        break;
    }
  }

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  portByTab.delete(tabId);
  if (managedTabs.delete(tabId)) saveManaged();
  for (const [sid, tid] of sessionTab) {
    if (tid === tabId) sessionTab.delete(sid);
  }
});

// If the user closes the pool window, drop the cached id so the next
// allocate creates a fresh one. (Stored session value is cleared too.)
chrome.windows.onRemoved.addListener((winId) => {
  if (winId === poolWindowId) {
    blog("pool window closed by user:", winId, "— will recreate on next allocate");
    poolWindowId = null;
    chrome.storage.session.remove("poolWindowId").catch(() => {});
  }
});

/** Put a tab into the provider rate-limit cooldown pool (~20 min). */
function applyRateLimitCooldown(tabId) {
  const st = tabState.get(tabId);
  if (!st) return;
  st.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  st.health = "rate_limited";
  send({ t: "HEALTH", tabId, state: "rate_limited", detail: "messages-too-frequent cooldown ~20min" });
}

/**
 * Wedged-tab recycling: consecutive submit-phase failures (button never
 * sendable, submits never landing) mean the tab's composer/DOM is degraded —
 * usually after many turns in one tab. Healthy turns reset the counter; at
 * the threshold the tab is closed outright. The bridge notices the unknown
 * tab on its next ensureReady and re-binds a fresh one; its chain is
 * untouched, so the next turn reseeds cleanly.
 */
const SUBMIT_FAIL_THRESHOLD = 3;

function noteSubmitFail(tabId, code) {
  const st = tabState.get(tabId);
  if (!st) return;
  st.submitFails = (st.submitFails || 0) + 1;
  blog(`submit failure ${st.submitFails}/${SUBMIT_FAIL_THRESHOLD} on tab`, tabId, `(${code})`);
  if (st.submitFails >= SUBMIT_FAIL_THRESHOLD) recycleTab(tabId, code);
}

function recycleTab(tabId, why) {
  blog("recycling wedged tab", tabId, `(${why}; bridge will re-bind fresh)`);
  tabState.delete(tabId);
  portByTab.delete(tabId);
  for (const [sid, tid] of sessionTab) {
    if (tid === tabId) sessionTab.delete(sid);
  }
  try {
    const r = chrome.tabs.remove(tabId);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    /* already gone */
  }
  send({ t: "HEALTH", tabId, state: "degraded", detail: `tab recycled after repeated submit failures (${why})` });
}

// ---------------------------------------------------------------------------
// pool hygiene: max-tabs LRU, idle close, warm tabs (WS-E)
// ---------------------------------------------------------------------------

/** Least-recently-released free managed tab, or null when none is closable. */
function oldestReleasedFreeTab() {
  let victim = null;
  let oldest = Infinity;
  for (const [tabId, st] of tabState) {
    if (st.state !== "ready" || st.sessionId) continue;
    if (!managedTabs.has(tabId)) continue;
    if (tabInCooldown(tabId, st)) continue;
    const ts = typeof st.releasedAt === "number" ? st.releasedAt : 0;
    if (ts < oldest) {
      oldest = ts;
      victim = tabId;
    }
  }
  return victim;
}

async function closeManagedTab(tabId) {
  tabState.delete(tabId);
  portByTab.delete(tabId);
  if (managedTabs.delete(tabId)) saveManaged();
  for (const [sid, tid] of sessionTab) {
    if (tid === tabId) sessionTab.delete(sid);
  }
  try {
    const r = chrome.tabs.remove(tabId);
    if (r && typeof r.catch === "function") await r.catch(() => {});
  } catch {
    /* already gone */
  }
  blog("pool hygiene closed tab", tabId);
}

/** E4: pre-create up to N managed tabs once the handshake completes. */
async function ensureWarmTabs() {
  const want = Math.max(0, Math.min(8, poolConfig.warmTabs | 0));
  if (!poolConfig.autoCreateTabs || want <= 0) return;
  const free = [...tabState.values()].filter((st) => st.state === "ready" && !st.sessionId).length;
  let need = want - free;
  while (need > 0) {
    if (poolConfig.maxTabs > 0 && managedTabs.size >= poolConfig.maxTabs) break;
    need--;
    try {
      const poolWin = await ensurePoolWindow();
      const created = poolWin !== null
        ? await chrome.tabs.create({ windowId: poolWin, url: START_URL, active: false })
        : await chrome.tabs.create({ url: START_URL, active: false });
      if (!created || typeof created.id !== "number") break;
      managedTabs.add(created.id);
      saveManaged();
      tabState.set(created.id, { state: "connecting", health: "ok", dirty: false });
      const loaded = await waitForLoaded(created.id, 30000);
      if (!loaded) {
        tabState.set(created.id, { state: "dead", health: "degraded" });
        continue;
      }
      const ok = await waitForReady(created.id, 20000);
      tabState.get(created.id).state = ok ? "ready" : "dead";
      if (ok) blog("warm tab ready:", created.id);
    } catch (e) {
      blog("warm tab create failed:", String((e && e.message) || e));
      break;
    }
  }
}

/** E3: close ready+unbound tabs idle beyond the threshold. MV3 service
 * workers die otherwise, so this runs on chrome.alarms. */
async function sweepIdleTabs() {
  const idleMs = poolConfig.tabIdleCloseMs | 0;
  if (!idleMs || idleMs <= 0) return;
  const now = Date.now();
  for (const [tabId, st] of [...tabState]) {
    if (st.state !== "ready" || st.sessionId) continue;
    if (!managedTabs.has(tabId)) continue;
    if (typeof st.releasedAt !== "number") continue;
    if (now - st.releasedAt >= idleMs) {
      blog("pool idle-close tab", tabId, `idle ${Math.round((now - st.releasedAt) / 1000)}s`);
      await closeManagedTab(tabId);
    }
  }
}

// ---------------------------------------------------------------------------
// boot: load config, keep the SW alive, connect
// ---------------------------------------------------------------------------

chrome.storage.sync.get({ wsUrl: DEFAULT_WS_URL }, (cfg) => {
  wsUrl = cfg.wsUrl || DEFAULT_WS_URL;
  connect();
});

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.create("pool-sweep", { periodInMinutes: 1 });
/**
 * v1.2.61: SW lifetime guard.
 *
 * Every long wait the SW does (RESET awaiting injector reply, BIND awaiting
 * tab load, turn awaiting completion) is a window in which no chrome.* API
 * is called and Chrome can reclaim the service worker. When that happens,
 * the pending timer / promise / port listener is lost, the bridge sees a
 * WS disconnect, reconnects, re-sends the same intent, and we get a flap
 * cascade.
 *
 * This tick fires every 10s and, whenever there is a pending operation,
 * calls a trivial chrome API (storage.session.get) so Chrome counts it as
 * activity and resets the idle horizon. It exits as soon as no operation
 * is pending.
 */
// Inform the bridge of every SW boot so crash loops are visible in the
// bridge log (with a wall-clock delta since process start we can only get
// coarsely, so just the boot counter is enough).
const swBootAt = Date.now();
function reportSwBoot() {
  // Deferred until the WS is up.
  const send2 = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ t: "HEALTH", state: "ok", detail: `sw-boot-ms=${swBootAt}` });
    } else {
      setTimeout(send2, 500);
    }
  };
  send2();
}

// Global error reporting: anything uncaught in the SW would normally kill
// it silently. Report to the bridge so we can see the exact exception.
try {
  self.addEventListener("unhandledrejection", (ev) => {
    const r = ev && ev.reason;
    const detail = String((r && (r.stack || r.message)) || r).slice(0, 300);
    blog("SW unhandledrejection:", detail);
    try { send({ t: "HEALTH", state: "degraded", detail: `unhandledrejection: ${detail}` }); } catch { /* noop */ }
  });
} catch { /* noop */ }
try {
  self.addEventListener("error", (ev) => {
    const detail = String((ev && (ev.message || ev.error)) || ev).slice(0, 300);
    blog("SW uncaught error:", detail);
    try { send({ t: "HEALTH", state: "degraded", detail: `error: ${detail}` }); } catch { /* noop */ }
  });
} catch { /* noop */ }

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") {
    // Reconnect if the WS is down. Keepalive during a healthy connection is
    // handled by startPingLoop (WS frame + chrome.runtime.getPlatformInfo).
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  }
  if (a.name === "pool-sweep") void sweepIdleTabs().catch((e) => blog("pool sweep failed:", String((e && e.message) || e)));
});

reportSwBoot();
