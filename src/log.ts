/** Audit logging (Chapter 2 quality attributes): one JSON line per event. */
//
// P7: batched writes with a bounded buffer. The old implementation called
// process.stdout.write() synchronously per log line and ignored the return
// value; when stdout was a slow pipe (developer running under `less` or
// piping to a file on a slow disk) the writes buffered in memory unbounded
// and could back-pressure the entire process. Now lines are queued and
// flushed on the next microtask, and the queue is capped: a runaway log
// line rate drops excess lines rather than growing memory forever.
//
// The buffer flushes at the end of the current macrotask, so a test that
// asserts on stdout sees every line by the time it returns to the event
// loop — the ordering guarantee (FIFO) is preserved by splice(0).

type Level = "info" | "warn" | "error" | "audit";

const LOG_BUFFER_LIMIT = 4096;
const logBuffer: string[] = [];
let logFlushScheduled = false;
let logDroppedSinceFlush = 0;

function scheduleFlush(): void {
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  setImmediate(flushLogs);
}

function flushLogs(): void {
  logFlushScheduled = false;
  if (logBuffer.length === 0) return;
  const dropped = logDroppedSinceFlush;
  logDroppedSinceFlush = 0;
  const batch = logBuffer.splice(0).join("\n") + "\n";
  try {
    // Ignore the return value: even when stdout is a slow pipe, the OS
    // buffer takes the write and we do not want to block the event loop.
    process.stdout.write(batch);
    if (dropped > 0) {
      process.stdout.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event: "log.dropped",
          count: dropped,
        }) + "\n"
      );
    }
  } catch {
    /* stdout gone (daemonized parent, closed pipe): drop silently */
  }
}

function emit(level: Level, event: string, fields: Record<string, unknown>): void {
  if (logBuffer.length >= LOG_BUFFER_LIMIT) {
    logDroppedSinceFlush += 1;
    return;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  logBuffer.push(line);
  scheduleFlush();
}

/** P7: flush pending log lines now. Exposed for graceful shutdown and tests. */
export function flushLogsSync(): void {
  flushLogs();
}

export const log = {
  info: (event: string, fields: Record<string, unknown> = {}) => emit("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit("error", event, fields),
  audit: (event: string, fields: Record<string, unknown> = {}) => emit("audit", event, fields),
};
