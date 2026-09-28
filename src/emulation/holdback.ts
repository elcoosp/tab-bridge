/**
 * Streaming holdback (spec 6.3): text streams immediately until a fence opener
 * appears; from that point fragments accumulate. On a closed, valid fence the
 * held text becomes a call event; on invalid, it flushes as content; past the
 * ceiling it flushes as content (model is writing backticks in an answer).
 */
import { HOLDBACK_CEILING } from "./types.js";
import type { HoldbackEvent } from "./types.js";

const OPENER = "```tool_call";
/**
 * Deformed opener the model occasionally emits with the backticks dropped
 * (`stop.tool_call\n{...}\n```` observed in the wild): the bare word
 * `tool_call` at a word boundary, followed by a newline. Only a following
 * valid JSON object + closing fence turns it into a call; anything else
 * flushes as content with a warning (same as an invalid fenced block), so a
 * prose mention can cost at most one repair round, never a lost call.
 */
const NAKED_OPEN_RE = /(^|[^\w])tool_call[ \t]*\r?\n/;

export class HoldbackBuffer {
  private pending = "";
  private holding = false;
  /** Byte length of the opener that started the current hold. */
  private openLen = OPENER.length;
  /** True when the hold began at a naked (backtick-less) marker. */
  private nakedOpen = false;
  private readonly ceiling: number;

  constructor(ceiling = HOLDBACK_CEILING) {
    this.ceiling = ceiling;
  }

  /** Feed one fragment; returns events that became unambiguous. */
  push(fragment: string): HoldbackEvent[] {
    this.pending += fragment;
    return this.drain();
  }

  /** Flush at end of stream. Any held text resolves as content. */
  finish(): HoldbackEvent[] {
    const events: HoldbackEvent[] = [];
    if (this.pending) {
      events.push({ type: "content", text: this.pending });
      this.pending = "";
    }
    this.holding = false;
    return events;
  }

  private drain(): HoldbackEvent[] {
    const events: HoldbackEvent[] = [];
    for (;;) {
      if (!this.holding) {
        const idx = this.pending.indexOf(OPENER);
        NAKED_OPEN_RE.lastIndex = 0;
        const naked = NAKED_OPEN_RE.exec(this.pending);
        const nakedStart = naked ? naked.index + naked[1].length : -1;
        let mStart = -1;
        let openLen = OPENER.length;
        let nakedOpen = false;
        if (idx !== -1 && (nakedStart === -1 || idx <= nakedStart)) {
          mStart = idx;
        } else if (nakedStart !== -1 && naked) {
          mStart = nakedStart;
          openLen = naked[0].length - naked[1].length;
          nakedOpen = true;
        }
        if (mStart === -1) {
          // Emit all but a possible partial opener tail (e.g. "``" / "```t"
          // or a word-boundary "tool_ca" still growing across fragments).
          const emitLen = safeEmitLength(this.pending);
          if (emitLen > 0) {
            events.push({ type: "content", text: this.pending.slice(0, emitLen) });
            this.pending = this.pending.slice(emitLen);
          }
          return events;
        }
        if (mStart > 0) {
          events.push({ type: "content", text: this.pending.slice(0, mStart) });
          this.pending = this.pending.slice(mStart);
        }
        this.holding = true;
        this.openLen = openLen;
        this.nakedOpen = nakedOpen;
      }

      // Holding: look for the closing fence.
      const closeIdx = this.pending.indexOf("```", this.openLen);
      if (closeIdx !== -1) {
        const inner = this.pending.slice(this.openLen, closeIdx).trim();
        const after = this.pending.slice(closeIdx + 3);
        // Naked blocks flush back verbatim (no backticks to normalize);
        // fenced blocks keep the historical normalized reconstruction.
        const verbatim = this.pending.slice(0, closeIdx + 3);
        this.pending = "";
        this.holding = false;
        try {
          const obj = JSON.parse(inner || "{}") as Record<string, unknown>;
          if (obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.name === "string") {
            const args =
              typeof obj.arguments === "string"
                ? obj.arguments
                : JSON.stringify(obj.arguments ?? {});
            events.push({
              type: "call",
              name: obj.name,
              argsJson: args,
              ...(typeof obj.id === "string" ? { id: obj.id } : {}),
            });
          } else {
            events.push({
              type: "invalid",
              text: this.nakedOpen ? verbatim : this.pendingText(OPENER + inner + "```"),
              error: "block is not a JSON object with a string name",
            });
          }
        } catch (e) {
          events.push({
            type: "invalid",
            text: this.nakedOpen ? verbatim : this.pendingText(OPENER + inner + "```"),
            error: (e as Error).message,
          });
        }
        // Continue draining content after the fence.
        const more = this.drainAfterClose(after);
        events.push(...more);
        return events;
      }

      // No close yet: ceiling check.
      if (this.pending.length > this.ceiling) {
        this.holding = false;
        const flushed = this.pending;
        this.pending = "";
        events.push({
          type: "invalid",
          text: flushed,
          error:
            `tool_call fence exceeded the holdback ceiling (${this.ceiling} chars); ` +
            "flushed as content — the model likely tried to inline a very large payload",
        });
        return events;
      }
      return events;
    }
  }

  private drainAfterClose(after: string): HoldbackEvent[] {
    this.pending = after;
    return this.drain();
  }

  private pendingText(_t: string): string {
    return _t;
  }
}

/**
 * Length we can emit from `s` without a suffix that could still grow into an
 * opener: hold back the longest suffix of s that is a (possibly full) prefix
 * of OPENER, or a word-boundary prefix of the naked `tool_call` marker
 * ("…tool_ca" + "ll\n" across a fragment boundary). Callers invoke this only
 * when no complete opener was found.
 */
export function safeEmitLength(s: string): number {
  let hold = 0;
  const maxCheck = Math.min(OPENER.length, s.length);
  for (let keep = maxCheck; keep > 0; keep--) {
    if (OPENER.startsWith(s.slice(s.length - keep))) {
      hold = keep;
      break;
    }
  }
  hold = Math.max(hold, nakedHoldLen(s));
  return s.length - hold;
}

/**
 * Longest trailing word-boundary run that could still grow into the naked
 * `tool_call` opener. The run must start the string or follow a non-word
 * char, otherwise mid-word prose ("stool_carrier") would stall emission.
 */
export function nakedHoldLen(s: string): number {
  const maxCheck = Math.min(10, s.length); // 1 boundary char + 9 marker chars
  for (let keep = maxCheck; keep > 0; keep--) {
    const start = s.length - keep;
    if (start > 0 && /[\w]/.test(s[start - 1])) continue;
    const suf = s.slice(start);
    if (!/^[^\w]?[A-Za-z_]*$/.test(suf)) continue;
    const core = suf.replace(/^[^\w]/, "");
    if (core.length > 0 && "tool_call".startsWith(core)) return keep;
  }
  return 0;
}
