/**
 * Enrollment (ADR-9v2): claiming a browser for an account.
 *
 * `fleet add` creates the account record, launches the profile's Chrome,
 * and OPENS an enrollment. The next worker HELLO whose instance id is not
 * already bound to an account is attributed to the pending enrollment and
 * permanently bound (fleet registry). Enrollments are serialized: two
 * open windows at once would be indistinguishable, so begin() while one
 * is pending throws. Timeout closes the enrollment with a clear error —
 * the human may simply have missed the login.
 *
 * Identity needs zero extension changes and zero credential pasting:
 * the browser dials the bridge on boot (DEFAULT_WS_URL), the HELLO already
 * carries `instance` (stable, chrome.storage.local per profile).
 */

import type { HelloFrame } from "../pool/fleet.js";
import { log } from "../log.js";

export interface Enrollment {
  accountId: string;
  expiresAt: number;
  settle: (instanceId: string) => void;
  abort: (e: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class EnrollmentManager {
  private pending: Enrollment | null = null;

  /** Open enrollment for `accountId`. Resolves with the claimed instance id. */
  begin(accountId: string, timeoutMs: number): Promise<string> {
    if (this.pending) {
      throw new Error(
        `enrollment already open for "${this.pending.accountId}" — complete or cancel it first (enrollments are serialized)`
      );
    }
    return new Promise<string>((settle, abort) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.cancel(accountId, "timed out");
              abort(new Error(`enrollment for "${accountId}" timed out after ${timeoutMs}ms (login not observed)`));
            }, timeoutMs)
          : null;
      // NOTE: intentionally NOT unref'd. The timer is what rejects the
      // enrollment promise on timeout, and an awaited promise must be
      // backed by a handle that keeps the loop alive until it fires —
      // otherwise an isolated node process (e.g. a single test file) can
      // exit while the promise is still pending, and the test runner
      // reports subsequent tests in the same file as "cancelled". The
      // bridge's HTTP server keeps the production process alive anyway,
      // and discardAll() clears the timer explicitly on shutdown.
      this.pending = { accountId, expiresAt: Date.now() + timeoutMs, settle, abort, timer };
      log.audit("fleet.enroll-begin", { accountId, timeoutMs });
    });
  }

  /** Attribute an otherwise-unknown HELLO to the pending enrollment.
   * Returns the account id when claimed, null when nothing is pending or
   * the instance is already known (normal reconnection, not enrollment). */
  consider(hello: HelloFrame, isKnownInstance: boolean): string | null {
    const p = this.pending;
    if (!p) return null;
    if (isKnownInstance) return null; // existing account reconnecting
    if (!hello.instance) return null; // extension too old to send instance
    this.clear("claimed");
    log.audit("fleet.enroll-claimed", { accountId: p.accountId, instance: hello.instance });
    p.settle(hello.instance);
    return p.accountId;
  }

  cancel(accountId: string, why: string): void {
    const p = this.pending;
    if (!p || p.accountId !== accountId) return;
    this.clear(why);
    p.abort(new Error(`enrollment for "${accountId}" ${why}`));
  }

  /** Cancel an enrollment and swallow its promise (shutdown path). */
  discardAll(): void {
    const p = this.pending;
    if (!p) return;
    this.clear("discarded");
    p.abort(new Error(`enrollment for "${p.accountId}" discarded`));
  }

  get pendingAccountId(): string | null {
    return this.pending?.accountId ?? null;
  }

  private clear(why: string): void {
    const p = this.pending;
    this.pending = null;
    if (p?.timer) clearTimeout(p.timer);
    if (p) log.audit("fleet.enroll-close", { accountId: p.accountId, why });
  }
}
