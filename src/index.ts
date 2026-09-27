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

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help" || !cmd) {
    process.stdout.write(usage() + "\n");
    process.exit(cmd ? 0 : 0);
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("tab-bridge 1.0.0\n");
    process.exit(0);
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
      worker_link: `ws://${config.host}:${config.port}/worker`,
    });
    process.stdout.write(
      `tab-bridge listening on http://${config.host}:${config.port} (worker link: ws://${config.host}:${config.port}/worker)\n`
    );
  });

  const shutdown = (signal: string) => {
    log.info("bridge.shutdown", { signal });
    bridge.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.on("error", (e) => {
    log.error("bridge.listen-error", { message: (e as Error).message });
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  });
}

main(process.argv.slice(2));
