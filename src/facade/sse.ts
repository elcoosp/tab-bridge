/**
 * SSE encoder (spec 8.2). Headers are sent lazily on the first frame so a
 * turn that fails before producing anything surfaces as a clean HTTP error,
 * not an empty 200-stream (ADR-7: empty successful streams are impossible).
 */
import type { ServerResponse } from "node:http";

export interface ChatChoiceDelta {
  index?: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type: "function";
      function: { name?: string; arguments: string };
    }>;
  };
  finish_reason: string | null;
}

export class SseStream {
  private res: ServerResponse;
  private headersSent = false;
  private frameCount = 0;
  private doneSent = false;
  private ended = false;

  constructor(res: ServerResponse) {
    this.res = res;
  }

  get sentHeaders(): boolean {
    return this.headersSent;
  }

  get frames(): number {
    return this.frameCount;
  }

  /** Send headers now (used by the caller at first real frame). */
  start(model: string): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-bridge-model": model,
    });
    this.res.flushHeaders?.();
  }

  sendChoice(delta: ChatChoiceDelta, model: string, id: string, created: number): void {
    this.start(model);
    this.write({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [delta],
    });
  }

  sendUsage(model: string, id: string, created: number, usage: Record<string, unknown>, extra?: Record<string, unknown>): void {
    this.start(model);
    this.write({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage,
      ...(extra ?? {}),
    });
  }

  sendRaw(obj: unknown): void {
    this.start("unknown");
    this.write(obj);
  }

  done(): void {
    if (this.doneSent || this.ended) return;
    this.doneSent = true;
    if (!this.headersSent) return;
    this.res.write("data: [DONE]\n\n");
  }

  /** Terminate with an error: before headers -> HTTP error; after -> SSE error frame. */
  fail(status: number, body: Record<string, unknown>, retryAfter?: number): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.headersSent) {
      const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
      if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
      this.res.writeHead(status, headers);
      this.res.end(JSON.stringify(body));
      return;
    }
    this.res.write(`data: ${JSON.stringify({ error: body.error })}\n\n`);
    this.res.write("data: [DONE]\n\n");
    this.res.end();
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.done();
    if (this.headersSent) this.res.end();
  }

  private write(obj: unknown): void {
    this.frameCount += 1;
    this.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }
}
