/** CLI flag parsing + effective configuration (spec 8.4). */

export interface Config {
  port: number;
  host: string;
  apiKey: string | null;
  stateful: boolean;
  autoCreateTabs: boolean;
  managedOnly: boolean;
  ttlMs: number;
  repairRounds: number;
  warmTabs: number;
  dbPath: string;
  turnTimeoutMs: number;
  bindTimeoutMs: number;
  /** Max chars buffered inside an open tool_call fence before it is
   * flushed as content with a warning (repair round can then react). */
  holdbackCeiling: number;
  /** Refuse prompts longer than this (chars). No truncation ever: over-cap
   * prompts fail fast with prompt-too-large so callers can compact. */
  maxPromptChars: number;
  /** Max turns generating against the provider account at once. DeepSeek
   * rejects a 3rd concurrent generation with "Another message is being
   * generated"; the bridge queues extra turns FIFO instead (0 disables the
   * gate). */
  maxConcurrentTurns: number;
  /** Max turns waiting in the generation queue. Overflow fails fast with
   * 503 queue_full + Retry-After. */
  queueCapacity: number;
  /** Max ms a turn may sit in the generation queue before failing with 503
   * queue_timeout + Retry-After. 0 waits forever. */
  queueTimeoutMs: number;
  /** WS-D: SEED-into-dirty-tab policy: auto (reset when worker reports dirty)
   * | always (reset on every SEED) | never (legacy: no dirty-driven reset). */
  resetOnSeed?: "auto" | "always" | "never";
  /** E2: cap on worker-managed tabs. 0 = unbounded (legacy). Shipped to the
   * worker in HELLO_OK; enforced worker-side in allocateTab. */
  maxTabs?: number;
  /** E3: worker closes ready+unbound tabs idle beyond this (ms). 0 = never. */
  tabIdleCloseMs?: number;
}

export const DEFAULTS: Config = {
  port: 8789,
  host: "127.0.0.1",
  apiKey: null,
  stateful: true,
  autoCreateTabs: false,
  managedOnly: true,
  ttlMs: 30 * 60_000,
  repairRounds: 1,
  warmTabs: 0,
  dbPath: "bridge-sessions.json",
  turnTimeoutMs: 240_000,
  bindTimeoutMs: 20_000,
  holdbackCeiling: 65_536,
  maxPromptChars: 1_000_000,
  maxConcurrentTurns: 2,
  queueCapacity: 32,
  queueTimeoutMs: 600_000,
  resetOnSeed: "auto",
  maxTabs: 4,
  tabIdleCloseMs: 15 * 60_000,
};

export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      throw new Error(`invalid duration: ${s}`);
  }
}

function boolValue(v: string | undefined, flagName: string): boolean {
  if (v === undefined || v === "") return true; // bare flag = true
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`${flagName} expects true|false`);
}

/** Parse `serve` flags. Throws on unknown flags / bad values. */
export function parseServeArgs(argv: string[]): Config {
  const cfg: Config = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const val = (): string => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${flag}`);
      return argv[i];
    };
    /** Boolean flags accept `--flag`, `--flag=true|false`, or `--flag true|false`.
     * A following `--other-flag` is never swallowed as the value. */
    const boolFlag = (): boolean => {
      if (inline !== undefined) return boolValue(inline, flag);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return true;
      i += 1;
      return boolValue(next, flag);
    };
    switch (flag) {
      case "--port":
        cfg.port = Number(val());
        if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
          throw new Error("--port must be an integer 1-65535");
        }
        break;
      case "--host":
        cfg.host = val();
        break;
      case "--api-key-env": {
        const name = val();
        cfg.apiKey = process.env[name] ?? null;
        break;
      }
      case "--stateful":
        cfg.stateful = boolFlag();
        break;
      case "--auto-create-tabs":
        cfg.autoCreateTabs = boolFlag();
        break;
      case "--managed-only":
        cfg.managedOnly = boolFlag();
        break;
      case "--ttl":
        cfg.ttlMs = parseDuration(val());
        break;
      case "--repair-rounds":
        cfg.repairRounds = Number(val());
        if (!Number.isInteger(cfg.repairRounds) || cfg.repairRounds < 0 || cfg.repairRounds > 3) {
          throw new Error("--repair-rounds must be an integer 0-3");
        }
        break;
      case "--holdback-ceiling":
        cfg.holdbackCeiling = Number(val());
        if (!Number.isInteger(cfg.holdbackCeiling) || cfg.holdbackCeiling < 1000) {
          throw new Error("--holdback-ceiling must be an integer >= 1000");
        }
        break;
      case "--warm-tabs":
        cfg.warmTabs = Number(val());
        if (!Number.isInteger(cfg.warmTabs) || cfg.warmTabs < 0 || cfg.warmTabs > 8) {
          throw new Error("--warm-tabs must be an integer 0-8");
        }
        break;
      case "--db":
        cfg.dbPath = val();
        break;
      case "--turn-timeout-ms":
        cfg.turnTimeoutMs = Number(val());
        if (!Number.isInteger(cfg.turnTimeoutMs) || cfg.turnTimeoutMs <= 0) {
          throw new Error("--turn-timeout-ms must be a positive integer");
        }
        break;
      case "--bind-timeout-ms":
        cfg.bindTimeoutMs = Number(val());
        if (!Number.isInteger(cfg.bindTimeoutMs) || cfg.bindTimeoutMs <= 0) {
          throw new Error("--bind-timeout-ms must be a positive integer");
        }
        break;
      case "--max-prompt-chars":
        cfg.maxPromptChars = Number(val());
        if (!Number.isInteger(cfg.maxPromptChars) || cfg.maxPromptChars <= 0) {
          throw new Error("--max-prompt-chars must be a positive integer");
        }
        break;
      case "--max-concurrent-turns":
        cfg.maxConcurrentTurns = Number(val());
        if (!Number.isInteger(cfg.maxConcurrentTurns) || cfg.maxConcurrentTurns < 0) {
          throw new Error("--max-concurrent-turns must be an integer >= 0 (0 disables the gate)");
        }
        break;
      case "--queue-capacity":
        cfg.queueCapacity = Number(val());
        if (!Number.isInteger(cfg.queueCapacity) || cfg.queueCapacity < 1 || cfg.queueCapacity > 4096) {
          throw new Error("--queue-capacity must be an integer 1-4096");
        }
        break;
      case "--queue-timeout-ms":
        cfg.queueTimeoutMs = Number(val());
        if (!Number.isInteger(cfg.queueTimeoutMs) || cfg.queueTimeoutMs < 0) {
          throw new Error("--queue-timeout-ms must be an integer >= 0 (0 waits forever)");
        }
        break;
      case "--reset-on-seed": {
        const mode = val();
        if (mode !== "auto" && mode !== "always" && mode !== "never") {
          throw new Error("--reset-on-seed must be auto|always|never");
        }
        cfg.resetOnSeed = mode;
        break;
      }
      case "--max-tabs":
        cfg.maxTabs = Number(val());
        if (!Number.isInteger(cfg.maxTabs) || cfg.maxTabs < 0) {
          throw new Error("--max-tabs must be an integer >= 0 (0 = unbounded)");
        }
        break;
      case "--tab-idle-close":
        cfg.tabIdleCloseMs = parseDuration(val());
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return cfg;
}

export function usage(): string {
  return [
    "tab-bridge — OpenAI-compatible facade over a stateful browser chat tab",
    "",
    "USAGE:",
    "  tab-bridge serve [flags]",
    "",
    "FLAGS:",
    "  --port <n>              HTTP port (default 8789)",
    "  --host <addr>           bind address (default 127.0.0.1)",
    "  --api-key-env <NAME>    env var holding the shared-secret bearer",
    "  --stateful=true|false   ADR-6 mode; false = always-reset fallback (default true)",
    "  --auto-create-tabs      worker may create managed tabs (default false)",
    "  --managed-only          allocate only worker-created tabs (default true)",
    "  --ttl=<dur>             idle session TTL, e.g. 30m (default 30m)",
    "  --repair-rounds=<n>     bounded tool-protocol repair rounds 0-3 (default 1)",
    "  --holdback-ceiling=<n>  max chars held inside an open tool_call fence (default 65536)",
    "  --warm-tabs=<n>         pre-created managed tabs 0-8 (default 0)",
    "  --db=<path>             session journal path (default ./bridge-sessions.json)",
    "  --turn-timeout-ms=<n>   per-turn observation deadline (default 240000)",
    "  --bind-timeout-ms=<n>   bind/readiness deadline (default 20000)",
    "  --max-prompt-chars=<n>  refuse prompts over n chars, never truncate (default 1000000)",
    "  --max-concurrent-turns=<n>  provider generations in flight at once, 0 disables the gate (default 2)",
    "  --queue-capacity=<n>        max turns waiting in the generation queue (default 32)",
    "  --queue-timeout-ms=<n>      max queue wait before 503 queue_timeout, 0 waits forever (default 600000)",
    "  --reset-on-seed=<mode>      SEED-into-dirty-tab policy auto|always|never (default auto)",
    "  --max-tabs=<n>              cap on worker-managed tabs, 0 = unbounded (default 4)",
    "  --tab-idle-close=<dur>      close ready+unbound tabs idle beyond dur, 0 = never (default 15m)",
  ].join("\n");
}
