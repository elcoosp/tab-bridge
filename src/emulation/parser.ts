/**
 * Response parser (spec 6.2): fenced ```tool_call JSON blocks + legacy kod
 * text convention, lenient schema validation, deterministic ids.
 */
import type { ToolSpec, ParsedCall, ParseOutcome } from "./types.js";
import { synthCallId } from "./ids.js";
import { canonJson } from "../util/json.js";

const FENCE_OPEN = /^[ \t]*```tool_call[ \t]*\r?\n?/m;
/** Deformed opener (backticks dropped by the model): bare `tool_call` at a
 * word boundary + newline. Same rule as the streaming holdback. */
const NAKED_FENCE_OPEN = /(^|[^\w])tool_call[ \t]*\r?\n/;

interface RawBlock {
  inner: string;
  start: number;
  end: number;
  /** Legacy blocks carry the name/id from the [tool_call ...] marker. */
  name?: string;
  id?: string;
}

const FENCE_OPENER = "```tool_call";

/**
 * P3: absolute-offset fence extraction. Finds the next valid opener at or
 * after `from` and returns its ABSOLUTE position in `text`, or -1 when none.
 *
 * A valid opener position is:
 *   - `from` itself (back-to-back after a previously-consumed close fence),
 *   - the start of the string, or
 *   - immediately after a newline with only spaces/tabs between (the `^[ \t]*`
 *     anchor the original regex enforced, now checked explicitly).
 *
 * The previous implementation sliced `rest` per block, which is O(n · blocks)
 * on replies containing many fences. This keeps the same semantics in O(n).
 */
function findFenceOpener(text: string, from: number): number {
  let searchFrom = from;
  for (;;) {
    const hit = text.indexOf(FENCE_OPENER, searchFrom);
    if (hit === -1) return -1;
    // Back-to-back: the opener begins exactly where the previous close ended.
    if (hit === from) return hit;
    // Walk back through [ \t]* to a line start (\n) or the string start.
    let i = hit;
    while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
    if (i === 0) return 0;
    if (text[i - 1] === "\n") return i;
    // Mid-line occurrence of "```tool_call" — not a valid opener, keep looking.
    searchFrom = hit + 1;
  }
}

function extractFences(text: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  // Fast path: no opener literal at all — nothing to scan.
  if (!text.includes(FENCE_OPENER)) return blocks;
  let from = 0;
  while (from < text.length) {
    const openIdx = findFenceOpener(text, from);
    if (openIdx === -1) break;
    // Consume the opener + optional [ \t]* + optional \r?\n.
    let innerStart = openIdx + FENCE_OPENER.length;
    while (innerStart < text.length && (text[innerStart] === " " || text[innerStart] === "\t")) {
      innerStart++;
    }
    if (text[innerStart] === "\r") innerStart++;
    if (text[innerStart] === "\n") innerStart++;
    const closeIdx = text.indexOf("```", innerStart);
    if (closeIdx === -1) {
      // Unterminated fence: treat the tail as content (holdback ceiling guards
      // runaway buffers upstream; a completed turn must still parse).
      break;
    }
    blocks.push({
      inner: text.slice(innerStart, closeIdx).trim(),
      start: openIdx,
      end: closeIdx + 3,
    });
    from = closeIdx + 3;
  }
  return blocks;
}

const LEGACY_LINE = /\[tool_call id=([^\]]*) name=([^\]]*)\]\s*([\s\S]*?)(?=\[tool_call |$)/g;

function extractNaked(text: string): RawBlock[] {
  if (!text.includes("tool_call")) return [];
  const blocks: RawBlock[] = [];
  let rest = text;
  let offset = 0;
  for (;;) {
    NAKED_FENCE_OPEN.lastIndex = 0;
    const open = NAKED_FENCE_OPEN.exec(rest);
    if (!open || open.index === undefined) break;
    const markerStart = open.index + open[1].length;
    const innerStart = open.index + open[0].length;
    const closeIdx = rest.indexOf("```", innerStart);
    if (closeIdx === -1) break; // unterminated: tail stays content
    const inner = rest.slice(innerStart, closeIdx);
    blocks.push({ inner: inner.trim(), start: offset + markerStart, end: offset + closeIdx + 3 });
    const consumed = closeIdx + 3;
    offset += consumed;
    rest = rest.slice(consumed);
  }
  return blocks;
}

function extractLegacy(text: string): RawBlock[] {
  if (!text.includes("[tool_call")) return [];
  const blocks: RawBlock[] = [];
  LEGACY_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LEGACY_LINE.exec(text)) !== null) {
    blocks.push({ inner: m[3].trim(), start: m.index, end: m.index + m[0].length, name: m[2].trim(), id: m[1] || undefined });
  }
  return blocks;
}

/** Lenient argument validation: required fields + primitive types. */
export function validateArgs(
  spec: ToolSpec,
  args: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  const params = spec.function.parameters;
  if (!params) return errors;
  const required = params.required ?? [];
  for (const r of required) {
    if (args[r] === undefined) errors.push(`missing required argument "${r}"`);
  }
  const props = params.properties ?? {};
  for (const [k, v] of Object.entries(args)) {
    const want = props[k]?.type;
    if (!want) continue; // unknown/undeclared args are tolerated (lenient)
    const got = Array.isArray(v) ? "array" : typeof v;
    if (want === "integer" && (typeof v !== "number" || !Number.isInteger(v))) {
      errors.push(`argument "${k}" must be an integer`);
    } else if (want !== "integer" && want !== "any" && got !== want) {
      errors.push(`argument "${k}" must be ${want}, got ${got}`);
    }
  }
  return errors;
}

export function parseResponse(fullText: string, tools: ToolSpec[]): ParseOutcome {
  const byName = new Map(tools.map((t) => [t.function.name, t]));
  const warnings: string[] = [];
  const calls: ParsedCall[] = [];
  const contentParts: string[] = [];

  let blocks = extractFences(fullText);
  let legacy = false;
  if (blocks.length === 0) {
    blocks = extractNaked(fullText);
  }
  if (blocks.length === 0) {
    blocks = extractLegacy(fullText);
    legacy = blocks.length > 0;
  }

  if (blocks.length === 0) {
    return { content: fullText, calls: [], warnings };
  }

  let cursor = 0;
  for (const b of blocks) {
    if (b.start > cursor) contentParts.push(fullText.slice(cursor, b.start));
    cursor = b.end;

    const rec = legacy
      ? ({ name: b.name, arguments: b.inner } as Record<string, unknown>)
      : (() => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(b.inner || "{}");
          } catch {
            return null;
          }
          return parsed as Record<string, unknown>;
        })();
    if (rec === null) {
      warnings.push("malformed JSON in tool_call block");
      contentParts.push(fullText.slice(b.start, b.end));
      continue;
    }
    if (typeof rec !== "object" || Array.isArray(rec)) {
      warnings.push("tool_call block must be a JSON object");
      contentParts.push(fullText.slice(b.start, b.end));
      continue;
    }
    const name = typeof rec.name === "string" ? rec.name : undefined;
    if (!name) {
      warnings.push("tool_call block missing \"name\"");
      contentParts.push(fullText.slice(b.start, b.end));
      continue;
    }
    const spec = byName.get(name);
    if (!spec) {
      warnings.push(`unknown tool "${name}"`);
      contentParts.push(fullText.slice(b.start, b.end));
      continue;
    }
    const argsRaw = rec.arguments;
    const args: Record<string, unknown> =
      typeof argsRaw === "string"
        ? safeParse(argsRaw)
        : argsRaw !== undefined && argsRaw !== null && typeof argsRaw === "object" && !Array.isArray(argsRaw)
          ? (argsRaw as Record<string, unknown>)
          : {};
    const errors = validateArgs(spec, args);
    if (errors.length > 0) {
      warnings.push(`${name}: ${errors.join("; ")}`);
      contentParts.push(fullText.slice(b.start, b.end));
      continue;
    }
    calls.push({
      name,
      arguments: canonJson(args),
      id: synthCallId(name, JSON.stringify(args)),
      errors: [],
    });
  }
  if (cursor < fullText.length) contentParts.push(fullText.slice(cursor));
  if (legacy && warnings.length === 0) {
    warnings.push("legacy tool_call text convention parsed (no fenced block present)");
  }

  const content = contentParts.join("").trim();
  // No valid call survived validation -> the whole text is content.
  if (calls.length === 0) {
    return { content: fullText, calls: [], warnings };
  }
  return { content, calls, warnings };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
