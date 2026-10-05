#!/usr/bin/env node
/**
 * tab-bridge CLI (spec 8.4):
 *   tab-bridge serve --port 8789 --api-key-env TAB_BRIDGE_KEY \
 *     --stateful=true --auto-create-tabs --managed-only --ttl=30m --repair-rounds=1
 */
import { createHttpServer } from "./facade/http.js";
import { TabBridge } from "./bridge.js";
import { parseServeArgs, usage } from "./config.js";
import { log } from "./log.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
const here = dirname(fileURLToPath(import.meta.url));
function readPkgVersion(): string {
  for (const p of [join(here, "../../package.json"), join(here, "../package.json")]) {
    try {
      const raw = readFileSync(p, "utf8");
      const v = (JSON.parse(raw) as { version?: string }).version;
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  return "unknown";
}
const pkgVersion: string = readPkgVersion();

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help" || !cmd) {
    process.stdout.write(usage() + "\n");
    process.exit(0);
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("tab-bridge " + pkgVersion + "\n");
    process.exit(0);
  }
  if (cmd === "fleet") {
    const { fleetMain } = await import("./fleet-cli.js");
    await fleetMain(rest);
    return;
  }
  if (cmd !== "serve") {
    process.stderr.write(`unknown command: ${cmd}\n\n${usage()}\n`);
    process.exit(2);
  }

  let config;
  try {
    config = parseServeArgs(rest);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n\n${usage()}\n`);
    process.exit(2);
  }

  const bridge = new TabBridge(config);
  const server = createHttpServer({ bridge });
  // Bug-hunt G18: warn at startup if the bridge is running without an
  // API key on a non-loopback host — anyone reachable can consume the
  // account's rate-limit budget as if they were the operator.
  if (
    !config.apiKey &&
    config.host !== "127.0.0.1" &&
    config.host !== "::1" &&
    config.host !== "localhost"
  ) {
    log.warn("bridge.no-auth-non-loopback", {
      host: config.host,
      message:
        "no --api-key-env set and host is not loopback — any reachable client can consume the account",
    });
  }
  // Bug-hunt G16: an explicit warning when extension auto-load is off.
  // The symptom (no worker connects) is otherwise hard to diagnose.
  if (config.fleetManualExtension === true) {
    log.warn("fleet.manual-extension", {
      message:
        "extension auto-load is disabled — each profile needs a one-time manual 'Load unpacked'",
    });
  }
  bridge.attachWorkerLink(server);

  server.listen(config.port, config.host, () => {
    log.info("bridge.listening", {
      host: config.host,
      port: config.port,
      stateful: config.stateful,
      mode: config.stateful ? "stateful" : "always-reset",
      ttl_ms: config.ttlMs,
      repair_rounds: config.repairRounds,
      auto_create_tabs: config.autoCreateTabs,
      managed_only: config.managedOnly,
      warm_tabs: config.warmTabs,
      db: config.dbPath,
      auth: config.apiKey ? "bearer" : "none",
      max_prompt_chars: config.maxPromptChars,
      max_concurrent_turns: config.maxConcurrentTurns,
      queue_capacity: config.queueCapacity,
      queue_timeout_ms: config.queueTimeoutMs,
      worker_link: `ws://${config.host}:${config.port}/worker`,
    });
    process.stdout.write(
      `tab-bridge listening on http://${config.host}:${config.port} (worker link: ws://${config.host}:${config.port}/worker)\n`
    );
  });

  const shutdown = async (signal: string) => {
    log.info("bridge.shutdown", { signal });
    // P5: await pending journal writes before dispose so a SIGTERM does not
    // drop the last turn's commit. Bounded by the watchdog below.
    try {
      await bridge.store.flush();
    } catch {
      /* best effort */
    }
    bridge.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Bug-hunt G1/G8: on an uncaught exception / unhandled rejection the
  // process would exit without disposing the bridge — leaving the fleet's
  // Chrome children orphaned. Route both into the same dispose path as a
  // signal, then exit non-zero.
  process.on("uncaughtException", (e) => {
    log.error("bridge.uncaught-exception", {
      message: e.message,
      stack: e.stack?.split("\n").slice(0, 6).join(" | "),
    });
    try {
      bridge.dispose();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("bridge.unhandled-rejection", { reason: String(reason) });
    try {
      bridge.dispose();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });

  server.on("error", (e) => {
    log.error("bridge.listen-error", { message: (e as Error).message });
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  });
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(1);
});
