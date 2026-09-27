/**
 * Deterministic JSON canonicalization used by call-id synthesis and hashing.
 * Object keys are sorted; arrays keep order; output has no whitespace.
 */
export function canonJson(value: unknown): string {
  return encode(value);
}

function encode(v: unknown): string {
  if (v === null || typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      if (obj[k] === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${encode(obj[k])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(String(v));
}
