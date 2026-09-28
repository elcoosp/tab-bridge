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
const PING_INTERVAL_MS = 25000;
const RESET_TIMEOUT_MS = 45000;
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
let poolConfig = { autoCreateTabs: false, managedOnly: true, warmTabs: 0 };
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

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
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
    // NOTE: backoff resets only on HELLO_OK below. Resetting it here made a
    // refused duplicate reconnect metronomically every 1s forever (open fires
    // before the refusal arrives).
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
      backoff = RECONNECT_MIN_MS;
      helloOk = true;
      poolConfig = m.config || poolConfig;
      blog("bridge HELLO_OK", JSON.stringify(poolConfig));
      // Flush intents that arrived during the handshake: they must run under
      // the real pool config, never the default-deny one (otherwise BIND
      // fails spuriously with no-tab-available despite autoCreateTabs).
      // Capped: without a handshake these would pile up unboundedly.
      const queued = helloQueue.splice(0, 20);
      for (const q of queued) routeIntent(q);
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
  ws.addEventListener("close", () => {
    blog("worker link closed — reconnecting in", backoff, "ms");
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
function startPingLoop() {
  stopPingLoop();
  pingTimer = setInterval(() => {
    send({ t: "PING", seq: ++seq }); // unanswered PONGs let the bridge mark us dead
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
  return [...tabState.entries()].map(([tabId, st]) => ({
    tabId,
    state: st.state,
    health: st.health || "ok",
  }));
}

function markHealth(tabId, health, detail) {
  const st = tabState.get(tabId);
  if (st) st.health = health;
  send({ t: "HEALTH", tabId, state: health, ...(detail ? { detail } : {}) });
}

async function allocateTab(sessionId) {
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
  blog("BIND", "(allocate) creating managed tab...");
  let created;
  try {
    created = await chrome.tabs.create({ url: START_URL, active: false });
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
  tabState.set(created.id, { state: "connecting", health: "ok" });
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
  const tabId = await allocateTab(m.sessionId);
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
  if (tabId === null || tabId === undefined) {
    blog("BIND", m.sessionId, "-> no-tab-available");
    send({ t: "BIND_FAILED", sessionId: m.sessionId, code: "no-tab-available" });
    return;
  }
  const st = tabState.get(tabId) || { state: "ready", health: "ok" };
  st.sessionId = m.sessionId;
  tabState.set(tabId, st);
  sessionTab.set(m.sessionId, tabId);
  blog("BIND", m.sessionId, "-> tab", tabId, `(${st.state})`);
  send({ t: "BOUND", sessionId: m.sessionId, tabId, state: st.state });
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
  const tabId = sessionTab.get(m.sessionId);
  sessionTab.delete(m.sessionId);
  if (tabId !== undefined) {
    const st = tabState.get(tabId);
    if (st) {
      st.sessionId = null;
      st.state = "ready";
    }
  }
  send({ t: "RELEASED", sessionId: m.sessionId });
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
    tabState.set(tabId, { state: "ready", health: "ok" });
    blog("injector reconnected managed tab", tabId);
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
        if (st) st.submitFails = 0; // healthy turn clears the wedge counter
        const s = fragStats.get(msg.reqId);
        blog(msg.t, msg.reqId, s ? `(${s.n} fragments, ${s.chars} chars)` : "(no fragments)");
        fragStats.delete(msg.reqId);
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

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  portByTab.delete(tabId);
  if (managedTabs.delete(tabId)) saveManaged();
  for (const [sid, tid] of sessionTab) {
    if (tid === tabId) sessionTab.delete(sid);
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
// boot: load config, keep the SW alive, connect
// ---------------------------------------------------------------------------

chrome.storage.sync.get({ wsUrl: DEFAULT_WS_URL }, (cfg) => {
  wsUrl = cfg.wsUrl || DEFAULT_WS_URL;
  connect();
});

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive" && (!ws || ws.readyState !== WebSocket.OPEN)) connect();
});
