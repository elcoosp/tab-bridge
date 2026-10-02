/**
 * DeepSeekAdapter (v1, spec 7.4): maps the ChatProviderAdapter contract onto
 * the bridge<->worker intents. DOM automation itself lives in the extension
 * (extension/injector.js); this class only speaks the port protocol.
 *
 * Race note: the worker may burst ACCEPTED/FRAGMENT/STATUS before
 * streamResponse subscribes, so every observation is buffered per-reqId from
 * the moment SEND is queued (the adapter keeps one permanent pool listener).
 */
import type {
  AdapterCapabilities,
  ChatProviderAdapter,
  Health,
  ManagedTab,
  Ready,
  ResetOutcome,
  StreamSink,
  TurnOptions,
  TurnResult,
} from "./types.js";
import type { WorkerPool } from "../pool/pool.js";
import { newReqId } from "../pool/pool.js";
import { randomId, TimeoutError } from "../util/async.js";
import { parseWorkerMessage, type WorkerObservation } from "../link/protocol.js";

const DEFAULT_CAPS: AdapterCapabilities = {
  streaming: true,
  thinkingToggle: true,
  resetSupport: true,
  maxPromptChars: 96_000,
  warmupMsTypical: 8_000,
  domFingerprint: "deepseek-web-1",
};

interface TurnEventBuffer {
  list: WorkerObservation[];
  waiters: Array<(e: WorkerObservation) => void>;
  closed: boolean;
  timeoutMs: number;
}

export class DeepSeekAdapter implements ChatProviderAdapter {
  readonly id = "deepseek-web";
  private readonly pool: WorkerPool;
  private readonly caps: AdapterCapabilities;
  private readonly buffers = new Map<string, TurnEventBuffer>();
  /** reqId of the SEND issued by the last sendTurn, per tab. */
  private pendingByTab = new Map<number, string>();

  constructor(pool: WorkerPool, caps?: Partial<AdapterCapabilities>) {
    this.pool = pool;
    this.caps = { ...DEFAULT_CAPS, ...caps };
    // Permanent dispatch: observations land in per-reqId buffers whether or
    // not a consumer has attached yet.
    this.pool.on("raw", (o: WorkerObservation) => this.dispatch(o));
  }

  private dispatch(o: WorkerObservation): void {
    // P1: the pool already parsed the observation; do not re-parse.
    if (!o || !("reqId" in o)) return;
    const reqId = (o as unknown as { reqId: string }).reqId;
    const buf = this.buffers.get(reqId);
    if (!buf) return;
    const waiter = buf.waiters.shift();
    if (waiter) waiter(o);
    else buf.list.push(o);
  }

  private bufferFor(reqId: string, timeoutMs: number): TurnEventBuffer {
    let b = this.buffers.get(reqId);
    if (!b) {
      b = { list: [], waiters: [], closed: false, timeoutMs };
      this.buffers.set(reqId, b);
    }
    return b;
  }

  private nextEvent(reqId: string): Promise<WorkerObservation | null> {
    const buf = this.buffers.get(reqId);
    if (!buf) return Promise.resolve(null);
    const ev = buf.list.shift();
    if (ev) return Promise.resolve(ev);
    if (buf.closed) return Promise.resolve(null);
    return new Promise((resolve) => buf.waiters.push(resolve));
  }

  private closeBuffer(reqId: string): void {
    const buf = this.buffers.get(reqId);
    if (!buf) return;
    buf.closed = true;
    for (const w of buf.waiters.splice(0)) w(null as unknown as WorkerObservation);
    this.buffers.delete(reqId);
  }

  capabilities(): AdapterCapabilities {
    return this.caps;
  }

  attach(_port: unknown): void {
    /* binding happens through the pool's worker link */
  }

  async ensureReady(tab: ManagedTab, timeoutMs: number): Promise<Ready> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      // C13: this is a readiness timeout, not "tab unknown". Returning
      // tab-not-known-to-worker made the engine issue a rebind on the
      // next turn for a tab that was merely slow to report healthy —
      // extra BIND round-trip, possibly a different tab, dirty-flag churn.
      if (remaining <= 0) return { ok: false, detail: "ensureReady-timeout" };
      try {
        const tabs = await this.pool.ping(Math.min(5_000, Math.max(500, remaining)));
        const me = tabs.find((t) => t.tabId === tab.tabId);
        if (me) {
          if (me.health === "ok") return { ok: true };
          // Terminal for this window: map to 429/5xx immediately.
          if (me.health !== "degraded") return { ok: false, detail: me.health };
          // Transient (port reconnect / SW restart): keep polling.
        }
        // Back off before the next ping — a hot loop here hammers the
        // worker for the entire deadline when the tab is simply absent.
        await new Promise((r) => setTimeout(r, 250));
      } catch (e) {
        if (e instanceof TimeoutError) return { ok: false, detail: "ensureReady-timeout" };
        if (Date.now() >= deadline) return { ok: false, detail: "ensureReady-timeout" };
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async sendTurn(tab: ManagedTab, text: string, opts: TurnOptions): Promise<void> {
    if (text.length > this.caps.maxPromptChars) {
      throw new Error(`prompt-too-large:${text.length}>${this.caps.maxPromptChars}`);
    }
    const reqId = newReqId();
    this.pendingByTab.set(tab.tabId, reqId);
    const buf = this.bufferFor(reqId, opts.timeoutMs);

    // Queue SEND, then consume buffered events until ACCEPTED/ERROR.
    const sendPromise = (async () => {
      const deadline = Date.now() + Math.max(opts.timeoutMs, 30_000);
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timeout waiting for ACCEPTED");
        const ev = await Promise.race([
          this.nextEvent(reqId),
          new Promise<null>((r) => setTimeout(() => r(null), remaining).unref?.()),
        ]);
        if (ev === null) throw new Error("timeout waiting for ACCEPTED");
        if (ev.t === "ACCEPTED") return;
        if (ev.t === "ERROR") throw errorFromObservation(ev);
        // STATUS submitting / stray FRAGMENTs before ACCEPTED: keep waiting.
      }
    })();

    try {
      await this.pool.sendTurnIntent(reqId, text, Math.max(opts.timeoutMs, 30_000), opts.think, tab.tabId);
      await sendPromise;
    } catch (e) {
      this.closeBuffer(reqId);
      this.pendingByTab.delete(tab.tabId);
      // The intent failed while the ACCEPTED-watcher was still pending
      // (link drop between queue and ack): it would otherwise reject later
      // with nobody awaiting it — an unhandled rejection that kills node.
      sendPromise.catch(() => {});
      throw e;
    }
  }

  async streamResponse(tab: ManagedTab, sink: StreamSink): Promise<TurnResult> {
    const reqId = this.pendingByTab.get(tab.tabId);
    if (!reqId) throw new Error("no-pending-turn-for-tab");
    this.pendingByTab.delete(tab.tabId);
    const buf = this.buffers.get(reqId);
    const timeoutMs = buf?.timeoutMs ?? 240_000;
    const deadline = Date.now() + timeoutMs;

    let text = "";
    let usageMeta: Record<string, unknown> | undefined;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timeout: no stream completion");
        const ev = await Promise.race([
          this.nextEvent(reqId),
          new Promise<null>((r) => setTimeout(() => r(null), remaining).unref?.()),
        ]);
        if (ev === null) throw new Error("timeout: no stream completion");
        switch (ev.t) {
          case "FRAGMENT":
            if (ev.full) {
              text = ev.text; // resync after a non-prefix DOM re-read
            } else {
              text += ev.text;
            }
            sink.onFragment(ev.full ? text : ev.text);
            break;
          case "STATUS":
            sink.onStatus(ev.code);
            if (ev.code === "done" || ev.code === "aborted") {
              return {
                text,
                stopReason: ev.code === "aborted" ? "aborted" : "stop",
                ...(usageMeta !== undefined ? { usageMeta } : {}),
              };
            }
            break;
          case "USAGE":
            usageMeta = ev.meta;
            sink.onUsage?.(ev.meta);
            break;
          case "ERROR": {
            // A turn can fail after the provider chat URL was already
            // reported via USAGE (first message accepted, reply errored).
            // Carry it on the thrown error so the engine can still learn
            // the session's relaunch URL in its catch block.
            const err = errorFromObservation(ev);
            const chatUrl = (usageMeta as Record<string, unknown> | undefined)?.["chat_url"];
            if (typeof chatUrl === "string" && chatUrl.length > 0) {
              (err as Error & { chatUrl?: string }).chatUrl = chatUrl;
            }
            throw err;
          }
          default:
            break;
        }
      }
    } finally {
      this.closeBuffer(reqId);
    }
  }

  async resetConversation(tab: ManagedTab): Promise<ResetOutcome> {
    const reqId = `reset_${randomId(6)}`;
    try {
      // 45s matches the worker RESET_TIMEOUT_MS: a control-not-found
      // fallback navigates the tab home and waits out a full page load.
      // The tab is addressed explicitly so other sessions' tabs are untouched.
      return await this.pool.resetIntent(reqId, 45_000, tab.tabId);
    } catch {
      return "failed";
    }
  }

  async health(tab: ManagedTab): Promise<Health> {
    try {
      const tabs = await this.pool.ping(5_000);
      const me = tabs.find((t) => t.tabId === tab.tabId);
      return { state: (me?.health as Health["state"]) ?? "degraded" };
    } catch {
      return { state: "degraded", detail: "ping-failed" };
    }
  }

  async dispose(tab: ManagedTab): Promise<void> {
    try {
      await this.pool.release(`tab:${tab.tabId}`, 5_000);
    } catch {
      /* best effort */
    }
  }
}

/** Normalize an ERROR observation into a mappable error string. */
function errText(ev: Extract<WorkerObservation, { t: "ERROR" }>): string {
  const base = `turn-error:${ev.code}`;
  const detail = ev.detail ? `:${ev.detail}` : "";
  const retry =
    typeof ev.retryAfterSec === "number" && ev.retryAfterSec > 0
      ? `;retry-after=${ev.retryAfterSec}`
      : "";
  return `${base}${detail}${retry}`;
}

/** Build the Error thrown for an ERROR observation, carrying the
 * userBubbleRendered flag (a submit that never placed a user bubble leaves
 * the tab state untouched and must not poison the session — RCA stage 2). */
function errorFromObservation(ev: Extract<WorkerObservation, { t: "ERROR" }>): Error {
  const err = new Error(errText(ev));
  if (typeof ev.userBubbleRendered === "boolean") {
    (err as Error & { userBubbleRendered?: boolean }).userBubbleRendered =
      ev.userBubbleRendered;
  }
  return err;
}
