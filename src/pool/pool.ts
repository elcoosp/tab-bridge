/**
 * Worker pool (bridge-side view of L0, spec 7.2): owns the worker connection,
 * correlates intents to observations, tracks tab states and health.
 * One worker connection is expected per extension instance; v1 uses the
 * first healthy worker for all allocations.
 */
import { EventEmitter } from "node:events";
import { randomId } from "../util/async.js";
import type { WsConnection, WsCloseInfo } from "../link/wsserver.js";
import { parseWorkerMessage, encodeIntent, WORKER_PROTOCOL, type WorkerIntent, type WorkerObservation } from "../link/protocol.js";
import type { HealthState } from "../adapter/types.js";
import { log } from "../log.js";

export interface PoolConfig {
  autoCreateTabs: boolean;
  managedOnly: boolean;
  warmTabs: number;
  maxTabs?: number;
  tabIdleCloseMs?: number;
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
  private lastPongAt = Date.now();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private inflight = new Set<Inflight>();
  private seq = 0;
  private healthByTab = new Map<number, HealthState>();
  /** Connection serials: alternating attach serials in the log prove a
   * duplicate-worker fight vs one flapping link. */
  private connSerial = 0;
  private activeSerial = 0;
  private readonly config: PoolConfig;

  constructor(config: PoolConfig) {
    super();
    // One in-flight pool request holds exactly one "raw" listener; kod retry
    // storms legitimately hold dozens concurrently. The default threshold of
    // 10 fires scary-but-benign MaxListeners warnings under load — verified
    // leak-free (every settle path removes its listener), so raise it while
    // still catching genuine runaway growth.
    this.setMaxListeners(64);
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

  /**
   * Wire a freshly upgraded connection; sends the effective pool config.
   * First live worker wins: a duplicate extension instance (second Chrome
   * profile, dev+prod side by side) would otherwise steal the link back and
   * forth on every reconnect, an alternating down/up storm that fails every
   * in-flight turn. A newcomer is refused while ANY incumbent socket is open:
   * a liveness grace was tried and failed, because during a total outage
   * there is no traffic to keep the incumbent fresh and the fight never
   * settles. A dead incumbent delivers a socket close, which clears the slot.
   */
  attach(conn: WsConnection): void {
    if (this.conn && this.conn.isOpen) {
      // Peek at the newcomer's HELLO before refusing: the refusal log then
      // names WHICH worker was turned away. One repeating instance id = a
      // single stale copy to disable; rotating ids = several live copies
      // (profiles/channels). Close is guaranteed by the timer even if the
      // newcomer never speaks.
      const guard = setTimeout(() => {
        try {
          conn.close(1013);
        } catch {
          /* ignore */
        }
      }, 5000);
      conn.once("message", (raw: string) => {
        clearTimeout(guard);
        let instance = "unknown";
        let extVersion = "unknown";
        try {
          const m = JSON.parse(raw) as { t?: string; instance?: string; extVersion?: string };
          if (m && m.t === "HELLO") {
            if (typeof m.instance === "string" && m.instance) instance = m.instance;
            if (typeof m.extVersion === "string" && m.extVersion) extVersion = m.extVersion;
          }
        } catch {
          /* not a HELLO — refuse unnamed */
        }
        log.warn("worker.refused-duplicate", { remote: conn.remoteAddress, instance, extVersion });
        try {
          conn.sendText(
            JSON.stringify({ t: "HELLO_REFUSED", reason: "another worker holds a live link" })
          );
        } catch {
          /* ignore */
        }
        conn.close(1013);
      });
      return;
    }
    this.detach("replaced");
    this.conn = conn;
    conn.on("pong", () => {
      this.lastPongAt = Date.now();
    });
    this.startHeartbeat();
    this.activeSerial = ++this.connSerial;
    log.info("worker.attach", { serial: this.activeSerial, remote: conn.remoteAddress });
    conn.on("message", (raw: string) => this.onMessage(raw));
    conn.on("close", (info: WsCloseInfo) => this.onDown(info));
    this.send({ t: "HELLO_OK", v: WORKER_PROTOCOL, config: this.config } as unknown as WorkerIntent);
  }

  /** Detect half-open worker sockets: ping on an interval, detach when
   * pongs go stale. `WsConnection` emits "pong" for control frames. */
  startHeartbeat(intervalMs = 25_000, staleAfterMs = 75_000): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const conn = this.conn;
      if (!conn || !conn.isOpen) return;
      if (Date.now() - this.lastPongAt > staleAfterMs) {
        log.warn("worker.heartbeat-timeout", { staleMs: Date.now() - this.lastPongAt });
        this.detach("heartbeat-timeout");
        return;
      }
      try {
        conn.sendPing(Buffer.from("hb"));
      } catch {
        /* send failure surfaces via the socket close path */
      }
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  detach(reason: string): void {
    this.stopHeartbeat();
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

  /**
   * Bind a session to a managed tab. A transient `no-tab-available` (worker
   * still handshaking, tab pool momentarily empty) does NOT fail: the worker
   * may be seconds away from readiness, so the bind waits out the deadline.
   * Only terminal failures (rate-limited cooldown) reject early. A timeout
   * still surfaces as bind-failed (503 pool_exhausted downstream), never a
   * bare timeout string.
   */
  async bind(
    sessionId: string,
    timeoutMs: number,
    opts: { noCreate?: boolean; chatUrl?: string | null } = {}
  ): Promise<{ tabId: number; state: string; dirty: boolean }> {
    try {
      const obs = await this.request<{ t: "BOUND"; sessionId: string; tabId: number; state: string; dirty?: boolean }>(
        {
          t: "BIND",
          sessionId,
          ...(opts.noCreate ? { noCreate: true } : {}),
          ...(opts.chatUrl ? { chatUrl: opts.chatUrl } : {}),
        },
        "BIND",
        timeoutMs,
        (o) => o?.t === "BOUND" && (o as { sessionId: string }).sessionId === sessionId,
        (o) => {
          if (o?.t !== "BIND_FAILED" || (o as { sessionId: string }).sessionId !== sessionId) return null;
          const code = (o as { code?: string }).code ?? "unknown";
          if (code.includes("rate-limited") || code.includes("server-busy")) {
            const retry = (o as { retryAfterSec?: number }).retryAfterSec;
            return new Error(
              `bind-failed: ${code}${typeof retry === "number" && retry > 0 ? `;retry-after=${retry}` : ""}`
            );
          }
          // E5: ephemeral background traffic must never grow the pool — a
          // noCreate BIND fails fast instead of waiting out the deadline.
          if (opts.noCreate) return new Error(`bind-failed: no-tab-available (no-create)`);
          return null; // no-tab-available and friends: keep waiting for BOUND
        }
      );
      this.healthByTab.set(obs.tabId, "ok");
      return { tabId: obs.tabId, state: obs.state, dirty: obs.dirty === true };
    } catch (e) {
      if (e instanceof Error && /timed out after/.test(e.message)) {
        throw new Error(`bind-failed: no-tab-available (timeout after ${timeoutMs}ms)`);
      }
      throw e;
    }
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

  resetIntent(reqId: string, timeoutMs: number, tabId?: number): Promise<"ok" | "timeout"> {
    return this.request<{ t: "RESET_OK" | "RESET_TIMEOUT" }>(
      { t: "RESET", reqId, ...(tabId !== undefined ? { tabId } : {}) },
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
    const route = (o: WorkerObservation) => {
      // P1: the pool emits the parsed observation now; do not re-parse.
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
      const hello = o as unknown as { t: "HELLO"; v: number; ext: string; extVersion?: string; instance?: string };
      if (hello.v !== WORKER_PROTOCOL) {
        this.conn?.sendText(
          JSON.stringify({ t: "HELLO_REFUSED", reason: `protocol version ${hello.v} not supported` })
        );
        this.detach("protocol-mismatch");
        return;
      }
      this.info = { ext: hello.ext, connectedAt: Date.now() };
      log.info("worker.up", { ext: hello.ext, extVersion: hello.extVersion ?? "unknown", instance: hello.instance ?? "unknown" });
      this.emit("event", { type: "worker-up", info: this.info } satisfies PoolEvent);
    }
    if (o.t === "HEALTH") {
      const h = o as { t: "HEALTH"; tabId?: number; state: string; detail?: string };
      // L2: worker-level HEALTH (SW boot notification) carries no tabId. It
      // must not install an undefined key in healthByTab — that created a
      // phantom tab visible in /healthz forever.
      if (typeof h.tabId === "number") {
        this.healthByTab.set(h.tabId, h.state as HealthState);
        this.emit("event", {
          type: "health",
          tabId: h.tabId,
          state: h.state as HealthState,
          ...(h.detail !== undefined ? { detail: h.detail } : {}),
        } satisfies PoolEvent);
      }
    }
    if (o.t === "PONG") {
      const p = o as { t: "PONG"; tabs?: Array<{ tabId: number; state: string; health: string }> };
      for (const t of p.tabs ?? []) this.healthByTab.set(t.tabId, t.health as HealthState);
    }
    if (o.t === "PING") {
      // v1.2.65 — reply to the worker's application-level PING. The reply is
      // an INBOUND text frame on the worker side, which is what resets the
      // Chrome MV3 30-second service-worker idle timer (outbound frames do
      // not; only events / extension-API calls / inbound messages do). The
      // worker's WS control-frame ping (sent by startHeartbeat) is handled by
      // Chrome internally and never surfaces as a "message" event, so it
      // cannot serve this purpose. Without this reply, the worker went idle
      // ~30 s into any quiet stretch, was killed mid-turn, and the bridge
      // retried RESET_RESEED into a flap cascade.
      const p = o as { t: "PING"; seq: number };
      try {
        this.send({ t: "PONG", seq: p.seq });
      } catch {
        /* send failure surfaces via the socket close path */
      }
    }
    // P1: emit the already-parsed observation. Every "raw" listener would
    // otherwise call parseWorkerMessage() again on the same string — with K
    // in-flight requests plus the adapter listener that is K+1 duplicate
    // JSON.parse calls per message (thousands per second under load).
    this.emit("raw", o);
  }

  /**
   * Worker-protocol trace. Failures (ERROR / BIND_FAILED) always log; the
   * per-turn flow (BOUND / ACCEPTED / first FRAGMENT / STATUS) logs when
   * TAB_BRIDGE_DEBUG is set — run with it to diagnose a stuck turn:
   *   TAB_BRIDGE_DEBUG=1 node dist/src/index.js serve ...
   */
  private fragSeen = new Set<string>();
  private static readonly FRAG_SEEN_MAX = 2048;
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
          // L1: cap the set; drop the oldest entry when full so an abandoned
          // turn whose link died before STATUS/ERROR cannot leak forever.
          if (this.fragSeen.size >= WorkerPool.FRAG_SEEN_MAX) {
            const oldest = this.fragSeen.values().next().value;
            if (oldest !== undefined) this.fragSeen.delete(oldest);
          }
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

  private onDown(info?: WsCloseInfo): void {
    this.stopHeartbeat();
    if (this.conn === null) return;
    const serial = this.activeSerial;
    this.conn = null;
    this.info = null;
    this.healthByTab.clear();
    // L1: reqIds on the dead link are unreachable — clear the set so a turn
    // that lost its link mid-stream cannot leak entries for process lifetime.
    this.fragSeen.clear();
    log.warn("worker.down", {
      reason: "socket closed",
      serial,
      code: info?.code ?? null,
      source: info?.source ?? "unknown",
    });
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
