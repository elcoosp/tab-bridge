/**
 * Hash-chain session state (ADR-3, spec 5.1).
 * One 16-byte digest per message, chained so position and content are both
 * covered. Digests are stored and compared as hex strings.
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "./canonical.js";
import { canonical, stripSystemPrefix } from "./canonical.js";

export const CHAIN_SCHEME = 3;
export const HASH_HEX_LEN = 32; // 16 bytes

export function blake2b16(data: string): Buffer {
  return createHash("blake2b512").update(data, "utf8").digest().subarray(0, 16);
}

export function hashCanonical(prev: string | null, canonicalMsg: string): string {
  const input = prev === null ? canonicalMsg : `${prev}|${canonicalMsg}`;
  return blake2b16(input).toString("hex");
}

/** Incremental verifier/folder over a message list. */
export class ChainFolder {
  private current: string | null = null;
  private count = 0;

  /** Fold one more message; returns its hex digest. */
  push(msg: ChatMessage): string {
    this.current = hashCanonical(this.current, canonical(msg));
    this.count += 1;
    return this.current;
  }

  /** Seed the folder with an existing chain prefix (hex digests). */
  seedWith(chainHex: readonly string[]): void {
    // Verify cheaply by refolding canonical strings is impossible without the
    // messages; callers only use this to compare fresh folds, so seeding is
    // done by position: current = chainHex[n-1], count = n.
    this.current = chainHex.length > 0 ? chainHex[chainHex.length - 1] : null;
    this.count = chainHex.length;
  }

  get head(): string | null {
    return this.current;
  }

  get length(): number {
    return this.count;
  }
}

/**
 * Fold the incoming history and compare against the stored chain.
 * Returns the index of the first mismatching position, or -1 when the whole
 * stored prefix matches.
 */
export function firstMismatch(
  storedChain: readonly string[],
  messages: readonly ChatMessage[]
): number {
  let prev: string | null = null;
  const limit = Math.min(storedChain.length, messages.length);
  for (let i = 0; i < limit; i++) {
    const h = hashCanonical(prev, canonical(messages[i]));
    if (h !== storedChain[i]) return i;
    prev = h;
  }
  return -1;
}

/** Fresh chain over a full message list (used by SEED / RESET_RESEED commits). */
export function foldAll(messages: readonly ChatMessage[]): string[] {
  const chain: string[] = [];
  let prev: string | null = null;
  for (const m of stripSystemPrefix(messages)) {
    prev = hashCanonical(prev, canonical(m));
    chain.push(prev);
  }
  return chain;
}
