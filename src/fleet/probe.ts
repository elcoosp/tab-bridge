/**
 * Fingerprint probe page (ADR-18, §7.3): a single static, dependency-free
 * HTML page the bridge serves to a fresh tab in an account's profile. The
 * page measures the account's *observable* fingerprint — canvas hash,
 * language, timezone, window metrics, exit IP — and POSTs the result back
 * to the bridge, so the checkup can prove (not merely assume) that the
 * Chromium build actually honors the per-profile switches.
 *
 * Never shared with the internet: the page has no third-party scripts and
 * its own POST goes back to the local bridge. The only external call it
 * makes is the optional exit-IP echo (api.ipify.org), which is what makes
 * the probe able to report "which IP does this profile actually wear".
 *
 * The account id and probe token travel in the query string (parsed by the
 * page from location.search), so the served HTML is identical for every
 * invocation and contains no user-supplied content — no HTML escaping is
 * required.
 */

export const PROBE_PATH = "/fleet-probe";
export const PROBE_RESULT_PATH = "/v1/fleet/_probe_result";

export interface ProbeResult {
  accountId: string;
  token: string;
  /** 16 hex chars derived from a 2D canvas render (SHA-256, truncated). */
  canvasHash: string;
  language: string;
  languages: string[];
  timezone: string;
  timezoneOffsetMin: number;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  userAgent: string;
  platform: string;
  hardwareConcurrency: number;
  gpuRenderer: string | null;
  exitIp: string | null;
  at: number;
}

/** The measured fingerprint the bridge keeps per account. Same shape as the
 * probe result minus the transport fields (accountId, token, UA, platform). */
export interface CheckupEntry {
  at: number;
  canvasHash: string;
  language: string;
  timezone: string;
  timezoneOffsetMin: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  gpuRenderer: string | null;
  exitIp: string | null;
}

/** Bug-hunt D4: bound every string field to a sane length so a malicious
 * local process cannot POST a multi-megabyte value and bloat the
 * checkupHistory inside fleet.json. 256 chars is generous for a canvas
 * hash (16 hex), a locale tag, an IANA timezone, an IPv6 literal, or a
 * WebGL renderer string. */
const PROBE_STR_MAX = 256;
function boundStr(s: unknown, max = PROBE_STR_MAX): string | null {
  if (typeof s !== "string") return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function probeResultToEntry(p: ProbeResult): CheckupEntry {
  const canvasHash = boundStr(p.canvasHash);
  const language = boundStr(p.language);
  const timezone = boundStr(p.timezone);
  const gpu = boundStr(p.gpuRenderer);
  const exit = boundStr(p.exitIp);
  return {
    at: typeof p.at === "number" && Number.isFinite(p.at) ? p.at : Date.now(),
    canvasHash: canvasHash ?? "",
    language: language ?? "",
    timezone: timezone ?? "",
    timezoneOffsetMin:
      typeof p.timezoneOffsetMin === "number" && Number.isFinite(p.timezoneOffsetMin)
        ? Math.max(-24 * 60, Math.min(24 * 60, Math.trunc(p.timezoneOffsetMin)))
        : 0,
    innerWidth:
      typeof p.innerWidth === "number" && Number.isFinite(p.innerWidth)
        ? Math.max(0, Math.min(100_000, Math.trunc(p.innerWidth)))
        : 0,
    innerHeight:
      typeof p.innerHeight === "number" && Number.isFinite(p.innerHeight)
        ? Math.max(0, Math.min(100_000, Math.trunc(p.innerHeight)))
        : 0,
    devicePixelRatio:
      typeof p.devicePixelRatio === "number" && Number.isFinite(p.devicePixelRatio)
        ? Math.max(0, Math.min(100, p.devicePixelRatio))
        : 1,
    gpuRenderer: gpu,
    exitIp: exit,
  };
}

/** Static probe HTML. The page reads id/token from its own URL, measures,
 * then POSTs the payload back to the bridge and prints a summary. */
export function renderProbeHtml(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>tab-bridge fingerprint probe</title>
<style>
  body{font:14px system-ui;padding:16px;max-width:680px;color:#222}
  pre{background:#f4f4f4;padding:8px;border-radius:4px;overflow:auto}
</style>
<p>tab-bridge fingerprint probe running. This tab may be closed once the result appears below.</p>
<pre id="out">measuring…</pre>
<script>
(async () => {
  const params = new URLSearchParams(location.search);
  const accountId = params.get("id") || "";
  const token = params.get("token") || "";
  let canvasHash = "";
  const language = navigator.language || "";
  const languages = navigator.languages ? Array.from(navigator.languages) : [];
  let timezone = "";
  const timezoneOffsetMin = new Date().getTimezoneOffset();
  let gpuRenderer = null;
  let exitIp = null;

  try {
    const c = document.createElement("canvas");
    c.width = 240; c.height = 80;
    const ctx = c.getContext("2d");
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#f60"; ctx.fillRect(10, 10, 150, 40);
    ctx.fillStyle = "#069"; ctx.fillText("tab-bridge-probe", 15, 15);
    ctx.fillStyle = "rgba(102,204,0,0.7)"; ctx.fillText("tab-bridge-probe", 18, 18);
    const data = c.toDataURL();
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
    canvasHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch (e) {}

  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}

  try {
    const probeCanvas = document.createElement("canvas");
    const gl = probeCanvas.getContext("webgl") || probeCanvas.getContext("experimental-webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) gpuRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch (e) {}

  try {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store", mode: "cors" });
    const j = await r.json();
    if (j && typeof j.ip === "string") exitIp = j.ip;
  } catch (e) {}

  const payload = {
    accountId, token, canvasHash, language, languages, timezone, timezoneOffsetMin,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    outerWidth: window.outerWidth, outerHeight: window.outerHeight,
    screenWidth: screen.width, screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio || 1,
    userAgent: navigator.userAgent, platform: navigator.platform || "",
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    gpuRenderer, exitIp, at: Date.now(),
  };

  const out = document.getElementById("out");
  out.textContent = JSON.stringify(payload, null, 2);
  try {
    await fetch("${PROBE_RESULT_PATH}", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    out.textContent += "\\n\\nPOST ok — you may close this tab.";
  } catch (e) {
    out.textContent += "\\n\\nPOST failed: " + e;
  }
})();
</script>
`;
}
