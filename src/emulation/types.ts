/** L2 shared types: tool specs, parsed outputs, holdback events. */

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
      [k: string]: unknown;
    };
  };
}

export interface ParsedCall {
  name: string;
  /** Canonical JSON string of the arguments object. */
  arguments: string;
  /** Client-visible call id (synthesized when the model did not supply one). */
  id: string;
  /** Validator diagnostics attached to this call (empty when valid). */
  errors: string[];
}

export interface ParseOutcome {
  /** Prose outside fences (or everything, when no valid call was found). */
  content: string;
  calls: ParsedCall[];
  warnings: string[];
}

export type HoldbackEvent =
  | { type: "content"; text: string }
  | { type: "call"; name: string; argsJson: string; id?: string }
  | { type: "invalid"; text: string; error: string };

export const TOOL_PROTOCOL_VERSION = 1;
export const HOLDBACK_CEILING = 4000;
export const TOOL_SCHEMA_BUDGET = 1200;
