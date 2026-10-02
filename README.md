# Tab Bridge

**OpenAI-compatible facade over a stateful browser chat tab** (DeepSeek v1).
Implementation of the Tab Bridge Architecture Specification: five strict layers
(L4 facade → L3 session/reconciliation → L2 tool emulation → L1 adapter → L0
browser runtime), hash-chain session state, fenced-JSON tool protocol with one
bounded repair round, and an error taxonomy keyed to coding-harness retry
semantics (kod / Cline / Aider).

```
kod harness ──HTTP/SSE──▶ L4 facade ──▶ L3 session engine ──▶ L2 emulation
                                              │                     │
                                         L1 adapter ◀──WS──▶ L0 extension (Chrome)
                                                                  └─ injector ─ chat.deepseek.com
```

## Repository layout

| Path | What it is |
|---|---|
| `src/core/` | L3: canonical messages, blake2b16 hash chain, turn classifier, session registry (TTL/409), JSONL persistence |
| `src/emulation/` | L2: prompt compiler, fence/legacy parser, deterministic call ids, streaming holdback |
| `src/adapter/` | L1: `ChatProviderAdapter` contract, DeepSeek adapter (bridge side), scripted adapter for tests |
| `src/link/`, `src/pool/` | L0 link: zero-dependency RFC 6455 WebSocket server + worker pool |
| `src/facade/` | L4: HTTP server, SSE encoder, endpoints, error taxonomy |
| `src/engine.ts` | Turn orchestration: classify → plan → stream → repair → commit |
| `extension/` | Chrome MV3 extension: service worker (tab pool) + DeepSeek injector |
| `test/` | 89 tests: unit, golden-ish, contract (HTTP, fake adapter), worker-link integration (real WebSocket), rate-limit recovery |
| `examples/kod-config.toml` | Ready-to-paste kod endpoint block |

**Zero runtime dependencies.** Dev deps: `typescript` + `@types/node` only.

## Build & test (0-error guarantee)

```bash
pnpm install          # dev deps only
pnpm run typecheck    # tsc --noEmit  → 0 errors
pnpm test             # build + node --test dist/test/*.test.js → 89 pass
pnpm run e2e          # bridge E2E: real bridge binary + real WS worker + real HTTP/SSE → 15 scenarios
pnpm start            # = node dist/src/index.js serve --help for flags
```

Requires Node ≥ 20 (tested on 24; E2E suite uses the global `WebSocket`, so
≥ 22 recommended for Tier 1). `dist/` ships prebuilt; `pnpm test` rebuilds it.

**How to test everything end-to-end for real** — see **[TESTING.md](TESTING.md)**:
four tiers from unit tests to the full real-browser drill (Chrome extension +
live DeepSeek: paste-to-file send gate, live rate limits, failure drills) up
to a kod agent loop.

## Run

```bash
node dist/src/index.js serve --port 8789 \
  --api-key-env TAB_BRIDGE_KEY \
  --stateful=true --auto-create-tabs --managed-only \
  --ttl=30m --repair-rounds=1 --holdback-ceiling=65536
```

Flags consolidate every ADR: `--stateful` (ADR-6 mode), `--auto-create-tabs` /
`--managed-only` (pool policy), `--ttl` (idle sweep), `--repair-rounds`
(ADR-5 budget), `--warm-tabs` (warm pool), `--db` (session journal path),
`--holdback-ceiling` (max chars buffered inside an open `tool_call` fence
before it flushes as content with a warning — raise it when the model inlines
large payloads, never below 1000). `/healthz` echoes the effective
configuration.

Load the extension: Chrome → `chrome://extensions` → Developer mode →
**Load unpacked** → select `extension/`. It connects to
`ws://127.0.0.1:8789/worker` (configurable via the extension's synced
`wsUrl` storage key), announces `HELLO`, and answers BIND/SEND/RESET intents.

## Endpoints (v1)

| Endpoint | Behavior |
|---|---|
| `POST /v1/chat/completions` | Full OpenAI semantics, stream + non-stream. Session affinity: `X-Session-ID` header → `user` field → `metadata.session_id`; absent = stateless legacy path |
| `GET /v1/models` | `{data:[{id}]}` with `deepseek-web-chat`, `deepseek-web-think` |
| `POST /v1/sessions` | Create; `?force=true` evicts the oldest idle session on pool exhaustion |
| `GET /v1/sessions` | Registry listing (session, tab, state, turns, chain length) |
| `DELETE /v1/sessions/:id` | 204; releases the tab, clears the row |
| `GET /healthz` | Mode flags, session count, per-tab health (no auth) |

Errors map to harness semantics (ADR-7): CF challenge → **429 + Retry-After 30s**;
provider send-frequency limit ("Messages too frequent") → **429 + Retry-After
(remaining cooldown, 1200s when the worker reports no remainder)**
(~20 min window, field-verified); pool exhaustion → **503 + Retry-After**;
same-session overlap → **409**; malformed request / `n>1` / unsupported params → **400**
with `X-Bridge-Ignored`; tab failure → **502**; never an HTML error page, and
an empty successful stream is structurally impossible (SSE headers are sent
lazily on the first real frame).

## Field-verified DeepSeek composer behaviors (v1.1)

Two provider behaviors are explicitly modeled by the injector and the bridge:

1. **Large pastes become file attachments.** When a big prompt is placed into
   the composer, DeepSeek converts it into a `Pasted Content_<timestamp>.txt`
   attachment, empties the composer, and keeps the **send button disabled**
   until the attachment finishes processing. The injector therefore
   (a) routes prompts ≥ 4 000 chars through a synthetic paste event so the
   site's own pipeline runs, (b) waits for the send control to become enabled
   (`aria-disabled`/`disabled`/`pointer-events` checked, up to 90 s), and
   (c) verifies the submit actually started (stop button / new bubble /
   cleared composer) with one alternate-method retry before reporting
   `send-button-disabled` (→ 502 with an actionable message).
2. **Send-frequency rate limits accept-then-error.** The wire shape is
   `event: ready` (message accepted) → `event: hint` with
   `finish_reason: "rate_limit_reached"` → `event: close` — i.e. the tab keeps
   an **orphan user message** and never produces a reply. The injector detects
   the "Messages too frequent" bubble in new reply nodes/toasts and reports
   `ERROR{code:"rate_limited"}`; the bridge maps it to 429 + Retry-After 1200,
   puts the tab into a 20-minute cooldown (no re-allocation until it expires),
   and marks the session `pendingReset` so the retry performs a full
   RESET_RESEED — the orphan message is cleaned, never injected after.

Health-visible: cooling tabs report `rate_limited` via `HEALTH` and appear in
`/healthz` `tabs[]` until the cooldown lapses.

## Generation gate (max concurrent DeepSeek generations)

DeepSeek refuses a send while the account already has ~2 concurrent
generations running ("Another message is being generated"). The bridge turns
that server-side refusal into client-side queueing:

- `--max-concurrent-turns=<n>` (default 2): turns holding a generation slot
  at once. `0` disables the gate.
- `--queue-capacity=<n>` (default 32): max queued turns; overflow fails fast
  with `503 queue_full` + `Retry-After: 5`.
- `--queue-timeout-ms=<n>` (default 600000): max queue wait; starvation fails
  with `503 queue_timeout` + `Retry-After: 5`. `0` waits forever.

Queued turns are invisible to callers: a client (kod included) just observes
a longer time-to-first-byte — in kod's TUI that reads as a longer "thinking"
phase. No client-side special casing is needed. If your DeepSeek account
turns out to allow only one concurrent generation, run
`--max-concurrent-turns=1`.

Observability: `/healthz` exposes `turn_gate` (active/waiting/capacity);
non-streaming responses carry `x-bridge-queued-ms`; audit logs emit
`turn.gate.wait|admit|full|timeout|client-gone`. Same-session overlap still
returns `409 session_busy` — the gate is cross-session provider capacity
only. If the refusal ever surfaces (parallel human use of the account), the
injector reports `concurrency_blocked` and the bridge answers a retryable
`429` + `Retry-After: 15`.

## Tool-call emulation

Tools are negotiated in-prompt (`tool-protocol: 1` block) and parsed from
fenced ` ```tool_call ` JSON blocks; the legacy kod `[tool_call id=… name=…]`
text convention is accepted on input **and** output. Call ids are
deterministic (`call_ + blake2b(name,args)[:10]`) so `tool_call_id` linkage
survives restarts. Streaming uses a holdback buffer: text flows immediately,
fence regions resolve to `delta.tool_calls` (index-keyed, arguments as a
single fragment) or flush back as content. One bounded repair round runs on
protocol violations; exhaustion degrades to a text completion with an
`x_bridge_warning` field — never a hang.

## Reconciliation engine

Per-session blake2b16 chain (16 bytes/message, position+content covered) plus
the tab's own last output hash (`tabHash`). Four plans, deterministic and
total:

| Plan | Fires when | Cost |
|---|---|---|
| `SEED` | fresh row / scheme mismatch / stateless mode / empty chain | full flatten + submit |
| `INJECT_TEXT` | delta = one user message (or echo-skip continuation) | text only |
| `INJECT_RESULTS` | delta = assistant(tool_calls)=tab output + tool results | results only, echo skipped |
| `RESET_RESEED` | regeneration, divergence, fabricated content | reset + full flatten |

Persistence is JSONL of chain digests only (no transcripts); boot replay
resumes chains exactly. Turns that fail mid-flight mark the row
`pendingReset` (persisted) and drop `tabHash`, so the next request performs a
full reseed instead of injecting after an unknown tab state.

## Testing the bridge without DeepSeek

```bash
node --test dist/test/            # full suite; ScriptedAdapter fakes the tab
```

The contract tier drives the real HTTP+SSE stack against a scripted adapter;
the worker-link tier connects a fake extension over a real WebSocket and
exercises BIND → SEND → FRAGMENT → SSE end to end, including reset, 409
overlap, 503-without-worker, and token auth.

## Known limitations (v1)

- DeepSeek selectors are best-effort (`SELECTOR_BUNDLE "ds-2"`); a DOM drift
  is fixed in `extension/injector.js` only.
- `n>1`, `logprobs`, `response_format: json_object` are rejected 400;
  `temperature`/`top_p`/`max_tokens`/`stop` are accepted and ignored.
- Usage numbers are synthesized (chars/4), rounded to be round-trip-safe.
- The WebSocket server implements the RFC 6455 subset needed by the worker
  (text frames, ping/pong, close, client fragmentation reassembly).
