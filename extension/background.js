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
const RESET_TIMEOUT_MS = 15000;
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

// ---------------------------------------------------------------------------
// websocket link
// ---------------------------------------------------------------------------

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
    backoff = RECONNECT_MIN_MS;
    blog("worker link open ->", wsUrl);
    send({ t: "HELLO", v: PROTOCOL_VERSION, ext: "deepseek-web" });
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
      poolConfig = m.config || poolConfig;
      blog("bridge HELLO_OK", JSON.stringify(poolConfig));
      return;
    }
    if (m && m.t === "HELLO_REFUSED") {
      console.warn("[tab-bridge-worker] refused:", m.reason);
      return;
    }
    if (m && m.t === "BIND") handleBind(m);
    else if (m && m.t === "SEND") handleSend(m);
    else if (m && m.t === "RESET") handleReset(m);
    else if (m && m.t === "ABORT") handleAbort(m);
    else if (m && m.t === "PING") handlePing(m);
    else if (m && m.t === "RELEASE") handleRelease(m);
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
  // 1) re-use a free managed tab (skipping rate-limit cooldowns)
  for (const [tabId, st] of tabState) {
    if (st.state === "ready" && !st.sessionId && !tabInCooldown(tabId, st)) return tabId;
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
  const created = await chrome.tabs.create({ url: START_URL, active: false });
  tabState.set(created.id, { state: "connecting", health: "ok" });
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
    send({ t: "BIND_FAILED", sessionId: m.sessionId, code: "rate-limited-cooldown" });
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
  port.postMessage({ t: "TURN", reqId: m.reqId, text: m.text, opts: m.opts || {} });
  // Ack the take-over: the bridge's adapter blocks until ACCEPTED/ERROR, so
  // this must arrive even though the injector is still working.
  send({ t: "ACCEPTED", reqId: m.reqId });
}

function handleReset(m) {
  let done = false;
  const targets = [...sessionTab.values()];
  if (targets.length === 0) {
    send({ t: "RESET_OK", reqId: m.reqId }); // nothing bound: trivially reset
    return;
  }
  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      send({ t: "RESET_TIMEOUT", reqId: m.reqId });
    }
  }, RESET_TIMEOUT_MS);
  for (const tabId of targets) {
    const port = portByTab.get(tabId);
    if (!port) continue;
    const onMessage = (msg) => {
      if (msg.t === "RESET_OK" || msg.t === "RESET_FAILED") {
        port.onMessage.removeListener(onMessage);
        if (!done) {
          done = true;
          clearTimeout(timer);
          send(
            msg.t === "RESET_OK"
              ? { t: "RESET_OK", reqId: m.reqId }
              : { t: "RESET_TIMEOUT", reqId: m.reqId }
          );
        }
      }
    };
    port.onMessage.addListener(onMessage);
    port.postMessage({ t: "RESET" });
  }
}

function handleAbort(m) {
  const rec = turnByReq.get(m.reqId);
  if (rec) {
    const port = portByTab.get(rec.tabId);
    if (port) port.postMessage({ t: "ABORT", reqId: m.reqId });
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
  blog("injector connected (tab", tabId + ")");
  portByTab.set(tabId, port);
  const st = tabState.get(tabId);
  if (st && st.state === "connecting") st.state = "ready";
  else if (!st) {
    // Service-worker restart wipes our tables while tabs (and their
    // injectors) survive: re-register the tab so PONG snapshots — and
    // therefore the bridge's ensureReady — see it again. Session affinity
    // is re-established by the bridge's next BIND.
    tabState.set(tabId, { state: "ready", health: "ok" });
    blog("injector reconnected unknown tab", tabId, "— re-registered as ready");
  }
  const waiters = readyWaiters.get(tabId) || [];
  readyWaiters.set(tabId, []);
  waiters.forEach((fn) => fn(true));

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
      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (portByTab.get(tabId) === port) portByTab.delete(tabId);
    blog("injector disconnected (tab", tabId + ")");
    markHealth(tabId, "degraded", "port-disconnected");
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  portByTab.delete(tabId);
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
