/**
 * Worker pool (bridge-side view of L0, spec 7.2): owns the worker connection,
 * correlates intents to observations, tracks tab states and health.
 * One worker connection is expected per extension instance; v1 uses the
 * first healthy worker for all allocations.
 */
import { EventEmitter } from "node:events";
import { randomId } from "../util/async.js";
import type { WsConnection } from "../link/wsserver.js";
import { parseWorkerMessage, encodeIntent, WORKER_PROTOCOL, type WorkerIntent, type WorkerObservation } from "../link/protocol.js";
import type { HealthState } from "../adapter/types.js";
import { log } from "../log.js";

export interface PoolConfig {
  autoCreateTabs: boolean;
  managedOnly: boolean;
  warmTabs: number;
}

export interface WorkerInfo {
  ext: string;
  connectedAt: number;
}

export type PoolEvent =
  | { type: "worker-up"; info: WorkerInfo }
  | { type: "worker-down" }
  | { type: "health"; tabId: number; state: HealthState; detail?: string };

interface Inflight {
  cleanup(): void;
  reject(e: Error): void;
}

export class WorkerPool extends EventEmitter {
  private conn: WsConnection | null = null;
  private info: WorkerInfo | null = null;
  private inflight = new Set<Inflight>();
  private seq = 0;
  private healthByTab = new Map<number, HealthState>();
  private readonly config: PoolConfig;

  constructor(config: PoolConfig) {
    super();
    this.config = config;
  }

  get hasWorker(): boolean {
    return this.conn !== null && this.conn.isOpen;
  }

  get workerInfo(): WorkerInfo | null {
    return this.info;
  }

  tabHealth(): Array<{ tabId: number; state: string }> {
    return [...this.healthByTab.entries()].map(([tabId, state]) => ({ tabId, state }));
  }

  /** Wire a freshly upgraded connection; sends the effective pool config. */
  attach(conn: WsConnection): void {
    this.detach("replaced");
    this.conn = conn;
    conn.on("message", (raw: string) => this.onMessage(raw));
    conn.on("close", () => this.onDown());
    this.send({ t: "HELLO_OK", v: WORKER_PROTOCOL, config: this.config } as unknown as WorkerIntent);
  }

  detach(reason: string): void {
    if (this.conn) {
      try {
        this.conn.close(1001);
      } catch {
        /* ignore */
      }
    }
    this.conn = null;
    this.info = null;
    this.failAllPending(new Error(`worker link lost (${reason})`));
    this.emit("event", { type: "worker-down" } satisfies PoolEvent);
  }

  /** Bind a session to a managed tab. */
  async bind(sessionId: string, timeoutMs: number): Promise<{ tabId: number; state: string }> {
    const obs = await this.request<{ t: "BOUND"; sessionId: string; tabId: number; state: string }>(
      { t: "BIND", sessionId },
      "BIND",
      timeoutMs,
      (o) => o?.t === "BOUND" && (o as { sessionId: string }).sessionId === sessionId,
      (o) =>
        o?.t === "BIND_FAILED" && (o as { sessionId: string }).sessionId === sessionId
          ? new Error(`bind-failed: ${(o as { code?: string }).code ?? "unknown"}`)
          : null
    );
    this.healthByTab.set(obs.tabId, "ok");
    return { tabId: obs.tabId, state: obs.state };
  }

  release(sessionId: string, timeoutMs: number): Promise<unknown> {
    return this.request(
      { t: "RELEASE", sessionId },
      "RELEASE",
      timeoutMs,
      (o) =>
        (o?.t === "RELEASED" || o?.t === "BIND_FAILED") &&
        (o as unknown as { sessionId: string }).sessionId === sessionId
    );
  }

  sendTurnIntent(
    reqId: string,
    text: string,
    timeoutMs: number,
    think: boolean,
    tabId?: number
  ): Promise<unknown> {
    return this.request(
      { t: "SEND", reqId, text, opts: { timeoutMs, think }, ...(tabId !== undefined ? { tabId } : {}) },
      "SEND",
      timeoutMs,
      (o) => o?.t === "ACCEPTED" && (o as unknown as { reqId: string }).reqId === reqId,
      (o) =>
        o?.t === "ERROR" && (o as unknown as { reqId: string }).reqId === reqId
          ? new Error(
              `turn-error:${(o as { code?: string }).code ?? "unknown"}${
                (o as { detail?: string }).detail ? `:${(o as { detail?: string }).detail}` : ""
              }`
            )
          : null
    );
  }

  resetIntent(reqId: string, timeoutMs: number): Promise<"ok" | "timeout"> {
    return this.request<{ t: "RESET_OK" | "RESET_TIMEOUT" }>(
      { t: "RESET", reqId },
      "RESET",
      timeoutMs,
      (o) =>
        (o?.t === "RESET_OK" || o?.t === "RESET_TIMEOUT") &&
        (o as unknown as { reqId: string }).reqId === reqId,
      (o) =>
        o?.t === "ERROR" && (o as unknown as { reqId: string }).reqId === reqId
          ? new Error("reset-failed")
          : null
    ).then((o) => (o.t === "RESET_OK" ? "ok" : "timeout"));
  }

  abortIntent(reqId: string): void {
    try {
      this.send({ t: "ABORT", reqId });
    } catch {
      /* link already down */
    }
  }

  /** Subscribe to FRAGMENT/STATUS/USAGE/ERROR for one reqId. */
  subscribe(
    reqId: string,
    handlers: {
      onFragment: (text: string, full: boolean) => void;
      onStatus: (code: "submitting" | "streaming" | "done" | "aborted") => void;
      onUsage?: (meta: Record<string, unknown>) => void;
      onError: (code: string, detail?: string) => void;
    }
  ): () => void {
    const listener = (raw: string) => {
      const o = parseWorkerMessage(raw);
      if (!o || !("reqId" in o) || (o as unknown as { reqId: string }).reqId !== reqId) return;
      switch (o.t) {
        case "FRAGMENT":
          handlers.onFragment(o.text, Boolean(o.full));
          break;
        case "STATUS":
          handlers.onStatus(o.code);
          break;
        case "USAGE":
          handlers.onUsage?.(o.meta);
          break;
        case "ERROR":
          handlers.onError(o.code, o.detail);
          break;
        default:
          break;
      }
    };
    this.on("raw", listener);
    return () => this.off("raw", listener);
  }

  async ping(timeoutMs = 5000): Promise<Array<{ tabId: number; state: string; health: string }>> {
    const seq = ++this.seq;
    const o = await this.request<{ t: "PONG"; tabs?: Array<{ tabId: number; state: string; health: string }> }>(
      { t: "PING", seq },
      "PING",
      timeoutMs,
      (x) => x?.t === "PONG" && (x as unknown as { seq: number }).seq === seq
    );
    return o.tabs ?? [];
  }

  private send(i: WorkerIntent | WorkerObservation): void {
    if (!this.conn || !this.conn.isOpen) throw new Error("no-worker-link");
    this.conn.sendText(encodeIntent(i as WorkerIntent));
  }

  /** Send an intent and await the matching observation (or reject via failMatch/timeout). */
  private request<T>(
    intent: WorkerIntent,
    what: string,
    timeoutMs: number,
    match: (o: ReturnType<typeof parseWorkerMessage>) => boolean,
    failMatch?: (o: ReturnType<typeof parseWorkerMessage>) => Error | null
  ): Promise<T> {
    if (!this.conn || !this.conn.isOpen) {
      return Promise.reject(new Error("no-worker-link"));
    }
    const d = {
      resolve: (v: T) => {},
      reject: (_e: Error) => {},
    } as { resolve: (v: T) => void; reject: (e: Error) => void };
    const promise = new Promise<T>((resolve, reject) => {
      d.resolve = resolve;
      d.reject = reject;
    });
    let timer: NodeJS.Timeout | null = null;
    const entry: Inflight = {
      cleanup: () => {
        this.off("raw", route);
        if (timer) clearTimeout(timer);
        this.inflight.delete(entry);
      },
      reject: (e: Error) => d.reject(e),
    };
    const route = (raw: string) => {
      const o = parseWorkerMessage(raw);
      if (!o) return;
      if (failMatch) {
        const fail = failMatch(o);
        if (fail) {
          entry.cleanup();
          d.reject(fail);
          return;
        }
      }
      if (match(o)) {
        entry.cleanup();
        d.resolve(o as T);
      }
    };
    timer = setTimeout(() => {
      entry.cleanup();
      d.reject(new Error(`${what} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.inflight.add(entry);
    this.on("raw", route);
    try {
      this.send(intent);
    } catch (e) {
      entry.cleanup();
      d.reject(e as Error);
    }
    return promise;
  }

  private onMessage(raw: string): void {
    const o = parseWorkerMessage(raw);
    if (!o) return;
    this.traceObservation(o);
    if (o.t === "HELLO") {
      const hello = o as unknown as { t: "HELLO"; v: number; ext: string };
      if (hello.v !== WORKER_PROTOCOL) {
        this.conn?.sendText(
          JSON.stringify({ t: "HELLO_REFUSED", reason: `protocol version ${hello.v} not supported` })
        );
        this.detach("protocol-mismatch");
        return;
      }
      this.info = { ext: hello.ext, connectedAt: Date.now() };
      log.info("worker.up", { ext: hello.ext });
      this.emit("event", { type: "worker-up", info: this.info } satisfies PoolEvent);
    }
    if (o.t === "HEALTH") {
      const h = o as { t: "HEALTH"; tabId: number; state: string; detail?: string };
      this.healthByTab.set(h.tabId, h.state as HealthState);
      this.emit("event", {
        type: "health",
        tabId: h.tabId,
        state: h.state as HealthState,
        ...(h.detail !== undefined ? { detail: h.detail } : {}),
      } satisfies PoolEvent);
    }
    if (o.t === "PONG") {
      const p = o as { t: "PONG"; tabs?: Array<{ tabId: number; state: string; health: string }> };
      for (const t of p.tabs ?? []) this.healthByTab.set(t.tabId, t.health as HealthState);
    }
    this.emit("raw", raw);
  }

  /**
   * Worker-protocol trace. Failures (ERROR / BIND_FAILED) always log; the
   * per-turn flow (BOUND / ACCEPTED / first FRAGMENT / STATUS) logs when
   * TAB_BRIDGE_DEBUG is set — run with it to diagnose a stuck turn:
   *   TAB_BRIDGE_DEBUG=1 node dist/src/index.js serve ...
   */
  private fragSeen = new Set<string>();
  private traceObservation(o: WorkerObservation): void {
    const debug = process.env.TAB_BRIDGE_DEBUG === "1" || process.env.TAB_BRIDGE_DEBUG === "true";
    const rec = o as unknown as Record<string, unknown>;
    const reqId = typeof rec.reqId === "string" ? rec.reqId : undefined;
    switch (o.t) {
      case "ERROR":
      case "BIND_FAILED":
        log.warn("worker.observation", {
          t: o.t,
          ...(reqId ? { reqId } : {}),
          ...(("code" in rec) ? { code: rec.code } : {}),
          ...(("sessionId" in rec) ? { sessionId: rec.sessionId } : {}),
          ...(("detail" in rec && typeof rec.detail === "string") ? { detail: rec.detail.slice(0, 200) } : {}),
        });
        if (reqId) this.fragSeen.delete(reqId);
        break;
      case "BOUND":
      case "ACCEPTED":
      case "STATUS":
        if (debug) {
          log.info("worker.observation", {
            t: o.t,
            ...(reqId ? { reqId } : {}),
            ...(("sessionId" in rec) ? { sessionId: rec.sessionId } : {}),
            ...(("tabId" in rec) ? { tabId: rec.tabId } : {}),
            ...(("code" in rec) ? { code: rec.code } : {}),
          });
        }
        if (o.t === "STATUS" && reqId) this.fragSeen.delete(reqId);
        break;
      case "FRAGMENT":
        if (reqId && !this.fragSeen.has(reqId)) {
          this.fragSeen.add(reqId);
          if (debug) {
            const text = typeof rec.text === "string" ? rec.text : "";
            log.info("worker.observation", {
              t: "FRAGMENT",
              reqId,
              first_chars: text.length,
              first_text: text.slice(0, 80),
            });
          }
        }
        break;
      default:
        break;
    }
  }

  private onDown(): void {
    if (this.conn === null) return;
    this.conn = null;
    this.info = null;
    this.healthByTab.clear();
    log.warn("worker.down", { reason: "socket closed" });
    this.failAllPending(new Error("worker link lost (socket closed)"));
    this.emit("event", { type: "worker-down" } satisfies PoolEvent);
  }

  private failAllPending(err: Error): void {
    for (const entry of [...this.inflight]) {
      entry.cleanup();
      entry.reject(err);
    }
    this.inflight.clear();
  }
}

export function newReqId(): string {
  return `req_${randomId(8)}`;
}
