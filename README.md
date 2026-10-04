<div align="center">
  <img src="docs/logo.png" alt="Tab Bridge Logo" width="200"/>
  <p>
    <strong>An OpenAI-compatible facade over a stateful DeepSeek browser tab, written in TypeScript.</strong><br/>
    A zero-runtime-dependency Node bridge plus a Chrome MV3 extension that turn live chat tabs into a
    stateful <code>/v1/chat/completions</code> endpoint — hash-chained session state, fenced-JSON tool-call
    emulation with a bounded repair round, a generation gate that queues what the provider would refuse,
    and an error taxonomy keyed to coding-harness retry semantics (kod / Cline / Aider).
  </p>
  <p>
    <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
    <img src="https://img.shields.io/badge/Node-%E2%89%A520%20%7C%2024-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node"/>
    <img src="https://img.shields.io/badge/API-OpenAI--Compatible-007ACC?style=flat-square" alt="OpenAI compatible"/>
    <img src="https://img.shields.io/badge/Version-1.2.84-6F4E37?style=flat-square" alt="Version"/>
    <img src="https://img.shields.io/badge/Runtime%20Deps-Zero-000000?style=flat-square" alt="Zero runtime dependencies"/>
    <img src="https://img.shields.io/badge/Tests-258%20Passing-228B22?style=flat-square" alt="Tests"/>
    <img src="https://img.shields.io/badge/Chrome-MV3%20Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome MV3 extension"/>
    <img src="https://img.shields.io/badge/Worker%20Link-RFC%206455-708090?style=flat-square" alt="RFC 6455 WebSocket"/>
  </p>
</div>

---

# Tab Bridge

> [!NOTE]
> Tab Bridge is a working harness: the bridge builds with zero type errors, the full
> test suite passes, and the complete serve → load-extension → drive-DeepSeek loop is
> field-verified against the live web UI. But DeepSeek ships DOM changes without notice —
> selectors are best-effort and fixed in the injector first. See [Project Status](#project-status).

---

## Table of Contents

- [Why Tab Bridge](#why-tab-bridge)
- [Features](#features)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Usage](#usage)
- [Configuration](#configuration)
- [Reliability and Error Semantics](#reliability-and-error-semantics)
- [Testing](#testing)
- [Project Status](#project-status)

---

## Why Tab Bridge

The OpenAI protocol is stateless by construction; a driven browser tab is the most
stateful client imaginable. Forcing one shape onto the other without an explicit
translation layer produces the classic silent-corruption bugs: duplicated context after
regeneration, wrong context after truncation, phantom history after a restart. Tab
Bridge exists to make that mismatch explicit, bounded, and testable.

- **A facade, not a proxy.** The OpenAI shape is the product surface, never the
  architecture. Five strict layers — L4 facade → L3 session/reconciliation → L2 tool
  emulation → L1 adapter → L0 browser runtime — translate the stateless protocol into
  the stateful world, and only at explicitly designed seams.
- **Session state you can audit.** Every message lands on a per-session blake2b16 hash
  chain (position + content covered). Reconciliation is a total, deterministic function
  of the chain delta and the tab's last output hash: one of exactly four plans, never a
  heuristic guess. Persistence is JSONL of chain digests only — no transcripts — and
  boot replay resumes chains exactly.
- **Tools without a tool-calling API.** Tools are negotiated in-prompt and parsed from
  fenced JSON blocks. Call ids are deterministic (`call_` + blake2b(name, args)[:10]),
  so `tool_call_id` linkage survives restarts. One bounded repair round runs on
  protocol violations; exhaustion degrades to a text completion with an
  `x_bridge_warning` — never a hang.
- **Provider refusals become protocol, not surprises.** Cloudflare challenges, send
  frequency limits, concurrency caps, pool exhaustion, same-session overlap — each maps
  to a specific HTTP status with `Retry-After`, so a coding agent's retry logic can act
  on them cheaply. Never an HTML error page, and an empty successful stream is
  structurally impossible.
- **Queueing where the provider says no.** DeepSeek refuses a third concurrent
  generation; the bridge turns that server-side refusal into client-side FIFO queueing
  that callers observe only as a longer time-to-first-byte.
- **Zero runtime dependencies.** Dev deps are `typescript` and `@types/node`, and that
  is the whole list. The WebSocket server is a hand-rolled RFC 6455 implementation; the
  test suite runs on `node:test` alone.
- **Tested like it will be used.** 258 tests over unit, contract (real HTTP + SSE stack
  against a scripted adapter), and worker-link tiers (real WebSocket against a fake
  extension), plus a 15-scenario E2E over real sockets and a four-tier ladder up to a
  real coding-agent loop.

---

## Features

### OpenAI facade (L4 · `src/facade/`)

- **Full chat-completions semantics** — stream and non-stream, role frame first, usage
  chunk last, `[DONE]` terminal. SSE headers are sent lazily on the first real frame.
- **Session affinity** — `X-Session-ID` header → `user` field → `metadata.session_id`;
  absent means the stateless legacy path.
- **Bearer auth** via `--api-key-env`; `/healthz` echoes the effective configuration
  (no auth) so ops can see mode flags, session count, and per-tab health at a glance.

### Session engine (L3 · `src/core/`, `src/engine.ts`)

- **blake2b16 hash chain** — 16 bytes per message, position and content covered, plus
  the tab's own last output hash (`tabHash`).
- **Four reconciliation plans, deterministic and total:**

  | Plan | Fires when | Cost |
  |------|------------|------|
  | `SEED` | fresh row, scheme mismatch, divergence, stateless mode | full flatten + submit |
  | `INJECT_TEXT` | delta = one user message (or echo-skip continuation) | text only |
  | `INJECT_RESULTS` | delta = tool results after a tab-generated tool call | results only, echo skipped |
  | `RESET_RESEED` | regeneration, divergence, fabricated content | reset + full flatten |

- **Failure containment** — turns that fail mid-flight mark the row `pendingReset`
  (persisted) and drop `tabHash`, so the next request reseeds instead of injecting
  after an unknown tab state. Session TTL sweep and same-session overlap (`409`) are
  registry-level concerns; eviction never silently reuses a live tab.

### Tool-call emulation (L2 · `src/emulation/`)

- **In-prompt negotiation** — a `tool-protocol: 1` block advertises tools; calls come
  back as fenced JSON; the legacy `[tool_call id=… name=…]` text convention is accepted
  on input **and** output.
- **Streaming holdback** — text flows immediately; fence regions resolve to
  `delta.tool_calls` (index-keyed, arguments as a single fragment) or flush back as
  content with a warning when they exceed the holdback ceiling.

### Worker link and tab pool (L0 · `src/link/`, `src/pool/`, `extension/`)

- **Zero-dep RFC 6455 WebSocket server** — text frames, ping/pong, close, client
  fragmentation reassembly, hardening tests (unmasked frame → 1002, fragment flood →
  1009), and an Origin allow-list that rejects web-page origins.
- **Intent protocol** — `BIND` / `SEND` / `RESET` / `ABORT` / `RELEASE` down,
  `BOUND` / `ACCEPTED` / `FRAGMENT` / `STATUS` / `HEALTH` / `ERROR` up.
- **Managed tab pool** — managed-only allocation, warm tabs, idle close, a per-tab
  ~20-minute cooldown after a rate-limit hit, and a cap on worker-managed tabs.
- **Field-hardened injector** — paste-to-file handling for large prompts, mandatory
  send-button-enabled gating (up to 90 s), submit verification with one alternate-method
  retry, reply scraping of post-submission nodes only, provider rate-limit detection,
  and a MAIN-world SSE hook that captures completions off the wire with a DOM observer
  fallback.

### Generation gate (`src/core/turngate.ts`)

- **Client-side queueing for a server-side cap** — `--max-concurrent-turns` (default 2)
  bounds generations in flight; extras wait FIFO in a bounded queue
  (`--queue-capacity`, `--queue-timeout-ms`). Queued turns are invisible to callers —
  a coding agent just observes a longer "thinking" phase.
- **Observability** — `/healthz` exposes `turn_gate` (active/waiting/capacity);
  non-streaming responses carry `x-bridge-queued-ms`; audit logs emit
  `turn.gate.wait|admit|full|timeout|client-gone`.

---

## Architecture

| Path | Layer | What it is |
|------|-------|------------|
| `src/facade/` | L4 | HTTP server, SSE encoder, endpoints, typed error taxonomy |
| `src/core/` | L3 | canonical messages, blake2b16 hash chain, turn classifier, session registry (TTL/409), JSONL persistence, generation gate |
| `src/emulation/` | L2 | prompt compiler, fence/legacy parser, deterministic call ids, streaming holdback |
| `src/adapter/` | L1 | `ChatProviderAdapter` contract, DeepSeek adapter, scripted adapter for tests |
| `src/link/`, `src/pool/` | L0 link | hand-rolled RFC 6455 WebSocket server + worker pool |
| `src/engine.ts` | — | turn orchestration: classify → plan → stream → repair → commit |
| `src/bridge.ts` | — | application wiring: registry + persistence + pool + adapter + worker link |
| `extension/` | L0 | Chrome MV3: service worker (tab pool), injector, MAIN-world SSE hook |
| `test/`, `e2e/` | — | 258 tests + 15 wire-level E2E scenarios |
| `docs/SPEC.md` | — | the architecture specification — the design source of truth |

### Data flow

```
        kod / Cline / Aider (OpenAI clients)
                        │ HTTP + SSE
                        ▼
        ┌────────────────────────────────────────────┐
        │ L4 facade                                  │
        │ /v1/chat/completions · /v1/models          │
        │ /v1/sessions · /healthz · error taxonomy   │
        └─────────────────────┬──────────────────────┘
                              ▼
        ┌────────────────────────────────────────────┐
        │ L3 session engine                          │
        │ classify → SEED / INJECT_TEXT /            │
        │   INJECT_RESULTS / RESET_RESEED            │
        │ blake2b16 chain · registry · JSONL journal │
        └─────────────────────┬──────────────────────┘
                              ▼
        ┌────────────────────────────────────────────┐
        │ L2 tool emulation                          │
        │ prompt compiler · fenced tool_call parser  │
        │ holdback stream · deterministic call ids   │
        └─────────────────────┬──────────────────────┘
                              ▼
        ┌────────────────────────────────────────────┐
        │ L1 adapter ── L0 worker link (zero-dep WS) │
        └─────────────────────┬──────────────────────┘
                              ▼  BIND / SEND / RESET
        ┌────────────────────────────────────────────┐
        │ Chrome MV3 extension                       │
        │ service worker (tab pool) · injector ·     │
        │ MAIN-world SSE hook                        │
        └─────────────────────┬──────────────────────┘
                              ▼
                chat.deepseek.com (managed tabs)
```

The in-repo `docs/SPEC.md` is the design source of truth; `docs/tab-bridge-*.md` hold
the dated production plans behind recent changes, and `TESTING.md` documents the
four-tier verification ladder.

---

## Getting Started

### Prerequisites

- **Node** ≥ 20 (tested on 24; E2E uses the global `WebSocket`, so ≥ 22 is recommended)
- **pnpm** or npm — dev deps only (`typescript`, `@types/node`)
- **Chrome / Chromium** ≥ 116 — to load the MV3 extension
- A **DeepSeek account** — only for real traffic (Tiers 2–3 of the test ladder)

### From source

```bash
git clone https://github.com/elcoosp/tab-bridge.git
cd tab-bridge
pnpm install        # dev deps only
pnpm run typecheck  # tsc --noEmit → 0 errors
pnpm test           # build + 258 tests
```

`dist/` ships prebuilt; `pnpm test` rebuilds it.

### First run

```bash
# 1. Start the bridge
node dist/src/index.js serve --port 8789 \
  --api-key-env TAB_BRIDGE_KEY \
  --stateful=true --auto-create-tabs --managed-only \
  --ttl=30m --repair-rounds=1 --holdback-ceiling=65536

# 2. Load the extension: chrome://extensions → Developer mode →
#    Load unpacked → select extension/
#    The service worker connects to ws://127.0.0.1:8789/worker

# 3. Check the worker linked up
curl http://127.0.0.1:8789/healthz

# 4. Send a real request
curl -N http://127.0.0.1:8789/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TAB_BRIDGE_KEY" \
  -H "x-session-id: my-first-session" \
  -d '{"model":"deepseek-web-think","stream":true,
       "messages":[{"role":"user","content":"List the primes under 50."}]}'
```

> [!TIP]
> The in-repo justfile's `serve` recipe runs the bridge with the field-tested flag
> set (including `--reset-on-seed=auto --max-tabs=4 --tab-idle-close=15m`). Prefer it
> during development. To point the extension at a different bridge URL, set `wsUrl`
> via `chrome.storage.sync`; with auth enabled, append `?token=…` to the URL.

---

## Usage

```
serve · /v1/chat/completions · /v1/models · /v1/sessions · /healthz
```

| Endpoint | Behavior |
|----------|----------|
| `POST /v1/chat/completions` | Full OpenAI semantics, stream + non-stream. Session affinity: `X-Session-ID` header → `user` field → `metadata.session_id`; absent = stateless legacy path |
| `GET /v1/models` | `{data:[{id}]}` with `deepseek-web-chat` and `deepseek-web-think` |
| `POST /v1/sessions` | Create; `?force=true` evicts the oldest idle session on pool exhaustion |
| `GET /v1/sessions` | Registry listing (session, tab, state, turns, chain length) |
| `DELETE /v1/sessions/:id` | 204; releases the tab, clears the row |
| `GET /healthz` | Mode flags, session count, turn gate, per-tab health (no auth) |

```bash
# A/B a refactor through the same endpoint your agent uses: any OpenAI SDK,
# Cline, Aider, or kod can point at the bridge with zero client changes.
```

### Wiring up kod

`examples/kod-config.toml` is a ready-to-paste endpoint block. The two values that
matter: `context_window` stays within the backing model's real limit (the bridge
refuses — never truncates — prompts over `--max-prompt-chars`), and `timeout_secs`
must cover the generation queue budget:
`timeout_secs > queue_timeout_ms/1000 + 2 × turn_timeout_ms/1000`. The example ships
with 900 s and `rate_limit_wait_secs = 1500`, which sleeps out DeepSeek's full
20-minute send-frequency window exactly once, then re-drives.

---

## Configuration

Behavior is consolidated into `serve` flags — every ADR has a knob, and `/healthz`
echoes the effective configuration so drift is visible.

| Flag | Default | Purpose |
|------|---------|---------|
| `--port` | `8789` | HTTP port |
| `--host` | `127.0.0.1` | Bind address |
| `--api-key-env <NAME>` | off | Env var holding the shared-secret bearer token |
| `--stateful` | `true` | ADR-6 mode; `false` = always-reset fallback |
| `--auto-create-tabs` | `false` | Worker may create managed tabs |
| `--managed-only` | `true` | Allocate only worker-created tabs |
| `--ttl` | `30m` | Idle session TTL |
| `--repair-rounds` | `1` | Bounded tool-protocol repair rounds (0–3) |
| `--holdback-ceiling` | `65536` | Max chars buffered inside an open tool_call fence before it flushes as content with a warning |
| `--warm-tabs` | `0` | Pre-created managed tabs (0–8) |
| `--db` | `./bridge-sessions.json` | Session journal path |
| `--turn-timeout-ms` | `240000` | Per-turn observation deadline |
| `--bind-timeout-ms` | `20000` | Bind/readiness deadline |
| `--max-prompt-chars` | `1000000` | Refuse (never truncate) prompts over this size |
| `--max-concurrent-turns` | `2` | Provider generations in flight; `0` disables the gate |
| `--queue-capacity` | `32` | Max turns waiting in the generation queue |
| `--queue-timeout-ms` | `600000` | Max queue wait before `503 queue_timeout`; `0` waits forever |
| `--reset-on-seed` | `auto` | SEED-into-dirty-tab policy: `auto` \| `always` \| `never` |
| `--max-tabs` | `4` | Cap on worker-managed tabs; `0` = unbounded |
| `--tab-idle-close` | `15m` | Close ready+unbound tabs idle beyond this; `0` = never |
| `--worker-origin <origin>` | `chrome-extension://*` | Comma-separated allowed Origin values for the worker upgrade |

> [!WARNING]
> The bridge drives a logged-in DeepSeek account. Keep `--host` on `127.0.0.1` and set
> `--api-key-env` whenever anything other than your own user can reach the port — an
> unauthenticated caller can consume your account's rate-limit window as if it were you.
> If your account allows only one concurrent generation, run `--max-concurrent-turns=1`.

---

## Reliability and Error Semantics

Every failure mode the bridge knows about has a wire shape a retry loop can act on
(ADR-7):

| Condition | Response |
|-----------|----------|
| Cloudflare challenge | `429` + `Retry-After: 30` |
| Send-frequency limit ("Messages too frequent") | `429` + `Retry-After` (remaining cooldown; `1200` s when the worker reports none) — tab cools down ~20 min, session marked `pendingReset`, retry performs a full reseed |
| Concurrency refusal ("Another message is being generated") | `429` + `Retry-After: 15` — unreachable through the gate; can surface when a human drives the account in a parallel window |
| Pool exhaustion / worker link down | `503 pool_exhausted` + `Retry-After: 5`; reconnect recovers |
| Queue overflow / starvation | `503 queue_full` / `queue_timeout` + `Retry-After: 5` |
| Same-session overlap | `409 session_busy` — the gate is cross-session capacity only |
| Tab failure / submit failure | `502` with an actionable message (e.g. the paste-to-file explanation) |
| Malformed request, `n>1`, unsupported params | `400`; accepted-and-ignored params are listed in `X-Bridge-Ignored` |
| Client disconnect while queued | `499 client_gone` (internal; never reaches the wire) |

Two provider behaviors are modeled explicitly rather than worked around:

1. **Large pastes become file attachments.** DeepSeek converts big composer input into
   a `Pasted Content_<timestamp>.txt` attachment, empties the composer, and keeps the
   send button disabled until processing finishes. The injector routes prompts through
   a synthetic paste event, waits for the send control to become truly enabled, and
   verifies the submit actually started — with one alternate-method retry before
   reporting `send-button-disabled`.
2. **Rate limits accept-then-error.** The wire shape is `ready` → hint with
   `finish_reason: "rate_limit_reached"` → `close`, leaving an orphan user message and
   no reply. The injector detects the bubble, the bridge maps it to `429` +
   `Retry-After: 1200`, cools the tab down, and marks the session `pendingReset` — the
   orphan message is cleaned on reset, never injected after.

---

## Testing

```bash
pnpm run typecheck   # 0 errors
pnpm test            # build + 258 tests (node --test)
pnpm run e2e         # real bridge binary + real WS worker + real HTTP/SSE
```

Four tiers, each answering a different question — run them in order, because a failure
in a lower tier invalidates everything above it. See [TESTING.md](TESTING.md) for the
full drill, including the real-browser tier.

| Tier | Question it answers | Needs Chrome? | Needs DeepSeek account? |
|------|---------------------|---------------|--------------------------|
| 0 | Is the logic correct? (258 unit + contract tests) | no | no |
| 1 | Does the whole bridge work over real sockets? (15 E2E scenarios) | no | no |
| 2 | Does the real extension drive the real DeepSeek page? | **yes** | **yes** |
| 3 | Does a real coding agent complete real work through it? | yes | yes |

The contract tier drives the real HTTP + SSE stack against a scripted adapter; the
worker-link tier connects a fake extension over a real WebSocket and exercises
BIND → SEND → FRAGMENT → SSE end to end, including reset, `409` overlap,
`503`-without-worker, token auth, and a SIGTERM/restart persistence drill. What Tier 1
cannot prove is DOM behavior — that is Tier 2's job.

---

## Project Status

### Working end-to-end

- The full loop: serve → load unpacked extension → session-affine chat completions →
  tool round-trips → streaming SSE → hash-bound persistence across restarts.
- All four reconciliation plans, fenced-JSON tool emulation with deterministic ids and
  the holdback stream, one bounded repair round with graceful degradation.
- Field-verified DeepSeek handling: paste-to-file submit gate, send-button-enabled
  wait with submit verification, rate-limit accept-then-error mapping with tab
  cooldowns, generation gate with bounded FIFO queueing.
- Workspace hygiene: zero runtime dependencies, 0 typecheck errors, 258 passing tests,
  hand-rolled RFC 6455 server with hardening tests, Origin allow-listing, bearer auth.
- Persistence is restart-safe by design: JSONL of chain digests only, async journal
  write queue, SIGTERM flush, boot replay resumes chains exactly.

### Known limitations

- **DeepSeek selectors are best-effort** (versioned `SELECTOR_BUNDLE "ds-2"`); DOM
  drift is fixed in `extension/injector.js` first. The Continue-button auto-resume
  click is the current open investigation — see [HANDOFF.md](HANDOFF.md).
- **`n>1`, `logprobs`, and `response_format: json_object` are rejected with `400`**;
  `temperature` / `top_p` / `max_tokens` / `stop` are accepted and ignored (surfaced
  via `X-Bridge-Ignored`).
- **Usage numbers are synthesized** (`chars/4`, rounded to be round-trip-safe) — the
  web UI exposes no token accounting.
- **The WebSocket server implements the RFC 6455 subset** the worker needs (text
  frames, ping/pong, close, client fragmentation reassembly) — not a general-purpose
  server.
- **One DeepSeek account is one capacity unit**: rate-limit windows and the
  concurrency cap are account-wide, so parallel human use shares the same budget.

> [!WARNING]
> Tab Bridge is a harness against a live, undocumented web UI. The guarantees it makes
> — hash-chained state, bounded reconciliation, typed errors, restart-safe persistence
> — are real; *playing strength* of the backing model is whatever DeepSeek serves that
> day, not something this project controls.

---

<p align="center">
  <em>Tab Bridge is an active work in progress. DOM-drift reports, selector fixes, and protocol discussions are welcome.</em>
</p>
