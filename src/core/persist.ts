/**
 * Persistence (ADR-3): JSON-lines file of committed session rows.
 * Chain digests only — never transcripts. Replay on boot: the last line per
 * sessionId wins, which recovers exactly the pre-restart state.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionRow, PersistStore } from "./registry.js";

export class JsonlSessionStore implements PersistStore {
  private readonly path: string;
  /**
   * P5: async write queue. Every append/compact chains onto this promise so
   * (a) disk I/O never blocks the event loop on the turn hot path, and
   * (b) appends stay ordered with each other and with compactions.
   *
   * `load()` stays synchronous: it is called once at boot, before the
   * server is listening, and callers that want a synchronous view of the
   * journal (tests, bridge boot) should not need to become async.
   *
   * Callers that need to observe the effects of a write (tests, graceful
   * shutdown) await `flush()`.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    const dir = dirname(path);
    if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  append(row: SessionRow): void {
    const line = JSON.stringify(row) + "\n";
    this.queue = this.queue
      .then(() => appendFile(this.path, line, "utf8"))
      .catch(() => {
        // Persistence must never take a turn down; the chain survives in
        // memory and the next commit retries.
      });
  }

  /** Await every pending write. Used by tests and graceful shutdown. */
  flush(): Promise<void> {
    return this.queue;
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
    const snapshot: string[] = [];
    for (const r of rows) snapshot.push(JSON.stringify(r));
    const body = snapshot.join("\n") + (snapshot.length ? "\n" : "");
    const tmp = `${this.path}.tmp`;
    this.queue = this.queue
      .then(async () => {
        await writeFile(tmp, body, "utf8");
        await rename(tmp, this.path);
      })
      .catch(() => {
        /* best effort */
      });
  }
}
