/**
 * Call-id synthesis (spec 6.2): call_ + blake2b(name + canonJson(args))[:10].
 * Deterministic across retries, duplicate parses, and bridge restarts.
 */
import { createHash } from "node:crypto";
import { canonJson } from "../util/json.js";

export function synthCallId(name: string, argsJson: string, occurrence = 0): string {
  let canonical: string;
  try {
    canonical = canonJson(JSON.parse(argsJson || "{}"));
  } catch {
    canonical = argsJson || "";
  }
  const digest = createHash("blake2b512")
    .update(`${name}:${canonical}#${occurrence}`, "utf8")
    .digest();
  return `call_${digest.subarray(0, 5).toString("hex")}`;
}
