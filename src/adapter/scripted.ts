/**
 * ScriptedAdapter: deterministic ChatProviderAdapter for contract tests and
 * offline development (ADR-2: bridge testable with no browser attached).
 * Each sendTurn consumes the next scripted reply; streamResponse replays it
 * as fragments.
 */
import type {
  AdapterCapabilities,
  ChatProviderAdapter,
  Health,
  ManagedTab,
  Ready,
  ResetOutcome,
  StopReason,
  StreamSink,
  TurnOptions,
  TurnResult,
} from "./types.js";

export interface ScriptedReply {
  /** Full reply text; emitted as 1-3 fragments. */
  text: string;
  stopReason?: StopReason;
  /** Split into fragments of this size (default 7, to force multi-fragment). */
  fragmentSize?: number;
  /** Fail the turn instead of streaming (code: submit-failed|timeout|dom-error). */
  failWith?: "submit-failed" | "timeout" | "dom-error" | "port-lost";
  /** Raw error string thrown verbatim (e.g. "turn-error:rate_limited:..."). */
  failText?: string;
}

export class ScriptedAdapter implements ChatProviderAdapter {
  readonly id: string;
  private replies: ScriptedReply[];
  private cursor = 0;
  private resets: ResetOutcome[] = [];
  private readyFailures = 0;
  readonly capabilitiesObj: AdapterCapabilities;
  /** Every text submitted via sendTurn (for plan-level assertions). */
  readonly sentTexts: string[] = [];
  resetCount = 0;

  constructor(opts?: { id?: string; replies?: ScriptedReply[]; maxPromptChars?: number }) {
    this.id = opts?.id ?? "scripted-web";
    this.replies = opts?.replies ?? [];
    this.capabilitiesObj = {
      streaming: true,
      thinkingToggle: true,
      resetSupport: true,
      maxPromptChars: opts?.maxPromptChars ?? 96_000,
      warmupMsTypical: 0,
      domFingerprint: "scripted-1",
    };
  }

  /** Queue additional replies (tests may also construct with them). */
  push(...replies: ScriptedReply[]): void {
    this.replies.push(...replies);
  }

  scriptResets(...outcomes: ResetOutcome[]): void {
    this.resets = [...outcomes];
  }

  failReady(times: number): void {
    this.readyFailures = times;
  }

  get consumed(): number {
    return this.cursor;
  }

  capabilities(): AdapterCapabilities {
    return this.capabilitiesObj;
  }

  attach(_port: unknown): void {
    /* nothing to bind for a scripted adapter */
  }

  async ensureReady(_tab: ManagedTab, _timeoutMs: number): Promise<Ready> {
    if (this.readyFailures > 0) {
      this.readyFailures -= 1;
      return { ok: false, detail: "scripted-not-ready" };
    }
    return { ok: true };
  }

  async sendTurn(_tab: ManagedTab, text: string, _opts: TurnOptions): Promise<void> {
    this.sentTexts.push(text);
    const reply = this.replies[this.cursor];
    if (reply?.failWith === "submit-failed") {
      throw new Error("submit-failed");
    }
    // Submission commits; observation happens in streamResponse.
  }

  async streamResponse(_tab: ManagedTab, sink: StreamSink): Promise<TurnResult> {
    const reply = this.replies[this.cursor];
    this.cursor += 1;
    if (!reply) throw new Error("scripted adapter exhausted");
    if (reply.failText) throw new Error(reply.failText);
    if (reply.failWith) throw new Error(reply.failWith);
    const size = reply.fragmentSize ?? 7;
    sink.onStatus("streaming");
    for (let i = 0; i < reply.text.length; i += size) {
      sink.onFragment(reply.text.slice(i, i + size));
    }
    sink.onStatus("done");
    return {
      text: reply.text,
      stopReason: reply.stopReason ?? "stop",
    };
  }

  async resetConversation(_tab: ManagedTab): Promise<ResetOutcome> {
    this.resetCount += 1;
    if (this.resets.length > 0) return this.resets.shift() as ResetOutcome;
    return "ok";
  }

  async health(_tab: ManagedTab): Promise<Health> {
    return { state: "ok" };
  }

  async dispose(_tab: ManagedTab): Promise<void> {
    /* nothing to dispose */
  }
}
