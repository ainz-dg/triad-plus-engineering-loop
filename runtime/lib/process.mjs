import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";

const SHELL_SYNTAX = /[|&;<>$`(){}\[\]*?\\"'\n\r]/;
const SHA256 = /^[a-f0-9]{64}$/i;

function invalidProvenance(message) {
  const error = new Error(`gate toolchain binding invalid: ${message}`);
  error.code = "gate_toolchain_invalid";
  return error;
}

function executableToken(command, args, shell) {
  if (shell) {
    if (typeof command !== "string" || !command.trim() || SHELL_SYNTAX.test(command)) return null;
    const parts = command.trim().split(/\s+/);
    // Whitespace-separated argv without shell syntax is safe to identify for
    // provenance; the command is still executed by the existing shell path.
    return parts[0] || null;
  }
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

async function executableCandidate(token, cwd, env) {
  if (path.isAbsolute(token) || token.includes(path.sep)) {
    return path.resolve(cwd, token);
  }
  const searchPath = String(env?.PATH ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of searchPath) {
    const candidate = path.join(directory, token);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function versionSnapshot(executable, cwd, env) {
  // Version probing is best effort and never changes pass/fail for an unbound
  // legacy gate. It uses direct argv execution and a short bounded timeout.
  try {
    const result = spawnSync(executable, ["--version"], {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 8 * 1024
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const value = result.stdout.trim().split(/\r?\n/, 1)[0].slice(0, 500);
      return value || null;
    }
  } catch {}
  return null;
}

function validateToolchainBinding(binding) {
  if (binding === undefined || binding === null) return null;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw invalidProvenance("toolchain must be an object");
  const unknown = Object.keys(binding).filter((key) => !["executable", "sha256", "version"].includes(key));
  if (unknown.length > 0) throw invalidProvenance(`unknown toolchain fields: ${unknown.join(", ")}`);
  if (binding.executable !== undefined && (typeof binding.executable !== "string" || !path.isAbsolute(binding.executable))) {
    throw invalidProvenance("toolchain executable must be an absolute path");
  }
  if (binding.sha256 !== undefined && (typeof binding.sha256 !== "string" || !SHA256.test(binding.sha256))) {
    throw invalidProvenance("toolchain sha256 must be a SHA-256 hex string");
  }
  if (binding.version !== undefined && (typeof binding.version !== "string" || !binding.version.trim() || binding.version.length > 500)) {
    throw invalidProvenance("toolchain version must be a bounded string");
  }
  if (binding.executable === undefined && binding.sha256 === undefined && binding.version === undefined) {
    throw invalidProvenance("toolchain must bind executable, sha256, or version");
  }
  return binding;
}

/**
 * Describe the executable behind a declared command without interpreting shell
 * syntax. Composite shell commands are intentionally recorded as unresolved.
 */
export async function describeCommandProvenance(command, args = [], options = {}) {
  const { cwd = process.cwd(), shell = false, env = process.env, toolchain: rawToolchain } = options;
  const toolchain = validateToolchainBinding(rawToolchain);
  const token = executableToken(command, args, shell);
  const declared = { command, args, cwd, shell };
  if (!token) {
    if (toolchain) throw invalidProvenance("a toolchain binding requires a direct executable command");
    return { declared, provenance_status: "unresolved_shell_command", resolved_executable: null, sha256: null, version: null };
  }
  const candidate = await executableCandidate(token, cwd, env);
  if (!candidate) {
    const result = { declared, provenance_status: "unresolved_executable", resolved_executable: null, sha256: null, version: null };
    if (toolchain) {
      const error = invalidProvenance(`executable ${token} could not be resolved`);
      error.provenance = result;
      throw error;
    }
    return result;
  }
  const resolved = await realpath(candidate).catch(() => path.resolve(candidate));
  let hash = null;
  try { hash = createHash("sha256").update(await readFile(resolved)).digest("hex"); } catch {}
  const version = versionSnapshot(resolved, cwd, env);
  const result = { declared, provenance_status: toolchain ? "bound" : "unbound", resolved_executable: resolved, sha256: hash, version };
  if (toolchain) {
    const executableMatches = toolchain.executable === undefined || path.resolve(toolchain.executable) === resolved;
    const hashMatches = toolchain.sha256 === undefined || toolchain.sha256.toLowerCase() === hash;
    const versionMatches = toolchain.version === undefined || toolchain.version === version;
    if (!executableMatches || !hashMatches || !versionMatches) {
      const error = new Error(`gate toolchain binding mismatch for ${token}`);
      error.code = "gate_toolchain_mismatch";
      error.provenance = result;
      throw error;
    }
  }
  return result;
}

export function runProcess(command, args = [], options = {}) {
  const { cwd, timeoutMs = 600_000, shell = false, killGraceMs = 2_000, encoding = "utf8" } = options;
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd, shell, detached, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = encoding === null ? [] : "";
    let stderr = "";
    let timedOut = false;
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcess(child, "SIGTERM", detached);
      forceTimer = setTimeout(() => signalProcess(child, "SIGKILL", detached), killGraceMs);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (encoding === null) stdout.push(Buffer.from(chunk));
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += `${error.message}\n`; });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({ exitCode: exitCode ?? 1, signal, timedOut, stdout: encoding === null ? Buffer.concat(stdout) : stdout, stderr });
    });
  });
}

function signalProcess(child, signal, detached) {
  try {
    if (detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may have exited between the timeout and the escalation.
  }
}
