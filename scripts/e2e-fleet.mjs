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
 * Those remain human-driven drills; see docs/RUNBOOK.md.
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
 * Run via: just e2e-fleet  (or)  node scripts/e2e-fleet.mjs
 */

import { createHash } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
const PORT = Number(
  process.env.E2E_FLEET_PORT ?? 19_000 + Math.floor(Math.random() * 1_000),
);
const BROWSER_OVERRIDE = process.env.E2E_FLEET_BROWSER;
const API_KEY = "e2e-secret-key";

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

/** Fetch JSON with the bearer token applied. Throws on non-2xx. */
async function api(path, init = {}) {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Setup
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
console.log("Step 0 — build (npm run build)");
try {
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
  check("build succeeds", true);
} catch (e) {
  const stderr = (e.stderr ?? Buffer.alloc(0)).toString("utf8");
  check("build succeeds", false, stderr.split("\n").slice(-3).join(" | "));
  process.exit(1);
}

// -- Step 1: browser detection ---------------------------------------------
console.log("");
console.log("Step 1 — detect a non-stable Chromium-family browser");

let browserPath = null;
try {
  const script = `
    import('./dist/src/fleet/launcher.js').then(m => {
      try { process.stdout.write(m.FleetLauncher.resolveBrowser(${JSON.stringify(BROWSER_OVERRIDE)})); }
      catch (e) { process.stderr.write(String(e.message)); process.exit(1); }
    });
  `;
  browserPath = execSync(`node --input-type=module -e ${JSON.stringify(script)}`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
} catch (e) {
  const msg = (e.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
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

const bridgeEnv = {
  ...process.env,
  E2E_KEY: API_KEY,
};
const bridge = spawn(
  "node",
  [
    "dist/src/index.js",
    "serve",
    "--port", String(PORT),
    "--host", "127.0.0.1",
    "--api-key-env", "E2E_KEY",
    "--stateful=true",
    "--auto-create-tabs=true",
    "--managed-only=true",
    "--db", sessionsFile,
    "--fleet-file", fleetFile,
    "--fleet-root", fleetRoot,
    "--fleet-launch", "never",
    "--fleet-launch-stagger", `${STAGGER_WINDOW_MS}ms`,
    "--fleet-checkup-timeout", "60s",
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
  info("bridge log tail:");
  info(bridgeLog.join("").split("\n").slice(-10).join("\n      "));
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
  work && personal ? `${work.fingerprint.slice(0, 8)} / ${personal.fingerprint.slice(0, 8)}` : "",
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
if (bridgeExited) {
  /* already dead */
} else {
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
  console.log("Note: this harness exercises the fleet's plumbing (process launch,");
  console.log("WS routing, per-account pools, checkup, cleanup). It does NOT cover");
  console.log("the DeepSeek DOM layer, which is captcha-gated and lives in");
  console.log("docs/RUNBOOK.md as a human-driven drill.");
}
process.exit(failed === 0 ? 0 : 1);
