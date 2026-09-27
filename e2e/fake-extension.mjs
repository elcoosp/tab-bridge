#!/usr/bin/env node
/**
 * FakeExtension — scriptable stand-in for the Chrome MV3 service worker
 * (extension/background.js). Speaks the bridge<->worker protocol v1 over a
 * REAL WebSocket, so everything on the bridge side (HTTP facade, engine,
 * registry, hash chain, adapter, pool, WS link) is exercised for real.
 *
 * Usage (see run-e2e.mjs for the driven form):
 *   import { FakeExtension } from "./fake-extension.mjs";
 *   const fake = new FakeExtension({ url: "ws://127.0.0.1:8789/worker" });
 *   await fake.connect();
 *   fake.turnScript = (text, reqId) => [
 *     { t: "STATUS", reqId, code: "submitting" },
 *     { t: "FRAGMENT", reqId, seq: 0, text: "Hello!" },
 *     { t: "STATUS", reqId, code: "done" },
 *   ];
 *
 * Default turn behavior (turnScript === null): echo
 *   `ECHO:<len>:<lastLine>` derived from the prompt.
 * Everything the bridge sends is recorded on `fake.received`; completed
 * turns on `fake.turns` as { reqId, text, observations }.
 */
export class FakeExtension {
  constructor({ url, ext = "e2e-fake", caps = null, tabBase = 100 } = {}) {
    if (!url) throw new Error("FakeExtension requires url");
    this.url = url;
    this.ext = ext;
    this.caps = caps ?? { managedTabs: true, autoCreate: false };
    this.tabBase = tabBase;
    this.tabNext = tabBase;

    /** (promptText, reqId) => obs[] | Promise<obs[]>  (after ACCEPTED) */
    this.turnScript = null;
    /** (sessionId) => { tabId?, state?, failWith? } | null */
    this.bindScript = null;

    this.ws = null;
    this.connected = false;
    this.helloOk = null;
    this.received = []; // every intent the bridge sent
    this.turns = []; // completed turns: { reqId, text, observations }
    this.binds = []; // successful BOUND sessionIds
    this.resets = 0; // RESET intents received
    /** tabId -> health string, as reported to PING (worker-side view). */
    this.boundTabs = new Map();
    this._seq = 0;
    this._obsCount = 0;
  }

  /** Open the socket, speak HELLO, await HELLO_OK. */
  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(
        () => reject(new Error(`fake-extension: HELLO timeout to ${this.url}`)),
        timeoutMs
      );
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ t: "HELLO", v: 1, ext: this.ext, caps: this.caps }));
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`fake-extension: ws error: ${e.message ?? e.type ?? "unknown"}`));
      });
      ws.addEventListener("close", () => {
        this.connected = false;
      });
      ws.addEventListener("message", (ev) => {
        let m;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        this.received.push(m);
        if (m.t === "HELLO_OK") {
          this.connected = true;
          this.helloOk = m;
          clearTimeout(timer);
          resolve(m);
          return;
        }
        try {
          this.handle(m);
        } catch (e) {
          console.error("fake-extension handler error:", e);
        }
      });
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.connected = false;
  }

  nextTabId() {
    return this.tabNext++;
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("fake-extension: socket closed");
    this.ws.send(JSON.stringify(obj));
  }

  handle(m) {
    switch (m.t) {
      case "BIND": {
        const custom = this.bindScript ? this.bindScript(m.sessionId) : null;
        if (custom?.failWith) {
          this.send({ t: "BIND_FAILED", sessionId: m.sessionId, code: custom.failWith });
          return;
        }
        const tabId = custom?.tabId ?? this.nextTabId();
        this.send({ t: "BOUND", sessionId: m.sessionId, tabId, state: custom?.state ?? "ready" });
        this.binds.push(m.sessionId);
        this.boundTabs.set(tabId, custom?.health ?? "ok");
        this.send({ t: "HEALTH", tabId, state: custom?.health ?? "ok" });
        return;
      }
      case "SEND": {
        const rec = { reqId: m.reqId, text: m.text, observations: [], startedAt: Date.now() };
        this.send({ t: "ACCEPTED", reqId: m.reqId });
        const obs = this.turnScript
          ? this.turnScript(m.text, m.reqId)
          : defaultEcho(m.text);
        Promise.resolve(obs)
          .then((list) => {
            for (const o of list) {
              const framed = { reqId: m.reqId, ...o };
              this.send(framed);
              rec.observations.push(framed);
            }
            this.turns.push(rec);
          })
          .catch((e) => {
            // Script error is surfaced as a worker-side dom-error.
            this.send({ t: "ERROR", reqId: m.reqId, code: "dom-error", detail: String(e) });
            this.turns.push(rec);
          });
        return;
      }
      case "RESET":
        this.resets += 1;
        this.send({ t: "RESET_OK", reqId: m.reqId });
        return;
      case "ABORT":
        this.send({ t: "STATUS", reqId: m.reqId, code: "aborted" });
        return;
      case "PING":
        this.send({
          t: "PONG",
          seq: m.seq,
          tabs: this.tabsHealth(),
        });
        return;
      case "RELEASE":
        this.send({ t: "RELEASED", sessionId: m.sessionId });
        return;
      default:
        return; // HELLO_OK / HELLO_REFUSED / anything else: recorded above
    }
  }

  /** Tab table reported to PING: every tab this fake ever BOUND. */
  tabsHealth() {
    return [...this.boundTabs.entries()].map(([tabId, health]) => ({
      tabId,
      state: "ready",
      health,
    }));
  }

  /** Last completed turn's prompt (or null). */
  lastPrompt() {
    return this.turns.length > 0 ? this.turns[this.turns.length - 1].text : null;
  }

  /** Wait until a turn with `pred` completes (polling; harness-friendly). */
  async waitForTurn(pred = () => true, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = [...this.turns].reverse().find((x) => pred(x));
      if (t) return t;
      if (Date.now() > deadline) throw new Error("fake-extension: waitForTurn timeout");
      await sleep(25);
    }
  }
}

/** Default scripted reply: deterministic echo of the prompt's last line. */
function defaultEcho(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : "(empty)";
  const body = `ECHO:${text.length}:${last}`.slice(0, 200);
  return [
    { t: "STATUS", code: "submitting" },
    { t: "FRAGMENT", seq: 0, text: body.slice(0, Math.ceil(body.length / 2)) },
    { t: "FRAGMENT", seq: 1, text: body.slice(Math.ceil(body.length / 2)) },
    { t: "STATUS", code: "done" },
  ];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
