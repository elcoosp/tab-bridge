/** Small async primitives: mutex, deferred, timeout helpers. */

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  /** Try to acquire without waiting. Returns false when already locked. */
  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }

  get isLocked(): boolean {
    return this.locked;
  }
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  private _resolve!: (v: T) => void;
  private _reject!: (e: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  resolve(v: T): void {
    if (this.settled) return;
    this.settled = true;
    this._resolve(v);
  }

  reject(e: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this._reject(e);
  }

  get isSettled(): boolean {
    return this.settled;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TimeoutError extends Error {
  constructor(message = "operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export function randomId(len = 16): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
