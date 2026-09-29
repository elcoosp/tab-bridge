/**
 * Tab Bridge — MAIN-world SSE capture hook (extension/sse-hook.js, v1.2.0).
 *
 * WHY THIS EXISTS
 * v1.1.0 scraped the reply from the DOM with a MutationObserver. That is
 * brittle by construction: background tabs throttle timers, chat UIs
 * virtualize/defer markdown rendering when hidden, and any class-name drift
 * silently kills the capture. The reply, however, ALWAYS arrives over the
 * network: DeepSeek streams every assistant answer through its completion
 * endpoint as an SSE body. Hooking `window.fetch` in the MAIN world captures
 * the stream at the source — independent of tab focus, rendering, or DOM
 * structure.
 *
 * HOW IT WORKS
 *  1. The injector "arms" this hook right before submitting a prompt
 *     (window.postMessage control channel, see below). While unarmed the hook
 *     is pass-through: zero tee-ing, zero parsing of the user's own chatting.
 *  2. While armed, the first POST to the completion endpoint is intercepted.
 *     The response body is tee()-ed: the page receives an untouched branch
 *     (wrapped in a fresh Response), the hook parses the other branch.
  *  3. SSE frames are parsed defensively across several known wire shapes:
  *       - DeepSeek web:  data:{"v":"delta"} deltas, data:{"v":{...}} metadata,
  *         `event: hint` frames carrying provider errors
  *         (finish_reason:"rate_limit_reached"), `event: close` terminator
  *       - DeepSeek typed fragments: full `{"v":{"response":{fragments:
  *         [{id,type:THINK|RESPONSE,content}]}}}` snapshots plus JSON-patch
  *         deltas (`response/fragments/-1/content` APPEND, `response/fragments`
  *         APPEND, BATCH). THINK-typed text is suppressed outright — thinking
  *         and answer share the {"v":"…"} shape and only fragment context
  *         tells them apart.
  *       - OpenAI-ish:    choices[0].delta.content / reasoning_content
  *       - generic:       {content}, {message:{content}}, [DONE]
 *  4. Deltas are posted to the ISOLATED world (injector) via
 *     window.postMessage; reasoning (<think>…</think> regions and
 *     reasoning_content fields) is suppressed from the visible stream.
 *  5. The injector owns the turn; this hook only reports what it saw and
 *     auto-expires an arm after the turn deadline as a safety net.
 *
 * CONTROL CHANNEL (injector -> here, via window.postMessage):
 *   { source: "tab-bridge-sse-control", type: "ping" }               -> hook announces itself
 *   { source: "tab-bridge-sse-control", type: "arm", turnId, timeoutMs }
 *   { source: "tab-bridge-sse-control", type: "disarm" }
 * OBSERVATION CHANNEL (here -> injector):
 *   { source: "tab-bridge-sse", type: "hello" | "arm-ack" |
 *       "stream-start"(status, contentType) | "delta"(text) |
 *       "hint-error"(content, finishReason) | "http-error"(status, snippet) |
 *       "complete"(text, sawAny, doneMarker, hintError) |
 *       "stream-error" | "hook-error" | "fetch-rejected"(error) }
 *
 * The file is a classic script for the MAIN world AND importable under Node
 * (no import/export statements; pure internals exposed on globalThis only
 * when `window` is undefined) so the parser is unit-testable.
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // pure internals (unit-tested via extension/test/sse-hook.test.mjs)
  // -------------------------------------------------------------------------

  function createInternals() {
    /** DeepSeek completion endpoint (api/v0/chat/completion). */
    // DeepSeek streams the initial answer and the "Continue" resume on
    // two distinct endpoints: /api/v0/chat/completion and
    // /api/v0/chat/continue. Both carry the same `data: {"v":...}` SSE
    // shape and are parsed identically. The initial capture arms on
    // completion; the Continue button's trusted click re-arms for the
    // follow-up POST, which lands on /chat/continue — hence the union.
    const COMPLETION_RE = /\/chat\/(completion|continue)/i;
    const THINK_OPEN = "<think>";
    const THINK_CLOSE = "</think>";

    function safeJsonParse(text) {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    }

    /** One SSE frame (already split on blank lines) -> {event, data}. */
    function frameData(frameText) {
      const lines = frameText.split("\n");
      let event = "";
      const data = [];
      for (const line of lines) {
        if (line.startsWith(":")) continue; // SSE comment / keep-alive
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("data")) data.push("");
      }
      return { event, data: data.join("\n") };
    }

    /**
     * Multi-shape frame extraction. Returns {delta|think, meta?, done?,
     * error?, finishReason?} or null when the frame carries nothing usable.
     */
    function extractFromFrame(obj) {
      if (obj == null) return null;
      if (typeof obj === "string") return { delta: obj };
      if (typeof obj !== "object") return null;

      // OpenAI-ish array frames
      if (Array.isArray(obj)) {
        let merged = null;
        for (const el of obj) {
          const r = extractFromFrame(el);
          if (!r) continue;
          if (!merged) merged = { delta: "", think: "" };
          if (r.delta) merged.delta += r.delta;
          if (r.think) merged.think += r.think;
          if (r.done) merged.done = true;
          if (r.error) merged.error = r.error;
        }
        return merged && (merged.delta || merged.think || merged.done || merged.error) ? merged : null;
      }

      // explicit error payloads first — never emit these as answer text
      if (obj.error) {
        const msg =
          typeof obj.error === "string"
            ? obj.error
            : typeof obj.error.message === "string"
              ? obj.error.message
              : JSON.stringify(obj.error).slice(0, 200);
        return { error: msg, finishReason: typeof obj.finish_reason === "string" ? obj.finish_reason : "" };
      }
      if (obj.type === "error") {
        return {
          error: typeof obj.content === "string" ? obj.content : JSON.stringify(obj).slice(0, 200),
          finishReason: typeof obj.finish_reason === "string" ? obj.finish_reason : "",
        };
      }

      // OpenAI chat completions chunk
      if (Array.isArray(obj.choices) && obj.choices.length > 0) {
        const c = obj.choices[0] || {};
        const d = c.delta || c.message || {};
        const res = {};
        if (typeof d.reasoning_content === "string" && d.reasoning_content) res.think = d.reasoning_content;
        else if (typeof d.content === "string" && d.content) res.delta = d.content;
        else if (typeof d.reasoning === "string" && d.reasoning) res.think = d.reasoning;
        if (c.finish_reason) {
          res.done = true;
          res.finishReason = c.finish_reason;
        }
        return res.delta || res.think || res.done ? res : null;
      }

      // DeepSeek web: {"v": ...}
      if ("v" in obj) {
        const v = obj.v;
        if (typeof v === "string") return { delta: v };
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const meta = {};
          let done = false;
          for (const k of ["request_id", "message_id", "fragment_id", "parent_id"]) {
            if (k in v) meta[k] = v[k];
          }
          if (typeof v.status === "string" && /finish|done|complete/i.test(v.status)) done = true;
          if (v.finish_reason) {
            done = true;
            meta.finish_reason = v.finish_reason;
          }
          if (v.is_finish === true || v.finish === true) done = true;
          return { meta, done };
        }
        return null;
      }

      // generic single-object shapes
      if (typeof obj.reasoning_content === "string" && obj.reasoning_content) return { think: obj.reasoning_content };
      if (typeof obj.content === "string" && obj.content) return { delta: obj.content };
      if (obj.message && typeof obj.message.content === "string" && obj.message.content) {
        return { delta: obj.message.content };
      }
      return null;
    }

    /** Longest suffix of `s` that is a proper prefix of `tag`. */
    function holdLen(s, tag) {
      const max = Math.min(tag.length - 1, s.length);
      for (let k = max; k > 0; k--) {
        if (tag.startsWith(s.slice(s.length - k))) return k;
      }
      return 0;
    }

    /**
     * Streaming <think> suppressor: drops everything between <think> and
     * </think> (tags split across deltas included), passes the rest through.
     * The filter holds back a partial-tag suffix in "out" mode so "<thi" is
     * never emitted prematurely.
     */
    function createThinkFilter() {
      let mode = "out"; // "out" | "in"
      let buf = "";
      let inner = ""; // retained thinking text (surfaced if the stream ends mid-think)
      function flush(final) {
        let out = "";
        for (; ;) {
          if (mode === "out") {
            const i = buf.indexOf(THINK_OPEN);
            if (i !== -1) {
              out += buf.slice(0, i);
              buf = buf.slice(i + THINK_OPEN.length);
              mode = "in";
              inner = "";
              continue;
            }
            if (final) {
              out += buf;
              buf = "";
              break;
            }
            const keep = holdLen(buf, THINK_OPEN);
            out += buf.slice(0, buf.length - keep);
            buf = buf.slice(buf.length - keep);
            break;
          } else {
            const i = buf.indexOf(THINK_CLOSE);
            if (i !== -1) {
              buf = buf.slice(i + THINK_CLOSE.length);
              mode = "out";
              inner = "";
              continue;
            }
            if (final) {
              // stream ended inside thinking: surface what is there rather
              // than returning nothing (transparent > clever)
              out += inner + buf;
              inner = "";
              buf = "";
              mode = "out";
              break;
            }
            const keep = holdLen(buf, THINK_CLOSE);
            inner += buf.slice(0, buf.length - keep);
            buf = buf.slice(buf.length - keep);
            break;
          }
        }
        return out;
      }
      return {
        feed(s) {
          if (!s) return "";
          buf += s;
          return flush(false);
        },
        end() {
          const out = flush(true);
          buf = "";
          return out;
        },
      };
    }

    /**
     * Incremental SSE parser: feed decoded chunks (byte boundaries anywhere),
     * get per-frame extraction results. Handles \r\n / \r / \n terminators
     * (with a carry so a split \r\n is never double-counted).
     */
    function createSseParser() {
      let buf = "";
      let carry = ""; // pending trailing "\r"
      const think = createThinkFilter();
      let emitted = "";
      let raw = "";
      let sawDoneMarker = false;
      let sawFinish = false;
      let hintError = null;
      // Frames that carried a payload but yielded no text: proves whether
      // "missing" bytes were never extracted (odd wire shape) vs never sent.
      let skipped = 0;
      let skippedSample = "";

      function noteSkipped(payload) {
        skipped += 1;
        if (skippedSample.length < 200) {
          skippedSample += String(payload).slice(0, 200 - skippedSample.length);
        }
      }

      // Typed-fragment attribution (DeepSeek web protocol). The completion
      // stream multiplexes thinking and answer in identical {"v": "..."}
      // frames; only the surrounding fragment context (full snapshots and
      // JSON-patch ops) says which is which. THINK text is suppressed outright
      // (already classified — no <think> scan needed); everything else flows
      // through the think filter as a second net. No fragment info seen yet
      // (legacy shapes): every v-string stays visible (transparent default).
      let fragId = null;
      let fragType = null; // "THINK" | "RESPONSE" | null
      const seenFragIds = new Set();
      let thinkChars = 0;

      /** Route already-classified text; returns the visible delta, if any. */
      function routeFragText(text, type) {
        if (!text) return null;
        raw += text;
        if (type === "THINK") {
          thinkChars += text.length;
          return null;
        }
        const visible = think.feed(text);
        if (visible) {
          emitted += visible;
          return visible;
        }
        return null;
      }

      /** Emit snapshot/append-carried fragment content once per fragment id. */
      function emitFragmentContent(fid, ftype, content, out) {
        if (typeof content !== "string" || !content) return;
        if (fid !== null) {
          if (seenFragIds.has(fid)) return;
          seenFragIds.add(fid);
        }
        const visible = routeFragText(content, ftype);
        if (visible) out.deltas.push(visible);
      }

      function trackFragment(fid, ftype) {
        if (fid !== null) {
          fragId = fid;
          fragType = ftype;
        } else if (ftype) {
          fragType = ftype;
        }
      }

      function applyPatchOp(p, o, v, out) {
        if (p === "response/fragments" && o === "APPEND" && Array.isArray(v)) {
          for (const f of v) {
            if (!f || typeof f !== "object") continue;
            trackFragment(typeof f.id === "number" ? f.id : null, typeof f.type === "string" ? f.type : null);
            emitFragmentContent(typeof f.id === "number" ? f.id : null, typeof f.type === "string" ? f.type : null, typeof f.content === "string" ? f.content : "", out);
          }
          return;
        }
        // -1/content appends usually omit "o" (default APPEND).
        if (p === "response/fragments/-1/content" && typeof v === "string" && (o === "APPEND" || o === undefined)) {
          const visible = routeFragText(v, fragType);
          if (visible) out.deltas.push(visible);
          return;
        }
        if ((p === "response/status" || p === "quasi_status") && (o === "SET" || o === undefined) && typeof v === "string" && /finish/i.test(v)) {
          sawFinish = true;
          out.done = true;
          return;
        }
        if (p === "response" && o === "BATCH" && Array.isArray(v)) {
          for (const sub of v) {
            if (sub && typeof sub === "object" && !Array.isArray(sub) && typeof sub.p === "string") {
              applyPatchOp(sub.p, sub.o, sub.v, out);
            }
          }
          return;
        }
        // Other patch paths (elapsed_secs, token usage, session updates): ignore.
      }

      /**
       * Consume one parsed frame when it belongs to the fragment protocol.
       * Returns true when consumed (generic extractor must skip it).
       */
      function routeFragmentFrame(obj, out) {
        if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return false;
        if (typeof obj.p === "string") {
          applyPatchOp(obj.p, obj.o, obj.v, out);
          return true;
        }
        const rv = obj.v;
        if (rv && typeof rv === "object" && !Array.isArray(rv) && rv.response && typeof rv.response === "object") {
          const resp = rv.response;
          if (typeof resp.status === "string" && /finish/i.test(resp.status)) sawFinish = true;
          if (Array.isArray(resp.fragments)) {
            for (const f of resp.fragments) {
              if (!f || typeof f !== "object") continue;
              trackFragment(typeof f.id === "number" ? f.id : null, typeof f.type === "string" ? f.type : null);
              emitFragmentContent(typeof f.id === "number" ? f.id : null, typeof f.type === "string" ? f.type : null, typeof f.content === "string" ? f.content : "", out);
            }
          }
          return true;
        }
        // Plain v-string: attributed to the current fragment (legacy streams
        // carry no fragment info, so untyped text stays visible).
        if ("v" in obj && typeof obj.v === "string") {
          const visible = routeFragText(obj.v, fragType);
          if (visible) out.deltas.push(visible);
          return true;
        }
        return false;
      }

      function feed(chunk) {
        let text = carry + chunk;
        carry = "";
        if (text.endsWith("\r")) {
          carry = "\r";
          text = text.slice(0, -1);
        }
        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        buf += text;
        const out = { deltas: [], hintError: null, done: false };
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const { event, data } = frameData(frame);
          const payload = data.trim();
          if (!payload) {
            if (event === "close") out.done = true;
            continue;
          }
          if (payload === "[DONE]") {
            sawDoneMarker = true;
            out.done = true;
            continue;
          }
          const obj = safeJsonParse(payload);
          if (obj === undefined) {
            noteSkipped(payload);
            continue;
          }

          // DeepSeek `event: hint` frames carry provider errors (rate limit)
          if (event === "hint") {
            const e = {
              content: typeof obj.content === "string" ? obj.content : "",
              finishReason: typeof obj.finish_reason === "string" ? obj.finish_reason : "",
            };
            if (e.content || e.finishReason) {
              hintError = e;
              out.hintError = e;
            }
            continue;
          }

          // DeepSeek typed-fragment protocol: thinking and answer share the
          // {"v": "..."} shape but are attributed to the current fragment
          // (THINK vs RESPONSE). Consumed here; anything else falls through
          // to the generic extractor below.
          if (routeFragmentFrame(obj, out)) continue;

          const r = extractFromFrame(obj);
          if (!r) {
            noteSkipped(payload);
            if (event === "close") out.done = true;
            continue;
          }
          if (r.error) {
            const e = { content: r.error, finishReason: r.finishReason || "" };
            hintError = e;
            out.hintError = e;
            if (/rate_limit/i.test(e.finishReason)) continue;
            // non-rate errors still end the stream logically
            out.done = true;
            continue;
          }
          if (r.done) sawFinish = true;
          if (r.think) {
            // semantically-tagged reasoning (reasoning_content): suppress
            // outright — it is not answer text and needs no <think> scan
            raw += r.think;
            continue;
          }
          const piece = r.delta || "";
          if (piece) {
            raw += piece;
            const visible = think.feed(piece);
            if (visible) {
              emitted += visible;
              out.deltas.push(visible);
            }
          }
        }
        return out;
      }

      function end() {
        const tail = think.end();
        if (tail) emitted += tail;
        return {
          text: emitted,
          rawLength: raw.length,
          // First 300 raw chars: settles "what did the wire actually send"
          // debates (tag variants, boundary nibbles) from one diag paste.
          rawHead: raw.slice(0, 300),
          skipped,
          skippedHead: skippedSample,
          thinkChars,
          sawAny: raw.length > 0,
          sawDoneMarker,
          sawFinish,
          hintError,
        };
      }

      return { feed, end, emitted: () => emitted };
    }

    return {
      COMPLETION_RE,
      frameData,
      extractFromFrame,
      holdLen,
      createThinkFilter,
      createSseParser,
      safeJsonParse,
    };
  }

  // -------------------------------------------------------------------------
  // Node (unit tests): expose pure internals, install nothing.
  // -------------------------------------------------------------------------
  if (typeof window === "undefined") {
    const internals = createInternals();
    Object.defineProperty(globalThis, "__tabBridgeSseInternals", {
      value: internals,
      configurable: true,
      writable: true,
    });
    return;
  }

  // -------------------------------------------------------------------------
  // MAIN-world installation
  // -------------------------------------------------------------------------
  if (window.__tabBridgeSseHookInstalled) return;
  window.__tabBridgeSseHookInstalled = true;

  const internals = createInternals();
  const SRC = "tab-bridge-sse";
  const CTRL = "tab-bridge-sse-control";
  let armed = null; // { turnId, deadline, started } | null
  const log = (...a) => {
    try {
      console.debug("[tab-bridge:sse]", ...a);
    } catch {
      /* noop */
    }
  };
  // Visible-by-default log: console.debug is hidden unless Verbose is on,
  // which is why stuck turns showed "no logs". info() is for turn-lifecycle
  // events only (arm / stream-start / complete / errors), never deltas.
  const info = (...a) => {
    try {
      console.log("[tab-bridge:sse]", ...a);
    } catch {
      /* noop */
    }
  };

  // Field diagnostics: readable from the page console as
  // `window.__tabBridgeSseDiag`. Tells us whether the completion POST was
  // ever seen, what it looked like, and what the capture produced.
  // NOTE: keep hookVersion in sync with manifest.json (MAIN world cannot
  // read the manifest; the injector reports its own version live).
  const diag = {
    hookVersion: "1.2.48",
    installedAt: new Date().toISOString(),
    arms: 0,
    lastArm: null,
    fetchesSeenWhileArmed: 0,
    /** Most recent non-matching fetch URLs seen while armed (max 8). */
    lastFetchUrls: [],
    /** Most recent non-matching XHR URLs seen while armed (max 8). */
    lastXhrUrls: [],
    /** All WebSocket URLs ever seen (max 8) — reveals a WS transport. */
    lastWsUrls: [],
    /** One entry per captured stream (max 8). */
    captures: [],
    /** Passive transport census: completion-URL requests seen per transport,
     * counted ALWAYS (even unarmed) so the diag alone reveals whether the
     * app streams over fetch, XHR, or EventSource. */
    census: { fetch: 0, xhr: 0, eventsource: 0 },
    /** Most recent completion-URL sightings "transport METHOD url" (max 8). */
    lastCompletionUrls: [],
  };
  try {
    window.__tabBridgeSseDiag = diag;
  } catch {
    /* noop */
  }

  function censusNote(transport, method, url) {
    let u = "";
    try {
      u = String(url == null ? "" : url);
      if (!internals.COMPLETION_RE.test(u)) return;
    } catch {
      return;
    }
    try {
      if (diag.census[transport] !== undefined) diag.census[transport] += 1;
      diag.lastCompletionUrls.push(`${transport} ${method} ${u.slice(0, 160)}`);
      if (diag.lastCompletionUrls.length > 8) diag.lastCompletionUrls.shift();
    } catch {
      /* noop */
    }
  }

  function recordCapture(entry) {
    diag.captures.push({ at: new Date().toISOString(), ...entry });
    if (diag.captures.length > 8) diag.captures.shift();
  }

  function noteFetchWhileArmed(method, url, matched) {
    diag.fetchesSeenWhileArmed += 1;
    if (!matched) {
      diag.lastFetchUrls.push(`${method} ${String(url).slice(0, 160)}`);
      if (diag.lastFetchUrls.length > 8) diag.lastFetchUrls.shift();
    }
  }

  /**
   * Shared stream finish: info-log, diag record, and the empty-stream re-arm
   * (an empty capture usually means we latched onto a non-answer request, so
   * stay armed for the real answer POST while the arm deadline allows).
   * Returns the parser's end() summary.
   */
  function finishStreamCapture(turnId, kind, parser, deltaCount) {
    const fin = parser.end();
    info(
      `stream complete for ${turnId} (${kind}):`,
      fin.rawLength,
      "raw chars,",
      fin.text.length,
      "visible in",
      deltaCount,
      "deltas,",
      fin.thinkChars || 0,
      "thinking chars suppressed,",
      fin.skipped,
      "frames skipped"
    );
    recordCapture({
      turnId,
      kind,
      result: fin.text.length > 0 ? "text" : "empty",
      deltas: deltaCount,
      rawLength: fin.rawLength,
      rawHead: fin.rawHead,
      skipped: fin.skipped,
      skippedHead: fin.skippedHead,
      thinkChars: fin.thinkChars || 0,
      textHead: fin.text.slice(0, 120),
      doneMarker: fin.sawDoneMarker || fin.sawFinish,
    });
    if (fin.text.length === 0 && armed && armed.turnId === turnId && Date.now() < armed.deadline) {
      armed.started = false;
      info("empty stream for", turnId, "— staying armed for the next completion request");
    }
    return fin;
  }

  function post(msg) {
    try {
      window.postMessage(Object.assign({ source: SRC }, msg), window.location.origin);
    } catch {
      /* page navigating away */
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== CTRL) return;
    if (d.type === "ping") {
      post({ type: "hello" });
      return;
    }
    if (d.type === "arm") {
      // auto-expire slightly after the turn deadline as a safety net
      armed = {
        turnId: d.turnId,
        deadline: Date.now() + (d.timeoutMs || 300000) + 30000,
        started: false,
      };
      diag.arms += 1;
      diag.lastArm = { turnId: d.turnId, at: new Date().toISOString() };
      diag.fetchesSeenWhileArmed = 0;
      info("armed for", d.turnId);
      post({ type: "arm-ack", turnId: d.turnId });
      return;
    }
    if (d.type === "disarm") {
      armed = null;
      return;
    }
  });

  // ---------------------------------------------------------------------------
  // Synchronous arm path.
  //
  // The isolated world dispatches this event on window immediately BEFORE
  // clicking a control that will synchronously fire a new fetch/XHR. Since
  // `window.postMessage` above is asynchronous (its listener runs on the
  // next task), the async arm races the continuation POST and loses it:
  // DeepSeek's Continue click fires /api/v0/chat/completion synchronously
  // while the hook is still unarmed. A CustomEvent dispatched on window is
  // delivered synchronously across the world boundary — the arm lands in
  // this MAIN-world listener BEFORE the click's event handler runs.
  //
  // Data is carried via a dataset attribute because Chrome's cross-world
  // event object does not reliably expose `detail`.
  // ---------------------------------------------------------------------------
  window.addEventListener("tab-bridge-sse-arm-sync", () => {
    let raw = "";
    try {
      raw = document.documentElement.dataset.tabBridgeArm || "";
      delete document.documentElement.dataset.tabBridgeArm;
    } catch {
      /* noop */
    }
    if (!raw) return;
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    if (!d || typeof d.turnId !== "string") return;
    armed = {
      turnId: d.turnId,
      deadline: Date.now() + (d.timeoutMs || 300000) + 30000,
      started: false,
    };
    diag.arms += 1;
    diag.lastArm = { turnId: d.turnId, at: new Date().toISOString(), sync: true };
    diag.fetchesSeenWhileArmed = 0;
    info("armed (sync) for", d.turnId);
    post({ type: "arm-ack", turnId: d.turnId });
  });

  post({ type: "hello" });
  info("hook installed (MAIN world), version", diag.hookVersion);

  async function pumpSse(branch, turnId) {
    const parser = internals.createSseParser();
    const dec = new TextDecoder();
    let deltaCount = 0;
    try {
      for (; ;) {
        const { value, done } = await branch.read();
        if (done) break;
        const res = parser.feed(dec.decode(value, { stream: true }));
        if (res.hintError) {
          post({
            type: "hint-error",
            turnId,
            content: res.hintError.content,
            finishReason: res.hintError.finishReason,
          });
        }
        for (const d of res.deltas) post({ type: "delta", turnId, text: d });
        deltaCount += res.deltas.length;
      }
    } catch (e) {
      post({ type: "stream-error", turnId, error: String((e && e.message) || e) });
      info("stream-error for", turnId, String((e && e.message) || e));
      recordCapture({ turnId, kind: "sse", result: "stream-error", deltas: deltaCount });
      try {
        branch.cancel();
      } catch {
        /* noop */
      }
      return;
    }
    const fin = finishStreamCapture(turnId, "sse", parser, deltaCount);
    post({
      type: "complete",
      turnId,
      text: fin.text,
      sawAny: fin.sawAny,
      doneMarker: fin.sawDoneMarker || fin.sawFinish,
      hintError: fin.hintError,
    });
    try {
      branch.cancel();
    } catch {
      /* already closed */
    }
  }

  /** Defensive: a 200 completion response that is not an SSE stream. */
  async function pumpJson(branch, turnId) {
    let text = "";
    try {
      text = await new Response(branch).text();
    } catch (e) {
      post({ type: "stream-error", turnId, error: String((e && e.message) || e) });
      info("stream-error (json) for", turnId, String((e && e.message) || e));
      recordCapture({ turnId, kind: "json", result: "stream-error" });
      return;
    }
    const r = internals.extractFromFrame(internals.safeJsonParse(text));
    const out = r && typeof r.delta === "string" ? r.delta : "";
    info("non-SSE completion for", turnId + ":", out.length, "chars");
    recordCapture({ turnId, kind: "json", result: out.length > 0 ? "text" : "empty" });
    if (out.length === 0 && armed && armed.turnId === turnId && Date.now() < armed.deadline) {
      armed.started = false;
      info("empty JSON completion for", turnId, "— staying armed for the next completion POST");
    }
    post({
      type: "complete",
      turnId,
      text: out,
      sawAny: out.length > 0,
      doneMarker: true,
      hintError: null,
    });
  }

  /** Error status bodies (429 rate limit, 401 auth, 5xx): report, then the
   * page still gets its untouched branch with the same JSON error. */
  async function drainError(branch, turnId, status) {
    let snippet = "";
    try {
      const t = await new Response(branch).text();
      const obj = internals.safeJsonParse(t);
      snippet =
        (obj && obj.error && typeof obj.error.message === "string" && obj.error.message) ||
        (obj && typeof obj.message === "string" && obj.message) ||
        String(t || "").slice(0, 300);
    } catch {
      /* ignore */
    }
    log("completion HTTP", status, snippet.slice(0, 80));
    info("completion HTTP", status, "for", turnId, String(snippet).slice(0, 120));
    recordCapture({ turnId, kind: "http-error", result: `http-${status}` });
    post({ type: "http-error", turnId, status, snippet: String(snippet).slice(0, 300) });
  }

  const origFetch = window.fetch;
  if (typeof origFetch !== "function") return;

  window.fetch = function (input, init) {
    let url = "";
    let method = "GET";
    try {
      if (typeof input === "string") url = input;
      else if (input && typeof input.url === "string") {
        url = input.url;
        if (input.method) method = input.method;
      }
      if (init && typeof init.method === "string") method = init.method;
    } catch {
      /* fall through to plain fetch */
    }
    let match = false;
    try {
      censusNote("fetch", method, url);
    } catch {
      /* noop */
    }
    try {
      match = !!armed && !armed.started && method === "POST" && internals.COMPLETION_RE.test(url);
    } catch {
      match = false;
    }
    if (armed && !armed.started) noteFetchWhileArmed(method, url, match);
    if (!match) return origFetch.call(this, input, init);

    const turnId = armed.turnId;
    armed.started = true; // exactly one capture per armed turn
    info("intercepting completion POST for", turnId, String(url).slice(0, 120));
    return Promise.resolve()
      .then(() => origFetch.call(this, input, init))
      .then((resp) => {
        try {
          if (!resp || !resp.body) {
            post({ type: "complete", turnId, text: "", sawAny: false, doneMarker: false, hintError: null });
            return resp;
          }
          const ct = (resp.headers && resp.headers.get("content-type")) || "";
          info("stream attached for", turnId + ":", resp.status, ct, String(url).slice(0, 120));
          post({ type: "stream-start", turnId, status: resp.status, contentType: ct });
          const branches = resp.body.tee();
          if (resp.status >= 400) drainError(branches[1], turnId, resp.status);
          else if (/text\/event-stream/i.test(ct)) pumpSse(branches[1], turnId);
          else pumpJson(branches[1], turnId);
          // Fresh Response for the page: the tee branch is byte-identical and
          // already decoded, so hop-headers must not leak onto it.
          const h = new Headers(resp.headers);
          h.delete("content-encoding");
          h.delete("content-length");
          return new Response(branches[0], {
            status: resp.status,
            statusText: resp.statusText,
            headers: h,
          });
        } catch (e) {
          post({ type: "hook-error", turnId, error: String((e && e.message) || e) });
          return resp; // never break the page
        }
      })
      .catch((err) => {
        post({
          type: "fetch-rejected",
          turnId,
          error: String((err && err.message) || err),
        });
        throw err;
      });
  };

  // -------------------------------------------------------------------------
  // XHR tap: some frontends stream over XMLHttpRequest (responseText grows
  // incrementally). Same arm/capture contract as the fetch tap.
  // -------------------------------------------------------------------------
  function attachXhrCapture(xhr, turnId) {
    const parser = internals.createSseParser();
    let seen = 0;
    let deltaCount = 0;
    let announced = false;

    const announce = () => {
      if (announced) return;
      announced = true;
      let ct = "";
      try {
        ct = xhr.getResponseHeader("content-type") || "";
      } catch {
        /* headers unavailable */
      }
      info("XHR stream attached for", turnId + ":", xhr.status || 0, ct);
      post({ type: "stream-start", turnId, status: xhr.status || 200, contentType: ct });
    };

    const pump = () => {
      let full = "";
      try {
        full = xhr.responseText || "";
      } catch {
        return; // non-text responseType: nothing to stream-parse
      }
      if (full.length <= seen) return;
      const chunk = full.slice(seen);
      seen = full.length;
      announce();
      let res;
      try {
        res = parser.feed(chunk);
      } catch {
        return;
      }
      if (res.hintError) {
        post({
          type: "hint-error",
          turnId,
          content: res.hintError.content,
          finishReason: res.hintError.finishReason,
        });
      }
      for (const d of res.deltas) post({ type: "delta", turnId, text: d });
      deltaCount += res.deltas.length;
    };

    const finish = (result) => {
      if (result === "http-error") {
        let snippet = "";
        try {
          snippet = String(xhr.responseText || "").slice(0, 300);
        } catch {
          /* ignore */
        }
        info("XHR completion HTTP", xhr.status, "for", turnId, snippet.slice(0, 120));
        recordCapture({ turnId, kind: "xhr", result: `http-${xhr.status}` });
        post({ type: "http-error", turnId, status: xhr.status || 0, snippet });
        return;
      }
      if (result === "failed") {
        post({ type: "fetch-rejected", turnId, error: "xhr request failed/aborted" });
        info("XHR request failed for", turnId);
        recordCapture({ turnId, kind: "xhr", result: "failed", deltas: deltaCount });
        return;
      }
      const fin = finishStreamCapture(turnId, "xhr", parser, deltaCount);
      post({
        type: "complete",
        turnId,
        text: fin.text,
        sawAny: fin.sawAny,
        doneMarker: fin.sawDoneMarker || fin.sawFinish,
        hintError: fin.hintError,
      });
    };

    try {
      xhr.addEventListener("progress", pump);
      xhr.addEventListener("load", () => {
        pump();
        finish(xhr.status >= 400 ? "http-error" : "done");
      });
      xhr.addEventListener("error", () => finish("failed"));
      xhr.addEventListener("abort", () => finish("failed"));
      xhr.addEventListener("timeout", () => finish("failed"));
    } catch {
      /* listener install failed — page flow untouched */
    }
  }

  try {
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR && OrigXHR.prototype && typeof OrigXHR.prototype.open === "function") {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url, ...rest) {
        try {
          this.__tbMethod = method;
          this.__tbUrl = url == null ? "" : String(url);
          censusNote("xhr", method, this.__tbUrl);
        } catch {
          /* noop */
        }
        return origOpen.call(this, method, url, ...rest);
      };
      OrigXHR.prototype.send = function (...args) {
        try {
          const method = String(this.__tbMethod || "GET").toUpperCase();
          const url = this.__tbUrl || "";
          censusNote("xhr", method, url);
          if (!!armed && !armed.started) {
            try {
              const matched = method === "POST" && internals.COMPLETION_RE.test(url);
              if (!matched) {
                diag.lastXhrUrls.push(`${method} ${url.slice(0, 160)}`);
                if (diag.lastXhrUrls.length > 8) diag.lastXhrUrls.shift();
              }
            } catch {
              /* noop */
            }
          }
          if (!!armed && !armed.started && method === "POST" && internals.COMPLETION_RE.test(url)) {
            const turnId = armed.turnId;
            armed.started = true;
            info("intercepting XHR completion POST for", turnId, url.slice(0, 120));
            attachXhrCapture(this, turnId);
          }
        } catch (e) {
          log("xhr tap failed:", String((e && e.message) || e));
        }
        return origSend.apply(this, args);
      };
    }
  } catch {
    /* XHR untappable — fetch tap still stands */
  }

  // -------------------------------------------------------------------------
  // WebSocket census: if answers ever stream over a socket, the fetch/XHR/
  // EventSource taps are all blind. Passive URL log only (no interception).
  // -------------------------------------------------------------------------
  try {
    const OrigWS = window.WebSocket;
    if (typeof OrigWS === "function") {
      window.WebSocket = function (url, protocols) {
        try {
          diag.lastWsUrls.push(String(url).slice(0, 160));
          if (diag.lastWsUrls.length > 8) diag.lastWsUrls.shift();
        } catch {
          /* noop */
        }
        return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      };
      window.WebSocket.prototype = OrigWS.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
        try {
          window.WebSocket[k] = OrigWS[k];
        } catch {
          /* noop */
        }
      }
    }
  } catch {
    /* WebSocket untappable */
  }

  // -------------------------------------------------------------------------
  // EventSource tap: if the app streams answers over SSE-as-transport, the
  // fetch/XHR taps see nothing. Constructor census always runs; capture only
  // while armed. Page listeners are snooped, never replaced.
  // -------------------------------------------------------------------------
  try {
    const OrigES = window.EventSource;
    if (typeof OrigES === "function") {
      window.EventSource = function (url, config) {
        const urlStr = String(url);
        try {
          censusNote("eventsource", "GET", urlStr);
        } catch {
          /* noop */
        }
        const es = new OrigES(url, config);
        try {
          if (!!armed && !armed.started && internals.COMPLETION_RE.test(urlStr)) {
            const turnId = armed.turnId;
            armed.started = true;
            info("intercepting EventSource completion stream for", turnId, urlStr.slice(0, 120));
            wrapEventSource(es, turnId);
          }
        } catch (e) {
          log("eventsource tap failed:", String((e && e.message) || e));
        }
        return es;
      };
      window.EventSource.prototype = OrigES.prototype;
    }
  } catch {
    /* EventSource untappable — fetch/XHR taps still stand */
  }

  function wrapEventSource(es, turnId) {
    const parser = internals.createSseParser();
    let deltaCount = 0;
    let announced = false;
    let done = false;

    const announce = () => {
      if (announced) return;
      announced = true;
      info("EventSource stream attached for", turnId);
      post({ type: "stream-start", turnId, status: 200, contentType: "text/event-stream" });
    };

    const feedData = (data) => {
      announce();
      let res;
      try {
        res = parser.feed("data: " + String(data).split("\n").join("\ndata: ") + "\n\n");
      } catch {
        return;
      }
      for (const d of res.deltas) post({ type: "delta", turnId, text: d });
      deltaCount += res.deltas.length;
    };

    const finish = () => {
      if (done) return;
      done = true;
      try {
        es.close();
      } catch {
        /* noop */
      }
      const fin = finishStreamCapture(turnId, "eventsource", parser, deltaCount);
      post({
        type: "complete",
        turnId,
        text: fin.text,
        sawAny: fin.sawAny,
        doneMarker: true,
        hintError: fin.hintError,
      });
    };

    const feedHint = (data) => {
      announce();
      let obj;
      try {
        obj = typeof data === "string" ? internals.safeJsonParse(data) : data;
      } catch {
        return;
      }
      const content = obj && typeof obj.content === "string" ? obj.content : "";
      const finishReason = obj && typeof obj.finish_reason === "string" ? obj.finish_reason : "";
      if (content || finishReason) {
        post({ type: "hint-error", turnId, content, finishReason });
      }
    };

    try {
      const origAdd = es.addEventListener.bind(es);
      es.addEventListener = (type, listener, opts) => {
        const snooping =
          typeof listener === "function"
            ? (ev) => {
              try {
                if (type === "message") feedData(ev && ev.data !== undefined ? ev.data : "");
                else if (type === "hint") feedHint(ev && ev.data);
                else if (type === "close" || type === "done" || type === "finish") finish();
              } catch {
                /* snoop never breaks the page */
              }
              listener(ev);
            }
            : listener;
        return origAdd(type, snooping, opts);
      };
      // onmessage / onerror property handlers (path used instead of
      // addEventListener by some clients).
      const wrapProp = (prop, fn) => {
        try {
          let current = es[prop];
          Object.defineProperty(es, prop, {
            configurable: true,
            get: () => current,
            set: (v) => {
              current =
                typeof v === "function"
                  ? (ev) => {
                    try {
                      fn(ev);
                    } catch {
                      /* noop */
                    }
                    v(ev);
                  }
                  : v;
            },
          });
        } catch {
          /* property not wrappable */
        }
      };
      wrapProp("onmessage", (ev) => feedData(ev && ev.data !== undefined ? ev.data : ""));
      const origOpen = es.onopen;
      try {
        es.onopen = (ev) => {
          announce();
          if (typeof origOpen === "function") origOpen(ev);
        };
      } catch {
        /* noop */
      }
      wrapProp("onerror", () => {
        try {
          if (es.readyState === 2) finish();
        } catch {
          /* noop */
        }
      });
    } catch {
      /* snooping failed — raw stream still flows to the page */
    }
  }
})();
