/**
 * Profile launcher (ADR-15): spawns one Chrome/Chromium process per fleet
 * account, each with its own --user-data-dir (⇒ its own cookie jar and
 * localStorage — the credential never leaves Chrome) and auto-loads the
 * unpacked tab-bridge extension. The bridge never touches the profile's
 * auth material; it only watches worker links and tab health.
 *
 * v4 (ADR-17/18/19): the process is BORN isolated — its own --proxy-server
 * (WebRTC pinned to the tunnel), its own presentation surface (language,
 * timezone, window geometry, canvas noise), and its own deterministic
 * position in the fleet's boot schedule. Isolation is decided once per
 * process, never per request.
 *
 * Known constraint: since Chrome 137 (mid-2025) Google-branded *stable*
 * builds ignore --load-extension. resolveBrowser() therefore probes
 * Chromium/Dev/Canary/Brave/Edge first and refuses branded-stable-with-
 * flags; the documented fallback is a one-time manual "Load unpacked" per
 * profile (still zero credential pasting).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../log.js";
import type { SurfaceProfile } from "./registry.js";

export const DEEPSEEK_URL = "https://chat.deepseek.com/";

/** Browser binaries that accept --load-extension, in probe order. */
const BROWSER_PROBES: Record<NodeJS.Platform, string[]> = {
  linux: [
    "chromium",
    "chromium-browser",
    "google-chrome-unstable",
    "google-chrome-beta",
    "brave-browser",
    "microsoft-edge",
  ],
  darwin: [
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  cygwin: [],
  netbsd: [],
  win32: [
    String.raw`C:\Program Files\Chromium\Application\chrome.exe`,
    String.raw`C:\Program Files\Google\Chrome Dev\Application\chrome.exe`,
    String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  ],
  aix: [],
  android: [],
  freebsd: [],
  haiku: [],
  openbsd: [],
  sunos: [],
};

export interface LaunchRequest {
  accountId: string;
  profileDir: string;
  extensionDir: string;
  url?: string;
  /** Skip --load-extension (branded stable fallback: manual unpacked load). */
  manualExtension?: boolean;
  /** ADR-17: launch-time proxy endpoint (already expanded from the fleet
   * record by the bridge). Absent = direct connection. */
  proxy?: string;
  /** ADR-18: presentation knobs (see SurfaceProfile in fleet/registry.ts). */
  surface?: SurfaceProfile;
  /** ADR-17: when true, launch refuses without a network identity. */
  proxyRequired?: boolean;
  /** Environment seam for tests (TZ propagation); defaults process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface LaunchHandle {
  accountId: string;
  pid: number;
  kill(reason: string): void;
}

type SpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => ChildProcess;

/** ADR-19: deterministic per-account launch phase in [0, windowMs). The
 * same id always maps to the same delay, so an account's boot traffic
 * keeps a stable, personal schedule instead of synchronized fleet bursts
 * (N browser windows creating their first tabs in the same second look
 * orchestrated; the same window starting at the same offset every boot
 * looks like one machine's routine). blake2b — the repo's hash discipline. */
export function staggerDelayMs(accountId: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  const h = createHash("blake2b512").update(`launch-phase:${accountId}`, "utf8").digest();
  let v = 0n;
  for (const b of h.subarray(0, 8)) v = (v << 8n) | BigInt(b);
  return Number(v % BigInt(windowMs));
}

export class FleetLauncher {
  private children = new Map<string, ChildProcess>();

  constructor(
    private readonly opts: {
      browserPath?: string;
      /** Test seam / headless environments. */
      spawnFn?: SpawnFn;
      onExit?: (accountId: string, code: number | null) => void;
    }
  ) {}

  /** Probe candidate browsers; explicit --browser-path wins. Throws with
   * actionable guidance when nothing suitable is installed. */
  static resolveBrowser(explicit?: string): string {
    if (explicit) {
      if (!existsSync(explicit)) throw new Error(`--browser-path does not exist: ${explicit}`);
      return explicit;
    }
    for (const candidate of BROWSER_PROBES[process.platform] ?? []) {
      try {
        // existsSync works for absolute probe paths; bare names ("chromium")
        // are resolved by spawn itself and validated by the exit probe.
        if (candidate.includes("/") || candidate.includes("\\")) {
          if (existsSync(candidate)) return candidate;
        } else {
          return candidate; // let PATH resolve; spawn errors surface in launch()
        }
      } catch {
        /* keep probing */
      }
    }
    throw new Error(
      "no Chromium-family browser found for the fleet (Chromium / Chrome Dev / Canary / Brave / Edge). " +
        "Install one or pass --browser-path."
    );
  }

  /** Pure argument builder — unit-tested without spawning anything.
   * v4 (ADR-17/18): applies the account's network identity and surface
   * profile so two profiles on one machine never present byte-identical
   * browser environments nor share one exit path. */
  argsFor(req: LaunchRequest): string[] {
    const args = [
      `--user-data-dir=${req.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Background-throttling immunity (2026-10-07 field finding): fleet
      // windows sit minimized/occluded behind the operator's work, and
      // Chrome throttles timers/rAF in occluded renderers. The injector
      // lives on DOM polling (send-enabled gating, submit verification,
      // reply-baseline settle), so a minimized window stretches submits
      // from seconds to minutes (observed: 152 s inline, 562 s
      // paste-to-file, both flagged "unverified (background tab?)").
      // These switches keep the renderers on wall-clock time.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ];
    if (!req.manualExtension) {
      // Chrome-family builds are inconsistent about resolving relative
      // --load-extension paths. A caller who passed "./extension" can
      // silently load nothing (no error, no SW, no HELLO) — we hit this
      // in the E2E harness. Resolve to absolute here so the launch is
      // independent of the child process's cwd.
      const extDir = resolve(req.extensionDir);
      args.push(`--disable-extensions-except=${extDir}`);
      args.push(`--load-extension=${extDir}`);
    }
    if (req.proxy) {
      args.push(`--proxy-server=${req.proxy}`);
      // A proxy that leaks local UDP candidates past itself is not a
      // network identity: keep WebRTC on the tunnel (ADR-17).
      args.push("--webrtc-ip-handling-policy=disable_non_proxied_udp");
    }
    const s = req.surface;
    if (s) {
      if (s.locale) args.push(`--lang=${s.locale}`);
      if (s.windowSize) args.push(`--window-size=${s.windowSize}`);
      if (s.windowPosition) args.push(`--window-position=${s.windowPosition}`);
      if (s.canvasNoise) {
        // Chromium's per-session canvas noise seeds: different profiles
        // get different canvas hashes while GPU strings stay real (N9).
        args.push("--fingerprinting-canvas-image-data-noise");
        args.push("--fingerprinting-canvas-measuretext-noise");
      }
      if (s.extraArgs) args.push(...s.extraArgs);
    }
    args.push(req.url ?? DEEPSEEK_URL);
    return args;
  }

  launch(req: LaunchRequest): LaunchHandle {
    if (this.children.has(req.accountId)) {
      throw new Error(`account already launched: ${req.accountId}`);
    }
    if (req.proxyRequired && !req.proxy) {
      throw new Error(
        `account "${req.accountId}" has no network identity (ADR-17): ` +
          "set one with `fleet proxy <id> <url>` or drop --fleet-proxy-required"
      );
    }
    const browser = FleetLauncher.resolveBrowser(this.opts.browserPath);
    const env: NodeJS.ProcessEnv = { ...(req.env ?? process.env) };
    const tz = req.surface?.timezone;
    if (tz && process.platform !== "win32") env.TZ = tz;
    log.audit("fleet.launch", {
      accountId: req.accountId,
      browser,
      manualExtension: req.manualExtension === true,
      proxy: req.proxy ? "set" : "unset",
      surface: req.surface ? Object.keys(req.surface).join(",") : "default",
    });
    const spawnFn = this.opts.spawnFn ?? ((cmd, args, o) => spawn(cmd, args, { stdio: "ignore", env: o.env }));
    const child = spawnFn(browser, this.argsFor(req), { env });
    child.on("error", (e) => {
      log.error("fleet.launch-failed", { accountId: req.accountId, error: String(e) });
    });
    child.on("exit", (code) => {
      this.children.delete(req.accountId);
      log.audit("fleet.exit", { accountId: req.accountId, code });
      this.opts.onExit?.(req.accountId, code);
    });
    this.children.set(req.accountId, child);
    return {
      accountId: req.accountId,
      pid: child.pid ?? -1,
      kill: (reason: string) => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        log.audit("fleet.kill", { accountId: req.accountId, reason });
      },
    };
  }

  isLaunched(accountId: string): boolean {
    const child = this.children.get(accountId);
    return child !== undefined && child.exitCode === null;
  }

  /** ADR-19: launch every account with its deterministic phase in
   * [0, staggerMs) so fleet boots do not synchronize first-tab creation
   * across accounts. Delay-0 accounts launch immediately; the rest are
   * scheduled (timers unref'd so shutdown stays free). */
  launchAll(reqs: LaunchRequest[], staggerMs: number): LaunchHandle[] {
    const handles: LaunchHandle[] = [];
    for (const req of reqs) {
      const delay = staggerDelayMs(req.accountId, staggerMs);
      if (delay <= 0) {
        handles.push(this.launch(req));
        continue;
      }
      log.audit("fleet.launch-scheduled", { accountId: req.accountId, delayMs: delay });
      const t = setTimeout(() => {
        try {
          this.launch(req);
        } catch (e) {
          log.error("fleet.launch-stagger-failed", { accountId: req.accountId, error: String(e) });
        }
      }, delay);
      t.unref?.();
    }
    return handles;
  }

  /** §7.3: open a URL in a new tab of the given profile. When the profile's
   * Chrome is already running, Chrome forwards the URL to the existing
   * process and this transient child exits; the profile lock is Chrome's
   * own. We do NOT track this child in `this.children` — the launcher's
   * `isLaunched()` semantics must reflect the long-lived session process,
   * not this one-shot tab opener. */
  /** Bug-hunt G21: probe tabs live in their own map so killAll reaches
   * them (they are not the account's session child, so they do not go into
   * `children`), and so the launcher can report/close them on shutdown. */
  private probeChildren = new Map<string, ChildProcess>();

  spawnProbeTab(profileDir: string, url: string, tz?: string): void {
    let browser: string;
    try {
      browser = FleetLauncher.resolveBrowser(this.opts.browserPath);
    } catch (e) {
      log.error("fleet.probe-spawn-failed", { error: String(e) });
      return;
    }
    const args = [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ];
    // Bug-hunt fix: propagate the account's surface TZ so the probe measures
    // the SAME timezone the account's real Chrome presents. Without this, a
    // closed profile's probe reports the OS timezone and the doctor's
    // isolation diff is wrong for TZ. Windows ignores TZ env (as in launch()).
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (tz && process.platform !== "win32") env.TZ = tz;
    const spawnFn = this.opts.spawnFn ?? ((cmd, a, o) => spawn(cmd, a, { stdio: "ignore", env: o.env }));
    try {
      const child = spawnFn(browser, args, { env });
      // Bug-hunt G21: keep a per-profile handle so a shutdown can SIGTERM a
      // stuck probe. The child usually exits immediately (URL forwarded to
      // an already-running Chrome); we drop it from the map on exit so the
      // map does not leak.
      const handle = child;
      const key = profileDir;
      this.probeChildren.set(key, handle);
      handle.on("error", (e) => {
        log.error("fleet.probe-spawn-failed", { error: String(e) });
        this.probeChildren.delete(key);
      });
      handle.on("exit", () => {
        if (this.probeChildren.get(key) === handle) this.probeChildren.delete(key);
      });
    } catch (e) {
      log.error("fleet.probe-spawn-failed", { error: String(e) });
    }
  }

  /** SIGTERM exactly one account's child (fleetRemove path). Returns true
   * when a child was killed, false when the account had no running child. */
  killOne(accountId: string, reason: string): boolean {
    const child = this.children.get(accountId);
    if (!child) return false;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    this.children.delete(accountId);
    log.audit("fleet.kill-one", { accountId, reason });
    return true;
  }

  /** SIGTERM every child we own (bridge shutdown / account removal). */
  killAll(reason: string): void {
    for (const [id, child] of this.children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      log.audit("fleet.kill", { accountId: id, reason });
    }
    // Bug-hunt G21: also SIGTERM any in-flight probe tabs so a shutdown
    // does not leave a Chrome renderer process behind. The probe tab has
    // already served its purpose by then.
    for (const [key, child] of this.probeChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      log.audit("fleet.kill-probe", { profileDir: key, reason });
    }
    this.probeChildren.clear();
  }
}
