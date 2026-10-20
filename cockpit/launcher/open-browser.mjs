import { spawn } from "node:child_process";

/** Return whether automatically opening a browser is appropriate here. */
export function canAutoOpenBrowser({ noOpen = false, platform = process.platform, env = process.env, isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  if (noOpen || !isInteractive || env.TERM === "dumb") return false;
  if (env.CI && env.CI !== "0" && env.CI.toLowerCase() !== "false") return false;
  if (env.SSH_TTY || env.SSH_CLIENT || env.SSH_CONNECTION || env.CODESPACES) return false;
  if (platform === "darwin") return true;
  if (platform === "linux") return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  // Avoid shell-based openers on platforms for which this package has no
  // direct, argument-safe launcher.
  return false;
}

/**
 * Open the one-time URL only in a local interactive desktop. The URL is passed
 * as one argv item (never through a shell); opener errors never affect server
 * availability and are intentionally logged without the URL or error text.
 */
export function openSessionUrl(url, { noOpen = false, platform = process.platform, env = process.env, isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY), spawnImpl = spawn, err = process.stderr } = {}) {
  if (!canAutoOpenBrowser({ noOpen, platform, env, isInteractive })) return false;
  const command = platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawnImpl(command, [url], { detached: true, stdio: "ignore", windowsHide: true });
    let reportedFailure = false;
    const reportFailure = () => {
      if (reportedFailure) return;
      reportedFailure = true;
      err.write("Could not open a browser automatically; use the one-time URL printed above.\n");
    };
    child.once("error", reportFailure);
    child.once("close", (code) => { if (code !== 0) reportFailure(); });
    child.unref();
    return true;
  } catch {
    err.write("Could not start a browser opener; use the one-time URL printed above.\n");
    return false;
  }
}
