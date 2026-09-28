/**
 * Turn classifier (spec 5.2): every request terminates in exactly one of four
 * plans. Deterministic and total; pure logic over (row, incomingMessages).
 */
import type { ChatMessage } from "./canonical.js";
import { canonical, stripSystemPrefix, textOf } from "./canonical.js";
import { firstMismatch, hashCanonical, CHAIN_SCHEME } from "./hashchain.js";

export type PlanName = "SEED" | "INJECT_TEXT" | "INJECT_RESULTS" | "RESET_RESEED";

export interface TurnPlan {
  plan: PlanName;
  reason: string;
  /** INJECT_TEXT: the single new user message. */
  injectText?: string;
  /** INJECT_RESULTS: tool results to render (assistant echo is skipped). */
  injectResults?: ChatMessage[];
}

export interface ClassifierRow {
  hasRow: boolean;
  scheme: number | null;
  mode: "stateful" | "always-reset";
  chain: readonly string[];
  tabHash: string | null;
  /** A previous turn failed post-submission: inject plans are unsafe. */
  pendingReset?: boolean;
}

function hasToolCalls(m: ChatMessage): boolean {
  return m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

/** Hash of a single message under scheme v1 (position-free form for tabHash). */
export function messageHash(msg: ChatMessage): string {
  return hashCanonical(null, canonical(msg));
}

export function classify(row: ClassifierRow, messages: readonly ChatMessage[]): TurnPlan {
  const base = classifyBase(row, messages);
  // A failed post-submission turn may have left an orphan user message in the
  // tab. Any continuation plan (INJECT_*) would append after that orphan, so
  // force a full reset+reseed. SEED stays SEED (engine resets it when needed).
  if (row.pendingReset && base.plan !== "SEED") {
    return { plan: "RESET_RESEED", reason: `pending-reset(${base.reason})` };
  }
  return base;
}

function classifyBase(row: ClassifierRow, messages: readonly ChatMessage[]): TurnPlan {
  // Continuity starts after an optional leading system message (spec 5.1 /
  // scheme v3): clients re-render system context every turn, so it is
  // verified nowhere and injected nowhere — only user/assistant/tool deltas
  // drive plans.
  messages = stripSystemPrefix(messages);
  // -- trivial leaves -------------------------------------------------------
  if (!row.hasRow) return { plan: "SEED", reason: "no-session-row" };
  if (row.scheme !== CHAIN_SCHEME) return { plan: "SEED", reason: "scheme-mismatch" };
  if (row.mode === "always-reset") return { plan: "SEED", reason: "stateless-mode" };
  // Empty chain = nothing the tab has been told yet: always seed.
  if (row.chain.length === 0) return { plan: "SEED", reason: "empty-chain" };

  const n = row.chain.length;
  const m = messages.length;

  // Prefix verification with early exit.
  const mismatch = firstMismatch(row.chain, messages);
  if (mismatch !== -1) {
    return { plan: "RESET_RESEED", reason: `divergence-at-${mismatch}` };
  }

  if (m === n) {
    return { plan: "RESET_RESEED", reason: "regeneration" };
  }
  if (m < n) {
    return { plan: "RESET_RESEED", reason: "truncated-history" };
  }

  const delta = messages.slice(n);

  // Fast path 1: exactly one new user message.
  if (delta.length === 1 && delta[0].role === "user") {
    const text = textOf(delta[0].content);
    if (text.length === 0) {
      return { plan: "RESET_RESEED", reason: "empty-user-delta" };
    }
    return {
      plan: "INJECT_TEXT",
      reason: "single-user-delta",
      injectText: text,
    };
  }

  // Fast path 2: the tool-round shape — assistant(tool_calls) matching the
  // tab's own last output, followed by one or more tool results.
  if (delta.length >= 2 && hasToolCalls(delta[0])) {
    const head = delta[0];
    const headMatchesTab = row.tabHash !== null && messageHash(head) === row.tabHash;
    if (!headMatchesTab) {
      return { plan: "RESET_RESEED", reason: "fabricated-assistant-echo" };
    }
    const rest = delta.slice(1);
    const allTools = rest.every((r) => r.role === "tool");
    if (allTools) {
      return {
        plan: "INJECT_RESULTS",
        reason: "tool-round-delta",
        injectResults: rest,
      };
    }
    // Optional trailing fabricated assistant inside the delta forces a reseed.
    const last = rest[rest.length - 1];
    const middleTools = rest.slice(0, -1).every((r) => r.role === "tool");
    if (middleTools && last.role === "assistant") {
      return { plan: "RESET_RESEED", reason: "fabricated-trailing-assistant" };
    }
    return { plan: "RESET_RESEED", reason: "mixed-delta-shape" };
  }

  // Fast path 3: text-echo continuation — the delta starts with a plain-text
  // assistant message followed by exactly one new user message. The echo is
  // skipped; only the user text is injected. Unlike tool echoes, the text is
  // NOT verified against tabHash: the tab is append-only ground truth, so
  // appending user text is coherent even when the client's echo copy differs
  // (reworded/stale transcript, compaction). The strict check only guards
  // tool calls, where misattachment corrupts semantics.
  if (
    delta.length === 2 &&
    delta[0].role === "assistant" &&
    !hasToolCalls(delta[0]) &&
    delta[1].role === "user"
  ) {
    const text = textOf(delta[1].content);
    if (text.length === 0) {
      return { plan: "RESET_RESEED", reason: "empty-user-delta" };
    }
    return {
      plan: "INJECT_TEXT",
      reason: "echo-skip-user-delta",
      injectText: text,
    };
  }

  return { plan: "RESET_RESEED", reason: "unsupported-delta-shape" };
}
