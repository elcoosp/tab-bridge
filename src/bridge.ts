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
import { BridgeError, queueFull, queueTimeout, clientGone, RATE_LIMIT_COOLDOWN_SEC, SERVER_BUSY_COOLDOWN_SEC } from "./facade/errors.js";
import { TurnGate, GateRejectionError } from "./core/turngate.js";
import { FleetRegistry, fingerprintOfDir, proxyOf, isolationConflicts, type SurfaceProfile } from "./fleet/registry.js";
import { FleetLauncher, staggerDelayMs } from "./fleet/launcher.js";
import { EnrollmentManager } from "./fleet/enroll.js";
import { PROBE_PATH, renderProbeHtml, probeResultToEntry, type ProbeResult, type CheckupEntry } from "./fleet/probe.js";
import type { ServerResponse } from "node:http";
import { FleetRouter, type HelloFrame } from "./pool/fleet.js";
import type { PoolConfig } from "./pool/pool.js";
import { AccountRegistry } from "./core/accounts.js";
import { AccountTurnGate } from "./core/accountgate.js";
import { existsSync } from "node:fs";
import { randomId } from "./util/async.js";
import { log } from "./log.js";

/** Bug-hunt D12: strip userinfo from a proxy URL, keeping scheme + host:port.
 * Returns the input unchanged when it has no userinfo or is a ${VAR}-form
 * reference whose host is unknowable until launch — those are safe because
 * they name an environment variable, not a credential. */
function stripProxyCredentials(proxy: string): string {
  if (proxy.includes("${")) return proxy;
  return proxy.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, "$1");
}

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
  /**
   * Fleet subsystem (ADR-11v2+). Present only when `--fleet-file` is set
   * to a non-empty path; absent (null) means "legacy single-pool mode" —
   * exactly the pre-fleet behavior. When the fleet file has zero accounts,
   * turns fall through to the single-pool path; the fleet only becomes
   * "active" once at least one account is enrolled.
   *
   * Wiring note: this pass wires the *bookkeeping* layers (registry,
   * accounts, placement, gate, launcher, HTTP surface). Pool-per-account
   * routing via FleetRouter is a follow-up: today all turns still ride the
   * default single WorkerPool. Fleet state is therefore authoritative for
   * placement, cooldowns, surfaces, and HTTP, but the physical routing
   * remains single-link.
   */
  readonly fleet: {
    registry: FleetRegistry;
    accounts: AccountRegistry;
    launcher: FleetLauncher;
    enrollment: EnrollmentManager;
    gate: AccountTurnGate;
    router: FleetRouter;
  } | null;
  /** Per-account DeepSeekAdapter instances, created lazily the first time a
   * turn is routed to an account. The default `this.adapter` is used for the
   * legacy (fleet-disabled) path so existing deployments are untouched. */
  private readonly adaptersByAccount = new Map<string, ChatProviderAdapter>();
  /** Bug-hunt C1: at most one in-flight checkup per account. Opening two
   * probe tabs concurrently used to orphan the second promise (its token
   * was claimed by the first POST) AND pile up probe tabs in the profile. */
  private readonly checkupInFlight = new Map<string, string>();
  /** Bug-hunt C5: only one drain runs at a time. Two concurrent drains on
   * the same source would double-move the same session rows. */
  private drainInFlight = false;
  /** Pending probe invocations, keyed by token. Resolved when the probe
   * page POSTs back; timed out by an internal timer. */
  private readonly probeWaiters = new Map<string, {
    accountId: string;
    settle: (r: CheckupEntry) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout | null;
  }>();
  private readonly wsServer: WsServer;
  private readonly bindTabImpl: (
    sessionId: string,
    timeoutMs: number,
    opts?: { noCreate?: boolean; chatUrl?: string | null }
  ) => Promise<number | { tabId: number; dirty?: boolean }>;

  constructor(config: Config, adapter?: ChatProviderAdapter) {
    this.config = config;
    this.store = new JsonlSessionStore(config.dbPath);
    this.registry = new SessionRegistry({
      mode: config.stateful ? "stateful" : "always-reset",
      ttlMs: config.ttlMs,
      persist: this.store,
      onEvict: (sessionId, row) => {
        log.audit("session.evict", { sessionId });
        // Bug-hunt E1: unwind the account's session counter. Without this,
        // a TTL-expired session leaks an activeSessions slot on its account
        // and the account eventually reports at-cap forever.
        if (this.fleet && row.accountId !== undefined) {
          this.fleet.accounts.noteSessionEnded(row.accountId);
        }
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
    const poolConfig: PoolConfig = {
      autoCreateTabs: config.autoCreateTabs,
      managedOnly: config.managedOnly,
      warmTabs: config.warmTabs,
      maxTabs: config.maxTabs ?? 4,
      tabIdleCloseMs: config.tabIdleCloseMs ?? 15 * 60_000,
    };
    this.pool = new WorkerPool(poolConfig);
    this.adapter = adapter ?? new DeepSeekAdapter(this.pool, { maxPromptChars: config.maxPromptChars });
    this.turnGate = new TurnGate({
      maxConcurrent: config.maxConcurrentTurns,
      capacity: config.queueCapacity,
      queueTimeoutMs: config.queueTimeoutMs,
    });
    this.bindTabImpl = async (sessionId, timeoutMs, opts) => {
      const anyAdapter = this.adapter as ChatProviderAdapter & {
        pool?: WorkerPool;
      };
      if (anyAdapter.pool) {
        const bound = await anyAdapter.pool.bind(sessionId, timeoutMs, opts ?? {});
        return bound.tabId === undefined ? 1 : bound;
      }
      // Pool-less adapters (scripted) use a stable pseudo tab.
      return 1;
    };
    this.wsServer = new WsServer({
      path: "/worker",
      token: config.apiKey,
      // H4: pass through the allow-list when configured; the default policy
      // (accept chrome-extension:// and Origin-less clients, reject web-page
      // origins) applies otherwise.
      ...(config.workerOrigins !== undefined ? { allowedOrigins: config.workerOrigins } : {}),
      onConnection: (conn) => {
        // Fleet routing (ADR-11v2): when the fleet is enabled, each worker
        // HELLO is routed to the pool of its account. The legacy single-pool
        // path is preserved when the fleet is disabled.
        if (this.fleet?.router) this.fleet.router.attach(conn);
        else this.pool.attach(conn);
      },
    });

    // ---- Fleet subsystem (ADR-15) -----------------------------------------
    // Enabled when --fleet-file is a non-empty path AND the file exists.
    // Absent file ⇒ legacy single-pool mode, bit-for-bit. Empty path ⇒
    // fleet explicitly disabled.
    const fleetEnabled =
      typeof config.fleetFile === "string" &&
      config.fleetFile.length > 0 &&
      existsSync(config.fleetFile);
    if (fleetEnabled) {
      const fleetRegistry = FleetRegistry.open(config.fleetFile as string, config.fleetRoot);
      const accounts = new AccountRegistry({
        maxSessionsPerAccount: config.maxSessionsPerAccount ?? 8,
      });
      for (const a of fleetRegistry.all()) {
        accounts.upsert({
          id: a.id,
          ...(a.label !== undefined ? { label: a.label } : {}),
          ...(a.instanceId !== undefined ? { instanceId: a.instanceId } : {}),
          fingerprint: fingerprintOfDir(a.profileDir),
          initial: a.instanceId ? "awaiting_login" : "unlinked",
        });
      }
      // Replay persisted session→account bindings into the live counters so
      // placement sees the same load the persisted state shows.
      for (const row of this.registry.list()) {
        if (row.accountId && accounts.record(row.accountId)) {
          accounts.noteSessionBound(row.accountId);
        }
      }
      const launcher = new FleetLauncher({
        ...(config.browserPath !== undefined ? { browserPath: config.browserPath } : {}),
        onExit: (id: string) => accounts.markWorkerDown(id),
      });
      const enrollment = new EnrollmentManager();
      const gate = new AccountTurnGate({
        perAccountConcurrent: config.perAccountTurns ?? 2,
        capacity: config.queueCapacity,
        queueTimeoutMs: config.queueTimeoutMs,
      });

      // FleetRouter (ADR-11v2): one WorkerPool per account. The route()
      // callback resolves a worker HELLO to an account (known instance via
      // the registry, or a fresh claim via an open enrollment), and refuses
      // unknown instances fail-closed. onFleetEvent() forwards per-account
      // pool events into account-state transitions.
      const router = new FleetRouter(poolConfig, {
        route: (hello: HelloFrame) => {
          const known = hello.instance
            ? fleetRegistry.accountForInstance(hello.instance)
            : undefined;
          if (known) return { kind: "route", accountId: known.id };
          const claimed = enrollment.consider(hello, known !== undefined);
          if (claimed) {
            try {
              fleetRegistry.bindInstance(claimed, hello.instance as string);
            } catch (err) {
              log.warn("fleet.instance-bind-failed", {
                accountId: claimed,
                instance: hello.instance,
                error: String(err),
              });
            }
            return { kind: "route", accountId: claimed };
          }
          return {
            kind: "refuse",
            reason: "unknown instance — run `fleet add <id>` in this profile",
          };
        },
        // Bug-hunt B7: refuse a routing decision that names an account the
        // fleet registry does not know. Defensive only — the route() callback
        // above already only returns registry-known ids.
        isKnownAccount: (accountId: string) => fleetRegistry.byId(accountId) !== undefined,
        onFleetEvent: (e) => {
          if (e.type === "worker-up") {
            accounts.markWorkerLinked(e.accountId);
          } else if (e.type === "worker-down") {
            accounts.markWorkerDown(e.accountId);
          } else if (e.type === "health") {
            if (e.state === "ok") {
              accounts.markLoginOk(e.accountId);
              fleetRegistry.markEnrolled(e.accountId);
            } else if (e.state === "auth_invalid") {
              accounts.markNeedsRelogin(e.accountId, e.detail);
            } else if (e.state === "rate_limited") {
              accounts.markCooling(e.accountId, RATE_LIMIT_COOLDOWN_SEC);
            } else if (e.state === "server_busy") {
              accounts.markCooling(e.accountId, SERVER_BUSY_COOLDOWN_SEC);
            }
          }
        },
      });

      this.fleet = { registry: fleetRegistry, accounts, launcher, enrollment, gate, router };

      // --fleet-launch=always ⇒ launch every persisted account at boot with
      // its own deterministic stagger phase (ADR-19).
      if (config.fleetLaunch === "always") {
        try {
          launcher.launchAll(
            fleetRegistry.all().map((acct) => {
              let proxy: string | undefined;
              try {
                proxy = proxyOf(acct, process.env) ?? undefined;
              } catch (err) {
                log.error("fleet.boot-proxy-unset", { accountId: acct.id, error: String(err) });
              }
              return {
                accountId: acct.id,
                profileDir: acct.profileDir,
                extensionDir: config.extensionDir ?? "./extension",
                manualExtension: config.fleetManualExtension === true,
                ...(proxy !== undefined ? { proxy } : {}),
                ...(acct.surface !== undefined ? { surface: acct.surface } : {}),
                proxyRequired: config.fleetProxyRequired === true,
              };
            }),
            config.fleetLaunchStaggerMs ?? 45_000
          );
        } catch (e) {
          log.error("fleet.boot-launch-failed", { error: String(e) });
        }
      }
    } else {
      this.fleet = null;
    }
  }

  /** Attach the worker-link upgrade handler to an HTTP server. */
  attachWorkerLink(server: { on(event: "upgrade", cb: (req: unknown, socket: unknown, head: unknown) => void): void }): void {
    this.wsServer.attach(server as Parameters<WsServer["attach"]>[0]);
  }

  /** Create a row through the public API (used by POST /v1/sessions). */
  createSession(sessionId: string): SessionRow {
    return this.registry.getOrCreate(sessionId);
  }

  async handleChat(params: ChatParams): Promise<TurnOutput & { accountId?: string }> {
    const ephemeral = params.sessionId === null;
    const row = ephemeral
      ? this.registry.createEphemeral()
      : this.registry.getOrCreate(params.sessionId as string);

    // ---- Fleet: place-then-stick (ADR-13v3) ------------------------------
    // A non-ephemeral session is bound to exactly one account, once. When
    // the fleet has zero accounts, fall through to the legacy single-pool
    // path — that keeps a bridge started with an empty fleet.json behaving
    // exactly like the pre-fleet bridge for its one real worker.
    const fleetActive = this.fleet !== null && this.fleet.registry.all().length > 0;
    // Bug-hunt E4: a persisted row can still carry a binding to an account
    // that no longer exists (removed while the bridge was down, or a
    // journal write that raced removal before D2's fix). Clear it so the
    // normal placement path below re-binds instead of routing to a ghost.
    if (
      fleetActive &&
      !ephemeral &&
      row.accountId !== undefined &&
      this.fleet!.registry.byId(row.accountId) === undefined
    ) {
      row.accountId = undefined;
      row.pendingReset = true;
    }
    if (fleetActive && !ephemeral && row.accountId === undefined) {
      const placed = this.fleet!.accounts.placeSession();
      if (!placed.ok) {
        const retry = this.fleet!.accounts.shortestCooldownSec() ?? 60;
        throw new BridgeError({
          status: 503,
          code: "fleet_busy",
          message:
            placed.reason === "none_ready"
              ? `no ready account for this session (retry in ~${retry}s)`
              : "every ready account is at its session cap",
          retryAfter: retry,
        });
      }
      row.accountId = placed.accountId;
      this.fleet!.accounts.noteSessionBound(row.accountId);
    }

    // ---- Fleet: pre-flight (typed, fail-fast — ADR-16) -------------------
    if (fleetActive && row.accountId !== undefined) {
      const cooling = this.fleet!.accounts.cooldownSec(row.accountId);
      if (cooling !== null) {
        throw new BridgeError({
          status: 429,
          code: "rate_limited",
          message: `account "${row.accountId}" is cooling; retry in ~${cooling}s`,
          retryAfter: cooling,
        });
      }
      const rec = this.fleet!.accounts.record(row.accountId);
      if (rec && rec.state === "needs_relogin") {
        throw new BridgeError({
          status: 503,
          code: "account_paused",
          message: `account "${row.accountId}" needs a human re-login`,
          headers: { "x-fleet-account": row.accountId },
        });
      }
    }

    // Same-session overlap is a caller bug: reject, never queue (ADR-7/R6).
    const mutex = this.registry.lockFor(row.sessionId);
    if (!mutex.tryAcquire()) {
      throw new BridgeError({
        status: 409,
        code: "session_busy",
        message: `session ${row.sessionId} already has a turn in flight`,
      });
    }
    let gateHeld = false;
    let usedFleetGate = false;
    let turnStarted = false;
    let onClientAbortRef: (() => void) | null = null;
    try {
      // Fleet turns ride the per-account FIFO gate (ADR-12v3); legacy turns
      // ride the global turn gate (unchanged).
      let gateWaitMs = 0;
      if (fleetActive && row.accountId !== undefined) {
        try {
          gateWaitMs = await this.fleet!.gate.acquire(row.accountId, row.sessionId, params.signal);
        } catch (e) {
          if (e instanceof GateRejectionError) throw mapGateRejection(e);
          throw e;
        }
        gateHeld = true;
        usedFleetGate = true;
        // Bug-hunt C3: mark the start so the finally block only calls
        // noteTurnEnd when noteTurnStart actually ran.
        this.fleet!.accounts.noteTurnStart(row.accountId);
        turnStarted = true;
      } else {
        gateWaitMs = await this.turnGate.acquire(row.sessionId, params.signal);
        gateHeld = true;
      }
      // Select the adapter for this session's account. When the fleet is
      // active, the adapter rides the account's own WorkerPool; otherwise
      // this is the default adapter over the default pool (legacy path).
      const adapter = this.adapterForAccount(row.accountId);
      // P9: after admission, a client that gives up would otherwise leave
      // the bridge streaming DeepSeek's full reply into a dead socket.
      const adapterWithReqId = adapter as ChatProviderAdapter & {
        reqIdForTab?: (tabId: number) => string | undefined;
        pool?: { abortIntent: (reqId: string) => void };
      };
      const onClientAbort = (): void => {
        if (row.tabId === null) return;
        const reqId = adapterWithReqId.reqIdForTab?.(row.tabId);
        if (reqId) adapterWithReqId.pool?.abortIntent(reqId);
      };
      onClientAbortRef = onClientAbort;
      if (params.signal) {
        if (params.signal.aborted) onClientAbort();
        else params.signal.addEventListener("abort", onClientAbort, { once: true });
      }
      // E5: background-class ephemeral traffic binds with noCreate.
      const noCreate = ephemeral && params.background === true;
      const bindTab = noCreate
        ? (
            sid: string,
            ms: number,
            extra?: { chatUrl?: string | null }
          ) => this.bindTabForAccount(row.accountId, sid, ms, { noCreate: true, ...(extra ?? {}) })
        : (sid: string, ms: number, extra?: { chatUrl?: string | null }) =>
            this.bindTabForAccount(row.accountId, sid, ms, extra ?? {});
      // v4 §10.3: advertise the serving account before any content. The
      // SSE writer emits this as a comment frame the instant it fires.
      if (row.accountId !== undefined) params.events?.onAccount?.(row.accountId);
      const out = await runTurn(
        {
          messages: params.messages,
          tools: params.tools,
          think: params.think,
          row,
          registry: this.registry,
          repairRounds: this.config.repairRounds,
          turnTimeoutMs: this.config.turnTimeoutMs,
          bindTimeoutMs: this.config.bindTimeoutMs,
          holdbackCeiling: this.config.holdbackCeiling,
          adapter,
          bindTab,
          resetOnSeed: this.config.resetOnSeed ?? "auto",
        },
        params.events
      );
      return {
        ...out,
        ...(gateWaitMs > 0 ? { gateWaitMs } : {}),
        ...(row.accountId !== undefined ? { accountId: row.accountId } : {}),
      };
    } catch (e) {
      if (e instanceof GateRejectionError) throw mapGateRejection(e);
      const postSubmit = Boolean(
        (e as Error & { postSubmit?: boolean })?.postSubmit
      );
      if (postSubmit && row.tabId !== null && row.chain.length > 0) {
        row.tabHash = null;
      }
      throw e;
    } finally {
      if (params.signal && onClientAbortRef !== null) {
        params.signal.removeEventListener("abort", onClientAbortRef);
      }
      if (gateHeld) {
        if (usedFleetGate && row.accountId !== undefined) {
          if (turnStarted) this.fleet!.accounts.noteTurnEnd(row.accountId);
          this.fleet!.gate.release(row.accountId);
        } else {
          this.turnGate.release();
        }
      }
      mutex.release();
      this.registry.dropLock(row.sessionId);
      if (ephemeral) {
        this.registry.delete(row.sessionId);
        if (row.tabId !== null) {
          this.pool.release(row.sessionId, 3_000).catch(() => {});
        }
      }
    }
  }

  /** The adapter that serves a given account: the default adapter when the
   * fleet is disabled or the account id is absent (legacy path), otherwise a
   * per-account DeepSeekAdapter over that account's WorkerPool — created
   * lazily on first use. */
  private adapterForAccount(accountId: string | undefined): ChatProviderAdapter {
    if (!accountId || !this.fleet || !this.fleet.router) return this.adapter;
    let a = this.adaptersByAccount.get(accountId);
    if (!a) {
      const pool = this.fleet.router.pool(accountId);
      a = new DeepSeekAdapter(pool, { maxPromptChars: this.config.maxPromptChars });
      this.adaptersByAccount.set(accountId, a);
    }
    return a;
  }

  /** On-demand relaunch (ADR-15, §6.5): when the fleet is active and a turn
   * is placed on an account whose Chrome is not running, spawn it with the
   * account's persisted identity (proxy + surface). No-op when the account
   * is already running or when the fleet is disabled. Launcher failures are
   * logged and swallowed — the caller's bind will surface the real error. */
  private relaunchIfDown(accountId: string): void {
    if (!this.fleet) return;
    const acct = this.fleet.registry.byId(accountId);
    if (!acct) return;
    if (this.fleet.launcher.isLaunched(accountId)) return;
    let proxy: string | undefined;
    try {
      proxy = proxyOf(acct, process.env) ?? undefined;
    } catch (err) {
      log.error("fleet.relaunch-proxy-unset", { accountId, error: String(err) });
    }
    // Bug-hunt fix: surface launch failures to the caller so a config error
    // (e.g. proxyRequired without an endpoint, browser binary missing) fails
    // the turn with a clear bind_failed reason instead of a silent timeout.
    try {
      this.fleet.launcher.launch({
        accountId,
        profileDir: acct.profileDir,
        extensionDir: this.config.extensionDir ?? "./extension",
        manualExtension: this.config.fleetManualExtension === true,
        ...(proxy !== undefined ? { proxy } : {}),
        ...(acct.surface !== undefined ? { surface: acct.surface } : {}),
        proxyRequired: this.config.fleetProxyRequired === true,
      });
      log.info("fleet.relaunch", { accountId });
    } catch (e) {
      log.error("fleet.relaunch-failed", { accountId, error: String(e) });
      throw e;
    }
  }

  /** Poll the account's pool until its worker link is up, up to timeoutMs.
   * Returns true once linked, false on timeout. Used only by the fleet
   * on-demand path (the legacy path relies on the pool's own retry). */
  private async waitForWorkerLink(accountId: string, timeoutMs: number): Promise<boolean> {
    if (!this.fleet) return false;
    const pool = this.fleet.router.pool(accountId);
    if (pool.hasWorker) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (pool.hasWorker) return true;
    }
    return false;
  }

  /** Bind a session to a tab through the correct pool for its account. For
   * scripted adapters (no real pool) returns the legacy pseudo tab id 1 so
   * the contract-test path is untouched. */
  private async bindTabForAccount(
    accountId: string | undefined,
    sessionId: string,
    timeoutMs: number,
    opts: { noCreate?: boolean; chatUrl?: string | null } = {}
  ): Promise<number | { tabId: number; dirty?: boolean }> {
    const adapter = this.adapterForAccount(accountId) as ChatProviderAdapter & {
      pool?: WorkerPool;
    };
    if (!adapter.pool) return 1;
    // On-demand relaunch (fleet path only): if the account's worker link
    // is down, launch its Chrome and wait for the link before binding.
    if (accountId !== undefined && this.fleet) {
      if (!adapter.pool.hasWorker) {
        this.relaunchIfDown(accountId);
        await this.waitForWorkerLink(accountId, timeoutMs);
      }
    }
    const bound = await adapter.pool.bind(sessionId, timeoutMs, opts);
    return bound.tabId === undefined ? 1 : bound;
  }

  /** Fleet status snapshot — the wire shape of GET /v1/accounts. */
  fleetStatus(): Record<string, unknown> {
    if (!this.fleet) {
      return {
        accounts: [],
        capacity: {
          readyAccounts: 0,
          turnSlots: 0,
          sessionSlots: 0,
          shortestCooldownInSec: null,
        },
        isolation: { findings: [], checkedAt: Date.now() },
      };
    }
    const rows = this.fleet.accounts.all();
    const maxSessions = this.config.maxSessionsPerAccount ?? 8;
    const maxTurns = this.config.perAccountTurns ?? 2;
    // Deterministic boot phase (ADR-19) so the doctor can show it without
    // recomputing; zero when stagger is disabled.
    const staggerWindow = this.config.fleetLaunchStaggerMs ?? 45_000;
    const accounts = rows.map((r) => {
      const acct = this.fleet!.registry.byId(r.id);
      // Boot phase: same deterministic function the launcher uses.
      let bootPhaseMs = 0;
      if (staggerWindow > 0) {
        bootPhaseMs = staggerDelayMs(r.id, staggerWindow);
      }
      return {
        id: r.id,
        ...(r.label !== undefined ? { label: r.label } : {}),
        state: r.state,
        cooldownInSec: this.fleet!.accounts.cooldownSec(r.id),
        sessions: r.activeSessions,
        maxSessions,
        activeTurns: r.activeTurns,
        maxTurns,
        linked: r.workerLinked,
        fingerprint: r.fingerprint,
        awaitingHuman: r.state === "awaiting_login" || r.state === "needs_relogin",
        network: { proxy: acct?.proxy ? true : false, exitIp: null, exitProbe: "skipped" },
        surface: acct?.surface ?? {},
        bootPhaseMs,
        ...(acct?.enrolledAt !== undefined ? { enrolledAt: acct.enrolledAt } : {}),
        ...(acct?.createdAt !== undefined ? { createdAt: acct.createdAt } : {}),
        // §7.3: the latest probe result (if any) so a dashboard can render
        // the measured fingerprint without re-running the probe.
        checkup: acct?.checkupHistory && acct.checkupHistory.length > 0
          ? acct.checkupHistory[0]
          : null,
      };
    });
    const readyRows = rows.filter((r) => r.state === "ready" && r.workerLinked);
    return {
      accounts,
      capacity: {
        readyAccounts: readyRows.length,
        turnSlots: readyRows.length * maxTurns,
        sessionSlots: rows.reduce((s, r) => s + r.activeSessions, 0),
        shortestCooldownInSec: this.fleet.accounts.shortestCooldownSec(),
      },
      isolation: {
        findings: isolationConflicts(this.fleet.registry.all()),
        checkedAt: Date.now(),
      },
    };
  }

  /** Bookkeeping hook for the DELETE /v1/sessions path. */
  releaseSession(sessionId: string): void {
    if (!this.fleet) return;
    const row = this.registry.get(sessionId);
    if (row?.accountId !== undefined) {
      this.fleet.accounts.noteSessionEnded(row.accountId);
    }
  }

  /** Fleet CLI: enroll a new account (add + launch + open enrollment). */
  fleetEnroll(input: {
    id: string;
    label?: string;
    proxy?: string;
    surface?: SurfaceProfile;
  }): { id: string } {
    if (!this.fleet) {
      throw new BridgeError({
        status: 503,
        code: "fleet_disabled",
        message: "fleet is not enabled (set --fleet-file to a non-empty path and restart)",
      });
    }
    const acct = this.fleet.registry.add({
      id: input.id,
      ...(input.label !== undefined ? { label: input.label } : {}),
    });
    if (input.proxy !== undefined) this.fleet.registry.setProxy(acct.id, input.proxy);
    if (input.surface !== undefined) this.fleet.registry.setSurface(acct.id, input.surface);
    const persisted = this.fleet.registry.byId(acct.id)!;
    this.fleet.accounts.upsert({
      id: persisted.id,
      ...(persisted.label !== undefined ? { label: persisted.label } : {}),
      fingerprint: fingerprintOfDir(persisted.profileDir),
      initial: "awaiting_login",
    });
    // Open the enrollment claim window first: the pool's worker-up handler
    // attributes the next unknown instance to it. The promise is
    // fire-and-forget; the CLI polls /v1/accounts for state.
    void this.fleet.enrollment.begin(persisted.id, 10 * 60_000).catch((e) => {
      // Bug-hunt fix: log enrollment timeout (or claim failure) so operators
      // have a server-side signal, not just a silently-hung CLI poll.
      log.warn("fleet.enroll-timeout", { accountId: persisted.id, error: String(e) });
    });
    // Launch the profile process.
    try {
      let proxyEndpoint: string | undefined;
      try {
        proxyEndpoint = proxyOf(persisted, process.env) ?? undefined;
      } catch (err) {
        log.error("fleet.proxy-unset", { accountId: persisted.id, error: String(err) });
      }
      this.fleet.launcher.launch({
        accountId: persisted.id,
        profileDir: persisted.profileDir,
        extensionDir: this.config.extensionDir ?? "./extension",
        manualExtension: this.config.fleetManualExtension === true,
        ...(proxyEndpoint !== undefined ? { proxy: proxyEndpoint } : {}),
        ...(persisted.surface !== undefined ? { surface: persisted.surface } : {}),
        proxyRequired: this.config.fleetProxyRequired === true,
      });
    } catch (e) {
      log.error("fleet.enroll-launch-failed", { accountId: persisted.id, error: String(e) });
      // The record persists; the operator can retry with `fleet open`.
    }
    return { id: persisted.id };
  }

  /** Fleet CLI: open the account's window without touching enrollment. */
  fleetOpenWindow(id: string): void {
    if (!this.fleet) {
      throw new BridgeError({ status: 503, code: "fleet_disabled", message: "fleet is not enabled" });
    }
    const acct = this.fleet.registry.byId(id);
    if (!acct) throw new BridgeError({ status: 404, code: "no_account", message: `no such account: ${id}` });
    let proxyEndpoint: string | undefined;
    try {
      proxyEndpoint = proxyOf(acct, process.env) ?? undefined;
    } catch (err) {
      log.error("fleet.proxy-unset", { accountId: id, error: String(err) });
    }
    this.fleet.launcher.launch({
      accountId: acct.id,
      profileDir: acct.profileDir,
      extensionDir: this.config.extensionDir ?? "./extension",
      manualExtension: this.config.fleetManualExtension === true,
      ...(proxyEndpoint !== undefined ? { proxy: proxyEndpoint } : {}),
      ...(acct.surface !== undefined ? { surface: acct.surface } : {}),
      proxyRequired: this.config.fleetProxyRequired === true,
    });
  }

  /** §7.3: serve the fingerprint probe page. The page is static; the account
   * id and token arrive via the query string and are read by the page. */
  serveProbeHtml(res: ServerResponse, _accountId: string, _token: string): void {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderProbeHtml());
  }

  /** §7.3: accept a probe result POSTed by the probe page. Local-trust only
   * (the probe page is served by this bridge, from a loopback browser);
   * the caller in http.ts enforces the loopback source address before
   * invoking this. Matches the token, resolves the waiting checkup, and
   * persists the entry on the account. */
  fleetRecordProbeResult(payload: unknown): { ok: boolean; reason?: string } {
    const p = payload as Partial<ProbeResult>;
    if (typeof p?.accountId !== "string" || typeof p?.token !== "string") {
      return { ok: false, reason: "missing accountId/token" };
    }
    const w = this.probeWaiters.get(p.token);
    if (!w) return { ok: false, reason: "no such probe (expired or unknown token)" };
    if (w.accountId !== p.accountId) {
      return { ok: false, reason: `token belongs to a different account ("${w.accountId}")` };
    }
    const entry = probeResultToEntry(p as ProbeResult);
    if (this.fleet) this.fleet.registry.recordCheckup(p.accountId, entry);
    this.probeWaiters.delete(p.token);
    if (w.timer) clearTimeout(w.timer);
    w.settle(entry);
    return { ok: true };
  }

  /** §7.3: the recorded checkup history for one account, newest first. */
  fleetCheckupHistory(id: string): CheckupEntry[] {
    if (!this.fleet) return [];
    const acct = this.fleet.registry.byId(id);
    return acct?.checkupHistory ?? [];
  }

  /** §7.3: run a fresh fingerprint checkup — open the probe page in a new
   * tab of the account's profile, wait up to timeoutMs for the result. */
  async fleetCheckup(id: string, timeoutMs = 30_000): Promise<CheckupEntry> {
    if (!this.fleet) {
      throw new BridgeError({
        status: 503,
        code: "fleet_disabled",
        message: "fleet is not enabled (set --fleet-file to a non-empty path and restart)",
      });
    }
    const acct = this.fleet.registry.byId(id);
    if (!acct) {
      throw new BridgeError({ status: 404, code: "no_account", message: `no such account: ${id}` });
    }
    // Bug-hunt C1: one in-flight checkup per account.
    if (this.checkupInFlight.has(id)) {
      throw new BridgeError({
        status: 409,
        code: "checkup_in_flight",
        message: `a checkup for "${id}" is already running — wait for it to finish`,
      });
    }
    // Token: random hex, unique per invocation.
    const token = `probe-${randomId(24)}`;
    // Bug-hunt D3: ALWAYS use 127.0.0.1 for the probe URL. The probe tab
    // runs in the account's own Chrome, whose --proxy-server would route
    // any other address through the exit proxy — so binding to e.g.
    // 10.0.0.5 or 192.168.x.y would silently break every checkup (the tab
    // cannot reach the bridge through the proxy). Loopback is always
    // reachable from the local browser and rides the OS routing table,
    // not the proxy.
    const host = "127.0.0.1";
    const url =
      `http://${host}:${this.config.port}${PROBE_PATH}` +
      `?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
    // Register the waiter BEFORE spawning: the probe page can POST back
    // within milliseconds of the tab opening.
    const self = this;
    const cleanup = (): void => {
      self.checkupInFlight.delete(id);
    };
    const promise = new Promise<CheckupEntry>((settle, reject) => {
      const timer = setTimeout(() => {
        this.probeWaiters.delete(token);
        cleanup();
        reject(
          new Error(
            `fingerprint probe for "${id}" did not return within ${timeoutMs}ms ` +
              `(check that the profile is logged in and the tab can reach ${host}:${this.config.port})`
          )
        );
      }, timeoutMs);
      timer.unref?.();
      const wrappedSettle = (r: CheckupEntry): void => { cleanup(); settle(r); };
      const wrappedReject = (e: Error): void => { cleanup(); reject(e); };
      this.probeWaiters.set(token, { accountId: id, settle: wrappedSettle, reject: wrappedReject, timer });
    });
    this.checkupInFlight.set(id, token);
    // Bug-hunt fix: pass the account's surface timezone so the probe measures
    // the SAME TZ the account's real Chrome presents.
    const tz = acct.surface?.timezone;
    this.fleet.launcher.spawnProbeTab(acct.profileDir, url, tz);
    return promise;
  }

  /** Fleet CLI: raw (unexpanded) proxy string for the doctor probe.
   * Never logged, never surfaced in /v1/accounts, never expanded here —
   * the caller is responsible for expanding ${VAR} against its own
   * environment (fail-closed). Returns null when the account has no proxy.
   *
   * Bug-hunt D12: strip any credentials embedded in the endpoint before
   * returning. _debug_proxy is loopback-only, but on a host with a shared
   * user account (or a browser XSS on another tab in the same profile)
   * that still means any local process can read it. The CLI needs only
   * the transport address for its exit-IP probe; the credentials belong
   * to the operator's environment and never leave it. */
  fleetRawProxy(id: string): string | null {
    if (!this.fleet) return null;
    const acct = this.fleet.registry.byId(id);
    if (!acct?.proxy) return null;
    return stripProxyCredentials(acct.proxy);
  }

  /** Bug-hunt fix (C12): true once the account's identity is live — i.e.
   * it has been launched at least once. Only live accounts require --force
   * to change their network identity or surface. */
  private isLiveAccount(id: string): boolean {
    if (!this.fleet) return false;
    const rec = this.fleet.accounts.record(id);
    if (!rec) return false;
    // awaiting_login = enrolled but the human hasn't logged in yet;
    // unlinked = enrolled, no worker link. Neither has accumulated identity
    // history, so a change is cheap and safe.
    return rec.state !== "awaiting_login" && rec.state !== "unlinked";
  }

  /** Fleet CLI: set/clear the account's network identity. Changing a LIVE
   * account requires `force` (C12: identity is stable for the account's
   * life; a mid-life change is what a risk engine reads as a different
   * person behind the same jar). */
  fleetSetProxy(id: string, proxy: string | null, force = false): void {
    if (!this.fleet) {
      throw new BridgeError({ status: 503, code: "fleet_disabled", message: "fleet is not enabled" });
    }
    if (!this.fleet.registry.byId(id)) {
      throw new BridgeError({ status: 404, code: "no_account", message: `no such account: ${id}` });
    }
    if (this.isLiveAccount(id) && !force) {
      throw new BridgeError({
        status: 409,
        code: "account_live",
        message:
          `account "${id}" is live — changing its network identity mid-life is an identity change (C12). ` +
          `Pass --force to proceed, or create a new profile instead.`,
      });
    }
    this.fleet.registry.setProxy(id, proxy);
  }

  /** Fleet CLI: set/clear the account's presentation surface. Same stability
   * rule as fleetSetProxy (C12). */
  fleetSetSurface(id: string, surface: SurfaceProfile | null, force = false): void {
    if (!this.fleet) {
      throw new BridgeError({ status: 503, code: "fleet_disabled", message: "fleet is not enabled" });
    }
    if (!this.fleet.registry.byId(id)) {
      throw new BridgeError({ status: 404, code: "no_account", message: `no such account: ${id}` });
    }
    if (this.isLiveAccount(id) && !force) {
      throw new BridgeError({
        status: 409,
        code: "account_live",
        message:
          `account "${id}" is live — changing its surface mid-life is an identity change (C12). ` +
          `Pass --force to proceed, or create a new profile instead.`,
      });
    }
    this.fleet.registry.setSurface(id, surface);
  }

  /** Fleet CLI: unbind the account (profile dir kept unless --purge). */
  fleetRemove(id: string): boolean {
    if (!this.fleet) {
      throw new BridgeError({ status: 503, code: "fleet_disabled", message: "fleet is not enabled" });
    }
    const removed = this.fleet.registry.remove(id);
    if (removed) {
      // Release any sessions still bound to it so we do not leak counters.
      // Bug-hunt D2: ALSO compact the journal after clearing row.accountId,
      // so a restart does not resurrect a session pinned to a removed
      // account. Without this, the next boot's `restore()` reads the stale
      // accountId and pre-flight fails (or worse — placement sees ready
      // accounts and tries to route with a ghost id).
      let clearedAny = false;
      for (const row of this.registry.list()) {
        if (row.accountId === id) {
          this.fleet.accounts.noteSessionEnded(id);
          row.accountId = undefined;
          row.pendingReset = true;
          clearedAny = true;
        }
      }
      if (clearedAny) {
        try {
          this.registry.persistCompact();
        } catch {
          /* best effort */
        }
      }
      // Bug-hunt fix: reject any waiters queued on the account's gate. Without
      // this, a session that was waiting for a slot on the removed account
      // hangs until queue_timeout because no release will ever come.
      try {
        this.fleet.gate.cancelAccount(id, `account "${id}" was removed`);
      } catch {
        /* ignore */
      }
      // Bug-hunt C11: detach the adapter's pool listener BEFORE dropping the
      // pool so it does not keep dispatching into a stale buffer map or hold
      // a strong reference to the soon-detached WorkerPool.
      const staleAdapter = this.adaptersByAccount.get(id) as
        | (ChatProviderAdapter & { detachPool?: () => void })
        | undefined;
      try {
        staleAdapter?.detachPool?.();
      } catch {
        /* ignore */
      }
      this.adaptersByAccount.delete(id);
      // Drop the account's pool so a later re-enroll starts clean.
      try {
        this.fleet.router.detach(id, `removed:${id}`);
      } catch {
        /* ignore */
      }
      // Bug-hunt fix: kill ONLY this account's Chrome. The previous call to
      // killAll() took down every other running profile too.
      try {
        this.fleet.launcher.killOne(id, `removed:${id}`);
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  /** Fleet CLI: plan (dry-run) or execute a drain — move sessions off one
   * account onto another (ADR-13v3 escape hatch). Returns the account that
   * WOULD receive the sessions plus the count of sessions that WOULD move;
   * when `dryRun` is false, performs the move. Operator-invoked only. */
  fleetDrain(fromId: string, to: string | "auto", dryRun = false): {
    moved: number;
    target: string;
    dryRun: boolean;
  } {
    if (!this.fleet) {
      throw new BridgeError({ status: 503, code: "fleet_disabled", message: "fleet is not enabled" });
    }
    if (this.drainInFlight) {
      throw new BridgeError({
        status: 409,
        code: "drain_in_flight",
        message: "another drain is already running — drains are serialized",
      });
    }
    const from = this.fleet.registry.byId(fromId);
    if (!from) throw new BridgeError({ status: 404, code: "no_account", message: `no such account: ${fromId}` });
    this.drainInFlight = true;
    let target: string;
    if (to === "auto") {
      // Bug-hunt D1: auto-pick must never choose the source account.
      // placeSession() is a general-purpose helper with no notion of "not
      // this account"; if fromId happens to be least-loaded it would
      // return fromId itself, rebinding every session onto the same
      // account (a pointless reseed storm). Loop by temporarily removing
      // the source from consideration: call placeSession repeatedly via
      // a snapshot of the registry minus `fromId`, falling back to the
      // explicit refusal the manual path uses.
      const source = this.fleet.registry.byId(fromId);
      let chosen: string | null = null;
      if (source) {
        // Temporarily remove fromId from placement by clearing its record
        // state to `unlinked`, restoring it in the finally below. This is
        // the cheapest way to reuse the existing placement logic without
        // adding a filter parameter.
        const rec = this.fleet.accounts.record(fromId);
        const savedState = rec?.state;
        if (rec) rec.state = "unlinked";
        try {
          const placed = this.fleet.accounts.placeSession();
          if (placed.ok) chosen = placed.accountId;
        } finally {
          if (rec && savedState !== undefined) rec.state = savedState;
        }
      }
      if (chosen === null) {
        throw new BridgeError({
          status: 503,
          code: "fleet_busy",
          message: "no target account available for drain (excluding the source)",
        });
      }
      target = chosen;
    } else {
      if (!this.fleet.registry.byId(to)) {
        throw new BridgeError({ status: 404, code: "no_account", message: `no such target account: ${to}` });
      }
      // Bug-hunt fix: a drain onto the same account is a no-op that still
      // re-binds every session — a pointless reseed storm. Refuse loudly.
      if (to === fromId) {
        throw new BridgeError({
          status: 400,
          code: "drain_self",
          message: `cannot drain "${fromId}" onto itself — pick a different target (or omit --to for auto)`,
        });
      }
      target = to;
    }
    try {
      let moved = 0;
      for (const row of this.registry.list()) {
        if (row.accountId !== fromId) continue;
        if (dryRun) {
          moved += 1;
          continue;
        }
        this.fleet.accounts.noteSessionEnded(fromId);
        row.accountId = target;
        row.pendingReset = true; // force reseed on the target (ADR-13v3)
        this.fleet.accounts.noteSessionBound(target);
        moved += 1;
      }
      return { moved, target, dryRun };
    } finally {
      this.drainInFlight = false;
    }
  }

  health(): Record<string, unknown> {
    const fleetBlock = this.fleet
      ? (() => {
          const rows = this.fleet!.accounts.all();
          const findings = isolationConflicts(this.fleet!.registry.all());
          const ready = rows.filter((r) => r.state === "ready").length;
          const maxSessions = this.config.maxSessionsPerAccount ?? 8;
          // Alerts: surface conditions a dashboard can page on without
          // having to compute them from the raw rows.
          const alerts: string[] = [];
          if (rows.length > 0 && ready === 0) alerts.push("no_ready_accounts");
          if (findings.length > 0) alerts.push("isolation_findings");
          if (maxSessions > 0) {
            const full = rows.filter((r) => r.state === "ready" && r.activeSessions >= maxSessions).length;
            if (full > 0 && full === ready) alerts.push("all_ready_accounts_at_session_cap");
          }
          return {
            enabled: true,
            accounts: rows.length,
            ready,
            cooling: rows.filter((r) => r.state === "cooling").length,
            needsRelogin: rows.filter((r) => r.state === "needs_relogin").length,
            awaitingLogin: rows.filter((r) => r.state === "awaiting_login").length,
            sessions: rows.reduce((s, r) => s + r.activeSessions, 0),
            queueDepth: this.fleet!.gate.totalWaiting(),
            isolationFindings: findings.length,
            alerts,
          };
        })()
      : { enabled: false };
    return {
      ok: true,
      mode: this.registry.mode,
      stateful: this.config.stateful,
      ttl_ms: this.config.ttlMs,
      repair_rounds: this.config.repairRounds,
      auto_create_tabs: this.config.autoCreateTabs,
      managed_only: this.config.managedOnly,
      warm_tabs: this.config.warmTabs,
      reset_on_seed: this.config.resetOnSeed,
      max_tabs: this.config.maxTabs,
      tab_idle_close_ms: this.config.tabIdleCloseMs,
      sessions: this.registry.size,
      turn_gate: this.turnGate.stats(),
      worker: this.pool.workerInfo
        ? { ext: this.pool.workerInfo.ext, connected: true }
        : { connected: false },
      tabs: this.pool.tabHealth(),
      fleet: fleetBlock,
    };
  }

  dispose(): void {
    this.registry.dispose();
    this.pool.detach("shutdown");
    // Bug-hunt fix: clean up every fleet-owned resource so a bridge restart
    // (or test teardown) does not leak pending probe timers, orphan Chrome
    // processes, router pools, or an open enrollment.
    if (this.fleet) {
      for (const [, w] of this.probeWaiters) {
        if (w.timer) clearTimeout(w.timer);
        w.reject(new Error("bridge disposed"));
      }
      this.probeWaiters.clear();
      // Bug-hunt E3: also clear the per-account checkup guard so a later
      // re-init of the bridge (or a test teardown that reuses the object)
      // does not see a phantom in-flight checkup.
      this.checkupInFlight.clear();
      try { this.fleet.launcher.killAll("shutdown"); } catch { /* ignore */ }
      try { this.fleet.router.detachAll("shutdown"); } catch { /* ignore */ }
      try { this.fleet.enrollment.discardAll(); } catch { /* ignore */ }
      this.adaptersByAccount.clear();
    }
  }
}
