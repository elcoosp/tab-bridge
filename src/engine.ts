/**
 * Turn engine (Chapters 5-6 orchestration): classify -> execute plan ->
 * stream with holdback -> optional repair -> commit chain + tabHash.
 * Pure with respect to the adapter: contract tests drive it via ScriptedAdapter.
 */
import type { ChatMessage, ToolCall } from "./core/canonical.js";
import { normalizeMessages, canonical, stripSystemPrefix } from "./core/canonical.js";
import { foldAll, hashCanonical } from "./core/hashchain.js";
import { messageHash, classify, type PlanName } from "./core/classifier.js";
import type { SessionRegistry, SessionRow } from "./core/registry.js";
import { isChatUrl } from "./core/registry.js";
import { validateArgs } from "./emulation/parser.js";
import {
  compileSeed,
  compileRegenerate,
  compileInjectResults,
  compileInjectText,
  compileRepair,
} from "./emulation/compiler.js";
import { HoldbackBuffer } from "./emulation/holdback.js";
import { HOLDBACK_CEILING } from "./emulation/types.js";
import type { ParsedCall, ToolSpec } from "./emulation/types.js";
import { synthCallId } from "./emulation/ids.js";
import { canonJson } from "./util/json.js";
import type { ChatProviderAdapter, ManagedTab, TurnOptions } from "./adapter/types.js";
import { log } from "./log.js";

export interface TurnRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  think: boolean;
  /** Resolved session row (already created by the facade). */
  row: SessionRow;
  registry: SessionRegistry;
  adapter: ChatProviderAdapter;
  repairRounds: number;
  turnTimeoutMs: number;
  bindTimeoutMs: number;
  /** Holdback ceiling override (0/unset = library default). */
  holdbackCeiling?: number;
  /** Binds a session to a managed tab (pool-backed deployments). May return
   * the tab id or the full bind observation (carries worker dirty flag).
   * The optional hint carries the session's remembered provider chat URL so
   * an evicted session can relaunch straight into its own conversation. */
  bindTab: (
    sessionId: string,
    timeoutMs: number,
    opts?: { chatUrl?: string | null }
  ) => Promise<number | { tabId: number; dirty?: boolean }>;
  /** WS-D: SEED-into-dirty-tab policy. auto = reset when the worker reports
   * the tab dirty (default); always = reset on every SEED; never = legacy. */
  resetOnSeed?: "auto" | "always" | "never";
}

export type ResetOnSeed = "auto" | "always" | "never";

export interface TurnEvents {
  onContent?(text: string): void;
  onCall?(call: ParsedCall): void;
  onStatus?(code: "submitting" | "streaming" | "done" | "aborted"): void;
  onPlan?(plan: PlanName, reason: string): void;
}

export interface TurnOutput {
  content: string;
  calls: ParsedCall[];
  warnings: string[];
  finish: "stop" | "tool_calls" | "length";
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  plan: PlanName;
  sessionId: string;
  promptChars: number;
  repairRoundsUsed: number;
  /** Ms the turn spent waiting in the generation gate before starting.
   * Present only when it actually waited (> 0). Surfaced as the
   * x-bridge-queued-ms response header on the JSON path. */
  gateWaitMs?: number;
}

/** Validate a holdback call event against the declared tools. */
export function validateCallEvent(
  name: string,
  argsJson: string,
  tools: ToolSpec[],
  suppliedId?: string,
  occurrence = 0
): { ok: true; call: ParsedCall } | { ok: false; error: string } {
  const spec = tools.find((t) => t.function.name === name);
  if (!spec) return { ok: false, error: `unknown tool "${name}"` };
  let argsObj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsJson || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "arguments must be a JSON object" };
    }
    argsObj = parsed as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `malformed JSON arguments: ${(e as Error).message}` };
  }
  const errors = validateArgs(spec, argsObj);
  if (errors.length > 0) return { ok: false, error: `${name}: ${errors.join("; ")}` };
  const canonicalArgs = canonJson(argsObj);
  return {
    ok: true,
    call: {
      name,
      arguments: canonicalArgs,
      id: suppliedId ?? synthCallId(name, JSON.stringify(argsObj), occurrence),
      errors: [],
    },
  };
}

function tabOf(tabId: number, dirty?: boolean): ManagedTab {
  return dirty === true ? { tabId, state: "ready", dirty: true } : { tabId, state: "ready" };
}

/**
 * Compact one-line-per-message shape summary for mismatch diagnosis
 * (TAB_BRIDGE_DEBUG only): role, content length + head, and per call
 * name/args-length/id-presence. Never logs full text.
 */
export function summarizeMessages(messages: readonly ChatMessage[]): string {
  return messages
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const head = (text ?? "").slice(0, 40).replace(/\s+/g, " ");
      const calls = Array.isArray(m.tool_calls)
        ? m.tool_calls
            .map(
              (c) =>
                `${c.function.name}(argsLen=${(c.function.arguments || "").length},id=${typeof c.id === "string" ? c.id.slice(0, 12) : "∅"})`
            )
            .join(";")
        : "";
      return `${m.role}[len=${(text ?? "").length},head=${JSON.stringify(head)}]${calls ? `{${calls}}` : ""}`;
    })
    .join(" | ");
}

async function ensureTabAndReady(req: TurnRequest, row: SessionRow): Promise<ManagedTab> {
  let dirty = false;
  // Relaunch hint: sessions that survived eviction/TTL in the journal carry
  // their provider chat URL. The worker navigates the fresh tab straight
  // there, so the turn below can continue instead of a full reseed.
  const bindOpts =
    typeof row.chatUrl === "string" && row.chatUrl.length > 0 ? { chatUrl: row.chatUrl } : undefined;
  const takeBind = (bound: number | { tabId: number; dirty?: boolean }): number => {
    if (typeof bound === "number") return bound;
    if (bound.dirty === true) dirty = true;
    return bound.tabId;
  };
  if (row.tabId === null) {
    row.tabId = takeBind(await req.bindTab(row.sessionId, req.bindTimeoutMs, bindOpts));
  }
  const ready = await req.adapter.ensureReady(tabOf(row.tabId), req.bindTimeoutMs);
  if (!ready.ok) {
    const detail = ready.detail ?? "not-ready";
    if (detail === "cf_challenge") throw new Error("cf-challenge");
    if (detail === "rate_limited") throw new Error("provider-rate-limited");
    if (detail === "tab-not-known-to-worker") {
      // Tab died while we held the row: re-bind once, then re-check.
      // A re-bind lands on some (possibly dirty) tab — track it as above.
      // The chat-URL hint travels here too: a recycled tab relaunches into
      // the session's own conversation when the provider still has it.
      row.tabId = takeBind(await req.bindTab(row.sessionId, req.bindTimeoutMs, bindOpts));
      const again = await req.adapter.ensureReady(tabOf(row.tabId), req.bindTimeoutMs);
      if (!again.ok) throw new Error(`not-ready:${again.detail ?? "unknown"}`);
    } else {
      throw new Error(`not-ready:${detail}`);
    }
  }
  return tabOf(row.tabId as number, dirty);
}

async function resetOrThrow(adapter: ChatProviderAdapter, tab: ManagedTab): Promise<void> {
  const outcome = await adapter.resetConversation(tab);
  if (outcome !== "ok") throw new Error(`reset failed: ${outcome}`);
}

function optionsFor(req: TurnRequest): TurnOptions {
  return { timeoutMs: req.turnTimeoutMs, think: req.think };
}

/**
 * Run one streamed observation pass: pump adapter fragments through the
 * holdback buffer, emitting content/call events. Returns the pass result.
 */
/**
 * v1.2.56 — extract a provider-reported total-token count from an adapter's
 * usageMeta bag. The deepseek adapter surfaces `{ total_tokens }` when the
 * worker's USAGE observation arrived before STATUS done; anything else
 * (unknown shape, negative/zero, non-number) returns undefined so the
 * estimate path stays authoritative.
 */
function readTotalTokens(meta: Record<string, unknown> | undefined): number | undefined {
  if (!meta) return undefined;
  const v = meta.total_tokens;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.floor(v);
}

/** Extract a validated provider chat URL from an adapter usageMeta bag. */
function readChatUrl(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const v = meta.chat_url;
  return isChatUrl(v) ? v : undefined;
}

async function observePass(
  req: TurnRequest,
  tab: ManagedTab,
  events: TurnEvents,
  tools: ToolSpec[]
): Promise<{ text: string; calls: ParsedCall[]; invalidText: string[]; passWarnings: string[]; stopReason: string; usageMeta?: Record<string, unknown> }> {
  const holdback = new HoldbackBuffer(req.holdbackCeiling ?? HOLDBACK_CEILING);
  const calls: ParsedCall[] = [];
  const callOccurrence = new Map<string, number>();
  const nextOccurrence = (name: string, argsJson: string): number => {
    const key = `${name}\u0000${argsJson}`;
    const n = callOccurrence.get(key) ?? 0;
    callOccurrence.set(key, n + 1);
    return n;
  };
  const invalidText: string[] = [];
  const passWarnings: string[] = [];
  let text = "";

  const emitEvent = (ev: ReturnType<HoldbackBuffer["push"]>[number]) => {
    if (ev.type === "content") {
      text += ev.text;
      events.onContent?.(ev.text);
    } else if (ev.type === "invalid") {
      // Spec 6.3: a fence that fails to parse flushes as content.
      text += ev.text;
      invalidText.push(ev.text);
      passWarnings.push(ev.error);
      events.onContent?.(ev.text);
    } else {
      const v = validateCallEvent(
        ev.name,
        ev.argsJson,
        tools,
        ev.id,
        ev.id === undefined ? nextOccurrence(ev.name, ev.argsJson) : 0
      );
      if (v.ok) {
        calls.push(v.call);
        events.onCall?.(v.call);
      } else {
        const flushed = `\n\`\`\`tool_call\n{"name": ${JSON.stringify(ev.name)}, "arguments": ${ev.argsJson}}\n\`\`\`\n`;
        text += flushed;
        invalidText.push(flushed);
        passWarnings.push(v.error);
        events.onContent?.(flushed);
      }
    }
  };

  const result = await req.adapter.streamResponse(tab, {
    onFragment: (frag) => {
      for (const ev of holdback.push(frag)) emitEvent(ev);
    },
    onStatus: (code) => events.onStatus?.(code),
  });

  for (const ev of holdback.finish()) emitEvent(ev);

  return {
    text,
    calls,
    invalidText,
    passWarnings,
    stopReason: result.stopReason,
    ...(result.usageMeta !== undefined ? { usageMeta: result.usageMeta } : {}),
  };
}

export async function runTurn(req: TurnRequest, events: TurnEvents = {}): Promise<TurnOutput> {
  const { row, registry } = req;
  const messages = normalizeMessages(req.messages);
  const tools = req.tools;

  // ---- classify -----------------------------------------------------------
  const plan = classify(
    {
      hasRow: true,
      scheme: row.scheme,
      mode: registry.mode,
      chain: row.chain,
      tabHash: row.tabHash,
      pendingReset: row.pendingReset,
    },
    messages
  );
  events.onPlan?.(plan.plan, plan.reason);
  log.audit("turn.plan", {
    sessionId: row.sessionId,
    plan: plan.plan,
    reason: plan.reason,
    mode: registry.mode,
    historyLen: messages.length,
    chainLen: row.chain.length,
  });
  if (
    process.env.TAB_BRIDGE_DEBUG &&
    (/^divergence|^fabricated/.test(plan.reason) || plan.plan === "RESET_RESEED")
  ) {
    const histForRoles = stripSystemPrefix(messages);
    log.info("turn.shapes", {
      sessionId: row.sessionId,
      reason: plan.reason,
      chainLen: row.chain.length,
      tabHash: row.tabHash,
      deltaRoles: histForRoles.slice(row.chain.length, row.chain.length + 6).map((m) => m.role),
      shapes: summarizeMessages(messages).slice(0, 2000),
    });
  }

  // ---- tab + readiness ----------------------------------------------------
  // Failures here (bind timeout, worker down during readiness) never touch
  // the tab: no prompt was placed, no navigation issued. They must NOT mark
  // the row — otherwise every outage poisons the session and forces resets
  // forever after (pending-reset storm).
  let tab: ManagedTab;
  try {
    tab = await ensureTabAndReady(req, row);
  } catch (e) {
    log.audit("turn.failed", {
      sessionId: row.sessionId,
      plan: plan.plan,
      error: e instanceof Error ? e.message : String(e),
      phase: "bind-ready",
    });
    throw e;
  }
  log.info("turn.tab", { sessionId: row.sessionId, tabId: tab.tabId });

  // ---- execute plan -------------------------------------------------------
  // Any failure from here on happened after the tab was addressed: the tab may
  // hold an orphan user message (rate limits accept-then-error on DeepSeek).
  // Mark the row so the next turn resets instead of injecting blindly.
  try {
    let promptText: string;
    if (plan.plan === "SEED") {
      // WS-D: never SEED into a dirty tab. A fresh row (empty chain) reuses
      // whatever conversation the physical tab still shows; the worker flags
      // such tabs dirty (completed turn since reset, or unknown after MV3
      // restart), and we reset before seeding. Fresh tabs report clean → no
      // extra reset on the common path.
      const policy = req.resetOnSeed ?? "auto";
      const needReset =
        row.chain.length > 0 ||
        row.pendingReset ||
        policy === "always" ||
        (policy === "auto" && tab.dirty === true);
      if (needReset) await resetOrThrow(req.adapter, tab);
      promptText = compileSeed(messages, tools);
    } else if (plan.plan === "RESET_RESEED") {
      await resetOrThrow(req.adapter, tab);
      promptText =
        plan.reason === "regeneration" ? compileRegenerate(messages, tools) : compileSeed(messages, tools);
    } else if (plan.plan === "INJECT_TEXT") {
      promptText = compileInjectText(plan.injectText ?? "");
    } else {
      promptText = compileInjectResults(plan.injectResults ?? []);
    }

    // Composer limit is part of the adapter contract (spec 7.1): refuse early.
    const maxChars = req.adapter.capabilities().maxPromptChars;
    if (promptText.length > maxChars) {
      throw new Error(`prompt-too-large:${promptText.length}>${maxChars}`);
    }

    // A fully empty compiled prompt would submit nothing (or an empty
    // bubble) into the tab. Fail with a typed, caller-actionable error.
    if (promptText.trim().length === 0) {
      throw new Error("empty-prompt");
    }

    await req.adapter.sendTurn(tab, promptText, optionsFor(req));
    log.info("turn.accepted", { sessionId: row.sessionId, promptChars: promptText.length });

    // ---- observe (stream with holdback) -------------------------------------
    events.onStatus?.("submitting");
    const first = await observePass(req, tab, events, tools);

    let text = first.text;
    let calls = first.calls;
    const warnings = [...first.passWarnings];
    let repairsUsed = 0;
    let stopReason = first.stopReason;
    // v1.2.56: provider-reported total_tokens, summed across repair rounds.
    let usageTotalTokens: number | undefined = readTotalTokens(first.usageMeta);
    // Session↔chat-URL mapping: remember the provider conversation URL the
    // moment the worker reports it, so post-eviction BINDs can relaunch it.
    const firstChatUrl = readChatUrl(first.usageMeta);
    if (firstChatUrl) registry.noteChatUrl(row, firstChatUrl);

    // ---- repair round (ADR-5, spec 6.4) --------------------------------------
    if (calls.length === 0 && tools.length > 0 && warnings.length > 0 && req.repairRounds > 0) {
      repairsUsed += 1;
      log.audit("turn.repair", { sessionId: row.sessionId, round: repairsUsed, warnings });
      const repairText = compileRepair(first.invalidText.join("") || first.text, warnings[0]);
      await req.adapter.sendTurn(tab, repairText, optionsFor(req));
      const second = await observePass(req, tab, events, tools);
      text += second.text;
      stopReason = second.stopReason;
      const secondTotal = readTotalTokens(second.usageMeta);
      if (secondTotal !== undefined) {
        usageTotalTokens = (usageTotalTokens ?? 0) + secondTotal;
      }
      if (second.calls.length > 0) {
        calls = second.calls;
        warnings.push("recovered after repair round");
      } else {
        warnings.push(...second.passWarnings);
        warnings.push("repair round exhausted; returning text completion");
      }
    }

    const finish: TurnOutput["finish"] =
      calls.length > 0 ? "tool_calls" : stopReason === "length" ? "length" : "stop";

    // ---- usage ---------------------------------------------------------------
    // v1.2.56: provider-reported token totals. total_tokens comes from
    // DeepSeek's accumulated_token_usage delta when available (real,
    // includes thinking); prompt is our chars/4 estimate; completion is
    // derived so prompt + completion === total. Fallback to the all-
    // estimate shape when no provider total was captured.
    const promptEstimate = Math.ceil(promptText.length / 4);
    const completionEstimate = Math.ceil(text.length / 4) || 0;
    let promptTokens = promptEstimate;
    let completionTokens = completionEstimate;
    let totalTokens = promptEstimate + completionEstimate;
    if (usageTotalTokens !== undefined && usageTotalTokens > 0) {
      totalTokens = usageTotalTokens;
      if (promptEstimate >= totalTokens) {
        promptTokens = totalTokens;
        completionTokens = 0;
      } else {
        promptTokens = promptEstimate;
        completionTokens = totalTokens - promptEstimate;
      }
    }

    // ---- commit chain + tabHash (spec 5.1/5.2) -------------------------------
    const chain =
      plan.plan === "SEED" || plan.plan === "RESET_RESEED"
        ? foldAll(messages)
        : foldDelta(row.chain, messages, row.chain.length);

    // The tab has now spoken: record the hash of the assistant message it produced.
    const emitted: ChatMessage = {
      role: "assistant",
      ...(text ? { content: text } : { content: null }),
      ...(calls.length > 0
        ? {
            tool_calls: calls.map(
              (c): ToolCall => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })
            ),
          }
        : {}),
    };
    // C11: always hash the emitted assistant message, even when text is
    // empty and no tool calls were made. Committing tabHash=null on an
    // empty-but-successful turn makes the NEXT tool round fail the
    // "assistant echo matches tabHash" check → fabricated-assistant-echo →
    // forced full RESEED for what was merely an empty turn. The chain
    // already folds the empty assistant message (`A|`), so this aligns
    // tabHash with the chain's own view of the tab's output.
    const outputHash = messageHash(emitted);
    registry.commit(row, chain, outputHash);

    log.audit("turn.commit", {
      sessionId: row.sessionId,
      plan: plan.plan,
      turns: row.turns,
      chainLen: chain.length,
      tabHash: outputHash,
      calls: calls.length,
      repairs: repairsUsed,
    });
    if (process.env.TAB_BRIDGE_DEBUG) {
      log.info("turn.emitted", {
        sessionId: row.sessionId,
        shapes: summarizeMessages([emitted]).slice(0, 1000),
      });
    }

    return {
      content: text,
      calls,
      warnings,
      finish,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      plan: plan.plan,
      sessionId: row.sessionId,
      promptChars: promptText.length,
      repairRoundsUsed: repairsUsed,
    };
  } catch (e) {
    // A submit that never placed a user bubble leaves the tab state
    // untouched. Marking the row failed here would set pendingReset and
    // null tabHash, forcing a full RESET_RESEED on the very next turn
    // (RCA stage 2 — the poisoned-session loop).
    const err = e as Error & { userBubbleRendered?: boolean; postSubmit?: boolean; chatUrl?: unknown };
    // The chat URL may have been created before the failure (first message
    // accepted, reply errored): still learn it for the next relaunch.
    if (isChatUrl(err.chatUrl)) registry.noteChatUrl(row, err.chatUrl);
    const submitNoBubble = err.userBubbleRendered === false;
    if (!submitNoBubble) {
      req.registry.markFailed(row);
      // Tag the error so the facade can distinguish post-submission
      // failures (tab state unknown) from bind/readiness failures (tab
      // untouched — dropping tabHash here would force needless reseeds).
      err.postSubmit = true;
    }
    log.audit("turn.failed", {
      sessionId: row.sessionId,
      plan: plan.plan,
      error: err.message || String(e),
      ...(submitNoBubble ? { submit_no_bubble: true } : {}),
    });
    throw e;
  }
}

/** Extend the stored chain with hashes of messages[storedLen..]. */
function foldDelta(
  storedChain: readonly string[],
  messages: readonly ChatMessage[],
  storedLen: number
): string[] {
  const hist = stripSystemPrefix(messages);
  const out = [...storedChain];
  let head: string | null = storedChain.length > 0 ? storedChain[storedChain.length - 1] : null;
  for (let i = storedLen; i < hist.length; i++) {
    head = hashCanonical(head, canonical(hist[i]));
    out.push(head);
  }
  return out;
}

