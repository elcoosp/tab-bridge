/**
 * TabBridge application wiring: registry + persistence + worker pool +
 * adapter + worker-link server. The HTTP facade (facade/http.ts) calls into
 * `handleChat`, `models`, `sessions*`, and `health`.
 */
import type { Config } from "./config.js";
import { SessionRegistry, type SessionRow } from "./core/registry.js";
import { JsonlSessionStore } from "./core/persist.js";
import { WorkerPool } from "./pool/pool.js";
import { DeepSeekAdapter } from "./adapter/deepseek.js";
import { WsServer } from "./link/wsserver.js";
import { runTurn, type TurnEvents, type TurnOutput } from "./engine.js";
import type { ChatMessage, ToolCall } from "./core/canonical.js";
import type { ToolSpec } from "./emulation/types.js";
import type { ChatProviderAdapter } from "./adapter/types.js";
import { BridgeError, queueFull, queueTimeout, clientGone } from "./facade/errors.js";
import { TurnGate, GateRejectionError } from "./core/turngate.js";
import { log } from "./log.js";

export const MODEL_CHAT = "deepseek-web-chat";
export const MODEL_THINK = "deepseek-web-think";
export const MODELS = [MODEL_CHAT, MODEL_THINK];

export interface ChatParams {
  messages: ChatMessage[];
  tools: ToolSpec[];
  think: boolean;
  /** Resolved session id, or null for the stateless legacy path. */
  sessionId: string | null;
  events?: TurnEvents;
  /** E5: ephemeral background-class traffic must never grow the tab pool —
   * set by the facade when metadata.tab_bridge_class = "background". */
  background?: boolean;
  /** Aborted when the HTTP client disconnects. Consumed by the generation
   * gate for the QUEUED phase only; an admitted turn always runs to
   * completion (unchanged v1 behavior). */
  signal?: AbortSignal;
}

/** Queued-phase rejections arrive as typed gate errors; map them onto the
 * HTTP taxonomy so callers (kod's retry treats 503 as retryable-transient)
 * can react cheaply. client_gone is 499 and never reaches the wire. */
function mapGateRejection(e: GateRejectionError): BridgeError {
  switch (e.code) {
    case "queue_full":
      return queueFull(e.retryAfterSec, e.message);
    case "queue_timeout":
      return queueTimeout(e.retryAfterSec, e.message);
    case "client_gone":
      return clientGone(e.message);
  }
}

export class TabBridge {
  readonly config: Config;
  readonly store: JsonlSessionStore;
  readonly registry: SessionRegistry;
  readonly pool: WorkerPool;
  readonly adapter: ChatProviderAdapter;
  /** Caps concurrent provider generations (DeepSeek limit: ~2 per account);
   * excess turns queue FIFO. See src/core/turngate.ts. */
  readonly turnGate: TurnGate;
  private readonly wsServer: WsServer;
  private readonly bindTabImpl: (sessionId: string, timeoutMs: number) => Promise<number>;
  private pendingNoCreate = false;

  constructor(config: Config, adapter?: ChatProviderAdapter) {
    this.config = config;
    this.store = new JsonlSessionStore(config.dbPath);
    this.registry = new SessionRegistry({
      mode: config.stateful ? "stateful" : "always-reset",
      ttlMs: config.ttlMs,
      persist: this.store,
      onEvict: (sessionId) => {
        log.audit("session.evict", { sessionId });
        // E1: release with the RAW session id. The worker keys its
        // sessionTab map by raw id (stored at BIND); a prefixed id never
        // matches and the tab stays occupied forever.
        this.pool.release(sessionId, 3_000).catch(() => {});
      },
    });
    // Replay persisted chains (ADR-3: restart resumes without stored text).
    for (const row of this.store.load().values()) {
      this.registry.restore(row);
    }
    this.pool = new WorkerPool({
      autoCreateTabs: config.autoCreateTabs,
      managedOnly: config.managedOnly,
      warmTabs: config.warmTabs,
    });
    this.adapter = adapter ?? new DeepSeekAdapter(this.pool, { maxPromptChars: config.maxPromptChars });
    this.turnGate = new TurnGate({
      maxConcurrent: config.maxConcurrentTurns,
      capacity: config.queueCapacity,
      queueTimeoutMs: config.queueTimeoutMs,
    });
    this.bindTabImpl = async (sessionId, timeoutMs) => {
      const anyAdapter = this.adapter as ChatProviderAdapter & {
        pool?: WorkerPool;
      };
      if (anyAdapter.pool) {
        const bound = await anyAdapter.pool.bind(sessionId, timeoutMs);
        return bound.tabId;
      }
      // Pool-less adapters (scripted) use a stable pseudo tab.
      return 1;
    };
    this.wsServer = new WsServer({
      path: "/worker",
      token: config.apiKey,
      onConnection: (conn) => this.pool.attach(conn),
    });
  }

  /** Attach the worker-link upgrade handler to an HTTP server. */
  attachWorkerLink(server: { on(event: "upgrade", cb: (req: unknown, socket: unknown, head: unknown) => void): void }): void {
    this.wsServer.attach(server as Parameters<WsServer["attach"]>[0]);
  }

  /** Create a row through the public API (used by POST /v1/sessions). */
  createSession(sessionId: string): SessionRow {
    return this.registry.getOrCreate(sessionId);
  }

  async handleChat(params: ChatParams): Promise<TurnOutput> {
    const ephemeral = params.sessionId === null;
    const row = ephemeral
      ? this.registry.createEphemeral()
      : this.registry.getOrCreate(params.sessionId as string);

    // Same-session overlap is a caller bug: reject, never queue (ADR-7/R6).
    // The generation gate below is a DIFFERENT axis: it caps how many turns
    // run against the provider account at once (DeepSeek refuses a 3rd
    // concurrent generation with "Another message is being generated").
    // Cross-session turns queue FIFO; same-session overlap still 409s here,
    // before the gate is ever consulted.
    const mutex = this.registry.lockFor(row.sessionId);
    if (!mutex.tryAcquire()) {
      const err = new BridgeError({
        status: 409,
        code: "session_busy",
        message: `session ${row.sessionId} already has a turn in flight`,
      });
      throw err;
    }
    let gateHeld = false;
    try {
      // Blocks (FIFO) until one of maxConcurrentTurns generation slots frees
      // up. Throws GateRejectionError on queue_full / queue_timeout /
      // client_gone — mapped to BridgeError below. To callers this is just a
      // longer time-to-first-byte ("thinking"); nothing else changes.
      const gateWaitMs = await this.turnGate.acquire(row.sessionId, params.signal);
      gateHeld = true;
      const out = await runTurn(
        {
          messages: params.messages,
          tools: params.tools,
          think: params.think,
          row,
          registry: this.registry,
          adapter: this.adapter,
          repairRounds: this.config.repairRounds,
          turnTimeoutMs: this.config.turnTimeoutMs,
          bindTimeoutMs: this.config.bindTimeoutMs,
          holdbackCeiling: this.config.holdbackCeiling,
          bindTab: this.bindTabImpl,
        },
        params.events
      );
      return { ...out, ...(gateWaitMs > 0 ? { gateWaitMs } : {}) };
    } catch (e) {
      if (e instanceof GateRejectionError) {
        // A queued-phase rejection never addressed the tab: no prompt was
        // placed, no navigation issued. tabHash must survive (same reasoning
        // as task T8 of the integration plan).
        throw mapGateRejection(e);
      }
      // Only a failure AFTER the tab was addressed leaves tab state
      // unknown; `markFailed` already handled the row for those. Bind/
      // readiness failures must leave the chain anchor untouched.
      const postSubmit = Boolean(
        (e as Error & { postSubmit?: boolean })?.postSubmit
      );
      if (postSubmit && row.tabId !== null && row.chain.length > 0) {
        row.tabHash = null;
      }
      throw e;
    } finally {
      // Release the gate slot first so the next queued turn starts before
      // the session bookkeeping unwinds (both are synchronous).
      if (gateHeld) this.turnGate.release();
      mutex.release();
      this.registry.dropLock(row.sessionId);
      if (ephemeral) {
        this.registry.delete(row.sessionId);
        // Free the worker-side binding so the tab returns to the allocatable
        // pool instead of leaking one tab per sessionless request.
        if (row.tabId !== null) {
          this.pool.release(row.sessionId, 3_000).catch(() => {});
        }
      }
    }
  }

  health(): Record<string, unknown> {
    return {
      ok: true,
      mode: this.registry.mode,
      stateful: this.config.stateful,
      ttl_ms: this.config.ttlMs,
      repair_rounds: this.config.repairRounds,
      auto_create_tabs: this.config.autoCreateTabs,
      managed_only: this.config.managedOnly,
      warm_tabs: this.config.warmTabs,
      sessions: this.registry.size,
      turn_gate: this.turnGate.stats(),
      worker: this.pool.workerInfo
        ? { ext: this.pool.workerInfo.ext, connected: true }
        : { connected: false },
      tabs: this.pool.tabHealth(),
    };
  }

  dispose(): void {
    this.registry.dispose();
    this.pool.detach("shutdown");
  }
}
