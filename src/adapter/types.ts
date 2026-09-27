/**
 * L1 adapter contract (spec 7.1) — frozen for v1.
 * The bridge knows a chat product ONLY through this interface.
 */

export interface ManagedTab {
  tabId: number;
  state: "created" | "connecting" | "ready" | "busy" | "cooldown" | "dead";
  health?: Health;
}

export type HealthState =
  | "ok"
  | "cf_challenge"
  | "auth_invalid"
  | "rate_limited"
  | "degraded";

export interface Health {
  state: HealthState;
  detail?: string;
}

export interface AdapterCapabilities {
  streaming: boolean;
  thinkingToggle: boolean;
  resetSupport: boolean;
  maxPromptChars: number;
  warmupMsTypical: number;
  domFingerprint: string;
}

export interface TurnOptions {
  timeoutMs: number;
  think: boolean;
}

export type StopReason = "stop" | "tool_calls" | "length" | "aborted";

export interface TurnResult {
  text: string;
  stopReason: StopReason;
  usageMeta?: Record<string, unknown>;
}

export interface StreamSink {
  onFragment(text: string): void;
  onStatus(code: "submitting" | "streaming" | "done" | "aborted"): void;
  onUsage?(meta: Record<string, unknown>): void;
}

export interface Ready {
  ok: boolean;
  detail?: string;
}

export type ResetOutcome = "ok" | "timeout" | "failed";

/**
 * The adapter seam (ADR-8). v1 ships DeepSeekAdapter only, but the contract is
 * implemented and consumed from day one.
 */
export interface ChatProviderAdapter {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  attach(port: unknown): void;
  ensureReady(tab: ManagedTab, timeoutMs: number): Promise<Ready>;
  sendTurn(tab: ManagedTab, text: string, opts: TurnOptions): Promise<void>;
  streamResponse(tab: ManagedTab, sink: StreamSink): Promise<TurnResult>;
  resetConversation(tab: ManagedTab): Promise<ResetOutcome>;
  health(tab: ManagedTab): Promise<Health>;
  dispose(tab: ManagedTab): Promise<void>;
}
