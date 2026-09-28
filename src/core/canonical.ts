/**
 * OpenAI message model, canonicalization (spec 5.1) and legacy text-convention
 * rewriting (kod H-P1 tolerance, R3).
 *
 * canonical(msg) forms (scheme v3):
 *   system    : "S|" + text            (hashed for tabHash only, never chained)
 *   user      : "U|" + text
 *   assistant : "A|" + text                         (no calls)
 *             | "A|=> call name(args)#id ; call ..." (with calls, prose excluded)
 *   tool      : "T#" + tool_call_id + "|" + text
 */
import { canonJson } from "../util/json.js";

export const SCHEME_VERSION = 1;

export interface ToolCall {
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart = { type: "text"; text: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string | ContentPart[] | null | undefined;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export function textOf(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is ContentPart => p != null && typeof p === "object" && p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Assistant tool_calls rendered wire-independently, args canonically. */
export function renderCalls(calls: ToolCall[]): string {
  return calls
    .map((c) => {
      const id = c.id ?? "-";
      let args: string;
      try {
        args = canonJson(JSON.parse(c.function.arguments || "{}"));
      } catch {
        args = c.function.arguments || "";
      }
      return `call ${c.function.name}(${args})#${id}`;
    })
    .join(" ; ");
}

/**
 * Chain continuity starts after an optional leading system message. Clients
 * legitimately re-render the system prompt every turn (timestamps, memory,
 * tool inventory), so hashing it would force a reseed on every follow-up.
 * The system text still reaches the tab on SEED compiles; it is simply not
 * part of the continuity proof. Only ONE leading message is skipped — a
 * system role anywhere else is hashed normally.
 */
export function stripSystemPrefix(messages: readonly ChatMessage[]): ChatMessage[] {
  if (messages.length > 0 && messages[0].role === "system") return messages.slice(1);
  return [...messages];
}

export function canonical(msg: ChatMessage): string {
  const text = textOf(msg.content);
  switch (msg.role) {
    case "system":
    case "developer":
      return `S|${text}`;
    case "user":
      return `U|${text}`;
    case "tool":
      return `T#${msg.tool_call_id ?? "-"}|${text}`;
    case "assistant": {
      // Scheme v2: prose is excluded when tool calls are present. OpenAI
      // clients legally replay assistant turns as {content: null, tool_calls}
      // while the tab produced prose + calls — hashing prose flags every
      // such replay as fabricated. Call identity (name/args/id) still binds.
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return `A|=> ${renderCalls(msg.tool_calls)}`;
      }
      return `A|${text}`;
    }
    default:
      return `S|${text}`;
  }
}

const LEGACY_CALL = /\[tool_call id=([^\]]*) name=([^\]]*)\]\s*/g;

/** Find the first balanced JSON object in `s`; returns null when absent. */
function scanJsonObject(s: string): { json: string | null; end: number } {
  const start = s.indexOf("{");
  if (start === -1) return { json: null, end: s.length };
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { json: s.slice(start, i + 1), end: i + 1 };
    }
  }
  return { json: null, end: s.length };
}

/**
 * Recognize the legacy kod text convention inside assistant string content:
 *   [tool_call id=abc name=execute_command] {"cmd":"ls"}
 * and rewrite it into native tool_calls. Text between blocks stays as content.
 * Returns the original message when no legacy markers are present.
 */
export function rewriteLegacyAssistant(msg: ChatMessage): ChatMessage {
  if (msg.role !== "assistant") return msg;
  if (msg.tool_calls && msg.tool_calls.length > 0) return msg;
  if (typeof msg.content !== "string") return msg;
  const content = msg.content;
  if (!content.includes("[tool_call")) return msg;

  LEGACY_CALL.lastIndex = 0;
  const calls: ToolCall[] = [];
  const contentParts: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = LEGACY_CALL.exec(content)) !== null) {
    found = true;
    if (m.index > cursor) contentParts.push(content.slice(cursor, m.index));
    const rest = content.slice(m.index + m[0].length);
    const { json, end } = scanJsonObject(rest);
    calls.push({
      id: m[1] || undefined,
      type: "function",
      function: { name: m[2].trim(), arguments: json ?? "{}" },
    });
    cursor = m.index + m[0].length + end;
    if (LEGACY_CALL.lastIndex <= m.index + m[0].length) {
      LEGACY_CALL.lastIndex = cursor;
    }
  }
  if (!found) return msg;
  if (cursor < content.length) contentParts.push(content.slice(cursor));
  const out: ChatMessage = {
    role: "assistant",
    content: contentParts.join("").trim() || null,
    tool_calls: calls,
  };
  return out;
}

/** Normalize an incoming message list: legacy rewrite + content coercion. */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(rewriteLegacyAssistant);
}
