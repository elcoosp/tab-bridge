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
        cfg.stateful = boolValue(val(), "--stateful");
        break;
      case "--auto-create-tabs":
        cfg.autoCreateTabs = boolValue(val(), "--auto-create-tabs");
        break;
      case "--managed-only":
        cfg.managedOnly = boolValue(val(), "--managed-only");
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
        break;
      case "--bind-timeout-ms":
        cfg.bindTimeoutMs = Number(val());
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
    "  --warm-tabs=<n>         pre-created managed tabs 0-8 (default 0)",
    "  --db=<path>             session journal path (default ./bridge-sessions.json)",
    "  --turn-timeout-ms=<n>   per-turn observation deadline (default 240000)",
    "  --bind-timeout-ms=<n>   bind/readiness deadline (default 20000)",
  ].join("\n");
}
