import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { startCockpitServer } from "./server.mjs";

// Foreground launcher behind `triad-plus cockpit`. It validates the control
// workspace, starts the loopback server, prints the one-time URL, and stops on
// SIGINT/SIGTERM. It starts no agent and performs no Triad+ transition.

function looksLikeControlWorkspace(root) {
  if (existsSync(path.join(root, ".triad-plus")) || existsSync(path.join(root, ".loop"))) return true;
  try {
    return readdirSync(path.join(root, "projects"), { withFileTypes: true })
      .some((entry) => entry.isDirectory() && existsSync(path.join(root, "projects", entry.name, ".loop")));
  } catch {
    return false;
  }
}

/** Validate inputs; returns `{ controlRoot, port }` or throws a user-facing Error. */
export function resolveCockpitOptions({ control, port }) {
  if (!control) throw new Error("Provide --control <project-control-path>.");
  const controlRoot = path.resolve(control);
  let info;
  try { info = statSync(controlRoot); } catch { throw new Error(`Control workspace does not exist: ${controlRoot}`); }
  if (!info.isDirectory()) throw new Error(`Control path is not a directory: ${controlRoot}`);
  if (!looksLikeControlWorkspace(controlRoot)) {
    throw new Error(`Not a Triad+ control workspace (no .triad-plus/, .loop/, or projects/<id>/.loop/): ${controlRoot}`);
  }
  let parsedPort = 0;
  if (port !== undefined) {
    parsedPort = Number(port);
    if (!/^\d+$/.test(String(port)) || !Number.isInteger(parsedPort) || parsedPort > 65535) throw new Error("--port must be an integer between 0 and 65535.");
  }
  return { controlRoot, port: parsedPort };
}

/**
 * Start the Cockpit and keep the process alive until a signal arrives.
 * Resolves with the started server (useful to tests); output goes to `out`.
 */
export async function launchCockpit({ control, port, out = process.stdout, err = process.stderr, handleSignals = true }) {
  const options = resolveCockpitOptions({ control, port });
  const started = await startCockpitServer({
    controlRoot: options.controlRoot,
    port: options.port,
    // Route template and status only: no query string, path, or secret.
    log: ({ method, route, status }) => err.write(`${method} ${route} ${status}\n`),
  });
  out.write(`Triad Cockpit (read-only) — ${options.controlRoot}\n`);
  out.write(`Listening on http://${started.address}:${started.port} (loopback only)\n`);
  if (!started.uiAvailable) out.write("Warning: UI assets are not built; only the JSON API is available.\n");
  // The URL carries a one-time login code, not the session secret. It is
  // printed once here and stops working after its first use.
  out.write(`Open this link once to start a session:\n  ${started.sessionUrl}\n`);
  out.write("Press Ctrl+C to stop.\n");
  if (handleSignals) {
    const stop = async () => {
      await started.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  return started;
}
