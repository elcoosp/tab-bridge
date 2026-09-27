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
    this.pool.on("raw", (raw: string) => this.dispatch(raw));
  }

  private dispatch(raw: string): void {
    const o = parseWorkerMessage(raw);
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
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const tabs = await this.pool.ping(Math.min(5_000, Math.max(500, deadline - Date.now())));
        const me = tabs.find((t) => t.tabId === tab.tabId);
        if (me) {
          if (me.health === "ok") return { ok: true };
          return { ok: false, detail: me.health };
        }
        if (Date.now() >= deadline) return { ok: false, detail: "tab-not-known-to-worker" };
      }
    } catch (e) {
      if (e instanceof TimeoutError) return { ok: false, detail: "ensureReady-timeout" };
      return { ok: false, detail: (e as Error).message };
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
        if (ev.t === "ERROR") throw new Error(errText(ev));
        // STATUS submitting / stray FRAGMENTs before ACCEPTED: keep waiting.
      }
    })();

    try {
      await this.pool.sendTurnIntent(reqId, text, Math.max(opts.timeoutMs, 30_000), opts.think, tab.tabId);
      await sendPromise;
    } catch (e) {
      this.closeBuffer(reqId);
      this.pendingByTab.delete(tab.tabId);
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
          case "ERROR":
            throw new Error(errText(ev));
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
      return await this.pool.resetIntent(reqId, 15_000);
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
  return ev.detail ? `${base}:${ev.detail}` : base;
}
