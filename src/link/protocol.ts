/**
 * Bridge<->worker message protocol (spec 7.3): intents and observations.
 * Adapter-agnostic; versioned; correlated by reqId / sessionId.
 * Protocol v1 — the observation table plus FRAGMENT resync support.
 */
export const WORKER_PROTOCOL = 1;

export type WorkerIntent =
  | { t: "HELLO"; v: number; ext: string; caps?: Record<string, unknown>; extVersion?: string; instance?: string }
  | { t: "BIND"; sessionId: string }
  | { t: "SEND"; reqId: string; text: string; opts: { timeoutMs: number; think: boolean }; tabId?: number }
  | { t: "RESET"; reqId: string; tabId?: number }
  | { t: "ABORT"; reqId: string }
  | { t: "PING"; seq: number }
  | { t: "RELEASE"; sessionId: string };

export type WorkerObservation =
  | { t: "HELLO"; v: number; ext: string; caps?: Record<string, unknown>; extVersion?: string; instance?: string }
  | { t: "HELLO_OK"; v: number; config: { autoCreateTabs: boolean; managedOnly: boolean; warmTabs: number } }
  | { t: "HELLO_REFUSED"; reason: string }
  | { t: "BOUND"; sessionId: string; tabId: number; state: string }
  | { t: "BIND_FAILED"; sessionId: string; code: string; detail?: string; retryAfterSec?: number }
  | { t: "ACCEPTED"; reqId: string }
  | { t: "FRAGMENT"; reqId: string; seq: number; text: string; full?: boolean }
  | { t: "STATUS"; reqId: string; code: "submitting" | "streaming" | "done" | "aborted" }
  | { t: "USAGE"; reqId: string; meta: Record<string, unknown> }
  | { t: "HEALTH"; tabId: number; state: string; detail?: string }
  | {
      t: "ERROR";
      reqId: string;
      code:
        | "submit-failed"
        | "port-lost"
        | "timeout"
        | "dom-error"
        | "rate_limited"
        | "send-button-disabled"
        | "concurrency_blocked";
      detail?: string;
      /** Suggested cooldown seconds (rate_limited carries ~1200s / 20 min). */
      retryAfterSec?: number;
      /** For submit-phase failures: whether a user bubble actually rendered.
       * false means the tab state is untouched — the bridge must not
       * pendingReset / null tabHash (RCA stage 2). */
      userBubbleRendered?: boolean;
    }
  | { t: "RESET_OK"; reqId: string }
  | { t: "RESET_TIMEOUT"; reqId: string }
  | { t: "PONG"; seq: number; tabs?: Array<{ tabId: number; state: string; health: string }> }
  | { t: "RELEASED"; sessionId: string };

export function parseWorkerMessage(raw: string): WorkerObservation | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.t !== "string") return null;
  return obj as unknown as WorkerObservation;
}

export function encodeIntent(i: WorkerIntent): string {
  return JSON.stringify(i);
}
