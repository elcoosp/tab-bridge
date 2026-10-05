#!/usr/bin/env node
/**
 * Real-browser fleet E2E harness.
 *
 * Verifies the fleet's plumbing against two real Chromium profiles:
 * process launch, distinct --user-data-dir and surface args, extension
 * load, WS HELLO routing to distinct WorkerPools, per-account enrollment,
 * fingerprint probe, targeted removal, and shutdown cleanup.
 *
 * What this does NOT verify (and cannot, inside the captcha boundary
 * this project's design respects — C1 in the plan):
 *   - the DeepSeek DOM itself (composer, send button, SSE, rate limits)
 *   - a real chat turn round-trip
 *   - 429 cooldown behavior
 *   - login-wall detection
 * Those remain human-driven drills; see docs/RUNBOOK.md §8.
 *
 * Package manager: the harness never invokes npm or pnpm. The build step
 * calls node_modules/.bin/tsc directly; the bridge is launched with the
 * local node binary against dist/. This keeps the harness agnostic of
 * pnpm-vs-npm and portable across CI images that ship only one of them.
 *
 * Environment:
 *   E2E_FLEET_KEEP=1           keep the temp dir on exit (for inspection)
 *   E2E_FLEET_BROWSER=<path>   override the browser binary
 *   E2E_FLEET_TIMEOUT_MS=...   per-step timeout (default 45_000)
 *   E2E_FLEET_PORT=...         bridge port (default random in 19000..19999)
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  at least one failed
 *   2  skipped (no Chromium-family browser available)
 *
 * Run via: pnpm e2e-fleet  (or)  node scripts/e2e-fleet.mjs
 */

import { createHash } from "node:crypto";
import { execFileSync, execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const KEEP = process.env.E2E_FLEET_KEEP === "1";
const TIMEOUT_MS = Number(process.env.E2E_FLEET_TIMEOUT_MS ?? 45_000);
// The tab-bridge extension dials a FIXED default URL (its chrome.storage.sync
// wsUrl, which ships as ws://127.0.0.1:8789/worker — see extension/README.md).
// The harness MUST bind the same port, or the extension loads and silently
// fails to dial. Default to 8789; E2E_FLEET_PORT is an advanced override
// for operators who have pre-seeded each profile's wsUrl.
const PORT = Number(process.env.E2E_FLEET_PORT ?? 8789);
if (PORT !== 8789) {
  console.log(
    `WARN: E2E_FLEET_PORT=${PORT} differs from the extension's default 8789. ` +
      `The worker will not link unless each profile's chrome.storage.sync.wsUrl ` +
      `has been pre-seeded to ws://127.0.0.1:${PORT}/worker.`,
  );
}
const BROWSER_OVERRIDE = process.env.E2E_FLEET_BROWSER;
// Empty: the harness bridge is keyless (see the spawn call's comment).
// Override to test a keyed bridge — but a fresh profile cannot be told the
// token, so a keyed run will time out at step 4. Kept as a knob for
// forward-compat only.
const API_KEY = "";

const STAGGER_WINDOW_MS = 5_000;
const BRIDGE_URL = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// Tiny test framework
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`;
  console.log(line);
  if (ok) passed++; else failed++;
}
function info(msg) {
  console.log("      " + msg);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replicates FleetLauncher.staggerDelayMs — same hash, same modulo. */
function expectedBootPhaseMs(accountId, windowMs) {
  if (windowMs <= 0) return 0;
  const h = createHash("blake2b512").update(`launch-phase:${accountId}`, "utf8").digest();
  let v = 0n;
  for (const b of h.subarray(0, 8)) v = (v << 8n) | BigInt(b);
  return Number(v % BigInt(windowMs));
}

/** List Chrome processes whose command line contains the given profile dir. */
function listChromePids(profileDir) {
  try {
    const out = execSync("ps -eo pid,command", { encoding: "utf8" });
    const pids = [];
    for (const line of out.split("\n")) {
      if (line.includes(`--user-data-dir=${profileDir}`)) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

/** Poll `pred()` until true or timeout. Returns true on success. */
async function waitFor(pred, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** Fetch JSON. Sends a bearer only when API_KEY is non-empty (forward-compat
 * with keyed bridges); the harness's own bridge runs keyless on loopback. */
async function api(path, init = {}) {
  const headers = {
    "content-type": "application/json",
    ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

console.log("================================================================");
console.log("Real-browser fleet E2E harness");
console.log("================================================================");
console.log(`  port:          ${PORT}`);
console.log(`  stagger:       ${STAGGER_WINDOW_MS}ms`);
console.log(`  timeout/step:  ${TIMEOUT_MS}ms`);
console.log(`  keep:          ${KEEP}`);
console.log("");

// -- Step 0: build ---------------------------------------------------------
console.log("Step 0 — build (node_modules/.bin/tsc)");
const tscBin = join(REPO_ROOT, "node_modules", ".bin", "tsc");
try {
  if (!existsSync(tscBin)) {
    throw new Error(`tsc not found at ${tscBin} — run pnpm install first`);
  }
  execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: REPO_ROOT, stdio: "pipe" });
  check("build succeeds", true);
} catch (e) {
  const stderr =
    e && typeof e.stderr !== "undefined"
      ? e.stderr.toString("utf8")
      : String(e);
  check("build succeeds", false, stderr.split("\n").slice(-3).join(" | "));
  process.exit(1);
}

// -- Step 1: browser detection ---------------------------------------------
console.log("");
console.log("Step 1 — detect a non-stable Chromium-family browser");

let browserPath = null;
try {
  // The harness is ESM; import the compiled launcher directly. Previous
  // versions shelled out with `node -e <multiline>` and the shell mangled
  // the escaped newlines into a literal token, causing a SyntaxError even
  // when a browser WAS available.
  const mod = await import(`file://${REPO_ROOT}/dist/src/fleet/launcher.js`);
  browserPath = mod.FleetLauncher.resolveBrowser(BROWSER_OVERRIDE);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log("");
  console.log(`SKIP — no Chromium-family browser available: ${msg || "(unknown)"}`);
  console.log("");
  console.log("Install Chromium, Chrome Dev, Chrome Canary, Brave, or Edge;");
  console.log("branded Google Chrome *stable* ignores --load-extension since v137 (C5).");
  process.exit(2);
}
check("browser binary found", browserPath.length > 0, browserPath);

// -- Step 2: temp dir ------------------------------------------------------
console.log("");
console.log("Step 2 — setup temp dir + empty fleet file");
const tmpRoot = mkdtempSync(join(tmpdir(), "tb-e2e-fleet-"));
const fleetFile = join(tmpRoot, "fleet.json");
const fleetRoot = join(tmpRoot, "fleet-home");
const sessionsFile = join(tmpRoot, "sessions.json");
writeFileSync(fleetFile, JSON.stringify({ v: 1, accounts: [] }));
info(`temp dir: ${tmpRoot}`);
check("temp dir ready", existsSync(fleetFile));

// -- Step 3: start bridge --------------------------------------------------
console.log("");
console.log("Step 3 — start bridge (fleet enabled, launch=never, stagger=5s)");

// The harness runs the bridge keyless.
//
// Why: a fresh fleet profile's extension dials ws://127.0.0.1:<port>/worker
// with no ?token=. If the bridge requires a bearer, the WS upgrade is
// rejected with HTTP 401 (visible in the SW console as "HTTP Authentication
// failed; no valid credentials available") and the SW flaps forever. There
// is no way for the harness to inject the token into a fresh profile
// without pre-seeding chrome.storage.sync.wsUrl via CDP, which is out of
// scope here. On a real deployment the operator pre-seeds the wsUrl; see
// docs/RUNBOOK.md §3.5. For the E2E, loopback-only + keyless is correct.
const bridgeEnv = { ...process.env };
const bridge = spawn(
  process.execPath,
  [
    join(REPO_ROOT, "dist", "src", "index.js"),
    "serve",
    "--port", String(PORT),
    "--host", "127.0.0.1",
    "--stateful=true",
    "--auto-create-tabs=true",
    "--managed-only=true",
    "--db", sessionsFile,
    "--fleet-file", fleetFile,
    "--fleet-root", fleetRoot,
    "--fleet-launch", "never",
    "--fleet-launch-stagger", `${STAGGER_WINDOW_MS}ms`,
    "--fleet-checkup-timeout", "60s",
    // Absolute path: relative --load-extension was silently ignored by
    // some Chrome builds (the root cause of the first E2E failure).
    "--extension-dir", join(REPO_ROOT, "extension"),
  ],
  {
    cwd: REPO_ROOT,
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const bridgeLog = [];
bridge.stdout.on("data", (b) => bridgeLog.push(b.toString("utf8")));
bridge.stderr.on("data", (b) => bridgeLog.push(b.toString("utf8")));

let bridgeExited = false;
bridge.on("exit", () => { bridgeExited = true; });

const bridgeReady = await waitFor(async () => {
  if (bridgeExited) return false;
  try {
    const res = await fetch(`${BRIDGE_URL}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}, TIMEOUT_MS);
check("bridge started and answered /healthz", bridgeReady);
if (!bridgeReady) {
  const tail = bridgeLog.join("").split("\n").slice(-15).join("\n      ");
  info("bridge log tail:");
  info(tail || "(empty)");
  // Common failure: another process on the same port (e.g. a dev bridge
  // already running on 8789). Make that explicit.
  if (/EADDRINUSE|address already in use/i.test(tail)) {
    info("");
    info(`HINT: port ${PORT} is already in use. Stop the other process, or run`);
    info(`      with E2E_FLEET_PORT=<port> (requires pre-seeding each profile's`);
    info(`      wsUrl). The extension's default URL is ws://127.0.0.1:8789/worker.`);
  }
  try { bridge.kill("SIGKILL"); } catch {}
  if (!KEEP) rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(1);
}

// -- Step 4: enroll two accounts -------------------------------------------
console.log("");
console.log("Step 4 — enroll two accounts (serialized by EnrollmentManager)");

async function enroll(id, surface) {
  await api("/v1/fleet/enroll", {
    method: "POST",
    body: JSON.stringify({ id, surface }),
  });
}

const surfaceWork = {
  locale: "de-DE",
  timezone: "Europe/Berlin",
  windowSize: "1440x900",
  canvasNoise: true,
};
const surfacePersonal = {
  locale: "fr-FR",
  timezone: "Europe/Paris",
  windowSize: "1680x1050",
  canvasNoise: true,
};

try {
  await enroll("work", surfaceWork);
  const workLinked = await waitFor(async () => {
    try {
      const s = await api("/v1/accounts");
      const a = s.accounts.find((x) => x.id === "work");
      return a?.linked === true;
    } catch { return false; }
  }, TIMEOUT_MS);
  check("work enrolled and worker linked", workLinked);
  if (!workLinked) {
    const full = bridgeLog.join("");
    info("");
    info(`DIAGNOSTIC — the worker did not link within ${TIMEOUT_MS}ms.`);
    info("");
    info("Rendered launch args (from FleetLauncher.argsFor):");
    try {
      const mod = await import(`file://${REPO_ROOT}/dist/src/fleet/launcher.js`);
      const probe = new mod.FleetLauncher({ browserPath });
      const args = probe.argsFor({
        accountId: "work",
        profileDir: join(fleetRoot, "work"),
        extensionDir: join(REPO_ROOT, "extension"),
      });
      for (const a of args) info(`  ${a}`);
    } catch (e) {
      info(`  (failed to reconstruct: ${String(e)})`);
    }
    info("");
    info("Worker-link evidence in bridge log:");
    const workerLines = full
      .split("\n")
      .filter(
        (l) =>
          /worker\.|fleet\.enroll|fleet\.launch|worker\.refused|uncaught|unhandled/i.test(l),
      );
    if (workerLines.length === 0) {
      info("  (none — the extension never dialed, or the bridge rejected with");
      info("   no log line, or nothing was captured)");
    } else {
      for (const l of workerLines.slice(-12)) info(`  ${l}`);
    }
    info("");
    info(`Bridge log line count: ${full.split("\n").length}`);
    info(`Bridge exit code observed: ${bridgeExited ? "yes" : "no"}`);
    info("");
  }

  await enroll("personal", surfacePersonal);
  const personalLinked = await waitFor(async () => {
    try {
      const s = await api("/v1/accounts");
      const a = s.accounts.find((x) => x.id === "personal");
      return a?.linked === true;
    } catch { return false; }
  }, TIMEOUT_MS);
  check("personal enrolled and worker linked", personalLinked);
} catch (e) {
  check("enroll both accounts", false, String(e));
}

// -- Step 5: fleet view assertions -----------------------------------------
console.log("");
console.log("Step 5 — /v1/accounts invariants");

const status = await api("/v1/accounts");
const work = status.accounts.find((a) => a.id === "work");
const personal = status.accounts.find((a) => a.id === "personal");

check("two accounts present", !!work && !!personal, `count=${status.accounts.length}`);
check(
  "fingerprints differ (distinct profile dirs)",
  !!work && !!personal && work.fingerprint !== personal.fingerprint,
  work && personal
    ? `${work.fingerprint.slice(0, 8)} / ${personal.fingerprint.slice(0, 8)}`
    : "",
);
check(
  "work surface echoed as configured",
  work?.surface?.locale === "de-DE" && work?.surface?.timezone === "Europe/Berlin",
);
check(
  "personal surface echoed as configured",
  personal?.surface?.locale === "fr-FR" && personal?.surface?.timezone === "Europe/Paris",
);

// -- Step 6: boot phase math matches launcher's algorithm ------------------
console.log("");
console.log("Step 6 — bootPhaseMs matches FleetLauncher.staggerDelayMs");

const expectedWork = expectedBootPhaseMs("work", STAGGER_WINDOW_MS);
const expectedPersonal = expectedBootPhaseMs("personal", STAGGER_WINDOW_MS);
check(
  "work bootPhaseMs matches hash-derived value",
  work?.bootPhaseMs === expectedWork,
  `expected ${expectedWork}, got ${work?.bootPhaseMs}`,
);
check(
  "personal bootPhaseMs matches hash-derived value",
  personal?.bootPhaseMs === expectedPersonal,
  `expected ${expectedPersonal}, got ${personal?.bootPhaseMs}`,
);
check(
  "boot phases differ (deterministic anti-synchrony)",
  work?.bootPhaseMs !== personal?.bootPhaseMs,
);

// -- Step 7: distinct Chrome processes -------------------------------------
console.log("");
console.log("Step 7 — two real Chrome processes with distinct --user-data-dir");

const workProfileDir = join(fleetRoot, "work");
const personalProfileDir = join(fleetRoot, "personal");

const found = await waitFor(() => {
  return listChromePids(workProfileDir).length > 0 && listChromePids(personalProfileDir).length > 0;
}, 10_000, 500);

const workPids = listChromePids(workProfileDir);
const personalPids = listChromePids(personalProfileDir);
check(
  "two Chrome processes detected",
  found && workPids.length > 0 && personalPids.length > 0,
  `work=${workPids.length} pid(s), personal=${personalPids.length} pid(s)`,
);
check(
  "processes are distinct",
  workPids.length > 0 &&
    personalPids.length > 0 &&
    workPids.every((p) => !personalPids.includes(p)),
);

// -- Step 8: checkup -------------------------------------------------------
console.log("");
console.log("Step 8 — fingerprint checkup runs in each profile");

let checkupWork = null;
let checkupPersonal = null;
try {
  const r = await api("/v1/fleet/work/checkup", { method: "POST" });
  checkupWork = r.checkup;
  check("checkup for work returns a result", !!checkupWork);
} catch (e) {
  check("checkup for work returns a result", false, String(e));
}
try {
  const r = await api("/v1/fleet/personal/checkup", { method: "POST" });
  checkupPersonal = r.checkup;
  check("checkup for personal returns a result", !!checkupPersonal);
} catch (e) {
  check("checkup for personal returns a result", false, String(e));
}

if (checkupWork) {
  check(
    "work canvas hash is a 16-hex digest",
    /^[0-9a-f]{16}$/.test(checkupWork.canvasHash),
    checkupWork.canvasHash,
  );
  check(
    "work window dimensions are positive",
    checkupWork.innerWidth > 0 && checkupWork.innerHeight > 0,
    `${checkupWork.innerWidth}x${checkupWork.innerHeight}`,
  );
}
if (checkupPersonal) {
  check(
    "personal canvas hash is a 16-hex digest",
    /^[0-9a-f]{16}$/.test(checkupPersonal.canvasHash),
    checkupPersonal.canvasHash,
  );
}
if (checkupWork && checkupPersonal) {
  if (checkupWork.language !== checkupPersonal.language) {
    info(
      `surface isolation verified: language ${checkupWork.language} vs ${checkupPersonal.language}`,
    );
  } else {
    info(
      `NOTE: --lang not honored by this Chrome build (both profiles report "${checkupWork.language}"); ` +
        `the fleet reports the truth rather than assuming isolation`,
    );
  }
  if (checkupWork.canvasHash !== checkupPersonal.canvasHash) {
    info("canvas hashes differ across profiles");
  } else {
    info(
      "NOTE: canvas hashes are identical — canvas-noise switches may be ignored by this build",
    );
  }
}

// -- Step 9: targeted removal ---------------------------------------------
console.log("");
console.log("Step 9 — fleet remove kills only the target profile");

const workPidsBefore = listChromePids(workProfileDir);
const personalPidsBefore = listChromePids(personalProfileDir);

await api("/v1/fleet/work/remove", { method: "POST" });

const workGone = await waitFor(() => listChromePids(workProfileDir).length === 0, 8_000, 500);
const personalStillThere = listChromePids(personalProfileDir).length > 0;

check(
  "work's Chrome process exited after removal",
  workGone,
  `was ${workPidsBefore.length} pid(s), now ${listChromePids(workProfileDir).length}`,
);
check(
  "personal's Chrome process survived the removal",
  personalStillThere,
  `was ${personalPidsBefore.length} pid(s), now ${listChromePids(personalProfileDir).length}`,
);

const statusAfter = await api("/v1/accounts");
check(
  "work no longer listed",
  !statusAfter.accounts.some((a) => a.id === "work"),
);
check(
  "personal still listed",
  statusAfter.accounts.some((a) => a.id === "personal"),
);

// -- Step 10: SIGTERM cleanup ---------------------------------------------
console.log("");
console.log("Step 10 — SIGTERM bridge kills remaining Chrome (crash cleanup)");

const personalPidsPreShutdown = listChromePids(personalProfileDir);
check("personal still running before shutdown", personalPidsPreShutdown.length > 0);

try { bridge.kill("SIGTERM"); } catch {}

const bridgeExitedOk = await waitFor(() => bridgeExited, 5_000, 100);
check("bridge process exited on SIGTERM", bridgeExitedOk);

const personalGone = await waitFor(() => listChromePids(personalProfileDir).length === 0, 8_000, 500);
check(
  "personal's Chrome process was cleaned up on shutdown",
  personalGone,
  `before=${personalPidsPreShutdown.length} pid(s)`,
);

// -- Cleanup ----------------------------------------------------------------
console.log("");
console.log("Cleanup");
if (!bridgeExited) {
  try { bridge.kill("SIGKILL"); } catch {}
}
// Best-effort kill any remaining Chrome from this run.
for (const dir of [workProfileDir, personalProfileDir]) {
  for (const pid of listChromePids(dir)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}
if (KEEP) {
  info(`temp dir kept: ${tmpRoot}`);
} else {
  rmSync(tmpRoot, { recursive: true, force: true });
}

// -- Report ----------------------------------------------------------------
console.log("");
console.log("================================================================");
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log("================================================================");
if (failed > 0) {
  console.log("");
  console.log("Full bridge log tail (last 30 lines):");
  const tailLines = bridgeLog.join("").split("\n").filter(Boolean).slice(-30);
  for (const l of tailLines) console.log("  " + l);
  console.log("");
  console.log("Note: this harness exercises the fleet's plumbing (process launch,");
  console.log("WS routing, per-account pools, checkup, cleanup). It does NOT cover");
  console.log("the DeepSeek DOM layer, which is captcha-gated and lives in");
  console.log("docs/RUNBOOK.md as a human-driven drill.");
}
process.exit(failed === 0 ? 0 : 1);
