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
    const COMPLETION_RE = /chat\/completion/i;
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
          if (obj === undefined) continue;

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

          const r = extractFromFrame(obj);
          if (!r) {
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
      log("armed for", d.turnId);
      post({ type: "arm-ack", turnId: d.turnId });
      return;
    }
    if (d.type === "disarm") {
      armed = null;
      return;
    }
  });

  post({ type: "hello" });
  log("hook installed (MAIN world)");

  async function pumpSse(branch, turnId) {
    const parser = internals.createSseParser();
    const dec = new TextDecoder();
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
      }
    } catch (e) {
      post({ type: "stream-error", turnId, error: String((e && e.message) || e) });
      try {
        branch.cancel();
      } catch {
        /* noop */
      }
      return;
    }
    const fin = parser.end();
    log("stream complete:", fin.rawLength, "raw chars,", fin.text.length, "visible");
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
      return;
    }
    const r = internals.extractFromFrame(internals.safeJsonParse(text));
    const out = r && typeof r.delta === "string" ? r.delta : "";
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
      match = !!armed && !armed.started && method === "POST" && internals.COMPLETION_RE.test(url);
    } catch {
      match = false;
    }
    if (!match) return origFetch.call(this, input, init);

    const turnId = armed.turnId;
    armed.started = true; // exactly one capture per armed turn
    return Promise.resolve()
      .then(() => origFetch.call(this, input, init))
      .then((resp) => {
        try {
          if (!resp || !resp.body) {
            post({ type: "complete", turnId, text: "", sawAny: false, doneMarker: false, hintError: null });
            return resp;
          }
          const ct = (resp.headers && resp.headers.get("content-type")) || "";
          log("stream attached:", resp.status, ct, String(url).slice(0, 120));
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
})();
