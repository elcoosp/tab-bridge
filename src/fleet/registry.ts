/**
 * Fleet registry (ADR-15): the list of Chrome-profile-backed accounts,
 * persisted as plain JSON. There are NO secrets here by design (ADR-10v2):
 * the credential is the Chrome profile directory itself — its cookie jar
 * and localStorage live inside the profile, owned by Chrome, never read
 * or copied by the bridge. This file only records bookkeeping:
 *   id / label / profileDir / the worker instance id that claimed it.
 *
 * Writes are atomic (tmp + rename) and 0600, mirroring the journal's
 * hygiene. No passphrase, no crypto — nothing to encrypt.
 *
 * v4 additions (ADR-17/18): per-account `proxy` (network identity) and
 * `surface` (presentation knobs). The proxy value is stored RAW — it may
 * reference environment variables as ${VAR} and is expanded only at
 * launch time, so authenticated proxy URLs never rest in the file
 * (ADR-10v2 preserved: still no secrets here).
 */

import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const FLEET_FILE_VERSION = 1;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Per-account surface profile (ADR-18): the small, honest set of browser
 * presentation knobs the launcher applies per profile, so two accounts on
 * one machine do not present byte-identical browser environments. Real
 * GPU, real UA, real hardware — only presentation varies (N9). */
export interface SurfaceProfile {
  /** UI + navigator language (--lang). Align with the exit IP's locale. */
  locale?: string;
  /** IANA timezone, applied as the child's TZ env (POSIX; doctor warns
   * on Windows, where the OS timezone wins). */
  timezone?: string;
  /** --window-size=WxH — feeds viewport-derived fingerprint inputs. */
  windowSize?: string;
  /** --window-position=XxY — cosmetic separation of open windows. */
  windowPosition?: string;
  /** Chromium's canvas image/measuretext noise switches: per-session
   * noise seeds ⇒ per-profile canvas hashes, same real GPU strings. */
  canvasNoise?: boolean;
  /** Verbatim extra Chromium switches (operator's responsibility). */
  extraArgs?: string[];
}

/** v4 §7.3: the recorded outcome of a fingerprint probe. Same shape as the
 * probe's own measurement, minus the transport fields. */
export type { CheckupEntry } from "./probe.js";

export interface FleetAccount {
  id: string;
  label?: string;
  /** Dedicated Chrome user-data-dir for this account (one process, one jar). */
  profileDir: string;
  /** Stable per-profile extension identity (chrome.storage.local) that
   * claimed this account at enrollment. Routes reconnects (ADR-9v2). */
  instanceId?: string;
  createdAt: number;
  /** Set when the first login was observed (HEALTH ok after enrollment). */
  enrolledAt?: number;
  /** ADR-17: per-account network identity (raw; ${VAR} refs expanded at
   * launch only). Absent = direct connection — allowed, but flagged by
   * `fleet doctor` whenever two accounts share one network path. */
  proxy?: string;
  /** ADR-18: presentation knobs applied at launch (see SurfaceProfile). */
  surface?: SurfaceProfile;
  /** §7.3: newest-first fingerprint probe results. The most recent is the
   * "current" fingerprint `fleet doctor` shows; the history allows drift
   * forensics (an account's canvas hash should not change mid-life). */
  checkupHistory?: import("./probe.js").CheckupEntry[];
}

interface FleetFile {
  v: number;
  accounts: FleetAccount[];
}

/** blake2b16 over the profile dir — a stable, non-secret display hash so
 * logs/HTTP can name an account without exposing paths. Mirrors the
 * hash discipline of src/core/hashchain.ts. */
export function fingerprintOfDir(profileDir: string): string {
  return createHash("blake2b512").update(profileDir, "utf8").digest().subarray(0, 16).toString("hex");
}

export class FleetRegistry {
  private accounts = new Map<string, FleetAccount>();
  private byInstance = new Map<string, string>();

  private constructor(
    readonly path: string,
    private readonly rootDir: string
  ) {}

  /** Open (or initialize) the fleet file. Corrupt JSON fails at boot,
   * never mid-turn. */
  static open(path: string, rootDir?: string): FleetRegistry {
    const reg = new FleetRegistry(path, rootDir ?? join(dirname(path), "fleet-home"));
    if (!existsSync(path)) {
      reg.persist(); // creates the file 0600, empty
      return reg;
    }
    let file: FleetFile;
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as FleetFile;
    } catch {
      throw new Error(`fleet file is not valid JSON: ${path}`);
    }
    if (file.v !== FLEET_FILE_VERSION || !Array.isArray(file.accounts)) {
      throw new Error(`unsupported fleet file version in ${path}`);
    }
    for (const acct of file.accounts) {
      reg.accounts.set(acct.id, acct);
      if (acct.instanceId) reg.byInstance.set(acct.instanceId, acct.id);
    }
    return reg;
  }

  private persist(): void {
    const body =
      JSON.stringify({ v: FLEET_FILE_VERSION, accounts: [...this.accounts.values()] } satisfies FleetFile, null, 2) +
      "\n";
    // Bug-hunt C2: append a short random suffix to the tmp file name so two
    // (rare) interleaved persists cannot race on the same tmp path.
    const tmp = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    mkdirSync(dirname(this.path) || ".", { recursive: true });
    const fh = openSync(tmp, "w", 0o600);
    try {
      writeSync(fh, body);
    } finally {
      closeSync(fh);
    }
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  /** Create an account record. `profileDir` defaults to <rootDir>/<id>. */
  add(input: { id: string; label?: string; profileDir?: string }): FleetAccount {
    if (!ID_RE.test(input.id)) throw new Error(`invalid account id: ${input.id}`);
    if (this.accounts.has(input.id)) throw new Error(`account already exists: ${input.id}`);
    const acct: FleetAccount = {
      id: input.id,
      ...(input.label !== undefined ? { label: input.label } : {}),
      profileDir: input.profileDir ?? join(this.rootDir, input.id),
      createdAt: Date.now(),
    };
    this.accounts.set(acct.id, acct);
    this.persist();
    return acct;
  }

  /** Bind the worker instance that claimed this account (enrollment /
   * re-enrollment). Rebinding a live instance away from another account is
   * refused — one profile is one account is one instance. */
  bindInstance(id: string, instanceId: string): void {
    const acct = this.accounts.get(id);
    if (!acct) throw new Error(`no such account: ${id}`);
    const owner = this.byInstance.get(instanceId);
    if (owner && owner !== id) {
      throw new Error(`instance ${instanceId} already belongs to account ${owner}`);
    }
    acct.instanceId = instanceId;
    this.byInstance.set(instanceId, id);
    this.persist();
  }

  markEnrolled(id: string): void {
    const acct = this.accounts.get(id);
    if (acct && acct.enrolledAt === undefined) {
      acct.enrolledAt = Date.now();
      this.persist();
    }
  }

  /** ADR-17: set/clear the account's network identity. Stored raw —
   * ${VAR} references are expanded only at launch (never persisted
   * expanded), so authenticated proxy URLs do not rest in the file. */
  setProxy(id: string, proxy: string | null): FleetAccount {
    const acct = this.accounts.get(id);
    if (!acct) throw new Error(`no such account: ${id}`);
    if (proxy === null) delete acct.proxy;
    else acct.proxy = proxy;
    this.persist();
    return acct;
  }

  /** ADR-18: set/clear the account's surface profile. */
  setSurface(id: string, surface: SurfaceProfile | null): FleetAccount {
    const acct = this.accounts.get(id);
    if (!acct) throw new Error(`no such account: ${id}`);
    if (surface === null) delete acct.surface;
    else acct.surface = surface;
    this.persist();
    return acct;
  }

  /** §7.3: record a fingerprint probe result. Prepends to history, capped
   * at 20 entries (a large drift log belongs in the operator's notes, not
   * the fleet file). */
  recordCheckup(id: string, entry: import("./probe.js").CheckupEntry): FleetAccount | null {
    const acct = this.accounts.get(id);
    if (!acct) return null;
    const hist = acct.checkupHistory ?? [];
    hist.unshift(entry);
    acct.checkupHistory = hist.slice(0, 20);
    this.persist();
    return acct;
  }

  remove(id: string): boolean {
    const acct = this.accounts.get(id);
    if (!acct) return false;
    if (acct.instanceId) this.byInstance.delete(acct.instanceId);
    this.accounts.delete(id);
    this.persist();
    return true;
  }

  has(id: string): boolean {
    return this.accounts.has(id);
  }

  byId(id: string): FleetAccount | undefined {
    return this.accounts.get(id);
  }

  accountForInstance(instanceId: string): FleetAccount | undefined {
    const id = this.byInstance.get(instanceId);
    return id ? this.accounts.get(id) : undefined;
  }

  ids(): string[] {
    return [...this.accounts.keys()];
  }

  all(): FleetAccount[] {
    return [...this.accounts.values()];
  }
}

/** Expand ${VAR} references against `env`. Fail-closed: an unset or empty
 * variable throws with the reference named — a silently-empty proxy would
 * launch a "separated" account straight down the shared uplink, which is
 * exactly the linkage ADR-17 exists to prevent. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (ref, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") throw new Error(`environment variable not set: ${ref}`);
    return v;
  });
}

/** The account's launch-time proxy endpoint (raw → expanded), or null.
 * `fleet doctor` catches unset references early; launch catches them
 * finally. */
export function proxyOf(acct: FleetAccount, env: NodeJS.ProcessEnv): string | null {
  if (!acct.proxy) return null;
  return expandEnvRefs(acct.proxy, env);
}

/** Endpoint of a proxy URL with any userinfo stripped — the uniqueness
 * key for shared-path detection. Credentials never enter the comparison,
 * logs, or doctor output (ADR-10v2 hygiene). */
export function proxyEndpoint(proxy: string): string {
  return proxy.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/, (m) => m.slice(0, m.indexOf("://") + 3)).toLowerCase();
}

/** ADR-17/18 — the `fleet doctor` brain: pairwise isolation findings
 * across accounts; empty = clean. Two findings matter:
 *  1. two accounts sharing one network path (or both direct) — one IP
 *     serving two identities is the strongest single linkage signal;
 *  2. two accounts with byte-identical surface profiles — the two windows
 *     would present the same fingerprint inputs (ADR-18).
 * Unset ${VAR} references degrade to raw comparison here; launch fails
 * closed on them separately. */
export function isolationConflicts(
  accounts: FleetAccount[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const out: string[] = [];
  const paths = accounts.map((a) => {
    let p: string | null;
    try {
      p = proxyOf(a, env);
    } catch {
      p = a.proxy ?? null; // compare raw; launch will fail closed later
    }
    return { id: a.id, path: p === null ? "(direct)" : proxyEndpoint(p) };
  });
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[i].path === paths[j].path) {
        out.push(
          `accounts "${paths[i].id}" and "${paths[j].id}" share one network path (${paths[i].path}) — one IP serving two identities is the strongest linkage signal there is`
        );
      }
    }
  }
  const surfaced = accounts.filter((a) => a.surface !== undefined);
  for (let i = 0; i < surfaced.length; i++) {
    for (let j = i + 1; j < surfaced.length; j++) {
      if (JSON.stringify(surfaced[i].surface) === JSON.stringify(surfaced[j].surface)) {
        out.push(`accounts "${surfaced[i].id}" and "${surfaced[j].id}" present identical surface profiles (ADR-18)`);
      }
    }
  }
  return out;
}
