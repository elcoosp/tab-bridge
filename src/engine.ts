/**
 * Turn engine (Chapters 5-6 orchestration): classify -> execute plan ->
 * stream with holdback -> optional repair -> commit chain + tabHash.
 * Pure with respect to the adapter: contract tests drive it via ScriptedAdapter.
 */
import type { ChatMessage, ToolCall } from "./core/canonical.js";
import { normalizeMessages, canonical } from "./core/canonical.js";
import { foldAll, hashCanonical } from "./core/hashchain.js";
import { messageHash, classify, type PlanName } from "./core/classifier.js";
import type { SessionRegistry, SessionRow } from "./core/registry.js";
import { validateArgs } from "./emulation/parser.js";
import {
  compileSeed,
  compileRegenerate,
  compileInjectResults,
  compileInjectText,
  compileRepair,
} from "./emulation/compiler.js";
import { HoldbackBuffer } from "./emulation/holdback.js";
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
  /** Binds a session to a managed tab (pool-backed deployments). */
  bindTab: (sessionId: string, timeoutMs: number) => Promise<number>;
}

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
}

/** Validate a holdback call event against the declared tools. */
export function validateCallEvent(
  name: string,
  argsJson: string,
  tools: ToolSpec[],
  suppliedId?: string
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
      id: suppliedId ?? synthCallId(name, JSON.stringify(argsObj)),
      errors: [],
    },
  };
}

function tabOf(tabId: number): ManagedTab {
  return { tabId, state: "ready" };
}

async function ensureTabAndReady(req: TurnRequest, row: SessionRow): Promise<ManagedTab> {
  if (row.tabId === null) {
    row.tabId = await req.bindTab(row.sessionId, req.bindTimeoutMs);
  }
  const ready = await req.adapter.ensureReady(tabOf(row.tabId), req.bindTimeoutMs);
  if (!ready.ok) {
    const detail = ready.detail ?? "not-ready";
    if (detail === "cf_challenge") throw new Error("cf-challenge");
    if (detail === "rate_limited") throw new Error("provider-rate-limited");
    if (detail === "tab-not-known-to-worker") {
      // Tab died while we held the row: re-bind once, then re-check.
      row.tabId = await req.bindTab(row.sessionId, req.bindTimeoutMs);
      const again = await req.adapter.ensureReady(tabOf(row.tabId), req.bindTimeoutMs);
      if (!again.ok) throw new Error(`not-ready:${again.detail ?? "unknown"}`);
    } else {
      throw new Error(`not-ready:${detail}`);
    }
  }
  return tabOf(row.tabId as number);
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
async function observePass(
  req: TurnRequest,
  tab: ManagedTab,
  events: TurnEvents,
  tools: ToolSpec[]
): Promise<{ text: string; calls: ParsedCall[]; invalidText: string[]; passWarnings: string[]; stopReason: string }> {
  const holdback = new HoldbackBuffer();
  const calls: ParsedCall[] = [];
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
      const v = validateCallEvent(ev.name, ev.argsJson, tools, ev.id);
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

  // ---- tab + readiness ----------------------------------------------------
  const tab = await ensureTabAndReady(req, row);

  // ---- execute plan -------------------------------------------------------
  // Any failure from here on happened after the tab was addressed: the tab may
  // hold an orphan user message (rate limits accept-then-error on DeepSeek).
  // Mark the row so the next turn resets instead of injecting blindly.
  try {
    let promptText: string;
    if (plan.plan === "SEED") {
      if (row.chain.length > 0 || row.pendingReset) await resetOrThrow(req.adapter, tab);
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

    await req.adapter.sendTurn(tab, promptText, optionsFor(req));

    // ---- observe (stream with holdback) -------------------------------------
    events.onStatus?.("submitting");
    const first = await observePass(req, tab, events, tools);

    let text = first.text;
    let calls = first.calls;
    const warnings = [...first.passWarnings];
    let repairsUsed = 0;
    let stopReason = first.stopReason;

    // ---- repair round (ADR-5, spec 6.4) --------------------------------------
    if (calls.length === 0 && tools.length > 0 && warnings.length > 0 && req.repairRounds > 0) {
      repairsUsed += 1;
      log.audit("turn.repair", { sessionId: row.sessionId, round: repairsUsed, warnings });
      const repairText = compileRepair(first.invalidText.join("") || first.text, warnings[0]);
      await req.adapter.sendTurn(tab, repairText, optionsFor(req));
      const second = await observePass(req, tab, events, tools);
      text += second.text;
      stopReason = second.stopReason;
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
    const promptTokens = Math.ceil(promptText.length / 4);
    const completionTokens = Math.ceil(text.length / 4) || 0;

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
    const outputHash = text || calls.length > 0 ? messageHash(emitted) : null;
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

    return {
      content: text,
      calls,
      warnings,
      finish,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      plan: plan.plan,
      sessionId: row.sessionId,
      promptChars: promptText.length,
      repairRoundsUsed: repairsUsed,
    };
  } catch (e) {
    req.registry.markFailed(row);
    log.audit("turn.failed", {
      sessionId: row.sessionId,
      plan: plan.plan,
      error: e instanceof Error ? e.message : String(e),
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
  const out = [...storedChain];
  let head: string | null = storedChain.length > 0 ? storedChain[storedChain.length - 1] : null;
  for (let i = storedLen; i < messages.length; i++) {
    head = hashCanonical(head, canonical(messages[i]));
    out.push(head);
  }
  return out;
}

