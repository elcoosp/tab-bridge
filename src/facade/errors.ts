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

export function badRequest(message: string, headers?: Record<string, string>): BridgeError {
  return new BridgeError({ status: 400, code: "bad_request", message, headers });
}

export function unauthorized(message = "invalid bearer token"): BridgeError {
  return new BridgeError({ status: 401, code: "auth_failed", message });
}

export function notFound(message = "not found"): BridgeError {
  return new BridgeError({ status: 404, code: "not_found", message });
}

export function conflict(message: string): BridgeError {
  return new BridgeError({ status: 409, code: "session_busy", message });
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
