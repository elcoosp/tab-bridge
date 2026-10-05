/**
 * FleetRouter (ADR-11v2): one WorkerPool per account. Composition over
 * modification — WorkerPool keeps its duplicate refusal, heartbeat, and
 * per-tab health map per pool; the fleet adds identity routing and
 * aggregation. The implicit "default" account preserves single-worker
 * behavior exactly (fleet file absent/empty ⇒ this class is not wired in).
 *
 * Identity rides the worker HELLO (zero extension change, ADR-9v2):
 *   1. `instance` — the stable per-profile id the extension already sends
 *      (chrome.storage.local, background.js) — resolved through the fleet
 *      registry (instanceId → account).
 *   2. an open enrollment claims otherwise-unknown instances (fleet add).
 *   3. anything else is refused fail-closed (HELLO_REFUSED) — an unknown
 *      browser must never silently join a fleet it was not enrolled into.
 *
 * The router peeks the first frame (HELLO) to route, then hands the
 * connection AND the parsed HELLO to the target pool so the pool does not
 * lose its greeting (attach(conn, { hello }) — see pool.ts).
 */

import { WorkerPool, type PoolConfig, type PoolEvent, type WorkerInfo } from "./pool.js";
import type { WsConnection } from "../link/wsserver.js";
import { log } from "../log.js";

export const DEFAULT_ACCOUNT = "default";

/** The HELLO subset the router cares about (protocol.ts WorkerIntent). */
export interface HelloFrame {
  t: "HELLO";
  v: number;
  ext: string;
  caps?: Record<string, unknown>;
  extVersion?: string;
  instance?: string;
  /** Reserved for the phase-2 self-branding patch (see §9). */
  account?: string;
}

/** PoolEvent is a union — intersection adds the owning account (the same
 * composition trick the worker-up event already uses). */
export type FleetEvent = PoolEvent & { accountId: string };

/** Routing decision supplied by the bridge (owns registry + enrollment). */
export type RouteDecision =
  | { kind: "route"; accountId: string }
  | { kind: "refuse"; reason: string; code?: number };

export class FleetRouter {
  private pools = new Map<string, WorkerPool>();

  constructor(
    private readonly config: PoolConfig,
    private readonly opts: {
      /** Resolve a HELLO to a routing decision (bridge-supplied). */
      route: (hello: HelloFrame) => RouteDecision;
      /** Receives fleet-aggregated pool events (worker-up/down, health). */
      onFleetEvent?: (e: FleetEvent) => void;
    }
  ) {}

  pool(accountId: string | null | undefined): WorkerPool {
    const id = accountId ?? DEFAULT_ACCOUNT;
    let p = this.pools.get(id);
    if (!p) {
      p = new WorkerPool(this.config);
      p.on("event", (e: PoolEvent) => this.opts.onFleetEvent?.({ ...e, accountId: id }));
    }
    this.pools.set(id, p);
    return p;
  }

  hasPool(accountId: string): boolean {
    return this.pools.has(accountId);
  }

  accountIds(): string[] {
    return [...this.pools.keys()];
  }

  isLinked(accountId: string): boolean {
    return this.pool(accountId).hasWorker;
  }

  workerInfo(accountId: string): WorkerInfo | null {
    return this.pool(accountId).workerInfo;
  }

  /** Fleet-wide tab health with owning account. */
  tabHealth(): Array<{ accountId: string; tabId: number; state: string }> {
    const out: Array<{ accountId: string; tabId: number; state: string }> = [];
    for (const [accountId, p] of this.pools) {
      for (const t of p.tabHealth()) out.push({ accountId, tabId: t.tabId, state: t.state });
    }
    return out;
  }

  /** WS wiring entry: peek the first frame, route by identity. */
  attach(conn: WsConnection): void {
    const guard = setTimeout(() => {
      try {
        conn.close(1013);
      } catch {
        /* ignore */
      }
    }, 5000);
    // Bug-hunt fix: unref so a stuck upgrade cannot delay process shutdown.
    guard.unref?.();
    conn.once("message", (raw: string) => {
      clearTimeout(guard);
      const hello = parseHello(raw);
      if (hello === null) {
        log.warn("worker.refused-unparseable", { remote: conn.remoteAddress });
        refuse(conn, "first frame was not a HELLO");
        return;
      }
      const decision = this.opts.route(hello);
      if (decision.kind === "refuse") {
        log.warn("worker.refused-unknown", {
          remote: conn.remoteAddress,
          instance: hello.instance ?? "none",
          reason: decision.reason,
        });
        refuse(conn, decision.reason);
        return;
      }
      // Hand the connection AND the consumed HELLO to the target pool.
      this.pool(decision.accountId).attach(conn, { hello });
    });
  }

  /** Tear down one account's link (account removal, shutdown). Bug-hunt fix:
   * also delete the map entry so a re-enrollment cycle does not accumulate
   * one WorkerPool per removed account forever. `pool(accountId)` recreates
   * the entry lazily on the next HELLO. */
  detach(accountId: string, reason: string): void {
    const existing = this.pools.get(accountId);
    if (existing) {
      existing.detach(reason);
      this.pools.delete(accountId);
      return;
    }
    // No pool for this id — still emit a detach on a throwaway so any
    // listener that expected the call sees the same shape (no-op otherwise).
    this.pool(accountId).detach(reason);
    this.pools.delete(accountId);
  }

  detachAll(reason: string): void {
    // Snapshot the keys: detach() mutates the map as it goes, and the
    // iterator would otherwise be invalidated mid-loop.
    for (const id of [...this.pools.keys()]) this.detach(id, reason);
  }
}

function parseHello(raw: string): HelloFrame | null {
  try {
    const m = JSON.parse(raw) as { t?: string };
    if (m && m.t === "HELLO") return m as HelloFrame;
  } catch {
    /* not JSON */
  }
  return null;
}

function refuse(conn: WsConnection, reason: string): void {
  try {
    conn.sendText(JSON.stringify({ t: "HELLO_REFUSED", reason }));
  } catch {
    /* ignore */
  }
  try {
    conn.close(1008);
  } catch {
    /* ignore */
  }
}
