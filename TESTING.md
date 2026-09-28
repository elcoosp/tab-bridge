# Testing Tab Bridge end-to-end

Four tiers, each answering a different question. Run them in order — a
failure in a lower tier invalidates everything above it.

| Tier | Question it answers | Needs Chrome? | Needs DeepSeek account? |
|------|--------------------|---------------|-------------------------|
| 0 | Is the logic correct? | no | no |
| 1 | Does the whole bridge work over real sockets? | no | no |
| 2 | Does the real extension drive the real DeepSeek page? | **yes** | **yes** |
| 3 | Does a real coding agent complete real work through it? | yes | yes |

---

## Tier 0 — unit + contract tests (seconds)

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit -> 0 errors
pnpm test            # builds, then 89 tests
```

Covers: hash-chain math, the 4-plan classifier, prompt compilation, fenced
JSON parsing + validation, holdback streaming, worker-link protocol
correlation, error mapping (429/Retry-After 1200, 502, 503, 409), session
registry bookkeeping, persistence journal.

---

## Tier 1 — bridge E2E over real sockets (~25 s)

Spawns the **real built bridge binary** on a real port, connects a scripted
**fake extension over a real WebSocket** (`e2e/fake-extension.mjs`, protocol
v1), then drives the **real HTTP/SSE API** exactly like kod does.

```bash
pnpm run build
pnpm run e2e           # or: node e2e/run-e2e.mjs [--port 8977] [-v] [--print-log]
```

15 scenarios, each asserting wire-level behavior:

| # | Scenario | Asserts |
|---|----------|---------|
| S01 | healthz before worker | `worker.connected=false`, 0 sessions |
| S02 | extension handshake | HELLO/HELLO_OK over real WS, healthz reflects worker |
| S03 | GET /v1/models | both `deepseek-web-*` ids |
| S04 | validation | 404 unknown model; 400 for `n>1`, empty messages, malformed JSON; 404 unknown session |
| S05 | SEED turn (non-stream) | compiled prompt contains TOOL PROTOCOL + TRANSCRIPT + cue; `X-Bridge-Ignored`; usage = chars/4; chain committed |
| S06 | delta turn | prompt is **only** the new user text (echo-skip); no RESET; chain 3 (scheme v3: system never chained) |
| S07 | streaming SSE | role frame first → content deltas reassemble → finish frame → usage chunk (empty choices) → `[DONE]` last |
| S08 | tool round-trip | fenced tool_call → `tool_calls` + synthetic `call_…` id → tool message → `=== TOOL RESULTS ===` injected, **no reset** |
| S09 | same-session overlap | second request → **409** `session_busy`, first completes |
| S10 | provider rate limit | worker ERROR `rate_limited` → **429 + Retry-After: 1200**; retry triggers RESET + full reseed |
| S10b | send-button-disabled | worker ERROR → 502 with paste-to-file explanation |
| S11 | worker link down | **503** `pool_exhausted` + Retry-After 5; reconnect recovers |
| S12 | link lost mid-stream | 502 after the turn deadline (failure drill) |
| S13 | persistence | SIGTERM + restart → journal replay → session/chain/tabHash restored, delta turn works, no reset |
| S14 | DELETE session | 204 → gone → next turn is full SEED |

What Tier 1 proves: everything from the OpenAI socket to the worker socket —
facade, engine, classifier, hash chain, registry, persistence, adapter, pool,
WS link, error taxonomy. What it **cannot** prove: DOM behavior (that is
Tier 2).

---

## Tier 2 — REAL full-stack E2E (Chrome + real DeepSeek)

This is the tier that actually exercises the paste-to-file submit gate, the
send-button enable wait, real SSE scraping, and live rate limits.

### 2.1 Start the bridge

```bash
pnpm run build
node dist/src/index.js serve \
  --port 8789 \
  --auto-create-tabs true \
  --managed-only true \
  --ttl 30m \
  --db ./bridge-sessions.json
# add  --api-key-env TAB_BRIDGE_KEY  if you want a bearer token
```

Expect the banner: `tab-bridge listening on http://127.0.0.1:8789 (worker
link: ws://127.0.0.1:8789/worker)`.

### 2.2 Load the extension

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` directory.
3. Click **service worker** on the card → DevTools opens on the SW console.
   Expected log within ~1 s: connection established + `HELLO_OK`
   (config `{autoCreateTabs, managedOnly, warmTabs}`).
4. Verify from the outside:

```bash
curl -s http://127.0.0.1:8789/healthz | jq .worker
# -> { "ext": "deepseek-web", "connected": true }
```

5. Open `https://chat.deepseek.com/` and log in. The SW opens/claims a
   managed tab; `curl -s http://127.0.0.1:8789/healthz | jq .tabs` shows it
   with health `ok`. (If the page shows a CF challenge or login, the tab
   health flips to `cf_challenge`/`degraded` — fix the page, health follows.)

### 2.3 The three consoles (where you look when something breaks)

| Console | What it shows |
|---------|---------------|
| Bridge stdout | `turn.plan` / `turn.commit` / `turn.failed` audits, HTTP requests |
| SW DevTools (chrome://extensions → service worker) | WS intents/observations, bind/allocate, tab cooldowns |
| Tab DevTools (DeepSeek page) | injector logs: composer, paste, submit gating, fragments |

### 2.4 Smoke: non-streaming turn

```bash
curl -s http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: manual-1' \
  -d '{"model":"deepseek-web-chat",
       "messages":[{"role":"user","content":"Reply with exactly: BRIDGE OK"}]}' | jq
```

Watch the DeepSeek tab: the composer fills, the message sends, the reply
streams, then the JSON response arrives with `finish_reason:"stop"`.
Check `usage` is present and `/v1/sessions/manual-1` shows `turns: 1`.

### 2.5 Smoke: streaming

```bash
curl -N http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: manual-1' \
  -d '{"model":"deepseek-web-chat","stream":true,
       "messages":[{"role":"user","content":"Count from 1 to 20 slowly."}]}'
```

Expect: `data: {"choices":[{"delta":{"role":"assistant",...` first, content
deltas arriving as the page streams, a `finish_reason` frame, a usage frame
with empty `choices`, then `data: [DONE]`.

### 2.6 Drill: large paste → file attachment → send-button gate

Send a prompt over the 8 000-char threshold (this triggers DeepSeek's
paste-to-file path):

```bash
node -e '
const big = "Explain this text in one sentence:\n" + "lorem ipsum dolor sit amet ".repeat(1200);
process.stdout.write(JSON.stringify({model:"deepseek-web-chat",
  messages:[{role:"user",content:big}]}));' > /tmp/big.json

curl -s http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' -H 'x-session-id: big-1' \
  --data-binary @/tmp/big.json | jq '.choices[0].finish_reason'
```

In the tab DevTools console you should see the injector: synthetic paste →
`Pasted Content_….txt` attachment chip → send button disabled → **waiting for
enabled** (up to 90 s budget) → verified submit. The curl call must return
200 with a real summary, not `502 send-button-disabled`.

### 2.7 Drill: tool round-trip (kod-style)

```bash
curl -s http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' -H 'x-session-id: tools-1' \
  -d '{"model":"deepseek-web-chat",
       "messages":[{"role":"user","content":"What is the weather in Paris? Use the tool."}],
       "tools":[{"type":"function","function":{"name":"get_weather",
         "description":"current weather for a city",
         "parameters":{"type":"object","properties":{"city":{"type":"string"}},
                       "required":["city"]}}}]}' | jq '.choices[0]'
```

Expect `finish_reason:"tool_calls"` and a synthetic `call_…` id. Send the
result back (assistant echo verbatim + `role:"tool"` message, same session)
and expect `=== TOOL RESULTS ===` to appear in the injector prompt (visible in
the tab console) with the final answer coming back.

### 2.8 Drill: live rate limit (accepts-then-errors)

Fire several turns in quick succession until DeepSeek answers
"Messages too frequent". Expected behavior on the wire and in the consoles:

- bridge returns **429** with `retry-after: 1200` on a fresh limit; a
  `BIND_FAILED{rate-limited-cooldown}` carries the *remaining* cooldown as
  `retryAfterSec`, so mid-window retries get the time actually left (T4);
- the tab enters a ~20-minute cooldown (`healthz` → tabs show the tab cooling;
  new binds fail with `rate-limited-cooldown` → also 429);
- the SW console logs the `rate_limited` ERROR;
- after the cooldown lapses (or with a second account/tab), the next turn on
  the same session reseeds the tab (bridge log: `RESET` then a full SEED
  prompt) — the orphan "too frequent" user message is wiped, not appended to.

To test without waiting 20 minutes, use two DeepSeek accounts / two Chrome
profiles, each with its own extension (second profile connects its own worker
to the same bridge URL).

### 2.9 Failure drills (resilience)

| Drill | Do | Expect |
|-------|----|--------|
| Tab closed mid-session | close the DeepSeek tab, then send a turn | auto-create re-opens a tab, session rebinds, turn succeeds (chain kept) |
| Page reload | F5 on the tab mid-session | injector re-attaches, health returns to `ok`, next turn continues |
| SW killed | in chrome://extensions stop the SW, send a turn | 503 `pool_exhausted`; SW auto-revives + reconnects with backoff |
| Bridge restart | Ctrl-C the bridge, restart with same `--db`, send next turn with full history | journal replay: delta turn, no reseed (Tier-1 S13, now with a real page) |
| Divergent history | resend a *different* first user message on an existing session | `RESET_RESEED` (divergence detected), tab gets New-chat + full transcript |
| `--stateful=false` | restart bridge with that flag | every turn is a full SEED; no chain reuse |

### 2.10 Auth drill

Restart the bridge with `--api-key-env TAB_BRIDGE_KEY` (export anything).
Expect 401 without the header, 200 with `-H "Authorization: Bearer $TAB_BRIDGE_KEY"`,
and the extension SW needing `?token=…` in its `wsUrl`
(`chrome.storage.sync.set({ wsUrl: "ws://127.0.0.1:8789/worker?token=…" })`).

---

## Tier 3 — kod harness E2E (the real consumer)

`examples/kod-config.toml` is a ready provider config. Point kod at the
bridge and run an agentic task with a tool:

```toml
# kod config (excerpt)
[provider.tab-bridge]
base_url = "http://127.0.0.1:8789/v1"
api_key  = "none"
model    = "deepseek-web-chat"
```

```bash
kod run "List the files in ./src and summarize main.ts" --tools fs
```

What proves Tier 3 is green:

1. kod's `/v1/models` probe succeeds;
2. `tools` arrive at the bridge and compile into the TOOL PROTOCOL block
   (visible in the tab console prompt);
3. the assistant turn ends `tool_calls`, kod executes locally, sends
   `role:"tool"` results;
4. the bridge classifies INJECT_RESULTS (no reset) — visible as
   `turn.plan … plan=INJECT_RESULTS` in the bridge audit log;
5. the loop closes with a final text answer and `turn.commit` per round.

Because kod resends full history every round, a multi-round task also proves
the hash-chain reconciliation against a live page end-to-end.

---

## Troubleshooting matrix

| Symptom | Likely cause | Fix / check |
|---------|--------------|-------------|
| SW console: connection refused | bridge not running / wrong port | start bridge; `curl /healthz` |
| 503 `pool_exhausted` on every turn | no worker connected, or all tabs cooling | `healthz` → `worker.connected`; check tab cooldown |
| 409 `session_busy` | same session fired twice concurrently | client bug: serialize turns per session |
| 429 `retry-after: 1200` | DeepSeek "Messages too frequent" | wait the window; add another account/tab |
| 502 `send-button-disabled` | paste-to-file still processing > 90 s, or selector drift | check tab console; bump `SUBMIT_READY_TIMEOUT_MS`; update `SELECTOR_BUNDLE` |
| 502 `tab not usable: cf_challenge` | Cloudflare/login wall on the page | solve the challenge in the tab |
| Turn 200 but wrong/stale answer on follow-ups | client history diverged from the tab | bridge reseeds (`divergence-at-N`); verify client resends full history |
| Empty 200 stream | impossible by design (lazy SSE headers) | if seen, file a bug with bridge log |
| Extension connects then disconnects every ~30 s | another worker replaced it, or ping loop starved | one worker per bridge; keep SW alive (alarm keepalive) |
