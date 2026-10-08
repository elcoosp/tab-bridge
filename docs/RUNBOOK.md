# Fleet Runbook

Operational guide for running tab-bridge with one or more DeepSeek accounts
in a multi-profile fleet. Audience: the operator who deploys the bridge,
adds accounts, monitors it, and responds when something goes wrong.

If you are looking for the *design* rather than the *operation*, read
[`README.md`](../README.md#multi-account-fleet) and
[`docs/SPEC.md`](SPEC.md). This file is the day-2 document.

---

## 1. Deploying the bridge

### Prerequisites

- **Node** ≥ 20
- **Chromium, Chrome Dev, Chrome Canary, Brave, or Edge** — *not* branded
  Google Chrome stable. Since Chrome 137 (mid-2025) stable ignores
  `--load-extension`, so the fleet cannot auto-load the tab-bridge
  extension there. `FleetLauncher.resolveBrowser` reflects this and
  refuses to launch with the wrong binary.
- **A DeepSeek account per profile.** Login is captcha-gated; the bridge
  never logs in for you.
- **(Optional, recommended) one proxy endpoint per account.** See §3.2.

### First-time setup

```bash
git clone https://github.com/elcoosp/tab-bridge.git
cd tab-bridge
pnpm install       # dev deps only: typescript, @types/node
npm run build      # produces dist/
```

### Running as a service (systemd)

The bridge is a foreground process that handles SIGTERM/SIGINT. It does
not daemonize itself. Give the unit an explicit `WorkingDirectory` so the
CWD-relative `--fleet-file=fleet.json` default resolves predictably:

```ini
[Unit]
Description=tab-bridge (multi-account fleet)
After=network-online.target

[Service]
Type=simple
User=tab-bridge
WorkingDirectory=/var/lib/tab-bridge
Environment=TAB_BRIDGE_KEY=<bearer-token>
Environment=FLEET_PROXY_WORK=socks5://user:pass@de-01.example.net:1080
Environment=FLEET_PROXY_PERSONAL=socks5://user:pass@fr-01.example.net:1080
ExecStart=/usr/bin/node /opt/tab-bridge/dist/src/index.js serve \
  --host 127.0.0.1 --port 8789 \
  --api-key-env TAB_BRIDGE_KEY \
  --stateful=true --auto-create-tabs=true --managed-only=true \
  --fleet-file=/var/lib/tab-bridge/fleet.json \
  --fleet-root=/var/lib/tab-bridge/fleet-home \
  --fleet-launch=on-demand \
  --fleet-launch-stagger=45s \
  --fleet-checkup-timeout=60s
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Notes:

- `--host 127.0.0.1` keeps the HTTP surface loopback-only. If you must
  bind elsewhere, **always** set `--api-key-env` — the bridge logs a
  startup warning when you forget, but it will not refuse to start.
- Proxy credentials live in the environment, never in `fleet.json`.
  Authenticated proxy URLs use the `${FLEET_PROXY_*}` pattern; the bridge
  expands them only at launch, fail-closed. An unset variable makes the
  launch refuse rather than silently ride the shared uplink.
- On Windows, the `TZ` env var is ignored by Chrome; timezone isolation
  does not work there. Prefer POSIX hosts for a fleet.

### Starting in single-account mode (no fleet)

```bash
node dist/src/index.js serve --fleet-file="" ...
```

`--fleet-file=""` disables the fleet entirely. The bridge runs exactly
as it did before the fleet layer existed. This is the correct rollback
(§7) and the correct path for an operator who only has one account.

---

## 2. Day 1 — onboarding accounts

### Enroll the first account

```bash
node dist/src/index.js fleet add work \
  --proxy 'socks5://${FLEET_PROXY_WORK}' \
  --surface 'locale=de-DE,tz=Europe/Berlin'
```

What happens:

1. The bridge writes a record to `fleet.json` (0600) and a profile dir
   under `fleet-root` (0700).
2. It launches Chrome with the account's proxy + surface, opening a
   window on `chat.deepseek.com`.
3. It opens a **serialized enrollment** (only one at a time). The next
   worker HELLO whose `instance` is not already claimed is attributed to
   this enrollment.
4. The human logs in (captcha included). When the injector reports the
   tab healthy, the account transitions to `ready`.
5. The CLI polls `/v1/accounts` and exits when the state is `ready`.

Expected transcript:

```
  fleet:  enrolling "work"...
  launch: browser window opening — log into the account in that window
  login:  ok — "work" is ready
  checkup: locale=de-DE timezone=Europe/Berlin
  checkup: network proxied
```

### Enroll the second account

```bash
node dist/src/index.js fleet add personal \
  --proxy 'socks5://${FLEET_PROXY_PERSONAL}' \
  --surface 'locale=fr-FR,tz=Europe/Paris'
```

With **≥ 2 accounts**, `fleet add` runs the fingerprint probe on the new
profile and prints the *measured* diff:

```
  probe:  measuring fingerprint in the new profile...
  probe:  canvas 9c02ab1f… · lang fr-FR · tz Europe/Paris · 1680x1050 · exit 198.51.100.31
```

Read that line carefully:

- **canvas hash differs** across profiles ⇒ the build honors the canvas-noise
  switches. Good.
- **`lang` / `tz` differ** and match the exit IP's geography ⇒ surface
  isolation is real.
- **`exit` differs** from the other account's ⇒ network isolation is real.

If the checkup prints the *same* values as another account, the doctor
says so (§5). Do not proceed to normal operation with a fleet that is
not measurably isolated.

### Enroll additional accounts

Repeat. Accounts add slots; they do not add availability beyond their
own rate-limit windows. Two accounts that both cool down simultaneously
is the rare case; a third smooths it out.

---

## 3. Configuration that matters

### 3.1 Surfaces

`--surface locale=de-DE,tz=Europe/Berlin,window=1440x900,canvas-noise=on`

- `locale` and `tz` should match the account's exit IP's country.
  `fleet doctor` warns on a mismatch.
- `window` (or `window-size`) sets `--window-size`. Feeds the viewport-
  derived fingerprint inputs.
- `canvas-noise` toggles Chromium's per-session canvas noise seeds.
  Requires a build that honors the switches.
- Set once, then stable. Changing a live account's surface is an
  identity change and requires `--force` (§3.3).

### 3.2 Proxies

One account, one endpoint, forever. The recommended pattern for
authenticated upstreams:

- Run a local forwarder (`gost`, `pproxy`, `3proxy`, or a WireGuard
  peer) on `127.0.0.1:<port>`.
- Point the fleet at the forwarder, not the upstream:
  `--proxy 'socks5://127.0.0.1:1081'`.
- Put the upstream credential in the forwarder's own config or in the
  bridge's environment.

`--fleet-proxy-required` makes the bridge refuse to launch any account
without a proxy. Use it on a shared host. When a required-but-missing
condition is present, `/healthz` reports an alert.

Endpoint shapes accepted by `fleet proxy`:

- `socks5://[user:pass@]host:port`
- `socks4://...`, `http://...`, `https://...`
- `host:port` (scheme inferred as `socks5` by Chrome)

Rejected: unknown schemes (`ftp://`), bare words (`banana`), whitespace
in the host.

### 3.3 Worker tokens on real deployments

A fresh fleet profile's extension dials `ws://127.0.0.1:8789/worker` on
first boot, with **no `?token=`**. If the bridge requires a bearer (i.e.
you passed `--api-key-env`), the WebSocket upgrade is rejected with
`HTTP 401` (visible in the profile's DevTools console as *"HTTP
Authentication failed; no valid credentials available"*), and the worker
link never comes up.

There are two ways to reconcile this:

**Option A (recommended for a loopback desktop deployment): run the
bridge keyless.**

```bash
node dist/src/index.js serve --host 127.0.0.1 --port 8789 \
  --fleet-file=/var/lib/tab-bridge/fleet.json \
  ...
```

Loopback-only bind is the trust boundary; the HTTP surface is not
reachable from off-host. This is the deployment the E2E harness runs.

**Option B (required when the HTTP surface is reachable beyond
loopback): pre-seed each profile's `wsUrl` before first boot.**

1. Launch the profile **without** the extension (or with the extension
   but expect the dial to fail on the first attempt — that is fine).
2. Open that profile's DevTools (⌥⌘I / Ctrl+Shift+I), Console tab.
3. Run:

   ```js
   chrome.storage.sync.set({
     wsUrl: "ws://127.0.0.1:8789/worker?token=YOUR_BEARER_TOKEN"
   });
   ```

4. Reload the extension (chrome://extensions → Tab Bridge Worker → ⟳).
5. Confirm the link: `fleet list` shows the account `ready`.

Do this **once per profile**. `chrome.storage.sync` persists across
browser restarts, and the token never leaves the profile's storage.

**Do not** ship the token in the extension source; the extension is
already installed by the time you know which bridge it will talk to.
The runtime-set `wsUrl` is the correct place.

A future version of `fleet add` may automate this via CDP; until then,
the manual step above is the honest procedure.

### 3.4 Identity stability (C12)

An account's proxy and surface are part of its identity. Changing them
mid-life is what a risk engine reads as "a different person behind the
same jar". The bridge enforces this:

```bash
node dist/src/index.js fleet proxy work socks5://10.0.0.5:1080
# → 409 account_live — pass --force to proceed, or create a new profile
```

If you actually need a new identity, that is not a surface change —
it is a **new account**: new profile, new login, new exit path, days
later (§6.3).

### 3.5 Per-account concurrency

`--per-account-turns=2` matches DeepSeek's observed per-account
generation cap. Leave it at 2 unless you have measured otherwise for
your account. Setting it to 0 disables the fleet's turn gate; the
bridge then submits every concurrent request and relies on the provider
to refuse — the fleet reports `turnSlots: null` in that case, which
means "no tracked limit", not "no capacity".

`--max-sessions-per-account=8` bounds how many sessions one profile
owns. Each session generates a periodic reseed cost; 8 is a safe
default for two or three accounts.

### 3.6 Warm tabs are required in fleet mode (`--warm-tabs >= 1`)

The bridge default is `--warm-tabs=0`. Do not use it with a fleet.

With 0, the worker creates no managed tabs until the first `BIND`
(`allocateTab` only runs on `BIND`, `ensureWarmTabs` early-returns when
`want <= 0`). But `BIND` needs a `ready` account for placement, and
`ready` needs a `HEALTH ok` from a worker-created managed tab
(`markLoginOk`). A fresh account therefore deadlocks at
`awaiting_login` forever — and the human's login happens in the
launcher-opened tab, which the worker ignores as foreign
(`ignoring foreign tab … not worker-created`), so the bridge never
observes it. Every chat completion fails `503 fleet_busy`
(`reason=none_ready`).

Run with at least one warm tab:

```bash
--warm-tabs=1
```

The worker pre-creates one managed tab at handshake; its `HEALTH ok`
promotes the account to `ready`. On an already-logged-in profile (cookie
jar on disk) that is ~1s after link. `just serve-fleet` ships this
setting; the systemd unit in §1 should add it too.

Fleet launches also carry background-throttling immunity
(`--disable-background-timer-throttling`,
`--disable-backgrounding-occluded-windows`,
`--disable-renderer-backgrounding`). Fleet windows sit minimized or
occluded behind the operator's work, and Chrome throttles timers/rAF in
occluded renderers. The injector lives on DOM polling (send-enabled
gating, submit verification, reply-baseline settle), so a minimized
window stretches submits from seconds to minutes (field-observed:
152 s for an inline paste, 562 s for a paste-to-file, both flagged
`unverified (background tab?)`). The switches keep the renderers on
wall-clock time; minimizing a fleet window is still discouraged but no
longer multiplies submit latency.

---

## 4. Day 2 — daily operation

### Reading `fleet list`

```
$ node dist/src/index.js fleet list
ACCOUNT    STATE            COOLDOWN  SESSIONS  TURNS  LINKED  NETWORK
work       ready            -         3/8       2/2    ✓       proxy ✓
personal   cooling          14:32     3/8       0/2    ✓       proxy ✓
backup     needs-relogin    -         1/8       0/2    ✓       (direct) ⚠
```

- `SESSIONS` is *bound sessions / cap*. `TURNS` is *active turns / per-
  account slots*.
- `(direct) ⚠` means the account shares the host uplink. With two direct
  accounts, `fleet doctor` reports a shared-path finding.
- `needs-relogin` accounts are waiting for a human. They will not
  recover without a re-login (§6.2).

### Reading `/healthz`

```json
{
  "ok": true,
  "sessions": 7,
  "turn_gate": { "active": 2, "waiting": 1, ... },
  "worker": { "ext": "deepseek-web", "connected": true },
  "fleet": {
    "enabled": true,
    "accounts": 3,
    "ready": 1,
    "cooling": 1,
    "needsRelogin": 1,
    "awaitingLogin": 0,
    "sessions": 7,
    "queueDepth": 1,
    "isolationFindings": 0,
    "lastProbeStartedAt": 1760000000000,
    "alerts": []
  },
  "bridge_started_at": 1759990000000,
  "uptime_ms": 1234567,
  "rss_bytes": 91827364
}
```

`alerts` is the field a dashboard should page on. Current values:

| Alert | Meaning | Action |
|-------|---------|--------|
| `no_ready_accounts` | Every enrolled account is cooling / paused / unlinked. New binds fail `503 fleet_busy`. | Investigate per-account: run `fleet list`; if all `cooling`, wait; if any `needs_relogin`, run §6.2. |
| `isolation_findings` | `fleet doctor` would print at least one shared-path or identical-surface finding. | Run `fleet doctor`. Fix the shared path (assign distinct proxies) or the surface (adjust one account's profile). |
| `all_ready_accounts_at_session_cap` | Every ready account is at `maxSessionsPerAccount`. New binds fail `503 fleet_busy` reason `all_full`. | Either raise `--max-sessions-per-account`, or drain (`fleet drain`) / retire idle sessions. |
| `proxy_required_but_missing` | `--fleet-proxy-required` was set, but at least one account has no proxy. Its next launch will refuse. | Run `fleet proxy <id> <url>` for each missing account, then relaunch. |

### Reading a `fleet doctor` run

```
$ node dist/src/index.js fleet doctor
  fleet doctor — 3 account(s)
  network:
            work      proxied · exit 198.51.100.23
            personal  proxied · exit 198.51.100.31
            backup    (direct) — shares the host uplink · exit 203.0.113.7
  findings: none — distinct network paths and surfaces
  surface:
            work      de-DE / Europe/Berlin / 1440x900 / canvas-noise on
            personal  fr-FR / Europe/Paris   / 1680x1050 / canvas-noise on
            backup    en-US / Europe/Berlin  / 1280x800  / canvas-noise off
  schedule:
            work      boot phase 12.1s
            personal  boot phase 33.7s
            backup    boot phase 3.9s
  enrolled: span 2 d over 3 accounts
```

What to look for:

- **findings: none** — the important line. Any non-empty findings list
  means the fleet is not measurably isolated; see §3.1, §3.2.
- **exit IPs are distinct** — the loudest signal against farm detection.
- **surface diff is meaningful** — locale + tz should match the exit
  geography; window size and canvas-noise should differ between at least
  one pair.
- **boot phases are spread** — with default 45s, expected.
- **enrollment clustering** — `⚠ R1: clustered enrollments` means
  accounts were created too close together (see §6.3).

### Running a checkup on demand

```bash
node dist/src/index.js fleet checkup work
```

Opens a probe tab in the account's profile, waits for it to POST back,
prints the measured fingerprint. Use it after changing a Chromium build,
after changing a proxy, or when you want a fresh measurement for the
record. One checkup per account runs at a time; a second concurrent call
returns `409 checkup_in_flight`.

---

## 5. Isolation findings — what each one means

`fleet doctor` and `isolationFindings` count two findings:

### 5.1 `accounts "X" and "Y" share one network path (…)`

**Impact:** the single strongest linkage signal there is. Two accounts
on one IP are one operator to a risk engine.

**Fix:** give each account its own proxy. The proxy can be a local
forwarder, a WireGuard peer, or an SSH `-D` tunnel. It cannot be the
same endpoint as another account, and it cannot be "direct" on a fleet
with more than one account.

**Enforcement:** `--fleet-proxy-required` refuses to launch an account
without a network identity. Use it on a shared host.

### 5.2 `accounts "X" and "Y" present identical surface profiles`

**Impact:** the two profiles present identical browser environments to
any JS fingerprinting probe on the page — identical locale, timezone,
window geometry, canvas noise setting. The fleet's whole point is that
they don't.

**Fix:** adjust one account's surface:

```bash
node dist/src/index.js fleet surface personal \
  --locale fr-FR --tz Europe/Paris \
  --window 1680x1050 --canvas-noise on --force
```

The `--force` is required because the account is live (C12). If the
accounts are still `awaiting_login`, `--force` is not needed.

### 5.3 The checkup reports *identical* canvas hashes even with noise on

**Impact:** this Chromium build ignores the `--fingerprinting-canvas-*-noise`
switches. The fleet cannot lie about this; it reports the truth.

**Fix:** install a build that honors the switches — Chromium, Chrome Dev,
Chrome Canary, Brave, or Edge. There is no software-side workaround; more
switches is not the answer.

---

## 6. Incidents

### 6.1 A single account is cooling (rate-limited)

Symptom: `fleet list` shows `cooling`, or `/healthz` `fleet.cooling >= 1`.

**What's happening:** the provider's per-account rate-limit window is
open — usually ~20 minutes after a "Messages too frequent" response.
Traffic to that account is refused with `429 rate_limited` and a
`Retry-After`.

**Do:**

- Nothing. Other accounts keep serving their own sessions undisturbed.
- Do **not** move the cooling account's sessions elsewhere; that is what
  `fleet drain` is for when a human cannot come back (§6.2), and it costs
  a full history replay.

**Do not:**

- Switch IPs to "fix" it. That is an identity change (§3.3).
- Hammer the account with retries that ignore `Retry-After`; the bridge
  already paces callers correctly.

### 6.2 An account needs re-login

Symptom: `fleet list` shows `needs-relogin`; `/healthz`
`fleet.needsRelogin >= 1`; sessions bound to that account return
`503 account_paused`.

**What's happening:** the injector detected the login wall — the session
was revoked, the account was locked, or the tab was logged out. This is
a stop sign from the provider.

**Do:**

1. `node dist/src/index.js fleet login <id>` opens the profile's window
   on the login page.
2. Complete the captcha **through the account's own proxy**, in the
   account's own window. Do not use a system browser on a different IP.
3. When the injector reports the tab healthy, the account resumes and
   its sessions unpause on the same account. No reseeds, no rebinds.

**If the human cannot return promptly:**

```bash
node dist/src/index.js fleet drain <id> --to auto --dry-run    # plan
node dist/src/index.js fleet drain <id> --to auto              # execute
```

The drain is explicit, serialized (one at a time), and priced: each
moved session replays its full history on the target. Read the plan
before executing.

**Do not:**

- Log in from a different profile.
- Re-login repeatedly if the first attempt fails — a second failure is a
  stronger signal than the first.
- Drain "just in case"; drains are priced and should be rare.

### 6.3 An account is banned

Symptom: a captcha you cannot solve; the account is unreachable no
matter what you do; a lock notice from DeepSeek.

**Do:**

1. Leave it. `fleet remove <id>` unbinds the account (profile dir kept
   on disk unless you purge — do not purge; keep it for forensics).
2. If sessions were bound to it, `fleet drain <id>` them onto a healthy
   account or let them end naturally.
3. **Do not** immediately re-enroll a replacement on the same proxy +
   profile path. The risk engine that banned the account is watching
   that path by definition.

**To replace it:**

- New profile dir (`fleet add <new-id>`).
- New proxy endpoint. Not the burned one.
- New surface — different locale/timezone/window pair than the burned
  account used.
- **Days apart**, not minutes.

### 6.4 All accounts are cooling

Symptom: `/healthz` `fleet.ready == 0`, alert `no_ready_accounts`. New
binds fail `503 fleet_busy`.

**What's happening:** simultaneous rate-limit windows. Rare with ≥ 2
accounts; requires simultaneous 429s.

**Do:**

- Let callers handle the typed `429` / `503` — the bridge already emits
  `Retry-After` with the shortest remaining cooldown.
- If this happens often, add a third account. The probability that three
  independent rate-limit windows coincide is low.

**Do not:**

- Disable the per-account gate (`--per-account-turns=0`) to "let more
  through". The provider refuses a 3rd concurrent generation per
  account; the gate turns that server-side refusal into a queue instead
  of errors.

### 6.5 The bridge crashed without a signal

Symptom: the process is gone; `ps` may still show Chrome children.

**What should happen:** the bridge installs `uncaughtException` and
`unhandledRejection` handlers that call `dispose()` before exiting.
`dispose()` calls `launcher.killAll()` which SIGTERMs every profile's
Chrome and every in-flight probe tab. This is verified by the E2E
harness (`just e2e-fleet`).

**If Chrome is still alive after a hard crash** (e.g. `kill -9`), it is
safe to `pkill -f 'fleet-home'` matching the fleet's profile root. The
profiles themselves are intact; the next `fleet open <id>` or on-demand
relaunch picks up where they left off.

### 6.6 Proxy endpoint is unreachable

Symptom: one account's link never comes up; `/healthz` shows it
`unlinked`; `fleet doctor` exit-IP probe reports `(timeout)` or
`(refused)` for that account.

**What should NOT happen:** Chrome falling back to a direct connection.
Chrome does not do this by default with `--proxy-server`, and the
bridge does not add any silent fallback. A proxy outage is an
availability event, never an identity leak.

**Do:**

1. Test the endpoint manually: `curl --socks5-hostname <host:port>
   https://api.ipify.org`.
2. Check the local forwarder's log if you use one.
3. Check the upstream provider's status.
4. Fix or replace the endpoint (the latter only for an account that has
   not yet established identity — otherwise treat it as a new profile,
   §3.3).

### 6.7 A required env var is unset

Symptom: `fleet add` or on-demand relaunch logs
`fleet.proxy-unset`; a launch refuses to start.

**What's happening:** `expandEnvRefs` is fail-closed. The proxy value
`${FLEET_PROXY_WORK}` names an environment variable that is not set in
the bridge's environment.

**Do:**

- Set the variable in the service unit's `Environment=` line, restart
  the bridge.
- Or unset the account's proxy: `fleet proxy <id> off`. This is allowed
  for a fleet that only has one account; for a multi-account fleet it
  produces a shared-path finding (§5.1).

---

## 7. Rollback

The fleet layer is designed to be removable without migration:

```bash
# Option A: disable for one session
node dist/src/index.js serve --fleet-file="" ...

# Option B: disable permanently
rm /var/lib/tab-bridge/fleet.json
# restart the bridge; --fleet-file default resolves to a nonexistent path
# and the fleet stays off
```

**What survives:**

- Chrome profile directories under `fleet-root` — the accounts are still
  logged in inside their jars. If you re-enable the fleet and re-`add`
  the same ids, they will re-claim the same profiles via their stable
  `instance` ids.
- The session journal. Sessions bound to now-unknown accounts will fail
  their next pre-flight with `account_paused` or re-bind via placement;
  no session is silently moved between accounts.

**What does not survive:**

- Fleet configuration (proxy assignments, surface assignments) — they
  live in `fleet.json`, which is what you deleted. If you plan to
  re-enable, note them down first: `fleet doctor` output is the
  authoritative record.

---

## 8. What the E2E harness verifies — and what it does not

Run:

```bash
just e2e-fleet
```

The harness launches two real Chromium profiles (via the same
`FleetLauncher` the bridge uses), enrolls two accounts, and asserts:

- Two Chrome processes with distinct `--user-data-dir`.
- Both workers connect and are routed to distinct `WorkerPool`s.
- `/v1/accounts` reports distinct fingerprints and surfaces.
- `bootPhaseMs` matches `staggerDelayMs(id, window)` — deterministic
  anti-synchrony.
- The fingerprint probe runs and returns real measurements from each
  profile (canvas hash, language, timezone, window dimensions).
- `fleet remove work` kills only work's Chrome; personal survives.
- `SIGTERM` on the bridge cleans up personal's Chrome.

The harness **skips cleanly** (exit code 2) when no Chromium-family
browser is installed. It is not part of `pnpm test`; run it explicitly.

### What the harness does *not* verify

The DeepSeek DOM layer is out of reach without a login, and login is
captcha-gated by design (C1). The following remain **human-driven drills**:

| Drill | Frequency | Procedure |
|-------|-----------|-----------|
| Real chat turn through a bound session | On version bump | Point an OpenAI client at the bridge; run a simple prompt; check the SSE round-trip and `X-Fleet-Account`. |
| Rate-limit window observation | When a `429` first appears in logs | Confirm the account cools, sessions pause, the retry after the window reseeds, and the same account serves. |
| Login-wall detection | When a challenge appears | Confirm `needs_relogin`, session pause typed 503, re-login resumes pinned. |
| Checkup reading after a Chromium upgrade | After any browser bump | `fleet checkup <id>`, compare canvas hash to the previous run; if it changed for one profile but not another, the switches are honored — if both changed, the build drifted. |

These drills are the honest boundary of automated verification. The
alternative — automating a DeepSeek login — would require solving a
captcha, which the project refuses to do.

---

## 9. When to add a third account

Not every scaling question needs a third account. A decision tree:

```
Are callers hitting 503 fleet_busy regularly?
├── Yes, reason=none_ready → more accounts won't help; investigate why
│                            existing ones aren't ready (cooling? unlinked?)
├── Yes, reason=all_full  → raise --max-sessions-per-account first.
│                            Sessions are cheap-ish but each costs a reseed
│                            per hour. Only then consider a third account.
└── No                    → you don't need a third account.

Are all accounts frequently cooling simultaneously?
├── Yes → a third account smooths the coincidences; add it.
└── No  → do not add; you will spend proxy money for no gain.
```

Adding an account is not free:

- 200–400 MB per running Chrome process (worse under load).
- One proxy endpoint per account, forever.
- One more profile whose login expires someday.
- One more surface to keep coherent with its exit IP's geography.

The fleet is a good tool for the operator who genuinely runs two or
three accounts. It is not a "throw more accounts at it" solution —
the provider's rate limits are per account, and the fleet is honest
about that.

---

## 10. Getting help

- `docs/SPEC.md` — the architecture specification.
- `README.md` — the user-facing overview, including the fleet section.
- `TESTING.md` — the verification ladder (Tier 0–3).
- `fleet doctor --json` — the machine-readable fleet state, suitable for
  a support ticket.
- `TAB_BRIDGE_DEBUG=1` on the bridge turns on per-observation worker
  logging; run with it and capture the log when reporting a DOM-layer
  issue.
