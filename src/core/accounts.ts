/**
 * Account registry + session placement (ADR-11v2, ADR-13v3). Runtime
 * health for the profile fleet: worker links, cooldowns, and the
 * human-in-the-loop auth states (ADR-14v3):
 *
 *   awaiting_login — enrolled profile, no login observed yet (fresh enroll
 *                    or re-opened window awaiting the captcha)
 *   ready          — worker linked and a tab reported HEALTH ok
 *   cooling        — provider cooldown window (429 / server-busy)
 *   needs_relogin  — worker linked but the tab reports the login wall
 *                    (session revoked). Human re-login required; the
 *                    bridge cannot and must not automate it (captcha).
 *   unlinked       — no worker link (Chrome closed or never launched)
 *
 * v3 semantics (place-then-stick, supersedes exhaust-then-rotate): the
 * fleet does NOT rotate. An account is assigned to a session exactly once,
 * at bind time, by least-loaded placement, and the binding is immutable
 * for the session's lifetime. Rate limits are accepted as a per-account
 * cost: traffic never moves between accounts to dodge a 429, because the
 * cross-account switch forces a RESET_RESEED (new tab + full history
 * replay) on top of the hourly pool-window reseed every managed tab
 * already pays. More accounts buy more concurrent session slots — not
 * cooldown immunity. The only rebinding path is the explicit,
 * operator-invoked `fleet drain` (engine layer).
 *
 * Pure in-process state; persistence lives in the fleet registry.
 */

import { log } from "../log.js";

export type AccountState =
  | "awaiting_login"
  | "unlinked"
  | "ready"
  | "cooling"
  | "needs_relogin";

export interface AccountRecord {
  id: string;
  label?: string;
  state: AccountState;
  /** Stable worker instance id bound at enrollment (routing key). */
  instanceId?: string;
  /** Provider cooldown window (rate-limit / server-busy), epoch ms. */
  coolingUntil: number;
  quarantinedAt: number | null;
  workerLinked: boolean;
  /** Turns currently holding a generation slot on this account. */
  activeTurns: number;
  /** Sessions currently bound to this account (place-then-stick, ADR-13v3). */
  activeSessions: number;
  /** Last time placement assigned a session here (tie-break: oldest first). */
  lastPlacedAt: number;
  lastUsedAt: number;
  /** blake2b16 of the profile dir — non-secret display hash. */
  fingerprint: string;
}

export type PlacementResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "none_ready" | "all_full" };

export interface AccountRegistryOptions {
  /** Max sessions bound per account (0 = unbounded). Bounds the hourly
   * per-session reseed fan-out one profile can generate. */
  maxSessionsPerAccount?: number;
  /** Cooldown cap; the provider reports up to 1200 s. */
  maxCooldownMs?: number;
}

export class AccountRegistry {
  private records = new Map<string, AccountRecord>();
  private readonly maxSessions: number;

  constructor(private readonly opts: AccountRegistryOptions) {
    this.maxSessions = Math.max(0, opts.maxSessionsPerAccount ?? 8);
  }

  /** Register/refresh from the fleet registry at boot and on enrollment. */
  upsert(view: {
    id: string;
    label?: string;
    instanceId?: string;
    fingerprint: string;
    initial?: AccountState;
  }): void {
    const existing = this.records.get(view.id);
    if (existing) {
      if (view.label !== undefined) existing.label = view.label;
      if (view.instanceId !== undefined) existing.instanceId = view.instanceId;
      existing.fingerprint = view.fingerprint;
      return;
    }
    this.records.set(view.id, {
      id: view.id,
      ...(view.label !== undefined ? { label: view.label } : {}),
      state: view.initial ?? "unlinked",
      ...(view.instanceId !== undefined ? { instanceId: view.instanceId } : {}),
      coolingUntil: 0,
      quarantinedAt: null,
      workerLinked: false,
      activeTurns: 0,
      activeSessions: 0,
      lastPlacedAt: 0,
      lastUsedAt: 0,
      fingerprint: view.fingerprint,
    });
  }

  record(id: string): AccountRecord | undefined {
    const r = this.records.get(id);
    return r === undefined ? undefined : lazilyExpire(r);
  }

  all(): AccountRecord[] {
    return [...this.records.values()].map(lazilyExpire);
  }

  markWorkerLinked(id: string): void {
    const r = this.records.get(id);
    if (!r) return;
    r.workerLinked = true;
    // A fresh link does not mean a logged-in account: the tab may still be
    // sitting on the login wall. Only a HEALTH ok promotes to ready.
    if (r.state === "unlinked") r.state = "awaiting_login";
    log.audit("account.linked", { accountId: id, state: r.state });
  }

  markWorkerDown(id: string): void {
    const r = this.records.get(id);
    if (!r) return;
    r.workerLinked = false;
    r.state = "unlinked";
    log.audit("account.unlinked", { accountId: id });
  }

  markCooling(id: string, seconds: number): void {
    const r = this.records.get(id);
    if (!r) return;
    const cap = this.opts.maxCooldownMs ?? 1200_000;
    r.coolingUntil = Date.now() + Math.min(seconds * 1000, cap);
    r.state = "cooling";
    log.audit("account.cooling", {
      accountId: id,
      seconds: Math.round((r.coolingUntil - Date.now()) / 1000),
    });
  }

  /** ADR-14v3: the login wall is on screen — the session died (or was never
   * established). Quarantine traffic and page the human. Bound sessions are
   * NOT moved: they pause (typed account_paused errors) and resume on the
   * same account when the human completes the re-login. */
  markNeedsRelogin(id: string, detail?: string): void {
    const r = this.records.get(id);
    if (!r) return;
    r.state = "needs_relogin";
    r.quarantinedAt = Date.now();
    log.audit("account.needs-relogin", { accountId: id, ...(detail ? { detail } : {}) });
  }

  /** HEALTH ok observed on one of this account's managed tabs: the human
   * completed a login (or the session recovered). Clears quarantine; bound
   * sessions resume exactly where they were pinned. */
  markLoginOk(id: string): void {
    const r = this.records.get(id);
    if (!r) return;
    r.quarantinedAt = null;
    r.coolingUntil = 0;
    r.state = r.workerLinked ? "ready" : "unlinked";
    log.audit("account.ready", { accountId: id });
  }

  noteTurnStart(id: string): void {
    const r = this.records.get(id);
    if (!r) return;
    r.activeTurns += 1;
    r.lastUsedAt = Date.now();
  }

  noteTurnEnd(id: string): void {
    const r = this.records.get(id);
    if (r) r.activeTurns = Math.max(0, r.activeTurns - 1);
  }

  /** Bind-time accounting (ADR-13v3). Called once per session, at bind. */
  noteSessionBound(id: string): void {
    const r = this.records.get(id);
    if (!r) return;
    r.activeSessions += 1;
    r.lastPlacedAt = Date.now();
    log.audit("fleet.session-bound", { accountId: id, sessions: r.activeSessions });
  }

  /** Session ended (client deleted it, or an explicit drain moved it). */
  noteSessionEnded(id: string): void {
    const r = this.records.get(id);
    if (r) r.activeSessions = Math.max(0, r.activeSessions - 1);
  }

  sessionsOf(id: string): number {
    return this.records.get(id)?.activeSessions ?? 0;
  }

  /** ADR-13v3 — the fleet's ONLY scheduling decision, made once per session
   * at bind time: least loaded `ready` account wins; ties break to the
   * account placed longest ago, then by id for determinism. Cooling,
   * quarantined, awaiting-login and unlinked accounts are never chosen;
   * accounts at the session cap are never chosen. There is no re-place,
   * no failover, no LRU promotion — a bound session rides its account
   * through cooldowns to the end. */
  placeSession(): PlacementResult {
    const ready = this.all().filter((r) => r.state === "ready" && r.workerLinked);
    if (ready.length === 0) return { ok: false, reason: "none_ready" };
    const open = ready.filter((r) => this.maxSessions === 0 || r.activeSessions < this.maxSessions);
    if (open.length === 0) return { ok: false, reason: "all_full" };
    open.sort(
      (a, b) =>
        a.activeSessions - b.activeSessions ||
        a.lastPlacedAt - b.lastPlacedAt ||
        (a.id < b.id ? -1 : 1)
    );
    const chosen = open[0];
    log.audit("fleet.placed", { accountId: chosen.id, sessions: chosen.activeSessions });
    return { ok: true, accountId: chosen.id };
  }

  /** Remaining cooldown on one account, in whole seconds (typed 429 shape). */
  cooldownSec(id: string): number | null {
    const r = this.records.get(id);
    if (!r) return null;
    const rest = r.coolingUntil - Date.now();
    return rest > 0 ? Math.ceil(rest / 1000) : null;
  }

  /** Shortest remaining cooldown across cooling accounts (health surface). */
  shortestCooldownSec(): number | null {
    let min: number | null = null;
    for (const r of this.records.values()) {
      const rest = r.coolingUntil - Date.now();
      if (rest > 0 && (min === null || rest < min)) min = rest;
    }
    return min === null ? null : Math.ceil(min / 1000);
  }

  /** Accounts a human needs to look at (enrollment pending or re-login). */
  awaitingHuman(): AccountRecord[] {
    return this.all().filter((r) => r.state === "awaiting_login" || r.state === "needs_relogin");
  }
}

/** Lazily expire cooling → ready so a stale snapshot never sticks (the
 * worker-side lesson from tabsSnapshot, v1.2.69, applied account-side). */
function lazilyExpire(r: AccountRecord): AccountRecord {
  if (r.state === "cooling" && Date.now() >= r.coolingUntil) {
    r.state = r.workerLinked ? "ready" : "unlinked";
    r.coolingUntil = 0;
  }
  return r;
}
