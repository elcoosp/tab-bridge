# Tab Bridge Worker — Chrome extension (DeepSeek v1)

MV3 extension implementing the L0 worker side of the worker-link protocol.

## Install

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` directory.
3. Start the bridge (default `ws://127.0.0.1:8789/worker`). The service worker
   connects automatically and logs `HELLO_OK` on success.

To point it at a different bridge URL, set `wsUrl` in
`chrome.storage.sync` (e.g. from the extension service-worker console):

```js
chrome.storage.sync.set({ wsUrl: "ws://127.0.0.1:9000/worker" });
```

If the bridge was started with `--api-key-env`, append the token as a query
parameter in the URL: `ws://127.0.0.1:8789/worker?token=…`.

## Components

- `background.js` — service worker: WebSocket link, tab pool
  (managed-only allocation, warm tabs), intent routing, keepalive alarm.
  Holds ONLY pool/binding/health state (ADR-2). Rate-limited tabs enter a
  ~20-minute cooldown (`rate_limited` health, not allocated to any session
  until it lapses).
- `injector.js` — content script on `chat.deepseek.com`: composer readiness,
  text placement, **send-button enabled gating**, submit verification,
  streaming fragment scraping, verifiable New-chat reset, provider
  rate-limit detection, DS session-id observer, CF/login/notice health
  sentinel. All DeepSeek-specific selectors live in one versioned bundle
  (`ds-2`).

## Submit pipeline (why turns do not fire blindly)

1. `waitComposer` — the composer exists and is enabled (15 s budget).
2. `placeText` — prompts ≥ 8 000 chars go through a synthetic paste event
   (`ClipboardEvent` + `DataTransfer`), letting DeepSeek run its native
   pipeline: big pastes convert to a `Pasted Content_<ts>.txt` attachment and
   the composer empties. Shorter prompts use the React-compatible value
   setter. If a paste is ignored, the setter path is the fallback.
3. `waitReadyToSubmit` — polls until the send control is truly enabled
   (`disabled`, `aria-disabled="true"`, `pointer-events:none` all count as
   disabled). This is the mandatory wait while an attachment processes.
   Budget: 90 s (configurable per-turn via `opts.submitWaitMs`).
4. Submit — click the enabled button; verify the tab reacted (stop button
   appears / a new bubble renders / the composer cleared) within 6 s; one
   retry via Enter, then one re-find-and-click. Failure →
   `ERROR{code:"send-button-disabled"|"submit-failed"}`.
5. `observeReply` — scrapes only nodes that appeared **after** submission
   (the prompt bubble is never scraped, so tool-result echoes cannot pollute
   fragments or trip the rate-limit scan), emits prefix-diff FRAGMENTs, and
   finishes when text is stable AND the stop control is gone AND the send
   button is enabled again.
6. Rate limit — a short "Messages too frequent / 请求过于频繁" bubble or toast
   in a new node ends the turn immediately with
   `ERROR{code:"rate_limited", retryAfterSec:1200}`; the bridge turns this
   into HTTP 429 + `Retry-After: 1200` and cools the tab down ~20 min.

## Protocol (v1)

Intents (bridge → worker): `BIND`, `SEND{reqId,text,opts,tabId?}`, `RESET{reqId,tabId?}`,
`ABORT`, `PING`, `RELEASE`.
Observations (worker → bridge): `BOUND`/`BIND_FAILED`, `ACCEPTED` (sent as
soon as the worker takes the turn),
`FRAGMENT{reqId,seq,text,full?}`, `STATUS`, `USAGE`, `HEALTH`, `ERROR`
(`code`: `submit-failed` | `port-lost` | `timeout` | `dom-error` |
`rate_limited` | `send-button-disabled`; `rate_limited` carries
`retryAfterSec: 1200`),
`RESET_OK`/`RESET_TIMEOUT`, `PONG`, `RELEASED`.
