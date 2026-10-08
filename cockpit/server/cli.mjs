#!/usr/bin/env node

// Prototype launcher for the read-only Cockpit backend. It is not wired into
// bin/triad-plus.js: the final command name and packaging are open decisions.
//
//   node cockpit/server/cli.mjs --control <path> [--port <n>]

import path from "node:path";
import process from "node:process";
import { startCockpitServer } from "./server.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const control = option("--control");
if (!control) {
  process.stderr.write("Usage: node cockpit/server/cli.mjs --control <project-control-path> [--port <n>]\n");
  process.exit(2);
}
const port = option("--port") === undefined ? 0 : Number(option("--port"));

try {
  const started = await startCockpitServer({
    controlRoot: path.resolve(control),
    port,
    log: ({ method, route, status }) => process.stderr.write(`${method} ${route} ${status}\n`),
  });
  // The URL carries a one-time login code (not the session secret). It is
  // printed once to this terminal and stops working after its first use.
  process.stdout.write(`Triad Cockpit (read-only) listening on http://${started.address}:${started.port}\n`);
  process.stdout.write(`Open once to establish a session (single use): ${started.sessionUrl}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");
  const stop = async () => {
    await started.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  process.stderr.write(`Cockpit could not start: ${error.code ?? error.message}\n`);
  process.exit(1);
}
