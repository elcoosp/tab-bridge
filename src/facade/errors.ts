/**
 * Error taxonomy (ADR-7, spec 8.3): every internal condition maps to the
 * status a harness-class client can act on. JSON bodies only — never HTML.
 */
export interface BridgeErrorInit {
  status: number;
  code: string;
  message: string;
  retryAfter?: number;
  /** Extra headers (e.g. X-Bridge-Ignored). */
  headers?: Record<string, string>;
}

export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  readonly headers?: Record<string, string>;

  constructor(init: BridgeErrorInit) {
    super(init.message);
    this.name = "BridgeError";
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.headers = init.headers;
  }

  body(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      error: { message: this.message, type: "tab_bridge_error", code: this.code },
    };
    return body;
  }
}

/**
 * C7: typed error carrying the taxonomy code. Engines, adapters, and pools
 * throw TurnError with a stable `kind` instead of relying on caller-side
 * string matching of `Error.message`. mapTurnError() prefers TurnError;
 * legacy string-based matching is kept as a fallback so existing call sites
 * keep working during migration and until every thrower is converted.
 *
 * The `kind` values mirror the HTTP taxonomy in this file: `cf_challenge`,
 * `provider_rate_limited`, `server_busy`, `concurrency_blocked`, `not_ready`,
 * `submit_failed`, `timeout`, `dom_error`, `port_lost`, `prompt_too_large`,
 * `empty_prompt`, `bind_failed`.
 */
export type TurnErrorKind =
  | "cf_challenge"
  | "provider_rate_limited"
  | "server_busy"
  | "concurrency_blocked"
  | "not_ready"
  | "submit_failed"
  | "timeout"
  | "dom_error"
  | "port_lost"
  | "prompt_too_large"
  | "empty_prompt"
  | "bind_failed";

export class TurnError extends Error {
  readonly kind: TurnErrorKind;
  readonly retryAfterSec?: number;
  readonly detail?: string;
  readonly submitNoBubble?: boolean;
  constructor(
    kind: TurnErrorKind,
    opts: { message?: string; retryAfterSec?: number; detail?: string; submitNoBubble?: boolean } = {}
  ) {
    // Keep the legacy string shape in `message` so any code still doing
    // prefix matching continues to work: "turn-error:<kind>[:<detail>]".
    const detail = opts.detail !== undefined ? `:${opts.detail}` : "";
    super(opts.message ?? `turn-error:${kind}${detail}`);
    this.name = "TurnError";
    this.kind = kind;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
    if (opts.detail !== undefined) this.detail = opts.detail;
    if (opts.submitNoBubble !== undefined) this.submitNoBubble = opts.submitNoBubble;
  }
}

/**
 * C7: map a worker ERROR observation's `code` to a TurnErrorKind. The worker
 * observation union and the taxonomy are aligned by intent, but named
 * differently (e.g. `rate_limited` on the wire ↔ `provider_rate_limited` in
 * the taxonomy, to disambiguate from the facade's own rate-limit responses).
 */
export function kindForErrorCode(code: string | undefined): TurnErrorKind {
  switch (code) {
    case "rate_limited":
      return "provider_rate_limited";
    case "server_busy":
      return "server_busy";
    case "concurrency_blocked":
      return "concurrency_blocked";
    case "timeout":
      return "timeout";
    case "submit-failed":
      return "submit_failed";
    case "send-button-disabled":
      return "submit_failed";
    case "port-lost":
      return "port_lost";
    case "dom-error":
    default:
      return "dom_error";
  }
}

export function badRequest(message: string, headers?: Record<string, string>): BridgeError {
  return new BridgeError({ status: 400, code: "bad_request", message, headers });
}

export function unauthorized(message = "invalid bearer token"): BridgeError {
  return new BridgeError({ status: 401, code: "auth_failed", message });
}

export function notFound(message = "not found"): BridgeError {
  return new BridgeError({ status: 404, code: "not_found", message });
}

export function rateLimited(retryAfter: number, message: string): BridgeError {
  return new BridgeError({
    status: 429,
    code: "rate_limited",
    message,
    retryAfter,
  });
}

/** Provider overload ("Server busy, please try again later."). Distinct
 * from rate_limited: 503 (not 429) with a 10-minute Retry-After. */
export function serverBusy(retryAfter: number, message: string): BridgeError {
  return new BridgeError({
    status: 503,
    code: "server_busy",
    message,
    retryAfter,
  });
}

export function poolExhausted(retryAfter: number, message: string): BridgeError {
  return new BridgeError({ status: 503, code: "pool_exhausted", message, retryAfter });
}

export function queueFull(retryAfterSec: number, message: string): BridgeError {
  return new BridgeError({ status: 503, code: "queue_full", message, retryAfter: retryAfterSec });
}

export function queueTimeout(retryAfterSec: number, message: string): BridgeError {
  return new BridgeError({ status: 503, code: "queue_timeout", message, retryAfter: retryAfterSec });
}

/** 499 (nginx convention): the client closed the connection while its turn
 * was queued. Never reaches the wire — the response socket is already gone. */
export function clientGone(message: string): BridgeError {
  return new BridgeError({ status: 499, code: "client_gone", message });
}

export function badGateway(message: string): BridgeError {
  return new BridgeError({ status: 502, code: "upstream_failure", message });
}

export function internal(message: string): BridgeError {
  return new BridgeError({ status: 500, code: "internal", message });
}

/**
 * DeepSeek web enforces a per-account send-frequency window. Observed wire
 * shape (v0 complete SSE): `event: hint` with
 * `{type:"error", content:"Messages too frequent. Try again later.",
 *   finish_reason:"rate_limit_reached"}` followed by `event: close` with
 * `{click_behavior:"retry", auto_resume:false}`. Empirically the window is
 * ~20 minutes, so every 429 we emit carries that Retry-After.
 */
export const RATE_LIMIT_COOLDOWN_SEC = 1200;

/** A send refused because another generation is still running clears within
 * seconds-to-minutes (unlike the ~20-minute send-frequency window), so the
 * Retry-After for the defensive 429 is short. */
export const CONCURRENCY_RETRY_AFTER_SEC = 15;

/** Provider overload cooldown (10 minutes). The injector retries in-tab
 * with exponential backoff first; only a persistent overload surfaces here. */
export const SERVER_BUSY_COOLDOWN_SEC = 600;

/** Map adapter/worker failures onto the taxonomy. */
export function mapTurnError(err: unknown): BridgeError {
  // C7: a typed TurnError carries the taxonomy code directly; no string
  // matching needed. Fall through to the legacy prefix scanner below when
  // the error is not a TurnError (older throw sites, third-party errors).
  if (err instanceof TurnError) {
    switch (err.kind) {
      case "cf_challenge":
        return badGateway(`cloudflare challenge: ${err.detail ?? "cf-challenge"}`);
      case "provider_rate_limited":
        return rateLimited(
          err.retryAfterSec ?? RATE_LIMIT_COOLDOWN_SEC,
          `provider reports rate limiting (Messages too frequent); wait ~${Math.ceil(
            (err.retryAfterSec ?? RATE_LIMIT_COOLDOWN_SEC) / 60
          )} minutes before retrying`
        );
      case "server_busy":
        return serverBusy(
          err.retryAfterSec ?? SERVER_BUSY_COOLDOWN_SEC,
          `provider reports overload (Server busy, please try again later); wait ~${Math.ceil(
            (err.retryAfterSec ?? SERVER_BUSY_COOLDOWN_SEC) / 60
          )} minutes before retrying`
        );
      case "concurrency_blocked":
        return badGateway(
          `provider rejected the send: another message is still generating${err.detail ? ` (${err.detail})` : ""}`
        );
      case "not_ready":
        return badGateway(`tab not usable: ${err.detail ?? "not ready"}`);
      case "submit_failed":
        return new BridgeError({
          status: 400,
          code: "submit_failed",
          message: `submit failed: ${err.detail ?? "unknown"}`,
        });
      case "timeout":
        return badGateway(`provider timed out: ${err.detail ?? "turn exceeded deadline"}`);
      case "dom_error":
        return badGateway(`provider error: ${err.detail ?? "DOM error"}`);
      case "port_lost":
        return badGateway(`worker link lost: ${err.detail ?? "port-lost"}`);
      case "prompt_too_large":
        return badRequest(`prompt too large: ${err.detail ?? ""}`);
      case "empty_prompt":
        return badRequest("empty prompt");
      case "bind_failed": {
        const detail = err.detail ?? "";
        if (detail.includes("server-busy")) {
          return serverBusy(
            err.retryAfterSec ?? SERVER_BUSY_COOLDOWN_SEC,
            `every managed tab is cooling down from provider overload; wait ~${Math.ceil(
              (err.retryAfterSec ?? SERVER_BUSY_COOLDOWN_SEC) / 60
            )} minutes`
          );
        }
        if (detail.includes("rate-limited")) {
          return rateLimited(
            err.retryAfterSec ?? RATE_LIMIT_COOLDOWN_SEC,
            `every managed tab is cooling down from a provider rate limit; wait ~${Math.ceil(
              (err.retryAfterSec ?? RATE_LIMIT_COOLDOWN_SEC) / 60
            )} minutes`
          );
        }
        return poolExhausted(
          err.retryAfterSec ?? 20,
          `no worker tab available: ${detail || "pool exhausted"}`
        );
      }
      default: {
        const _exhaustive: never = err.kind;
        void _exhaustive;
        return badGateway(`turn error: ${(err as Error).message}`);
      }
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  const retryHint = /retry-after=(\d+)/.exec(msg);
  const retryAfterSec = retryHint ? Number(retryHint[1]) : RATE_LIMIT_COOLDOWN_SEC;
  if (msg === "cf-challenge") {
    return rateLimited(30, "Cloudflare challenge active on the provider tab");
  }
  if (
    msg === "provider-rate-limited" ||
    msg.startsWith("provider-rate-limited:") ||
    msg.startsWith("turn-error:rate_limited")
  ) {
    return rateLimited(
      retryAfterSec,
      `provider reports rate limiting (Messages too frequent); wait ~${Math.ceil(retryAfterSec / 60)} minutes before retrying`
    );
  }
  if (msg.startsWith("turn-error:server_busy")) {
    const busyHint = /retry-after=(\d+)/.exec(msg);
    const busyAfter = busyHint ? Number(busyHint[1]) : SERVER_BUSY_COOLDOWN_SEC;
    return serverBusy(
      busyAfter,
      `provider reports overload (Server busy, please try again later); wait ~${Math.ceil(busyAfter / 60)} minutes before retrying`
    );
  }
  // DeepSeek refuses a send while the account already has the maximum number
  // of concurrent generations running ("Another message is being generated").
  // The turn gate (src/core/turngate.ts) makes this unreachable for bridge
  // traffic; when it does surface anyway (a human driving the same account in
  // a parallel window), give callers a retryable 429 with a short window,
  // never a dead-end 502.
  if (msg.startsWith("turn-error:concurrency_blocked")) {
    return rateLimited(
      CONCURRENCY_RETRY_AFTER_SEC,
      "provider is already generating the maximum number of concurrent replies; retry shortly"
    );
  }
  if (
    /another\s+(?:message|response|reply|request|generation)|already\s+being\s+generated|正在生成|已有一条消息/i.test(
      msg
    )
  ) {
    return rateLimited(
      CONCURRENCY_RETRY_AFTER_SEC,
      `provider rejected the send: another message is still generating (${msg})`
    );
  }
  if (msg.startsWith("not-ready:server_busy") || msg.startsWith("not-ready:server-busy")) {
    return serverBusy(
      SERVER_BUSY_COOLDOWN_SEC,
      `managed tab is cooling down from provider overload; wait ~${Math.ceil(SERVER_BUSY_COOLDOWN_SEC / 60)} minutes`
    );
  }
  if (msg.startsWith("not-ready:") || msg.startsWith("reset failed")) {
    return badGateway(`tab not usable: ${msg}`);
  }
  if (msg.startsWith("submit-failed")) return badGateway(`composer submit failed: ${msg}`);
  if (msg.startsWith("timeout")) return badGateway(`tab turn failed: ${msg}`);
  if (msg.startsWith("dom-error")) return badGateway(`DOM automation error: ${msg}`);
  if (msg.startsWith("port-lost")) return badGateway("tab port lost mid-turn");
  if (msg.startsWith("prompt-too-large")) return badRequest(`prompt exceeds adapter limit (${msg})`);
  if (msg === "empty-prompt") {
    return badRequest("compiled prompt is empty (message content resolved to no text)");
  }

  if (msg.startsWith("bind-failed")) {
    const detail = msg.slice("bind-failed:".length).trim();
    if (detail.includes("server-busy")) {
      return serverBusy(
        retryHint ? Number(retryHint[1]) : SERVER_BUSY_COOLDOWN_SEC,
        `every managed tab is cooling down from provider overload; wait ~${Math.ceil((retryHint ? Number(retryHint[1]) : SERVER_BUSY_COOLDOWN_SEC) / 60)} minutes`
      );
    }
    if (detail.includes("rate-limited")) {
      return rateLimited(
        retryAfterSec,
        `every managed tab is cooling down from a provider rate limit; wait ~${Math.ceil(retryAfterSec / 60)} minutes`
      );
    }
    if (detail.includes("no-tab") || detail.includes("exhaust")) {
      return poolExhausted(5, `no allocatable tab: ${detail}`);
    }
    return badGateway(`tab bind failed: ${detail}`);
  }
  if (msg === "no-worker-link" || msg.startsWith("worker link lost")) {
    return poolExhausted(5, "no extension worker connected to the bridge");
  }
  if (msg.startsWith("turn-error")) {
    if (msg.includes("timeout")) return badGateway(`tab turn failed: ${msg}`);
    if (msg.includes("send-button-disabled")) {
      return badGateway(
        `composer never became sendable: ${msg} (large prompts convert to a file attachment and the send button stays disabled until processing finishes)`
      );
    }
    return badGateway(`tab error: ${msg}`);
  }
  return internal(msg);
}
