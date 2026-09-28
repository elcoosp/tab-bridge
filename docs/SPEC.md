Here is the full specification, pasted directly into the chat:

---

# Tab Bridge — Architecture Specification
**OpenAI-Compatible Facade over a Stateful Browser Tab**

---

## 1. Executive Summary and Design Thesis

This specification settles the central design question of the Tab Bridge project: whether to keep an OpenAI-shaped API as the product surface, given that the thing behind it — a live browser tab holding a stateful chat session — is anything but stateless. The answer is **yes, conditionally**: the OpenAI shape is the correct surface, but only once it is demoted from being *the architecture* to being *a facade over one*.

The OpenAI chat-completions protocol is stateless by construction: every request carries the entire conversation, the server keeps nothing between calls, and any server that honors the shape is interchangeable. A driven browser tab is the opposite in every respect. It holds one conversation tree keyed by a server-side session identifier, it can only be spoken to through DOM automation, it cannot be told structured facts such as tool schemas or function results, and its whole value — prompt caching, context continuity, reasoning carried across turns — depends on state surviving between requests. Forcing one shape onto the other without an explicit translation layer produces the exact class of silent-corruption bugs your Addendum 2 catalogued: duplicated context after regeneration, wrong context after truncation, phantom history after a bridge restart.

The design position of this specification is therefore that the product is not "an OpenAI-compatible API with some session logic bolted on." The product is a **reconciliation engine** that makes two incompatible state models agree, wrapped by three supporting concerns: a protocol facade that speaks fluent OpenAI on the outside, a tool-call emulation layer that turns a text-only chat surface into a function-calling endpoint, and a provider adapter seam that keeps the DeepSeek-specific automation replaceable when Qwen-class backends arrive in v2. Each of these is a named layer with a formal contract in this document, and each can be tested and versioned independently.

| Option | What it means | Verdict |
|---|---|---|
| **OpenAI-only facade** | One wire protocol (`/v1/chat/completions`, `/v1/models`) plus session lifecycle endpoints; statefulness hidden entirely behind the facade | **ACCEPTED** — maximal harness compatibility; statefulness is an internal concern, exposed only through `/v1/sessions` as a pressure valve |
| Dual protocol (OpenAI + Anthropic Messages) | Two facades over the same core so Claude-style harnesses connect unmodified | REJECTED for v1 — doubles the wire-test matrix before the core is proven; the layered design keeps it a cheap v3 option |
| Native stateful-first API | Embrace statefulness: `/v1/conversations` with server-side history, deltas as the primary call | REJECTED — no harness speaks it natively; every client would need a custom driver, defeating the reason the OpenAI shape was wanted |

Grounding matters more than taste here, so the harness-facing requirements in Chapter 2 were verified against the source code of **kod** (github.com/elcoosp/kod), the Rust coding-agent harness this bridge must serve on day one. Reading kod at the crate level changed the design in one substantial way: a coding harness spends most of its life inside multi-round tool loops, so the common case between two consecutive requests is not "one new user message" — it is "one assistant tool-call turn plus one tool result." The reconciliation classifier in Chapter 5 therefore adds an **INJECT_RESULTS** fast path that your Addendum 2 classifier lacked; without it, a kod session would hit the reset-and-reseed sledgehammer on nearly every round, paying full reseed latency and forfeiting the tab's context advantage exactly where it matters most.

The document is organized for implementation. Chapters 2–3 establish the contract and the shape of the system. Chapter 4 records the eight decisions that carry the design. Chapters 5–8 specify the reconciliation engine, the tool-call emulation layer, the provider adapter contract, and the wire surface, at interface-and-sketch depth. Chapters 9–10 close with operations and a testable rollout plan. Code appears as TypeScript-flavored sketches and protocol examples rather than drop-in patches; the intent is that every signature here can be transcribed directly into the existing `bridge.js`, `background.js`, and `injector.js` files without re-architecting them.

---

## 2. The Harness Contract: System Context

Before any interface is designed, the system must be pinned to the observable behavior of the clients it will serve. This chapter records what a coding-agent harness actually puts on the wire, verified by reading kod's provider, engine, and configuration sources rather than inferred from documentation. Cline and Aider, the other reference clients for v1, speak the same protocol family with the same structural properties: strict OpenAI schemas, native tool calling, and full-history requests.

### 2.1 What kod verifiably sends and requires

kod is configured through a `[[llm.endpoints]]` block carrying `provider = "openai-compatible"`, a `base_url` that is normalized so both a server root and an `.../v1` root work, a model name that must exist on the server, an `api_key_env` variable name, a `context_window` used for memory budgeting, and a per-request timeout that defaults to 300 seconds. At startup and at model-listing time the harness issues `GET {base_url}/models` with a Bearer token and expects a body shaped `{ data: [ { id } ] }`; a server that cannot answer this endpoint fails before the first prompt is sent. These two facts alone dictate hard requirements: the bridge must implement `GET /v1/models`, and it must accept — though not validate — any Bearer credential.

The conversation path is more consequential. kod's OpenAI-compatible provider sends **native OpenAI tool calling**: a `tools` array of function declarations with JSON-schema parameters, assistant messages carrying a `tool_calls` array, and tool results as `role:"tool"` messages linked by `tool_call_id`. The agent engine resends the **full message history on every round** of its tool loop, streaming responses are assembled from SSE deltas including index-keyed tool-call fragments, and the provider reports capabilities such as `streaming_tools` so the engine knows what the endpoint supports. Notably, kod's own production-readiness review (finding H-P1) records a period when its adk-model dependency flattened tool calls into a text convention — assistant calls rendered as `[tool_call id=... name=...] {args}` and results as user-role text. The convention was fixed, but its existence is instructive for the bridge: wire conventions drift, so the reconciliation layer must treat both the native message shapes and the legacy text convention as equivalent canonical input.

Finally, kod's reliability machinery constrains the bridge's error behavior. Retries classify rate limits, connection resets, and 5xx responses as retryable with exponential backoff, and treat 400/401/404-class failures as permanent. Streaming has an empty-completion safety net: a stream that ends without having committed any content is retried, up to three attempts. A bridge that responds 200 and then streams nothing — the natural instinct when a tab is mid-CF-challenge — would therefore be retried silently instead of surfacing the problem. The error taxonomy in Chapter 8 is designed around this classifier, not around generic HTTP folklore.

### 2.2 Requirements and quality attributes

| ID | Requirement | Source of truth |
|---|---|---|
| R1 | `GET /v1/models` returns `{data:[{id}]}` with at least `deepseek-web-chat` and `deepseek-web-think` | kod `list_models()` |
| R2 | `POST /v1/chat/completions` accepts full-history messages, a `tools` array, `stream` true/false, and any Bearer credential | kod provider + engine |
| R3 | Assistant `tool_calls` and `role:"tool"` results round-trip; the legacy `[tool_call ...]` text convention is tolerated as input | kod H-P1 history |
| R4 | Streaming emits role, content and tool-call deltas (index-keyed), usage, `finish_reason`, and a `[DONE]` terminator | kod StreamChunk types |
| R5 | Empty 200-streams never happen; failure modes map to 429/5xx with `Retry-After`, 409, or 400 | kod retry + empty-retry logic |
| R6 | Concurrent sessions are independent (kod swarm); same-session overlap is rejected, not queued silently | kod swarm runner |
| R7 | A turn completes well inside a 300 s request timeout, including one bridge-driven repair round | kod `timeout_secs` default |
| R8 | Requests tolerate full history resend every round with byte-identical prefixes and detect everything else | kod engine loop |

Quality attributes follow from the harness contract. Correctness of context outranks latency: a bridge that is fast but subtly wrong destroys trust in the harness's edits, while a bridge that is occasionally slow merely tests patience. Auditability comes second — because the bridge rewrites the wire, it must log the plan it chose for every turn (SEED, INJECT_TEXT, INJECT_RESULTS, RESET_RESEED) with the hashes that justified it, so any harness-side anomaly can be replayed offline. Extensibility is the third attribute and is enforced structurally by the adapter contract in Chapter 7 rather than by discipline.

Three non-goals bound the scope. The bridge does not implement server-side conversation storage as a product feature — the client's messages array is the only ledger of truth, and the bridge's hash chain exists purely to decide what to do with it. It does not support OpenAI endpoints beyond chat completions and models; embeddings, images, and batches are out of scope until a harness needs them. And it does not attempt to execute tools itself: the harness owns execution, permission gating, and sandboxing (kod ships its own bwrap/sandbox-exec layer), which keeps the bridge a protocol component rather than an agent runtime.

---

## 3. Architecture Overview

The system is organized as five layers, each owning one transformation between the stateless wire and the stateful tab. The layering is strict: a layer may only call the layer beneath it, and every layer below the facade is protocol-blind. This is what makes the v2 Qwen expansion a contained change — and what keeps the reconciliation logic testable without a browser attached.

> **Figure 1 — Five-layer architecture.** The facade is the only protocol-aware layer; the browser runtime is the only DOM-aware layer. *(L4 Protocol Facade → L3 Session & Reconciliation → L2 Tool-Call Emulation → L1 Provider Adapter → L0 Browser Runtime)*

| Layer | Responsibility | Owns | Never does |
|---|---|---|---|
| **L4 Protocol Facade** | Speak exact OpenAI wire: parse requests, encode SSE and JSON responses, map errors to harness-meaningful statuses | HTTP server, SSE encoder, error taxonomy, `/v1/sessions` | Decide tab actions; touch DOM |
| **L3 Session & Reconciliation** | Decide, per request, what the tab must be told | Session registry, hash-chain state, turn classifier, TTL, 409 guard | Format prompts; parse model output |
| **L2 Tool-Call Emulation** | Bridge text-only chat to OpenAI function calling | Tool schema compiler, output parser, call-id synthesis, stream holdback, repair round | Know about tabs or sessions |
| **L1 Provider Adapter** | Drive one chat product through its automation contract | `ChatProviderAdapter`, capability vector, readiness/health model | Manage sessions; interpret OpenAI |
| **L0 Browser Runtime** | Own Chrome: the managed tab pool and the port lifecycle | Tab allocation, injector lifecycle, keepalive, CF sentinel plumbing | Understand conversations |

### 3.1 State ownership: the bridge drives, the SW obeys

Your Addendum 2 landed on the rule and this specification ratifies it as architectural law: **the bridge owns all conversation state, and the service worker is a stateless executor.** The worker keeps only what the tab pool physically needs — which tabId is bound to which session, whether a reset is in flight, and the health of each port. It no longer tracks turn counts, first-turn flags, or any notion of what the tab has been told, because the bridge is the only component that can compare the incoming history against the tab's actual exposure. All session bookkeeping lives in Node, where it is unit-testable, serializable to disk in one line, and recoverable after a restart by replaying the persisted journal.

This split also defines the message vocabulary. The bridge speaks adapter-agnostic intent (SEND this text, RESET the conversation, ABORT the current turn) and the worker replies with adapter-agnostic observations (FRAGMENT events, STATUS transitions, USAGE, ERROR). Chapter 7 fixes the full message table. The practical consequence is that swapping DeepSeek for Qwen changes only the worker's DOM driver and the adapter implementation; not one message type or state-machine edge in the bridge moves.

### 3.2 One kod tool round, end to end

> **Figure 2 — One kod tool round through the layers.** Steps 1–4 and 7–10 execute in the bridge process; steps 5–6b in the browser.

kod POSTs the full history plus the tools array (1). The facade parses and validates, then hands the message list to the reconciliation engine, which hashes it into the chain and classifies: this round's delta is an assistant tool-call turn (already produced by the tab itself) plus a `role:"tool"` result, so the plan is INJECT_RESULTS (2). The emulation layer renders the tool result as flat text in the tab's own transcript format and skips re-injecting the assistant echo (3). The worker queues the SEND onto the pinned tab (4–5), the injector types, submits, and watches the reply stream (6), and fragments flow back over the port (6b). The emulation layer buffers text with holdback, extracts any fenced tool-call blocks, synthesizes call ids, and validates arguments against the declared tools (7). The facade emits SSE — tool_call deltas, a usage chunk, `finish_reason:"tool_calls"` — and the engine appends the round's hashes and persists the session row (8–9). kod executes the command locally and re-requests with the result appended (10). The loop repeats until the model answers in plain text or the round cap fires.

> **Why the assistant echo is skipped** — When the delta begins with an assistant message whose hash equals the tab's own last output, re-sending it would duplicate the turn in the tab's conversation tree. The classifier compares against the recorded `tabOutputHash` instead of the generic history, so the bridge injects only what the tab has not itself said. Fabricated assistant messages — hashes that match nothing the tab emitted — are treated as divergence and force a reseed, because a web chat cannot be told "here is something you previously said" except by flattened prompt text.

---

## 4. Architecture Decision Records

Eight decisions carry the design. Each is recorded with its context, the decision itself, the alternatives that were considered and rejected, and the consequences the implementation must live with. The records are numbered so that code review, commit messages, and future addenda can reference them unambiguously.

### ADR-1: OpenAI-only protocol facade
**Context:** the bridge must serve harnesses written against OpenAI's schema, and every hour spent supporting a second wire shape delays the reconciliation work that actually makes the product correct. **Decision:** v1 exposes exactly one protocol surface — `POST /v1/chat/completions`, `GET /v1/models`, and the `/v1/sessions` lifecycle family — and nothing else. **Alternatives rejected:** a dual Anthropic Messages facade (doubles the contract-test matrix; trivially addable later as a second facade over the same L3/L2 core) and a native stateful conversations API (no client speaks it; it optimizes for the server's convenience at the expense of every caller). **Consequences:** clients that need Anthropic-style system prompts or `cache_control` blocks must adapt upstream of the bridge, and the session endpoints carry the statefulness that a native API would have made first-class.

### ADR-2: The bridge owns conversation truth
**Context:** two processes cooperate — the Node bridge and the Chrome extension — and session state must live in exactly one of them. **Decision:** all conversation-level state (hash chains, plans, TTL, persistence) lives in the bridge; the service worker is a stateless tab-pool executor holding only binding and health data. **Alternatives rejected:** keeping turn counts in the worker (your Addendum 1 design) was superseded by Addendum 2's own conclusion — the worker cannot compare histories, so any state it holds is either redundant or wrong after a restart. **Consequences:** every worker mutation is derivable from bridge messages, SW restarts cost one re-bind instead of state loss, and the bridge can be developed and tested against a scripted worker stub with no browser installed.

### ADR-3: Hash-chain session state, not stored transcripts
**Context:** reconciliation requires knowing what the tab has been told, and the naive implementation stores the full last-messages array per session — tens of kilobytes per session and unbounded growth. **Decision:** the bridge stores only a per-session chain of content hashes (one 16-byte digest per message, chained so that position and content are both covered) plus the hash of the tab's own last emitted assistant output. The client always resends the full history, so a reseed never needs stored text. **Alternatives rejected:** persisting `lastMessages` verbatim (disk bloat, privacy, and a second source of truth that can diverge from the client's view) and comparing only message counts (blind to edits — the exact bug class Addendum 2 opened with). **Consequences:** comparison is O(n) over digests, persistence stays tiny (`bridge-sessions.json` holds hundreds of sessions in a few kilobytes), and a canonicalization change requires bumping a scheme version so old chains are discarded rather than miscompared.

### ADR-4: Tool-result delta injection as a first-class fast path
**Context:** Addendum 2's classifier fast-paths exactly one shape — a delta of a single user message — and resets on everything else. Verified harness behavior (Chapter 2) shows that between two consecutive harness requests the delta is overwhelmingly assistant(tool_calls) followed by `role:"tool"` results; the single-user-message delta happens once per user turn, while the tool-result delta happens once per round, typically several times per turn. **Decision:** the classifier recognizes the tool-round delta and injects the rendered tool results without a reset, skipping the assistant echo via `tabOutputHash`. **Alternatives rejected:** always-reset (correct but pays 2–8 s reseed and full prompt re-tokenization on every round, and forfeits the tab's server-side context entirely) and native delta requests (no harness sends them). **Consequences:** the classifier must render tool results deterministically (same input, same text, always), and the INJECT_RESULTS path inherits a correctness obligation: the flattened transcript format for tool results is part of the contract and gets a golden test.

### ADR-5: Fenced-JSON tool protocol with one bounded repair round
**Context:** DeepSeek's web composer accepts only prose, so function calling must be negotiated inside the prompt and parsed out of the reply. **Decision:** Chapter 6 specifies a strict output contract — tool calls appear as fenced ` ```tool_call ` JSON blocks — with a lenient parser, deterministic call-id synthesis, and at most one bridge-driven repair round when the contract is violated. **Alternatives rejected:** emitting malformed output as plain text (kod would treat it as a final answer and end the turn silently — the worst failure mode) and unbounded repair loops (latency and cost spiral under a confused model). **Consequences:** harness-visible behavior degrades gracefully — worst case a turn returns text with an `x_bridge_warning` extension field instead of hanging or looping.

### ADR-6: Both state modes, flag-selected, stateful default
**Context:** Addendum 2 proposed divergence detection with an always-reset fallback for production surprises. **Decision:** ship both as `--stateful=true|false` with stateful as the default and always-reset as the documented correctness fallback; the flag is read at bridge start, logged, and surfaced on `/healthz`. **Alternatives rejected:** stateful-only (no escape hatch when a tab-side anomaly appears) and always-reset-only (defers the product's main optimization past v1). **Consequences:** every integration test in Chapter 10 runs in both modes, and the mode is stamped into each turn's audit log line so a misbehaving deployment is diagnosable from logs alone.

### ADR-7: Errors are classified for the harness, not for humans
**Context:** kod retries 429/5xx/transport failures with backoff and honors `Retry-After`; it treats 4xx as permanent and re-drives empty 200-streams. **Decision:** the facade's error taxonomy (Chapter 8) maps every internal condition to the status a harness-class client can act on — CF challenges and tab-pool exhaustion are 429/503 with `Retry-After`, same-session overlap is 409, parameter misuse is 400 — and an empty successful stream is structurally impossible. **Alternatives rejected:** honest-but-useless 500s for everything (converts recoverable conditions into harness-fatal ones) and silent queuing of same-session overlap (hides caller bugs that kod's swarm would otherwise surface). **Consequences:** the facade owns a single error-mapping function with a golden test per condition, and bridge internal errors never leak HTML error pages (kod truncates bodies at 400 bytes and shows them to users).

### ADR-8: Adapter seam now, DeepSeek-only implementation
**Context:** v2 brings Qwen-class backends, and retrofitting a seam after the DOM automation has leaked through the codebase is the expensive kind of refactor. **Decision:** the `ChatProviderAdapter` contract (Chapter 7) is implemented and consumed from day one, even though v1 ships exactly one adapter. **Alternatives rejected:** hardcoding DeepSeek in the bridge with a promised "v2 cleanup" (the leak always starts earlier than promised) and building a second adapter speculatively (no real client to test against; the contract would be validated against imagination). **Consequences:** a small amount of indirection in v1, and the guarantee that the Qwen spike is a new file plus a capability vector rather than an architectural project.

---

## 5. Session and Reconciliation Engine

This chapter specifies L3 formally: the registry, the canonical message model, the hash chain, the classifier, and the lifecycle machinery. Everything here is pure logic over `(prevChain, prevTabOutput, incomingMessages)` and is therefore unit-testable without a browser — the property that makes the engine trustworthy before it is ever attached to a live tab.

### 5.1 Canonical messages and the hash chain

Every OpenAI message is first canonicalized: reduced to a role tag plus a deterministic text rendering of its content. String content is taken verbatim; array content joins its text parts with a single newline. Assistant tool_calls render in a fixed wire-independent format, and `role:"tool"` messages render with their `tool_call_id` so that parallel calls stay linkable. The legacy kod text convention is recognized and rewritten into the same rendering, so a harness regression that reintroduces H-P1 flattening would not silently defeat the classifier.

```text
canonical(msg) ->
  system     : "S|" + text
  user       : "U|" + text
  assistant  : "A|" + text
             | "A|" + text + "=> " + calls.map(c => "call " + c.name
                    + "(" + canonJson(c.arguments) + ")#" + (c.id ?? "-")
                  ).join(" ; ")
  tool       : "T#" + (tool_call_id ?? "-") + "|" + text

chain[i]  = blake2b16( chain[i-1] || "|" || canonical(msg[i]) )
tabHash   = chain[k] where msg[k] is the last assistant message
            the tab itself produced (recorded at stream end)
sessionRow: { sessionId, tabId, chain[], tabHash, turns, state,
              createdAt, lastUsed, mode }   // ~64 bytes/turn
```

Chaining rather than hashing messages independently is what makes prefix comparison trustworthy: two requests agree on a prefix only if both content and position match, and a reordered history produces a different chain rather than a false match. The digest is deliberately compact — sixteen bytes per message — so a hundred-turn session costs about 1.6 KB of state, which is what allows the persistence file to survive casual backups and rapid restarts without rotation policy. Reconstructing a chain is equally cheap: verification of an incoming history against the stored chain is a single left-to-right fold with early exit on the first mismatch, so classification cost stays negligible even for repo-map-heavy kod prompts. The scheme version is stored in the session row; on mismatch the engine drops the chain and classifies as SEED, which is always safe, and version bumps are expected only when canonicalization itself changes — the one event that would make old digests meaningless.

### 5.2 The classifier

> **Figure 3 — Turn classifier.** SEED and the two INJECT plans reuse tab context; RESET_RESEED is the safe default whenever the tab's state cannot be proven equivalent to the client's.

The classifier runs on every request before anything is sent to the tab, and it is total: every input terminates in one of four plans. Ordering matters in the flow — the cheap binary tests run before the expensive delta shapes — and every branch is deterministic, so the same request replayed against the same chain always yields the same plan.

| Plan | Fires when | Worker actions | Chain update |
|---|---|---|---|
| **SEED** | no session row, or chain scheme mismatch, or stateless mode | RESET if tab dirty, await composer ready, SEND flattened history + tool protocol block | `chain := hash(C); tabHash := last assistant in C` |
| **INJECT_TEXT** | C extends P and delta is exactly one user message | SEND that message text | append delta hashes; tabHash unchanged |
| **INJECT_RESULTS** | C extends P, delta = assistant(tool_calls) matching tabHash + one or more tool results (+ optional trailing fabricated assistant, which forces reseed instead) | SEND rendered tool-result text only (assistant echo skipped) | append all delta hashes; `tabHash := -` (tab has not spoken since) |
| **RESET_RESEED** | C equals P (regeneration); C diverges (edit, truncate, reorder); delta contains fabricated or multi-message content other than the tool-round shape | RESET, await RESET_OK, SEND flattened full C | `chain := hash(C); tabHash reset` |

Two edges deserve emphasis. First, INJECT_RESULTS accepts only the shape whose assistant prefix the tab can be proven to hold; any fabricated assistant turn inside the delta falls to RESET_RESEED, because the only way to make a web chat believe it said something is to reseed the whole transcript as flattened text. Second, consecutive tool rounds with no intervening model output (a harness that batches results) extend the INJECT_RESULTS path naturally: the delta is checked against the chain, not against "last plan," so batching is just a longer tool-result list.

### 5.3 Lifecycle, persistence, and concurrency

A session is created on first sight of its `X-Session-ID` (or `user` field, or `metadata.session_id`, with the precedence header > body > metadata) and is pinned to a tab by the worker under the one-tab-one-session invariants. From that moment the bridge row carries the state: `active`, `resetting` (a RESET is in flight and SENDs queue behind RESET_OK), or `draining` (DELETE received, tab released). Idle TTL defaults to 30 minutes and is swept every 60 seconds; `DELETE /v1/sessions/:id` releases immediately and accepts `?force=true` to evict the oldest idle session when the pool is exhausted — the mitigation your Addendum 1 left as an open decision, resolved here as an explicit opt-in rather than silent behavior.

Persistence is deliberately boring: the bridge appends each committed turn to `bridge-sessions.json` (chain digests, not transcripts) and reloads it on boot. After a bridge restart, a session whose chain survived is resumed exactly where it was; a session whose tab died while the bridge was down is un-pinned and re-seeds on next use. Concurrency is enforced per session with a mutex: kod sequences its own rounds, so a second overlapping request on the same session indicates a caller bug and is answered 409 immediately rather than queued, while distinct sessions — kod swarm runs several in parallel — never contend for anything except tab allocation.

---

## 6. Tool-Call Emulation Layer

L2 is the bridge's two-faced translator: toward the tab it is a transcript formatter that makes tools legible to a chat model; toward the harness it is a parser that turns prose back into structured tool_calls. Its contract with L3 is one function pair — `compileRequest(messages, tools, plan)` to flat prompt text, and `parseResponse(fullText, tools)` to `{ content, calls, warning? }` — both pure and golden-tested.

### 6.1 The prompt compiler

On SEED and RESEED the compiler emits the full flattened transcript: a tool protocol block derived from the request's `tools` array, then each message in order, then a final ASSISTANT cue. The protocol block is versioned (`tool-protocol: 1`) so parser improvements can be coordinated with prompt changes. Each tool is rendered with its name, one-line description, and its JSON-schema parameters condensed to required-fields-with-types; schemas are truncated at a configurable budget (default 1200 characters per tool) because web-chat prompt realism beats schema completeness. On INJECT_RESULTS the compiler renders only the delta's tool results, in the same transcript format the tab already saw at seed time — the model experiences one continuous transcript even though the bridge experiences discrete plans.

```text
=== TOOL PROTOCOL (tool-protocol: 1) ===
You can call tools. To call one, output a fenced block:
```tool_call
{"name": "execute_command", "arguments": {"cmd": "ls -la"}}
```
Rules: one JSON object per block; emit one block per call, back to
back for parallel calls; no prose inside a block; after emitting
blocks, STOP and wait for results. Unknown tools are errors.
=== TOOLS ===
[execute_command] Run a shell command. args: cmd (string, required),
  timeout_secs (number). ...
=== TRANSCRIPT ===
### SYSTEM ... ### USER ... ### ASSISTANT ... ### TOOL#call_a1 ...
```

### 6.2 The response parser and id synthesis

`parseResponse` scans the completed text for ` ```tool_call ` fences, extracts the JSON, and validates it against the request's tools array: the name must be declared, and arguments must satisfy the schema's required fields and primitive types (a deliberately lenient check — web models will omit optionals, and rejecting them would strand the harness). Call ids are synthesized deterministically as `call_ + blake2b(name + canonJson(args))[:10]`, which makes retries and duplicate parses produce the same id and lets the harness's `tool_call_id` linkage stay stable across bridge restarts. A model that emits the legacy kod text convention (`[tool_call id=... name=...]`) instead of a fence is parsed by the same validator, so both output dialects converge on one structure. Text outside fences is returned as content; when no valid block is found the entire text is content and `finish_reason` is `stop`.

### 6.3 Streaming holdback

Live streaming and fence parsing conflict: the moment a response contains the opening of a fence, everything from the backtick onward is ambiguous — it might be a tool call (which must become `delta.tool_calls`, not `delta.content`) or a literal code sample in an answer. The holdback buffer resolves this. Text streams to the client immediately until a fence opener appears; from that point, fragments accumulate. If the fence closes and parses as a valid call, the held text never reaches content and the call is emitted as tool-call deltas; if it closes but fails validation, the held text is flushed as content and the repair round (below) decides what happens next; if the buffer exceeds a safety ceiling (default 4000 characters) without closing, it is flushed as content on the assumption that the model is writing backticks inside a long answer.

| Finish reason | Emitted when |
|---|---|
| `tool_calls` | at least one fenced block parsed and validated |
| `stop` | plain text answer; no valid tool-call block |
| `length` | tab reports a truncated generation (adapter StopReason) |
| none (error-adjacent) | failures never finish a stream; they become HTTP errors per ADR-7 |

### 6.4 The repair round

When the model violates the protocol — malformed JSON, an undeclared tool, arguments failing required fields — the bridge has one bounded recourse before giving up: a repair round. The bridge sends a single corrective turn to the same tab (no reset): the model's own offending output quoted, the specific validation error, and a re-statement of the contract. If the repair round also fails, the original text is returned as content with `finish_reason: stop` and a warning in the `x_bridge_warning` extension field, and the harness sees an ordinary text completion instead of a hang. The repair budget defaults to one round, is gated by `--repair-rounds`, and every repair is an audit-logged event because a rising repair rate is the earliest signal of prompt-format drift on the provider side.

---

## 7. Provider Adapter Contract

L1 is the seam that makes the DeepSeek automation replaceable. The contract below is the entire surface the bridge is allowed to know about a chat product: anything outside these methods is, by definition, adapter-internal. The contract is deliberately small — nine members — because every member must be genuinely portable across DeepSeek, Qwen, and plausible v3 backends.

### 7.1 The ChatProviderAdapter interface

```typescript
interface ChatProviderAdapter {
  readonly id: string;                    // "deepseek-web", "qwen-web"

  capabilities(): AdapterCapabilities;

  // ---- lifecycle (per managed tab) --------------------------------
  attach(port: RuntimePort): void;        // bind injector events
  async ensureReady(tab: ManagedTab,
                    timeoutMs: number): Promise<Ready>;
  async sendTurn(tab: ManagedTab, text: string,
                 opts: TurnOptions): Promise<void>;   // submit only
  streamResponse(tab: ManagedTab,
                 sink: StreamSink): Promise<TurnResult>;
  async resetConversation(tab: ManagedTab): Promise<ResetOutcome>;
  async health(tab: ManagedTab): Promise<Health>;
  async dispose(tab: ManagedTab): Promise<void>;
}

interface AdapterCapabilities {
  streaming: boolean;          // fragment-level streaming support
  thinkingToggle: boolean;     // separate think/no-think model ids
  resetSupport: boolean;       // programmatic "new chat" available
  maxPromptChars: number;      // composer hard limit
  warmupMsTypical: number;     // fresh-tab SPA + auth cost
  domFingerprint: string;      // selector bundle version
}

type Health = { state: "ok" | "cf_challenge" | "auth_invalid"
                   | "rate_limited" | "degraded",
                 detail?: string };
```

The split between `sendTurn` and `streamResponse` is intentional. Submission and observation have different failure domains — a submit can fail loudly at the composer, while a stream fails silently mid-generation — and the worker's queue drain needs to know the instant a submission is committed so it can start timeout accounting. `TurnOptions` carries the only per-request knobs the adapter is allowed to see (thinking mode, turn timeout); it never sees message history, session ids, or tool schemas, which is what keeps L2's output format out of the DOM layer.

### 7.2 Managed tab lifecycle and health

Every tab in the pool walks one state machine: `created` (chrome.tabs.create with the adapter's start URL), `connecting` (injector loaded, port established), `ready` (ensureReady succeeded), `busy` (a turn is in flight), `cooldown` (adapter-reported backoff, not allocatable), and `dead` (port closed or tab gone). Only tabs the worker itself created are allocatable by default — the `managedOnly` policy from your Addendum 1 — and a user-claimed tab (one with an observed DeepSeek session id the worker did not mint) is skipped by the allocator even in permissive mode. Health is sampled by the adapter's sentinel rather than assumed: a CF challenge is detected from the page's challenge markers, auth loss from a login-wall heuristic, and rate limiting from the site's own error shapes. Health feeds the facade's error mapping (Chapter 8), so a tab in cooldown under `cf_challenge` becomes an HTTP 429 with `Retry-After`, not a mysterious hang.

### 7.3 Bridge-to-worker message protocol

The worker speaks in intents and observations, both adapter-agnostic. These tables are the complete vocabulary; nothing else crosses the port, which is what makes a second adapter a DOM-only change.

**Intents — bridge to SW:**

| Message | Fields | Semantics |
|---|---|---|
| `BIND` | sessionId | pin session to a free (or newly created) managed tab |
| `SEND` | reqId, text, opts | queue one turn on the pinned tab's serial queue |
| `RESET` | reqId | new conversation in-tab; reply RESET_OK / RESET_TIMEOUT |
| `ABORT` | reqId | cancel an in-flight turn's observation (best effort) |
| `PING` | seq | keepalive + liveness probe; unanswered after 2 misses = dead |
| `RELEASE` | sessionId | unbind session; tab returns to the free pool |

**Observations — SW to bridge:**

| Message | Fields | Semantics |
|---|---|---|
| `BOUND` | sessionId, tabId | pin completed; tab state included |
| `ACCEPTED` | reqId | turn queued; timeout accounting starts |
| `FRAGMENT` | reqId, seq, text | monotonic stream fragment of the reply |
| `STATUS` | reqId, code | submitting \| streaming \| done \| aborted |
| `USAGE` | reqId, meta | provider-reported usage metadata when visible |
| `HEALTH` | tabId, state | adapter health transition (cf_challenge etc.) |
| `ERROR` | reqId, code, detail | submit-failed \| port-lost \| timeout \| dom-error |
| `RESET_OK / RESET_TIMEOUT` | reqId | reset outcome; SENDs queue behind it |

Every message carries a `reqId` (or sessionId, for binding intents) so that responses correlate unambiguously even when several turns are queued or a reset overlaps a retry, and FRAGMENT sequences are monotonic per reqId so the holdback buffer can detect gaps instead of silently reordering text. The vocabulary is versioned with a single `protocol` field on the first message of each connection; a worker that disagrees on the version is refused at BIND time rather than corrupting a session mid-conversation. Neither side ever sends conversation content in both directions of an intent — the bridge sends the text to type, the worker returns only what it observed — which keeps the port protocol free of any assumption about OpenAI shapes.

### 7.4 DeepSeekAdapter (v1) and the Qwen v2 delta

The v1 adapter maps the contract onto your existing injector assets: composer readiness polling, text injection and submit, fragment scraping of the streaming reply, the New chat button as `resetConversation`, and the `DS_SESSION_ID` observer that powers the user-claimed-tab guard. Two behaviors are elevated from implementation detail to contract obligations so they can be tested: reset must be *verifiable* (the adapter confirms the conversation actually changed, not just that the button was clicked), and fragments must be reassembled with a streaming-safe UTF-8 decoder since emoji and CJK split across TCP chunks are a known kod-class bug (its H-P2 finding).

For v2, the Qwen delta is exactly the adapter file, its selector bundle, its reset semantics, and a capability vector — no bridge code changes. The known unknowns are catalogued rather than solved: Qwen's composer may paginate long inputs differently (`maxPromptChars` changes), its conversation reset may require navigation rather than a button, and its reply DOM may interleave reasoning panels with answer text (a sink-side filter). None of these touch the message protocol, the classifier, or the emulation layer, which is the entire point of ADR-8.

---

## 8. Protocol Surface and Harness Integration

L4 is the only layer most users ever see, so its specification is written against real clients: endpoint tables, exact SSE framing, an error taxonomy keyed to harness retry behavior, and the configuration blocks that connect kod and the bridge in under ten lines.

### 8.1 Endpoints

| Endpoint | Behavior |
|---|---|
| `POST /v1/chat/completions` | Full OpenAI chat-completions semantics, stream and non-stream. Session affinity via `X-Session-ID` header, `user` field, or `metadata.session_id` (precedence: header, body, metadata; absent = stateless legacy path) |
| `GET /v1/models` | `{ data: [ { id } ] }` listing `deepseek-web-chat` and `deepseek-web-think`; the think variant maps to the adapter's thinking toggle |
| `POST /v1/sessions` | Explicit creation; returns `{session_id}`. Optional `?force=true` evicts the oldest idle session when the pool is exhausted |
| `GET /v1/sessions` | Registry listing: session_id, tab_id, state, turns, created, last_used |
| `DELETE /v1/sessions/:id` | 204; releases the tab immediately and clears the bridge row |
| `GET /healthz` | Bridge mode flags, session count, per-tab health summary (operator use) |

### 8.2 SSE framing

Streaming responses follow OpenAI's chunk shape exactly: a first delta carrying the assistant role, content deltas as they stream (minus the holdback window), tool-call deltas emitted once per parsed call in index order with `id`, `function.name`, and arguments as a single fragment, a trailing chunk with empty choices and full usage, then `finish_reason` on the final choice and the `[DONE]` sentinel. Usage is synthesized conservatively: prompt tokens as characters/4 of the flattened prompt, completion tokens from adapter metadata when visible and characters/4 otherwise — round-trip-safe numbers that keep harness context meters honest without pretending to know provider tokenization. Non-streaming requests return the ordinary JSON completion object; no SSE framing leaks into it.

### 8.3 Error taxonomy

| Condition | HTTP | Harness-visible effect |
|---|---|---|
| CF challenge / provider rate limit | **429** + Retry-After | kod backs off and retries — the desired behavior; tab cools down |
| No allocatable tab (pool exhausted) | **503** + Retry-After | retryable; pairs with `?force=true` on session creation |
| `503` | `queue_full` | All `max-concurrent-turns` slots busy and the queue is at `--queue-capacity`. Retry-After: 5. Transient — retry the same request. |
| `503` | `queue_timeout` | Queued longer than `--queue-timeout-ms`. Retry-After: 5. Transient. |
| `499` | `client_gone` | Internal only (nginx convention): the client disconnected while queued; the queued entry is cancelled and no turn is run. Never written to the wire. |
| `429` | `rate_limited` (concurrency variant) | The provider refused the send because another generation is running (`concurrency_blocked` upstream). Retry-After: 15. |
| Same-session overlap (caller bug) | **409** | permanent — surfaces swarm/logic bugs immediately |
| Malformed request, n>1, unsupported params | **400** | permanent; body names the offending field |
| Bridge auth failure (when `--api-key` set) | **401** | permanent; misconfiguration, not transient |
| Tab timeout / dom-error / port lost | **502** | retryable; the turn failed before or during observation |
| Unexpected bridge fault | **500** (JSON body) | retryable; never an HTML error page |

Parameter policy is explicit rather than silently lenient: `n` greater than 1 is rejected with 400 because the tab cannot branch; `temperature`, `top_p`, `max_tokens`, and `stop` are accepted, logged once per request, and ignored (a comma-joined `X-Bridge-Ignored` response header makes the ignoring visible); `logprobs` and `response_format.json_object` are rejected 400 in v1. The empty 200-stream is structurally impossible because every stream path terminates in either a frame or an HTTP error — the property kod's empty-completion retry exists to catch, and which this design makes unnecessary.

### 8.4 Wiring kod to the bridge

```toml
# ~/.kod/config.toml
[[llm.endpoints]]
name           = "tab-bridge"
provider       = "openai-compatible"
base_url       = "http://127.0.0.1:8789/v1"
model          = "deepseek-web-think"
api_key_env    = "TAB_BRIDGE_KEY"   # value ignored by the bridge
context_window = 65536              # sizes kod memory budget
timeout_secs   = 300
```

```bash
# bridge side
tab-bridge serve --port 8789 --api-key-env TAB_BRIDGE_KEY \
  --stateful=true --auto-create-tabs --managed-only \
  --ttl=30m --repair-rounds=1
```

The flags consolidate every open decision from the addenda: `--stateful` selects ADR-6's mode; `--auto-create-tabs` and `--managed-only` implement the two config decisions Addendum 1 asked to be explicit; `--ttl` sets the idle sweep; and `--repair-rounds` bounds ADR-5. All defaults are the values shown, and `/healthz` echoes the effective configuration so a misread flag is visible in one request.

---

## 9. Reliability and Operations

The failure matrix consolidates the sharp edges from both addenda with the operational machinery that contains them. Every row names the detection point, the automatic response, the session-state consequence, and what the harness sees — because a failure that is visible and classified is an incident, while one that is silent is a bug report three weeks later.

| Failure | Detection | Automatic response | Harness sees |
|---|---|---|---|
| CF challenge mid-session | adapter health sentinel | tab to cooldown; in-flight turn fails closed; session row survives | 429 + Retry-After; next turn reuses tab context after solve |
| Tab crash / port lost | PING misses, port close | tab dead; session unpinned; next request re-pins and SEEDs | 502 once, then normal service |
| Service worker restart | port close on all tabs | bindings dropped; tabs re-connect via injector; bridge rows intact | one 502 burst at worst; chains survive |
| Bridge restart | process supervisor | reload `bridge-sessions.json`; unpin tabs that died meanwhile | chains resume; no duplicate context (ADR-3) |
| Duplicate DeepSeek session ids | DS_SESSION_ID observer | newer duplicate dropped from pool; managed-only prevents creation | none (policy prevents the state) |
| Client cancel mid-stream | req close event | ABORT to tab; session marked dirty; next turn re-anchors | clean disconnect; next turn correct |
| Harness crash, session pinned | TTL sweep | idle session expires; `?force=true` evicts on demand | capacity returns in at most TTL |
| Model violates tool protocol | L2 validation | one repair round; then text + `x_bridge_warning` | text completion, never a hang (ADR-5) |
| Empty completion | stream guard | structurally impossible: streams end in frames or errors | n/a by construction (ADR-7) |

### 9.1 Latency budget and warm pool

| Stage | Typical | Worst | Notes |
|---|---|---|---|
| Fresh tab warmup (SPA + auth) | 3–10 s | 15 s | paid once per tab; ensureReady timeout at 15 s |
| SEED (flatten + submit) | 1–3 s | 6 s | scales with history length; tab re-tokenizes |
| INJECT_TEXT / INJECT_RESULTS | 1–2 s | 4 s | the stateful dividend: no reseed cost per round |
| Stream time-to-first-fragment | 0.5–2 s | 5 s | provider-dominated |
| Repair round | +1 turn | +1 turn | bounded at 1 by default |

The budget explains why ADR-4 exists in numbers: an eight-round kod turn under always-reset pays eight seeds (8–24 s of pure reseed overhead plus re-tokenized prompts), while the stateful path pays one seed and seven injections. A warm pool of one pre-created managed tab (flag-gated, `--warm-tabs`) removes warmup from the first-turn path in exchange for one idle browser tab, and the keepalive ping doubles as the service-worker heartbeat so Chrome does not reclaim the worker mid-session.

### 9.2 Security posture

The bridge binds 127.0.0.1 by default and accepts an optional shared-secret Bearer via `--api-key-env`, mirroring kod's own `api_key_env` convention so secrets never appear in config files or process listings. The bridge never executes tools — execution stays inside the harness where kod's permission gates and sandbox live — and the injector's DOM automation is confined to the adapter's site patterns. Session rows persist hashes and metadata only, never transcripts, so `bridge-sessions.json` is safe even if it lands in a dotfile backup by accident. The residual risk worth documenting is authorization between harness and bridge on a multi-user machine: the optional bearer closes localhost spoofing, and operators who need more should front the bridge with their own proxy rather than expand this component's scope.

---

## 10. Testing Strategy and Rollout

The test strategy follows the architecture's best property: the two hardest components — the classifier and the emulation layer — are pure functions, so the bulk of confidence is bought without a browser. Browser-dependent behavior is isolated behind the adapter contract and covered by a thin, explicitly tagged integration tier.

| Tier | Covers | Character |
|---|---|---|
| Unit (pure) | classifier plans, canonicalization, hash chains, id synthesis, error mapping | thousands of table-driven cases; runs in ms |
| Golden (pure) | seed/inject prompt snapshots, parse fixtures, holdback stream traces | byte-exact snapshots; diff reviews are the review |
| Contract (fake tab) | L4+L3+L2 against a scripted adapter; SSE framing, 409s, TTL, restart replay | harness-like client drives scenarios |
| Integration (real tab) | adapter lifecycle, reset verification, CF sentinel, UTF-8 split fragments | tagged slow; runs nightly, not per-commit |
| Fuzz | UTF-8 chunk splits, fence-in-content, schema-edge arguments | property tests on L2 and the SSE decoder |

The golden scenarios are keyed to verified kod behaviors so the suite fails exactly when compatibility would: the eight-round tool loop with parallel calls and stable call ids; regeneration, truncation, and edit forcing RESET_RESEED; the legacy `[tool_call ...]` convention parsing; 429 handling with honored Retry-After; a 502 mid-loop followed by correct reseed; four concurrent swarm sessions with independent chains; and a bridge restart resuming a chain without duplicating context. Each scenario runs twice — stateful and always-reset — because ADR-6 made the mode a supported configuration rather than a toggle.

| Milestone | Ships | Exit criteria |
|---|---|---|
| **M1 — Facade core** | L4 + worker tab pool, stateless path, `/v1/models`, non-stream chat | kod chat round-trips against a live tab; error taxonomy golden-tested |
| **M2 — Streaming + tools** | SSE with holdback, tool protocol, parser, repair round | kod agent mode completes multi-round tool loops; fuzz tier green |
| **M3 — Sessions & reconciliation** | registry, hash chains, all four plans, TTL, persistence, 409s | full golden scenario suite green in both state modes; restart replay proven |
| **M4 — Adapter seam & warm pool** | `ChatProviderAdapter` extracted, warm tab preload, `/healthz`, ops hardening | second adapter stub passes contract tests; Qwen spike scoped to one file plus selectors |

Milestone order is deliberate: the facade is proven boring before the emulation layer leans on it, the emulation layer is proven correct before sessions make its input history-sensitive, and the adapter seam is formalized last — after the real DeepSeek behavior has had time to teach the contract what it must actually contain. A team that finishes M3 has a product it can use daily; M4 is what makes the v2 Qwen promise a one-file change instead of a rewrite.

---

That's the complete document (all 10 chapters, 8 ADRs, 12 tables — same content as the PDF). If you also want the `.md` file saved to the download folder, or want any chapter expanded (e.g., the classifier pseudocode, or the Qwen adapter sketch), say the word.
