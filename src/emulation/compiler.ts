/**
 * Prompt compiler (spec 6.1): renders the flattened transcript the tab sees.
 * Deterministic: same input -> same text, always (ADR-4 obligation).
 */
import type { ChatMessage, ToolCall } from "../core/canonical.js";
import { textOf } from "../core/canonical.js";
import type { ToolSpec } from "./types.js";
import { TOOL_PROTOCOL_VERSION, TOOL_SCHEMA_BUDGET } from "./types.js";

/** Render one tool's schema condensed to required-fields-with-types. */
export function renderToolSpec(spec: ToolSpec, budget = TOOL_SCHEMA_BUDGET): string {
  const name = spec.function.name;
  const desc = (spec.function.description ?? "").replace(/\s+/g, " ").trim();
  const params = spec.function.parameters;
  const parts: string[] = [`[${name}] ${desc}`.trim()];
  if (params && typeof params === "object") {
    const props = params.properties ?? {};
    const required = new Set(params.required ?? []);
    const fields = Object.entries(props).map(([k, v]) => {
      const req = required.has(k) ? ", required" : "";
      const t = v?.type ?? "any";
      return `${k} (${t}${req})`;
    });
    if (fields.length > 0) parts.push(`args: ${fields.join(", ")}.`);
  }
  let out = parts.join(" ");
  if (out.length > budget) out = out.slice(0, budget - 1) + "…";
  return out;
}

export function renderToolProtocolBlock(tools: ToolSpec[]): string {
  const lines: string[] = [];
  lines.push(`=== TOOL PROTOCOL (tool-protocol: ${TOOL_PROTOCOL_VERSION}) ===`);
  lines.push("You can call tools. To call one, output a fenced block:");
  lines.push("```tool_call");
  lines.push('{"name": "tool_name", "arguments": {"arg": "value"}}');
  lines.push("```");
  lines.push(
    "Rules: one JSON object per block; no prose inside a block; unknown tools are errors."
  );
  lines.push(
    "BATCHING IS MANDATORY: emit EVERY independent tool_call block you already know you will need " +
      "in the SAME reply, back to back, before you stop. Parallel calls run together, and the " +
      "provider is rate-limited per message, so one batched reply that carries N calls is strictly " +
      "more valuable than N single-call turns. Do not space calls out one turn at a time. Only stop " +
      "to wait for results when you genuinely cannot decide the next call without them."
  );
  lines.push(
    "PROSE FORMAT: any text outside a tool_call block is a normal markdown answer. " +
      "Use headings, bullet lists, numbered steps, fenced code blocks, tables, and inline " +
      "code freely — markdown formatting is expected, not suppressed."
  );
  lines.push("=== TOOLS ===");
  if (tools.length === 0) lines.push("(no tools declared; answer normally — markdown is fine)");
  else for (const t of tools) lines.push(renderToolSpec(t));
  return lines.join("\n");
}

const ROLE_TAG: Record<ChatMessage["role"], string> = {
  system: "SYSTEM",
  developer: "SYSTEM",
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL",
};

function renderMessageForTranscript(m: ChatMessage): string {
  const tag = ROLE_TAG[m.role] ?? "SYSTEM";
  const text = textOf(m.content);
  if (m.role === "tool") {
    return `### TOOL#${m.tool_call_id ?? "-"}\n${text}`;
  }
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    const calls = m.tool_calls
      .map((c: ToolCall) => `call ${c.function.name}(${c.function.arguments || "{}"})#${c.id ?? "-"}`)
      .join(" ; ");
    const head = text ? `${text} => ` : "";
    return `### ASSISTANT\n${head}${calls}`;
  }
  return `### ${tag}\n${text}`;
}

/** Full flattened transcript for SEED / RESET_RESEED (spec 6.1). */
export function compileSeed(
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[]
): string {
  const out: string[] = [];
  out.push(renderToolProtocolBlock([...tools]));
  out.push("=== TRANSCRIPT ===");
  for (const m of messages) out.push(renderMessageForTranscript(m));
  out.push(
    "=== ASSISTANT CUE ===\n" +
      "Continue the transcript above as the assistant. Follow the TOOL PROTOCOL exactly. " +
      "When you need tools, emit EVERY independent tool_call block you already know you will " +
      "need in the SAME reply — back to back, batched, before stopping. The bridge runs those " +
      "calls in parallel and the provider is rate-limited per message, so a single batched reply " +
      "is strictly more valuable than several single-call turns. Stop only when you genuinely " +
      "need the results to decide the next call. When no tools are needed, write a normal "
      + "markdown answer — headings, lists, code fences, and tables are all welcome."
  );
  return out.join("\n\n");
}

/** Regeneration cue: same transcript, explicit redo instruction. */
export function compileRegenerate(
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[]
): string {
  const body = compileSeed(messages, tools);
  return (
    body +
    "\n\nNOTE: your previous assistant message above is being regenerated. Produce a fresh response now."
  );
}

/** Tool-result delta rendering for INJECT_RESULTS (same transcript format). */
export function compileInjectResults(results: readonly ChatMessage[]): string {
  const out: string[] = ["=== TOOL RESULTS ==="];
  for (const r of results) out.push(renderMessageForTranscript(r));
  out.push(
    "=== ASSISTANT CUE ===\n" +
      "Continue the transcript as the assistant given the tool results above. " +
      "SAME BATCHING RULE as before: emit EVERY independent tool_call block you already know " +
      "you will need in a SINGLE reply — back to back, batched, before stopping. Parallel calls " +
      "are executed together and the provider is rate-limited per message; do not spend one turn " +
      "per call. When no further calls are needed, write a normal markdown answer — "
      + "headings, lists, code fences, and tables are all welcome."
  );
  return out.join("\n\n");
}

export function compileInjectText(text: string): string {
  return text;
}

/** Corrective turn for the repair round (spec 6.4). */
export function compileRepair(offendingOutput: string, validationError: string): string {
  return [
    "=== PROTOCOL REMINDER (tool-protocol: " + TOOL_PROTOCOL_VERSION + ") ===",
    "Your previous reply violated the tool output contract.",
    "Validation error: " + validationError,
    "Your previous reply was:",
    "-----",
    offendingOutput,
    "-----",
    "Reply again. To call a tool, output a fenced ```tool_call block containing one JSON object " +
      'with "name" and "arguments". No prose inside the block. You may (and should) emit several ' +
      "such blocks back to back in the same reply when you need several independent tools — " +
      "batching is preferred. If no tool is needed, write a normal markdown answer — "
      + "markdown formatting is encouraged.",
  ].join("\n");
}
