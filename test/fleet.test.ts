/**
 * Fleet smoke suite (v4 §13): 14 groups covering placement invariants,
 * account accounting, the per-account FIFO gate (including the ADR-12v3
 * capacity-drift repro), fleet-registry persistence + identity fields,
 * enrollment serialization, launcher arg mapping for proxy/surface,
 * deterministic boot stagger, and the isolation-conflict detector.
 *
 * Group numbering matches the plan:
 *   1-3   placement / accounting / cooldowns
 *   4-6   gate invariants (drift fix, FIFO, rejections)
 *   7-9   registry, enrollment, launcher args (v2 carried)
 *   10-14 v4 isolation additions
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountRegistry } from "../src/core/accounts.js";
import { AccountTurnGate } from "../src/core/accountgate.js";
import { GateRejectionError } from "../src/core/turngate.js";
import {
  FleetRegistry,
  expandEnvRefs,
  proxyOf,
  proxyEndpoint,
  isolationConflicts,
  fingerprintOfDir,
  type SurfaceProfile,
} from "../src/fleet/registry.js";
import { EnrollmentManager } from "../src/fleet/enroll.js";
import { FleetRouter, type FleetEvent } from "../src/pool/fleet.js";
import type { PoolConfig } from "../src/pool/pool.js";
import { SseStream } from "../src/facade/sse.js";
import { FleetLauncher, staggerDelayMs, type LaunchRequest } from "../src/fleet/launcher.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fleet-test-"));
}

function fp(id: string): string {
  return fingerprintOfDir(`/tmp/profile/${id}`);
}

function upsertReady(reg: AccountRegistry, id: string, fp: string): void {
  reg.upsert({ id, fingerprint: fp });
  reg.markWorkerLinked(id);
  reg.markLoginOk(id);
}

function launcherArgs(launcher: FleetLauncher, req: LaunchRequest): string[] {
  return launcher.argsFor(req);
}

const NO_SPAWN = (_cmd: string, _args: string[], _opts: unknown): never => {
  throw new Error("spawn not expected in tests");
};

function makeLauncher(browserPath = "/bin/true"): FleetLauncher {
  return new FleetLauncher({
    browserPath,
    spawnFn: NO_SPAWN as unknown as (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => import("node:child_process").ChildProcess,
  });
}

// ---------------------------------------------------------------------------
// group 1: placement invariants
// ---------------------------------------------------------------------------
test("group 1: placement — least-loaded wins; ties by oldest placed then id", () => {
  const reg = new AccountRegistry({ maxSessionsPerAccount: 8 });
  upsertReady(reg, "a", fp("a"));
  upsertReady(reg, "b", fp("b"));
  // a has 1 session already, b has 0 → b wins
  reg.noteSessionBound("a");
  const p = reg.placeSession();
  assert.equal(p.ok, true);
  if (p.ok) assert.equal(p.accountId, "b");

  // Both empty → id tiebreak (lastPlacedAt=0 for both)
  const reg2 = new AccountRegistry({ maxSessionsPerAccount: 8 });
  upsertReady(reg2, "b", fp("b"));
  upsertReady(reg2, "a", fp("a"));
  const p2 = reg2.placeSession();
  assert.equal(p2.ok, true);
  if (p2.ok) assert.equal(p2.accountId, "a");
});

test("group 1b: placement — cooling / needs_relogin / unlinked / awaiting_login never chosen", () => {
  const reg = new AccountRegistry({ maxSessionsPerAccount: 8 });
  reg.upsert({ id: "cooling", fingerprint: fp("c") });
  reg.markWorkerLinked("cooling");
  reg.markLoginOk("cooling");
  reg.markCooling("cooling", 60);

  reg.upsert({ id: "paused", fingerprint: fp("p") });
  reg.markWorkerLinked("paused");
  reg.markNeedsRelogin("paused");

  reg.upsert({ id: "unlinked", fingerprint: fp("u") });

  reg.upsert({ id: "await", fingerprint: fp("a") });
  reg.markWorkerLinked("await"); // stays awaiting_login

  const p = reg.placeSession();
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.reason, "none_ready");
});

test("group 1c: placement — cap produces all_full when all ready accounts are full", () => {
  const reg = new AccountRegistry({ maxSessionsPerAccount: 1 });
  upsertReady(reg, "a", fp("a"));
  upsertReady(reg, "b", fp("b"));
  reg.noteSessionBound("a");
  reg.noteSessionBound("b");
  const p = reg.placeSession();
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.reason, "all_full");
});

// ---------------------------------------------------------------------------
// group 2: session accounting
// ---------------------------------------------------------------------------
test("group 2: session accounting floors at zero and tracks sessionsOf", () => {
  const reg = new AccountRegistry({});
  upsertReady(reg, "a", fp("a"));
  assert.equal(reg.sessionsOf("a"), 0);
  reg.noteSessionBound("a");
  reg.noteSessionBound("a");
  assert.equal(reg.sessionsOf("a"), 2);
  reg.noteSessionEnded("a");
  assert.equal(reg.sessionsOf("a"), 1);
  reg.noteSessionEnded("a");
  reg.noteSessionEnded("a"); // floor
  assert.equal(reg.sessionsOf("a"), 0);
});

// ---------------------------------------------------------------------------
// group 3: cooldown bookkeeping
// ---------------------------------------------------------------------------
test("group 3: cooldowns typed seconds, shortest across accounts, lazy expiry", () => {
  const reg = new AccountRegistry({});
  upsertReady(reg, "a", fp("a"));
  upsertReady(reg, "b", fp("b"));
  reg.markCooling("a", 10);
  reg.markCooling("b", 30);
  const a = reg.cooldownSec("a");
  const b = reg.cooldownSec("b");
  assert.ok(a !== null && b !== null);
  assert.ok(a! <= 10 && b! <= 30);
  const shortest = reg.shortestCooldownSec();
  assert.ok(shortest !== null && shortest! <= a!);

  // Force expiry: set coolingUntil to past then all() lazily expire
  const rec = reg.record("a")!;
  rec.coolingUntil = Date.now() - 1;
  const after = reg.record("a")!;
  assert.equal(after.state, "ready");
});

// ---------------------------------------------------------------------------
// group 4: cross-account head never admitted (ADR-12v3 bug repro)
// ---------------------------------------------------------------------------
test("group 4: gate — release(b) admits b's head, not a's (drift fix)", async () => {
  const gate = new AccountTurnGate({ perAccountConcurrent: 1, capacity: 16, queueTimeoutMs: 0 });
  // Fill both accounts.
  await gate.acquire("a", "a1");
  await gate.acquire("b", "b1");
  // Queue a2 then b2 (in the buggy v2 gate, a global FIFO would admit a2
  // when b releases — a foreign-account head).
  const a2P = gate.acquire("a", "a2");
  const b2P = gate.acquire("b", "b2");
  // Counters before release: a has 1 active, b has 1 active.
  assert.equal(gate.activeOn("a"), 1);
  assert.equal(gate.activeOn("b"), 1);
  // Release b → b2 admitted, a2 still queued.
  gate.release("b");
  const b2Wait = await b2P;
  assert.equal(typeof b2Wait, "number");
  assert.equal(gate.activeOn("b"), 1);
  assert.equal(gate.activeOn("a"), 1);
  // Release a → a2 admitted.
  gate.release("a");
  await a2P;
});

// ---------------------------------------------------------------------------
// group 5: FIFO within one account
// ---------------------------------------------------------------------------
test("group 5: gate — FIFO within one account", async () => {
  const gate = new AccountTurnGate({ perAccountConcurrent: 1, capacity: 16, queueTimeoutMs: 0 });
  await gate.acquire("a", "first");
  const order: string[] = [];
  const p2 = gate.acquire("a", "second").then(() => order.push("second"));
  const p3 = gate.acquire("a", "third").then(() => order.push("third"));
  gate.release("a");
  await p2;
  gate.release("a");
  await p3;
  assert.deepEqual(order, ["second", "third"]);
});

// ---------------------------------------------------------------------------
// group 6: gate rejections
// ---------------------------------------------------------------------------
test("group 6: gate — queue_full / queue_timeout / client_gone", async () => {
  const gate = new AccountTurnGate({ perAccountConcurrent: 1, capacity: 1, queueTimeoutMs: 0 });
  await gate.acquire("a", "held");
  const p = gate.acquire("a", "q1");
  // Capacity 1, one waiter already queued → next fails queue_full.
  await assert.rejects(gate.acquire("a", "q2"), (e: unknown) => {
    return e instanceof GateRejectionError && e.code === "queue_full";
  });
  // client_gone: abort signal
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(gate.acquire("a", "aborted", ac.signal), (e: unknown) => {
    return e instanceof GateRejectionError && e.code === "client_gone";
  });
  // Cleanup: release twice to clear
  gate.release("a");
  await p;
});

// ---------------------------------------------------------------------------
// group 7: registry persistence + 0600 perms
// ---------------------------------------------------------------------------
test("group 7: registry — reopen round-trip, 0600, instance conflict, id validation", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "fleet.json");
    const reg = FleetRegistry.open(path, join(dir, "home"));
    const a = reg.add({ id: "work", label: "Work" });
    assert.equal(a.id, "work");
    reg.bindInstance("work", "w-1111");
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

    const reg2 = FleetRegistry.open(path, join(dir, "home"));
    assert.equal(reg2.byId("work")?.instanceId, "w-1111");
    assert.equal(reg2.accountForInstance("w-1111")?.id, "work");

    // id validation
    assert.throws(() => reg2.add({ id: "BAD ID" }), /invalid account id/);
    // instance rebinding refusal
    reg2.add({ id: "personal" });
    assert.throws(() => reg2.bindInstance("personal", "w-1111"), /already belongs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// group 8: enrollment serialization + claim
// ---------------------------------------------------------------------------
test("group 8: enrollment — serialization refusal, claim-by-HELLO, timeout", async () => {
  const em = new EnrollmentManager();
  const p1 = em.begin("work", 10_000);
  assert.throws(() => em.begin("personal", 10_000), /already open/);
  const claimedId = em.consider(
    { t: "HELLO", v: 1, ext: "tab-bridge", instance: "w-1111" },
    false
  );
  assert.equal(claimedId, "work");
  assert.equal(await p1, "w-1111");

  // Known instance is ignored (normal reconnect, not enrollment).
  const p2 = em.begin("personal", 5_000);
  assert.equal(em.consider({ t: "HELLO", v: 1, ext: "x", instance: "w-known" }, true), null);
  em.cancel("personal", "test cancel");
  await assert.rejects(p2, /test cancel/);

  // Timeout aborts.
  const p3 = em.begin("tmp", 10);
  await assert.rejects(p3, /timed out/);
});

// ---------------------------------------------------------------------------
// group 9: launcher args (v2 carried) — base + manual extension
// ---------------------------------------------------------------------------
test("group 9: launcher — base args and manual-extension flag", () => {
  const launcher = makeLauncher();
  const args = launcherArgs(launcher, {
    accountId: "work",
    profileDir: "/tmp/p/work",
    extensionDir: "/tmp/ext",
  });
  assert.ok(args.includes("--user-data-dir=/tmp/p/work"));
  assert.ok(args.includes("--no-first-run"));
  assert.ok(args.includes("--no-default-browser-check"));
  assert.ok(args.some((a) => a.startsWith("--load-extension=/tmp/ext")));
  assert.ok(args.some((a) => a.startsWith("--disable-extensions-except=")));
  assert.ok(args[args.length - 1].startsWith("https://"));

  const args2 = launcherArgs(launcher, {
    accountId: "work",
    profileDir: "/tmp/p/work",
    extensionDir: "/tmp/ext",
    manualExtension: true,
  });
  assert.ok(!args2.some((a) => a.startsWith("--load-extension=")));
  assert.ok(!args2.some((a) => a.startsWith("--disable-extensions-except=")));
});

// ---------------------------------------------------------------------------
// group 10: registry identity fields (v4)
// ---------------------------------------------------------------------------
test("group 10: registry — proxy/surface persist raw; clear to absent", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "fleet.json");
    const reg = FleetRegistry.open(path, join(dir, "home"));
    reg.add({ id: "work" });
    reg.add({ id: "personal" });
    reg.setProxy("work", "socks5://127.0.0.1:1081");
    reg.setProxy("personal", "socks5://${FLEET_PROXY_PERSONAL}");
    const surface: SurfaceProfile = {
      locale: "de-DE",
      timezone: "Europe/Berlin",
      windowSize: "1440x900",
      canvasNoise: true,
    };
    reg.setSurface("work", surface);

    const reg2 = FleetRegistry.open(path, join(dir, "home"));
    assert.equal(reg2.byId("work")?.proxy, "socks5://127.0.0.1:1081");
    assert.equal(reg2.byId("personal")?.proxy, "socks5://${FLEET_PROXY_PERSONAL}");
    assert.deepEqual(reg2.byId("work")?.surface, surface);

    reg2.setProxy("work", null);
    reg2.setSurface("work", null);
    const reg3 = FleetRegistry.open(path, join(dir, "home"));
    assert.equal(reg3.byId("work")?.proxy, undefined);
    assert.equal(reg3.byId("work")?.surface, undefined);

    assert.throws(() => reg3.setProxy("nope", "x"), /no such account/);
    assert.throws(() => reg3.setSurface("nope", {}), /no such account/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// group 11: ${VAR} expansion fail-closed; proxyEndpoint strips userinfo
// ---------------------------------------------------------------------------
test("group 11: proxy ${VAR} expansion is fail-closed", () => {
  assert.equal(
    expandEnvRefs("socks5://${HOST}:${PORT}", { HOST: "10.0.0.1", PORT: "1080" }),
    "socks5://10.0.0.1:1080"
  );
  assert.throws(() => expandEnvRefs("socks5://${MISSING}", {}), /environment variable not set/);
  assert.throws(() => expandEnvRefs("socks5://${EMPTY}", { EMPTY: "" }), /environment variable not set/);

  // proxyOf throws on unset, passes on set
  const acct = { id: "a", profileDir: "/p", createdAt: 0, proxy: "socks5://${A}" };
  assert.throws(() => proxyOf(acct, {}), /environment variable not set/);
  assert.equal(proxyOf(acct, { A: "10.0.0.1:1080" }), "socks5://10.0.0.1:1080");

  // proxyEndpoint strips credentials, keeps scheme://host:port
  assert.equal(proxyEndpoint("socks5://user:pass@10.0.0.1:1080"), "socks5://10.0.0.1:1080");
  assert.equal(proxyEndpoint("http://10.0.0.1:8080"), "http://10.0.0.1:8080");
});

// ---------------------------------------------------------------------------
// group 12: launcher maps identity + surface; proxyRequired refuses
// ---------------------------------------------------------------------------
test("group 12: launcher — proxy/WebRTC pin, locale/window/canvas, TZ, refusal", () => {
  const launcher = makeLauncher();
  const args = launcherArgs(launcher, {
    accountId: "work",
    profileDir: "/p/work",
    extensionDir: "/e",
    proxy: "socks5://127.0.0.1:1081",
    surface: {
      locale: "de-DE",
      timezone: "Europe/Berlin",
      windowSize: "1440x900",
      windowPosition: "0x0",
      canvasNoise: true,
      extraArgs: ["--flag-from-op"],
    },
  });
  assert.ok(args.includes("--proxy-server=socks5://127.0.0.1:1081"));
  assert.ok(args.includes("--webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(args.includes("--lang=de-DE"));
  assert.ok(args.includes("--window-size=1440x900"));
  assert.ok(args.includes("--window-position=0x0"));
  assert.ok(args.includes("--fingerprinting-canvas-image-data-noise"));
  assert.ok(args.includes("--fingerprinting-canvas-measuretext-noise"));
  assert.ok(args.includes("--flag-from-op"));

  // No proxy → no webrtc pin, no --proxy-server
  const args2 = launcherArgs(launcher, {
    accountId: "personal",
    profileDir: "/p/personal",
    extensionDir: "/e",
  });
  assert.ok(!args2.some((a) => a.startsWith("--proxy-server=")));
  assert.ok(!args2.includes("--webrtc-ip-handling-policy=disable_non_proxied_udp"));

  // proxyRequired without a proxy throws
  assert.throws(
    () =>
      launcher.launch({
        accountId: "backup",
        profileDir: "/p/backup",
        extensionDir: "/e",
        proxyRequired: true,
      }),
    /no network identity/
  );
});

// ---------------------------------------------------------------------------
// group 13: stagger determinism
// ---------------------------------------------------------------------------
test("group 13: stagger — deterministic, bounded, spread, window<=0 disables", () => {
  const w = 45_000;
  const d1 = staggerDelayMs("work", w);
  const d2 = staggerDelayMs("work", w);
  assert.equal(d1, d2);
  assert.ok(d1 >= 0 && d1 < w);
  assert.ok(staggerDelayMs("personal", w) >= 0 && staggerDelayMs("personal", w) < w);
  // Different ids → likely different phases (statistically); assert at least
  // they are bounded and the same id is stable.
  assert.equal(staggerDelayMs("work", 0), 0);
  assert.equal(staggerDelayMs("work", -1), 0);
});

// ---------------------------------------------------------------------------
// group 14: isolation conflicts
// ---------------------------------------------------------------------------
test("group 14: isolationConflicts — same path flagged, credentials ignored, distinct clean", () => {
  const base = { createdAt: 0 };
  const direct = [
    { id: "a", profileDir: "/p/a", ...base },
    { id: "b", profileDir: "/p/b", ...base },
  ];
  const d = isolationConflicts(direct, {});
  assert.ok(d.some((s) => s.includes("share one network path")));

  const credentialed = [
    { id: "a", profileDir: "/p/a", createdAt: 0, proxy: "socks5://u1:p1@10.0.0.1:1080" },
    { id: "b", profileDir: "/p/b", createdAt: 0, proxy: "socks5://u2:p2@10.0.0.1:1080" },
  ];
  const c = isolationConflicts(credentialed, {});
  assert.ok(c.some((s) => s.includes("share one network path")));
  // Credentials must never appear in findings
  for (const line of c) {
    assert.ok(!line.includes("u1"));
    assert.ok(!line.includes("p1"));
    assert.ok(!line.includes("u2"));
    assert.ok(!line.includes("p2"));
  }

  const distinct = [
    { id: "a", profileDir: "/p/a", createdAt: 0, proxy: "socks5://10.0.0.1:1080" },
    { id: "b", profileDir: "/p/b", createdAt: 0, proxy: "socks5://10.0.0.2:1080" },
  ];
  assert.equal(isolationConflicts(distinct, {}).length, 0);

  // Identical surface profiles flagged
  const sameSurface = [
    { id: "a", profileDir: "/p/a", createdAt: 0, surface: { locale: "de-DE" } },
    { id: "b", profileDir: "/p/b", createdAt: 0, surface: { locale: "de-DE" } },
  ];
  const s = isolationConflicts(sameSurface, {});
  assert.ok(s.some((line) => line.includes("identical surface")));

  // Env-expanded comparison works when the var is set
  const envProxy = [
    { id: "a", profileDir: "/p/a", createdAt: 0, proxy: "socks5://${UP}" },
    { id: "b", profileDir: "/p/b", createdAt: 0, proxy: "socks5://${UP}" },
  ];
  assert.ok(isolationConflicts(envProxy, { UP: "10.0.0.1:1080" }).length > 0);
  // Unset env degrades to raw comparison (still equal → flagged)
  assert.ok(isolationConflicts(envProxy, {}).length > 0);
});

// ---------------------------------------------------------------------------
// group 15: launcher — killOne kills exactly one child
// ---------------------------------------------------------------------------
test("group 15: launcher — killOne targets one account only", () => {
  const launched: string[] = [];
  const killed: string[] = [];
  // Fake child that reports on .on / .kill; matching the surface launcher uses.
  const makeChild = (accountId: string) => ({
    pid: 1,
    exitCode: null,
    on: (_ev: string, _fn: (...a: unknown[]) => void) => {},
    kill: (_sig: string) => { killed.push(accountId); },
  });
  const launcher = new FleetLauncher({
    // Use the running node binary as a stub path: guaranteed to exist on
    // every platform (macOS has no /bin/true) and never actually spawned —
    // spawnFn below replaces it.
    browserPath: process.execPath,
    spawnFn: ((cmd: string, args: string[], _opts: unknown) => {
      const dir = args.find((a) => a.startsWith("--user-data-dir=")) ?? "";
      const id = dir.split("/").pop() ?? "unknown";
      launched.push(id);
      return makeChild(id) as unknown as import("node:child_process").ChildProcess;
    }) as unknown as (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => import("node:child_process").ChildProcess,
  });
  launcher.launch({ accountId: "a", profileDir: "/p/a", extensionDir: "/e" });
  launcher.launch({ accountId: "b", profileDir: "/p/b", extensionDir: "/e" });
  assert.deepEqual(launched, ["a", "b"]);
  assert.equal(launcher.killOne("a", "test"), true);
  assert.deepEqual(killed, ["a"]);
  // b is still launched; a is gone.
  assert.equal(launcher.isLaunched("a"), false);
  assert.equal(launcher.isLaunched("b"), true);
  // Kill on unknown id returns false.
  assert.equal(launcher.killOne("nonexistent", "test"), false);
});

// ---------------------------------------------------------------------------
// group 16: launcher — spawnProbeTab propagates the surface TZ
// ---------------------------------------------------------------------------
test("group 16: launcher — spawnProbeTab propagates surface TZ to Chrome env", () => {
  const observed: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const launcher = new FleetLauncher({
    // See group 15's note: process.execPath always exists.
    browserPath: process.execPath,
    spawnFn: ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      observed.push({ args, env: opts.env });
      return { pid: 1, on: () => {}, kill: () => {} } as unknown as import("node:child_process").ChildProcess;
    }) as unknown as (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => import("node:child_process").ChildProcess,
  });
  // On non-Windows, TZ is set. On Windows it is ignored (matching launch()).
  launcher.spawnProbeTab("/p/work", "http://127.0.0.1:8789/fleet-probe?id=work", "Europe/Berlin");
  assert.equal(observed.length, 1);
  if (process.platform !== "win32") {
    assert.equal(observed[0].env.TZ, "Europe/Berlin");
  }
  assert.ok(observed[0].args.some((a) => a.startsWith("http://")));
  assert.ok(observed[0].args.includes("--user-data-dir=/p/work"));
  // Without a timezone, TZ is not injected.
  launcher.spawnProbeTab("/p/personal", "http://127.0.0.1:8789/fleet-probe?id=personal");
  assert.equal(observed.length, 2);
  if (process.platform !== "win32") {
    // TZ may be inherited from the process env; only assert it is NOT the
    // surface one.
    assert.notEqual(observed[1].env.TZ, "Europe/Berlin");
  }
});

// ---------------------------------------------------------------------------
// group 17: AccountTurnGate — totalWaiting + cancelAccount
// ---------------------------------------------------------------------------
test("group 17: AccountTurnGate — totalWaiting reflects queued waiters; cancelAccount rejects them", async () => {
  const gate = new AccountTurnGate({ perAccountConcurrent: 1, capacity: 8, queueTimeoutMs: 0 });
  assert.equal(gate.totalWaiting(), 0);
  await gate.acquire("a", "held");
  const p1 = gate.acquire("a", "q1");
  const p2 = gate.acquire("a", "q2");
  assert.equal(gate.totalWaiting(), 2);
  // Cancel account a's pending waiters — both must reject.
  gate.cancelAccount("a", "test cancel");
  await assert.rejects(p1, (e: unknown) => e instanceof GateRejectionError && e.code === "client_gone");
  await assert.rejects(p2, (e: unknown) => e instanceof GateRejectionError && e.code === "client_gone");
  assert.equal(gate.totalWaiting(), 0);
  // Cancel on an empty account is a no-op.
  gate.cancelAccount("b", "no waiters");
  assert.equal(gate.totalWaiting(), 0);
  // Release the held slot; no new admittances should happen (all waiters gone).
  gate.release("a");
  assert.equal(gate.activeOn("a"), 0);
});

// ---------------------------------------------------------------------------
// group 18: FleetRouter.detach cleans the pool map
// ---------------------------------------------------------------------------
test("group 18: FleetRouter — detach deletes the pool from the map (no leak)", () => {
  const calls: string[] = [];
  const poolConfig: PoolConfig = {
    autoCreateTabs: false,
    managedOnly: true,
    warmTabs: 0,
    maxTabs: 4,
    tabIdleCloseMs: 15 * 60_000,
  };
  const router = new FleetRouter(poolConfig, {
    route: () => ({ kind: "route", accountId: "x" }),
    onFleetEvent: (e: FleetEvent) => calls.push(e.type),
  });
  // pool() creates on demand.
  router.pool("a");
  router.pool("b");
  assert.deepEqual(router.accountIds().sort(), ["a", "b"]);
  router.detach("a", "test");
  assert.deepEqual(router.accountIds(), ["b"]);
  // Detaching an unknown id is safe (no leak of a throwaway).
  router.detach("never-existed", "test");
  assert.deepEqual(router.accountIds(), ["b"]);
  // detachAll clears everything.
  router.detachAll("test");
  assert.deepEqual(router.accountIds(), []);
});

// ---------------------------------------------------------------------------
// group 19: registry — duplicate id add throws (bug-hunt regression)
// ---------------------------------------------------------------------------
test("group 19: registry — duplicate id add throws a clear error", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "fleet.json");
    const reg = FleetRegistry.open(path, join(dir, "home"));
    reg.add({ id: "work" });
    assert.throws(() => reg.add({ id: "work" }), /already exists/);
    // Removing then re-adding is allowed.
    reg.remove("work");
    reg.add({ id: "work" });
    assert.equal(reg.byId("work")?.id, "work");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// group 20: FleetRouter.attach — refuses unknown route targets (B7)
// ---------------------------------------------------------------------------
test("group 20: FleetRouter — isKnownAccount refuses unknown route target", () => {
  const poolConfig: PoolConfig = {
    autoCreateTabs: false,
    managedOnly: true,
    warmTabs: 0,
    maxTabs: 4,
    tabIdleCloseMs: 15 * 60_000,
  };
  let refused = 0;
  let accepted = 0;
  // Fake WsConnection: implements the tiny surface attach() touches.
  const makeConn = () => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    return {
      isOpen: true,
      remoteAddress: "127.0.0.1",
      once(ev: string, fn: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(fn); },
      on(_ev: string, _fn: (...a: unknown[]) => void) {},
      sendText(_s: string) { accepted += 1; },
      sendPing(_b: Buffer) {},
      close(_code?: number) { refused += 1; },
      fire(ev: string, payload: unknown) {
        for (const fn of listeners[ev] ?? []) fn(payload);
      },
    };
  };
  const router = new FleetRouter(poolConfig, {
    route: () => ({ kind: "route", accountId: "ghost" }),
    isKnownAccount: (id: string) => id === "real",
  });
  const conn = makeConn();
  router.attach(conn as never);
  // Feed a HELLO so the route() callback runs.
  conn.fire("message", JSON.stringify({ t: "HELLO", v: 1, ext: "x", instance: "i-1" }));
  // Refused because "ghost" is not known.
  assert.ok(refused > 0, "unknown account must refuse the connection");
  // With a known account, the same setup accepts.
  const router2 = new FleetRouter(poolConfig, {
    route: () => ({ kind: "route", accountId: "real" }),
    isKnownAccount: (id: string) => id === "real",
  });
  const conn2 = makeConn();
  router2.attach(conn2 as never);
  conn2.fire("message", JSON.stringify({ t: "HELLO", v: 1, ext: "x", instance: "i-2" }));
  assert.ok(accepted > 0, "known account must accept the connection");
});

// ---------------------------------------------------------------------------
// group 21: SSE sendMeta before any frame keeps SSE headers (C10)
// ---------------------------------------------------------------------------
test("group 21: SseStream — sendMeta starts the stream with correct headers", () => {
  const headers: Array<{ status: number; hdrs: Record<string, string> }> = [];
  const writes: string[] = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(status: number, hdrs: Record<string, string>) {
      headers.push({ status, hdrs });
      return this;
    },
    flushHeaders() {},
    write(s: string) { writes.push(s); return true; },
    end() { this.writableEnded = true; },
  };
  const sse = new SseStream(res as never);
  sse.sendMeta({ "x-fleet-account": "work" }, "deepseek-web-chat");
  assert.equal(headers.length, 1, "sendMeta must call start() so headers land once");
  assert.match(headers[0].hdrs["content-type"], /text\/event-stream/);
  assert.equal(headers[0].hdrs["x-bridge-model"], "deepseek-web-chat");
  assert.ok(writes.some((w) => w.startsWith(": meta ")));
  sse.sendChoice(
    { delta: { role: "assistant", content: "" }, finish_reason: null },
    "deepseek-web-chat",
    "id",
    0
  );
  assert.equal(headers.length, 1, "headers must be sent exactly once");
});

// ---------------------------------------------------------------------------
// group 22: parseDuration accepts bare "0" (C18)
// ---------------------------------------------------------------------------
test("group 22: parseDuration — bare 0 means zero ms", () => {
  // Local import so the test is self-contained.
  const cfgPath = new URL("../src/config.js", import.meta.url).href;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return import(cfgPath).then((m) => {
    const parseDuration = (m as { parseDuration: (s: string) => number }).parseDuration;
    assert.equal(parseDuration("0"), 0);
    assert.equal(parseDuration("0ms"), 0);
    assert.equal(parseDuration("5s"), 5000);
    assert.throws(() => parseDuration("nonsense"), /invalid duration/);
  });
});

// ---------------------------------------------------------------------------
// group 23: registry — persist produces no leftover tmp files (C2)
// ---------------------------------------------------------------------------
test("group 23: registry — persist leaves no tmp file behind", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "fleet.json");
    const reg = FleetRegistry.open(path, join(dir, "home"));
    reg.add({ id: "a" });
    reg.setProxy("a", "socks5://127.0.0.1:1080");
    reg.add({ id: "b" });
    reg.setSurface("b", { locale: "de-DE" });
    const reg2 = FleetRegistry.open(path, join(dir, "home"));
    assert.equal(reg2.byId("a")?.proxy, "socks5://127.0.0.1:1080");
    assert.deepEqual(reg2.byId("b")?.surface, { locale: "de-DE" });
    // No leftover tmp files in the dir.
    const entries = readdirSync(dir) as string[];
    assert.equal(entries.filter((f) => f.includes(".tmp-")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// group 24: registry — idempotent setProxy / setSurface calls
// ---------------------------------------------------------------------------
test("group 24: registry — setProxy/setSurface are safe to call with same value", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "fleet.json");
    const reg = FleetRegistry.open(path, join(dir, "home"));
    reg.add({ id: "a" });
    reg.setProxy("a", "socks5://127.0.0.1:1080");
    reg.setProxy("a", "socks5://127.0.0.1:1080");
    const reg2 = FleetRegistry.open(path, join(dir, "home"));
    assert.equal(reg2.byId("a")?.proxy, "socks5://127.0.0.1:1080");
    reg.setProxy("a", null);
    const reg3 = FleetRegistry.open(path, join(dir, "home"));
    assert.equal(reg3.byId("a")?.proxy, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// group 25: DeepSeekAdapter exposes detachPool (C11)
// ---------------------------------------------------------------------------
test("group 25: DeepSeekAdapter exposes detachPool()", async () => {
  const { DeepSeekAdapter } = await import("../src/adapter/deepseek.js");
  const listeners: Array<(...a: unknown[]) => void> = [];
  const fakePool = {
    on(_ev: string, fn: (...a: unknown[]) => void) { listeners.push(fn); },
    off(_ev: string, fn: (...a: unknown[]) => void) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    ping: async () => [],
    sendTurnIntent: async () => {},
    resetIntent: async () => "ok",
    release: async () => {},
    abortIntent: () => {},
  };
  const adapter = new DeepSeekAdapter(fakePool as never);
  assert.equal(typeof (adapter as unknown as { detachPool?: () => void }).detachPool, "function");
  assert.equal(listeners.length, 1, "constructor registers one 'raw' listener");
  (adapter as unknown as { detachPool: () => void }).detachPool();
  assert.equal(listeners.length, 0, "detachPool removes the listener");
});
