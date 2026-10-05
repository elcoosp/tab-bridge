/**
 * tab-bridge fleet — manage the profile fleet.
 *   fleet add <id> [--label ...] [--proxy <url>]     enroll + launch + login
 *   fleet list                                       table of accounts + states
 *   fleet open <id>                                  open the account's window
 *   fleet login <id>                                 guided re-login
 *   fleet proxy <id> <url|off>                       set/clear network identity
 *   fleet surface <id> [flags]                       set presentation surface
 *   fleet doctor                                     isolation findings + probe
 *   fleet drain <id> [--to <id|auto>]                move its sessions (priced)
 *   fleet remove <id> [--purge]                      unbind (+ purge profile dir)
 * Flags: --url http://127.0.0.1:8789  --key-env TAB_BRIDGE_KEY
 *
 * Thin HTTP client: the running bridge owns the fleet file; the CLI never
 * writes it directly, so there is exactly one writer.
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

interface AccountRow {
  id: string;
  state: string;
  sessions: number;
  awaitingHuman?: boolean;
}

async function waitForReady(
  base: string,
  headers: Record<string, string>,
  id: string,
  deadlineMs: number
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${base}/v1/accounts`, { headers });
    const data = (await res.json()) as { accounts: Array<{ id: string; state: string }> };
    const acct = data.accounts.find((a) => a.id === id);
    if (acct?.state === "ready") return;
    if (Date.now() > deadline) {
      throw new Error(`"${id}" did not reach ready within ${deadlineMs}ms (state: ${acct?.state ?? "unknown"})`);
    }
  }
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
      if (!id) throw new Error("usage: fleet add <id> [--label ...] [--proxy ...]");
      console.log(`  fleet:  enrolling "${id}"...`);
      const body: Record<string, unknown> = { id };
      const label = getFlag(argv, "--label");
      if (label !== undefined) body.label = label;
      const proxy = getFlag(argv, "--proxy");
      if (proxy !== undefined) body.proxy = proxy;
      await post("/v1/fleet/enroll", body);
      console.log("  launch: browser window opening - log into the account in that window");
      return waitForReady(base, headers, id, 10 * 60_000);
    }
    case "list": {
      const data = (await getJson("/v1/accounts")) as { accounts: AccountRow[] };
      for (const a of data.accounts) {
        process.stdout.write(
          `${a.id}\t${a.state}${a.awaitingHuman ? "  (needs a human)" : ""}\t${a.sessions}\n`
        );
      }
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
      console.log(`window opening for "${id}" - complete the login; the bridge takes it from there`);
      return;
    case "proxy": {
      if (!id) throw new Error("usage: fleet proxy <id> <url|off>");
      const value = argv[3];
      await post(`/v1/fleet/${id}/proxy`, { proxy: value === "off" ? null : value });
      console.log(`  proxy:  "${id}" network identity updated (stored raw; expanded at launch)`);
      return;
    }
    case "surface":
      if (!id) throw new Error("usage: fleet surface <id> [--locale L] [--tz Z] ...");
      console.log(`  surface: "${id}" presentation update endpoint not yet wired`);
      return;
    case "doctor":
      console.log("  fleet doctor - endpoint not yet wired");
      return;
    case "drain":
      if (!id) throw new Error("usage: fleet drain <id> [--to <id|auto>]");
      await post(`/v1/fleet/${id}/drain`, { to: getFlag(argv, "--to") ?? "auto" });
      return;
    case "remove":
      if (!id) throw new Error("usage: fleet remove <id>");
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
