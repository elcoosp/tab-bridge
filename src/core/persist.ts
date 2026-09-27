/**
 * Persistence (ADR-3): JSON-lines file of committed session rows.
 * Chain digests only — never transcripts. Replay on boot: the last line per
 * sessionId wins, which recovers exactly the pre-restart state.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRow, PersistStore } from "./registry.js";

export class JsonlSessionStore implements PersistStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    const dir = dirname(path);
    if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  append(row: SessionRow): void {
    try {
      appendFileSync(this.path, JSON.stringify(row) + "\n", "utf8");
    } catch {
      // Persistence must never take a turn down; the chain survives in memory
      // and the next commit retries.
    }
  }

  /** Load rows; last line per sessionId wins. Corrupt lines are skipped. */
  load(): Map<string, SessionRow> {
    const out = new Map<string, SessionRow>();
    if (!existsSync(this.path)) return out;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return out;
    }
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const row = JSON.parse(s) as SessionRow;
        if (row && typeof row.sessionId === "string" && Array.isArray(row.chain)) {
          row.state = "active"; // draining/resetting states do not survive restart
          out.set(row.sessionId, row);
        }
      } catch {
        // skip corrupt line
      }
    }
    return out;
  }

  /** Compact the journal into a single snapshot (housekeeping helper). */
  compact(rows: Iterable<SessionRow>): void {
    const tmp = `${this.path}.tmp`;
    const lines: string[] = [];
    for (const r of rows) lines.push(JSON.stringify(r));
    try {
      writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
      renameSync(tmp, this.path);
    } catch {
      /* best effort */
    }
  }
}
