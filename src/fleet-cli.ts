/**
 * tab-bridge fleet — manage the profile fleet.
 *   fleet add <id> [--label L] [--proxy URL] [--surface k=v,...]
 *   fleet list                                     table of accounts
 *   fleet open <id>                                open the account's window
 *   fleet login <id>                               guided re-login
 *   fleet proxy <id> <url|off>                     set/clear the network identity
 *   fleet surface <id> [--locale L] [--tz Z] [--window WxH] [--pos XxY]
 *                       [--canvas-noise on|off] [--arg "..."] [--force]
 *   fleet doctor                                   isolation findings + exit-IP probe
 *   fleet drain <id> [--to <id|auto>] [-y]         move its sessions (priced)
 *   fleet remove <id> [--purge]                    unbind (+ purge profile dir)
 * Flags: --url http://127.0.0.1:8789  --key-env TAB_BRIDGE_KEY
 *
 * Thin HTTP client: the running bridge owns the fleet file and all live
 * state; the CLI never writes anything directly.
 */

const DEFAULT_BASE = "http://127.0.0.1:8789";

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

interface SurfaceBody {
  locale?: string;
  timezone?: string;
  windowSize?: string;
  windowPosition?: string;
  canvasNoise?: boolean;
  extraArgs?: string[];
}

interface AccountRow {
  id: string;
  label?: string;
  state: string;
  cooldownInSec: number | null;
  sessions: number;
  maxSessions: number;
  activeTurns: number;
  maxTurns: number;
  linked: boolean;
  fingerprint: string;
  awaitingHuman?: boolean;
  network: { proxy: boolean; exitIp: string | null; exitProbe: string };
  surface: SurfaceBody;
  bootPhaseMs?: number;
  enrolledAt?: number;
  createdAt?: number;
}

interface AccountsResponse {
  accounts: AccountRow[];
  capacity: {
    readyAccounts: number;
    turnSlots: number;
    sessionSlots: number;
    shortestCooldownInSec: number | null;
  };
  isolation: {
    findings: string[];
    checkedAt: number;
  };
}

async function waitForReady(
  base: string,
  headers: Record<string, string>,
  id: string,
  deadlineMs: number
): Promise<AccountRow> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${base}/v1/accounts`, { headers });
    const data = (await res.json()) as AccountsResponse;
    const acct = data.accounts.find((a) => a.id === id);
    if (acct?.state === "ready") return acct;
    if (Date.now() > deadline) {
      throw new Error(`"${id}" did not reach ready within ${deadlineMs}ms (state: ${acct?.state ?? "unknown"})`);
    }
  }
}

function parseSurfaceArgs(argv: string[]): SurfaceBody {
  const out: SurfaceBody = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--locale") out.locale = argv[++i];
    else if (a === "--tz") out.timezone = argv[++i];
    else if (a === "--window") out.windowSize = argv[++i];
    else if (a === "--pos") out.windowPosition = argv[++i];
    else if (a === "--canvas-noise") {
      const v = argv[++i];
      out.canvasNoise = v === "on" || v === "true" || v === "1";
    } else if (a === "--arg") {
      const v = argv[++i];
      if (v) {
        if (!out.extraArgs) out.extraArgs = [];
        out.extraArgs.push(v);
      }
    }
  }
  return out;
}

function parseSurfaceCsv(csv: string): SurfaceBody {
  const out: SurfaceBody = {};
  for (const pair of csv.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (!k || v === undefined) continue;
    if (k === "locale") out.locale = v;
    else if (k === "timezone" || k === "tz") out.timezone = v;
    else if (k === "windowSize" || k === "window") out.windowSize = v;
    else if (k === "windowPosition" || k === "pos") out.windowPosition = v;
    else if (k === "canvasNoise" || k === "canvas-noise") out.canvasNoise = v === "on" || v === "true" || v === "1";
  }
  return out;
}

/** Run `curl` through the account's proxy to fetch its exit IP. Returns a
 * printable string (never throws). Credentials are never passed on the
 * command line as a value the operator wrote; the endpoint is whatever
 * was stored in the fleet file (raw, possibly an env var expansion). */
async function probeExitIp(proxy: string | null): Promise<string> {
  const { probeExitIpNative } = await import("./fleet/netprobe.js");
  const r = await probeExitIpNative(proxy);
  if (r.ip) return r.ip;
  return `(${r.status})`;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export async function fleetMain(argv: string[]): Promise<void> {
  const [sub, id] = argv;
  const base = getFlag(argv, "--url") ?? DEFAULT_BASE;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const keyEnv = getFlag(argv, "--key-env");
  if (keyEnv && process.env[keyEnv]) headers.authorization = `Bearer ${process.env[keyEnv]}`;

  const post = async (path: string, body?: unknown): Promise<unknown> =>
    fetchJson(`${base}${path}`, {
      method: "POST",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const getJson = async (path: string): Promise<unknown> =>
    fetchJson(`${base}${path}`, { method: "GET", headers });

  switch (sub) {
    case "add": {
      if (!id) throw new Error("usage: fleet add <id> [--label L] [--proxy URL] [--surface k=v,...]");
      console.log(`  fleet:  enrolling "${id}"...`);
      const body: Record<string, unknown> = { id };
      const label = getFlag(argv, "--label");
      if (label !== undefined) body.label = label;
      const proxy = getFlag(argv, "--proxy");
      if (proxy !== undefined) body.proxy = proxy;
      const surface = getFlag(argv, "--surface");
      if (surface !== undefined) body.surface = parseSurfaceCsv(surface);
      await post("/v1/fleet/enroll", body);
      console.log("  launch: browser window opening — log into the account in that window");
      const acct = await waitForReady(base, headers, id, 10 * 60_000);
      console.log(`  login:  ok — "${id}" is ready`);
      // Compact summary line: configured surface + network facts.
      const surfaceFacts = acct.surface && Object.keys(acct.surface).length > 0
        ? Object.entries(acct.surface).map(([k, v]) => `${k}=${String(v)}`).join(" ")
        : "(no surface profile set)";
      console.log(`  checkup: ${surfaceFacts}`);
      const proxyFacts = acct.network.proxy ? "proxied" : "(direct)";
      console.log(`  checkup: network ${proxyFacts}`);
      // §6.1: with ≥2 accounts, run the fingerprint probe on the new
      // profile so the operator sees the *measured* isolation, not just
      // the configured surface. Best-effort: a probe that never returns
      // (profile closed, bridge port unreachable from the tab) prints a
      // one-line warning but does not fail the enrollment.
      const listing = (await getJson("/v1/accounts")) as AccountsResponse;
      if (listing.accounts.length >= 2) {
        console.log("  probe:  measuring fingerprint in the new profile...");
        try {
          const res = await fetch(`${base}/v1/fleet/${id}/checkup`, {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(45_000),
          });
          if (!res.ok) {
            console.log(`  probe:  (skipped: HTTP ${res.status})`);
          } else {
            const body = (await res.json()) as {
              checkup: {
                canvasHash: string; language: string; timezone: string;
                innerWidth: number; innerHeight: number; exitIp: string | null;
              };
            };
            const c = body.checkup;
            console.log(
              `  probe:  canvas ${c.canvasHash.slice(0, 8)}… · lang ${c.language} · tz ${c.timezone} · ${c.innerWidth}x${c.innerHeight} · exit ${c.exitIp ?? "(unknown)"}`
            );
          }
        } catch (e) {
          console.log(`  probe:  (skipped: ${(e as Error).message})`);
        }
      }
      return;
    }

    case "list": {
      const data = (await getJson("/v1/accounts")) as AccountsResponse;
      // Column widths are best-effort; alignment matters more than perfection.
      const w = (s: string, n: number): string => s.padEnd(n).slice(0, n);
      console.log(
        `${w("ACCOUNT", 12)} ${w("STATE", 15)} ${w("COOLDOWN", 10)} ${w("SESSIONS", 10)} ${w("TURNS", 6)} ${w("LINKED", 7)} ${w("NETWORK", 14)}`
      );
      for (const a of data.accounts) {
        const cooldown = a.cooldownInSec === null ? "-" : `${a.cooldownInSec}s`;
        const network = a.network.proxy ? `proxy ✓` : "(direct) ⚠";
        const human = a.awaitingHuman ? "  (needs a human)" : "";
        console.log(
          `${w(a.id, 12)} ${w(a.state + human, 15)} ${w(cooldown, 10)} ${w(`${a.sessions}/${a.maxSessions}`, 10)} ${w(`${a.activeTurns}/${a.maxTurns}`, 6)} ${w(a.linked ? "✓" : "-", 7)} ${w(network, 14)}`
        );
      }
      console.log(
        `capacity: ${data.capacity.readyAccounts} ready account(s) · ${data.capacity.turnSlots} turn slots · ${data.capacity.sessionSlots} bound sessions · shortest cooldown ${data.capacity.shortestCooldownInSec ?? "-"}s`
      );
      return;
    }

    case "open":
      if (!id) throw new Error("usage: fleet open <id>");
      await post(`/v1/fleet/${id}/open`);
      console.log(`window opening for "${id}"`);
      return;

    case "login":
      if (!id) throw new Error("usage: fleet login <id>");
      await post(`/v1/fleet/${id}/relogin`);
      console.log(`window opening for "${id}" — complete the login; the bridge takes it from there`);
      return;

    case "proxy": {
      if (!id) throw new Error("usage: fleet proxy <id> <url|off>");
      const value = argv[3];
      await post(`/v1/fleet/${id}/proxy`, { proxy: value === "off" ? null : value });
      console.log(`  proxy:  "${id}" network identity updated (stored raw; expanded at launch)`);
      return;
    }

    case "surface": {
      if (!id) throw new Error("usage: fleet surface <id> [--locale L] [--tz Z] [--window WxH] [--pos XxY] [--canvas-noise on|off] [--arg \"...\"] [--force]");
      const surface = parseSurfaceArgs(argv.slice(3));
      const force = argv.includes("--force");
      await post(`/v1/fleet/${id}/surface`, { surface, force });
      console.log(`  surface: "${id}" presentation updated (C12: was this forced?)`);
      return;
    }

    case "doctor": {
      const data = (await getJson("/v1/accounts")) as AccountsResponse;
      // --json: machine-readable snapshot for dashboards; identical data to
      // the human rendering below (accounts + capacity + isolation).
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
        return;
      }
      console.log(`  fleet doctor — ${data.accounts.length} account(s)`);
      // Network paths (with optional exit-IP probe).
      const probe = !argv.includes("--no-probe");
      console.log("  network:");
      for (const a of data.accounts) {
        // The wire shape exposes only a boolean proxy flag; the raw endpoint
        // is not shipped (ADR-10v2 hygiene: no proxy URLs in HTTP responses).
        // doctor's job is to show facts a dashboard can verify: proxy vs
        // direct, plus (when probing) the observed exit IP.
        let suffix = a.network.proxy ? "proxied" : "(direct) — shares the host uplink";
        if (probe && a.network.proxy) {
          const ip = await probeExitIp(await fetchRawProxy(base, headers, a.id));
          suffix += ` · exit ${ip}`;
        } else if (probe && !a.network.proxy) {
          const ip = await probeExitIp(null);
          suffix += ` · exit ${ip}`;
        }
        console.log(`            ${a.id.padEnd(12)} ${suffix}`);
      }
      // Isolation findings.
      if (data.isolation.findings.length === 0) {
        console.log("  findings: none — distinct network paths and surfaces");
      } else {
        console.log("  findings:");
        for (const f of data.isolation.findings) console.log(`            ⚠ ${f}`);
      }
      // Surface diff.
      console.log("  surface:");
      for (const a of data.accounts) {
        const s = a.surface ?? {};
        const facts = [
          s.locale ?? "-",
          s.timezone ?? "-",
          s.windowSize ?? "-",
          s.canvasNoise === true ? "canvas-noise on" : s.canvasNoise === false ? "canvas-noise off" : "canvas-noise default",
        ].join(" / ");
        console.log(`            ${a.id.padEnd(12)} ${facts}`);
      }
      // Boot phases (deterministic stagger).
      console.log("  schedule:");
      for (const a of data.accounts) {
        console.log(`            ${a.id.padEnd(12)} boot phase ${fmtElapsed(a.bootPhaseMs ?? 0)}`);
      }
      // Enrollment clustering (R1).
      const enrolled = data.accounts
        .filter((a) => a.enrolledAt !== undefined)
        .sort((x, y) => (x.enrolledAt ?? 0) - (y.enrolledAt ?? 0));
      if (enrolled.length > 1) {
        const newest = enrolled[enrolled.length - 1].enrolledAt ?? 0;
        const oldest = enrolled[0].enrolledAt ?? 0;
        const spanMin = Math.round((newest - oldest) / 60_000);
        const warning = spanMin < 30 ? " ⚠ R1: clustered enrollments" : "";
        console.log(`  enrolled: span ${spanMin} min over ${enrolled.length} accounts${warning}`);
      }
      return;
    }

    case "drain": {
      if (!id) throw new Error("usage: fleet drain <id> [--to <id|auto>] [--dry-run] [-y]");
      const target = getFlag(argv, "--to") ?? "auto";
      const dryRun = argv.includes("--dry-run");
      if (dryRun) {
        console.log(`  drain (dry-run): "${id}" -> "${target}"`);
      } else {
        console.log(`  draining "${id}" -> "${target}"`);
        console.log(`  cost:  each moved session replays its full history on the target (one-time)`);
      }
      const out = (await post(`/v1/fleet/${id}/drain`, { to: target, dryRun })) as {
        moved?: number;
        target?: string;
        dryRun?: boolean;
      };
      if (dryRun) {
        console.log(`  plan:  would move ${out.moved ?? 0} session(s) to "${out.target ?? target}"`);
      } else {
        console.log(`  done:  ${out.moved ?? 0} session(s) moved`);
      }
      return;
    }

    case "remove":
      if (!id) throw new Error("usage: fleet remove <id> [--purge]");
      await post(`/v1/fleet/${id}/remove`);
      console.log(`"${id}" removed from the fleet (profile dir left on disk)`);
      return;

    default:
      process.stderr.write(
        "usage: tab-bridge fleet add|list|open|login|proxy|surface|doctor|drain|remove ...\n"
      );
      process.exit(2);
  }
}

/** Fetch the account's raw proxy string via the operator-only debug endpoint.
 * Returns null when the endpoint is unavailable (older bridge, fleet
 * disabled, or the CLI lacks permission) — probeExitIp then falls back to
 * the direct path. Never prints or logs the credential. */
async function fetchRawProxy(
  base: string,
  headers: Record<string, string>,
  id: string
): Promise<string | null> {
  try {
    const res = await fetch(`${base}/v1/fleet/${id}/_debug_proxy`, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { proxy?: string | null };
    return typeof body.proxy === "string" ? body.proxy : null;
  } catch {
    return null;
  }
}
