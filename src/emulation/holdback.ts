/**
 * Streaming holdback (spec 6.3): text streams immediately until a fence opener
 * appears; from that point fragments accumulate. On a closed, valid fence the
 * held text becomes a call event; on invalid, it flushes as content; past the
 * ceiling it flushes as content (model is writing backticks in an answer).
 */
import { HOLDBACK_CEILING } from "./types.js";
import type { HoldbackEvent } from "./types.js";

const OPENER = "```tool_call";

export class HoldbackBuffer {
  private pending = "";
  private holding = false;
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
        if (idx === -1) {
          // Emit all but a possible partial opener tail (e.g. "``" / "```t").
          const emitLen = safeEmitLength(this.pending);
          if (emitLen > 0) {
            events.push({ type: "content", text: this.pending.slice(0, emitLen) });
            this.pending = this.pending.slice(emitLen);
          }
          return events;
        }
        if (idx > 0) {
          events.push({ type: "content", text: this.pending.slice(0, idx) });
          this.pending = this.pending.slice(idx);
        }
        this.holding = true;
      }

      // Holding: look for the closing fence.
      const closeIdx = this.pending.indexOf("```", OPENER.length);
      if (closeIdx !== -1) {
        const inner = this.pending.slice(OPENER.length, closeIdx).trim();
        const after = this.pending.slice(closeIdx + 3);
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
              text: this.pendingText(OPENER + inner + "```"),
              error: "block is not a JSON object with a string name",
            });
          }
        } catch (e) {
          events.push({
            type: "invalid",
            text: this.pendingText(OPENER + inner + "```"),
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
        events.push({ type: "content", text: this.pending });
        this.pending = "";
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
 * of OPENER. Callers invoke this only when no complete opener was found.
 */
export function safeEmitLength(s: string): number {
  const maxCheck = Math.min(OPENER.length, s.length);
  for (let keep = maxCheck; keep > 0; keep--) {
    if (OPENER.startsWith(s.slice(s.length - keep))) return s.length - keep;
  }
  return s.length;
}
