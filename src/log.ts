/** Audit logging (Chapter 2 quality attributes): one JSON line per event. */

type Level = "info" | "warn" | "error" | "audit";

function emit(level: Level, event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  process.stdout.write(line + "\n");
}

export const log = {
  info: (event: string, fields: Record<string, unknown> = {}) => emit("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit("error", event, fields),
  audit: (event: string, fields: Record<string, unknown> = {}) => emit("audit", event, fields),
};
