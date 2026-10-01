#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};

function versionParts(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, minimum) {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  if (!a || !b) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] > b[index]) return true;
    if (a[index] < b[index]) return false;
  }
  return true;
}

function expandHome(candidate) {
  return candidate.startsWith("~/") ? path.join(process.env.HOME ?? "", candidate.slice(2)) : candidate;
}

function resolveExecutable(candidate) {
  const expanded = expandHome(candidate);
  const candidates = path.isAbsolute(expanded) || expanded.includes(path.sep)
    ? [path.resolve(expanded)]
    : String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, expanded));
  for (const pathname of candidates) {
    try {
      if (statSync(pathname).isFile() && (statSync(pathname).mode & fsConstants.S_IXUSR)) return realpathSync(pathname);
    } catch {}
  }
  return null;
}

function executableHash(pathname) {
  if (!pathname) return null;
  try { return createHash("sha256").update(readFileSync(pathname)).digest("hex"); } catch { return null; }
}

function commandVersion(binary, overriddenOutput) {
  const candidates = Array.isArray(binary) ? binary : [binary];
  for (const candidate of candidates) {
    const expanded = expandHome(candidate);
    const resolvedPath = resolveExecutable(expanded);
    const executable = resolvedPath ?? expanded;
    const result = overriddenOutput ? { status: 0, stdout: overriddenOutput } : spawnSync(executable, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return { binary: expanded, version: versionParts(result.stdout)?.join(".") ?? null, resolved_path: resolvedPath, sha256: executableHash(resolvedPath) };
  }
  const expanded = expandHome(candidates[0]);
  const resolvedPath = resolveExecutable(expanded);
  return { binary: expanded, version: null, resolved_path: resolvedPath, sha256: executableHash(resolvedPath) };
}

function validHookRule(rule, lifecycle) {
  if (!rule || typeof rule !== "object") return false;
  let matcher;
  try {
    matcher = new RegExp(rule.matcher ?? "");
  } catch {
    return false;
  }
  if (!matcher.test(lifecycle.agent_type)) return false;
  const hooks = Array.isArray(rule.hooks) ? rule.hooks : [];
  return hooks.some((hook) => {
    const command = String(hook?.command ?? "");
    return hook?.type === "command" &&
      !command.includes("<TRIAD_") &&
      command.includes("triad-verify.mjs") &&
      command.includes("--project") &&
      (!lifecycle.requires_async || hook.async === true);
  });
}

async function loadAdapter() {
  const adapterPath = option("--adapter");
  if (adapterPath) return JSON.parse(await readFile(path.resolve(adapterPath), "utf8"));
  const adapters = JSON.parse(await readFile(new URL("./legacy-adapters.json", import.meta.url), "utf8"));
  const id = option("--host") ?? "codex";
  const adapter = adapters[id];
  if (!adapter) throw new Error(`unsupported adapter: ${id}`);
  return adapter;
}

async function hookConfiguration(pathname, lifecycle) {
  if (!lifecycle) return { configured: false, reason: "adapter_has_no_lifecycle_hook", minimum: null };
  if (!pathname) return { configured: false, reason: "hook_configuration_not_declared", minimum: lifecycle.minimum_version ?? null };
  try {
    const source = await readFile(pathname, "utf8");
    const parsed = JSON.parse(source);
    const rules = parsed?.hooks?.[lifecycle.kind];
    if (!Array.isArray(rules) || !rules.some((rule) => validHookRule(rule, lifecycle))) {
      return { configured: false, reason: "hook_configuration_has_no_usable_triad_rule", minimum: parsed.minimum_version ?? parsed.minimum_codex_cli_version ?? lifecycle.minimum_version ?? null };
    }
    return { configured: true, reason: null, minimum: parsed.minimum_version ?? parsed.minimum_codex_cli_version ?? lifecycle.minimum_version ?? null };
  } catch (error) {
    return { configured: false, reason: `hook_configuration_unreadable:${error.code ?? "error"}`, minimum: lifecycle.minimum_version ?? null };
  }
}

const requestedMode = option("--requested-mode") ?? "auto";
const versionOutput = option("--version-output");
const adapter = await loadAdapter();
if (adapter?.schema_version !== 1 || typeof adapter.id !== "string" || typeof adapter.binary !== "string") {
  throw new Error("adapter metadata must contain schema_version 1, id, and binary");
}
const lifecycle = adapter.lifecycle ?? null;
const hostRuntime = commandVersion(option("--host-bin") ?? adapter.binary_candidates ?? adapter.binary, versionOutput);
const hostBinary = hostRuntime.binary;
const hostVersion = hostRuntime.version;
const nodeBinary = option("--node-bin") ?? "node";
const nodeRuntime = commandVersion(nodeBinary);
const nodeVersion = nodeRuntime.version;
const hook = await hookConfiguration(option("--hook-config"), lifecycle);
const lifecycleAvailable = Boolean(lifecycle && hostVersion && (!hook.minimum || atLeast(hostVersion, hook.minimum)));
const hookAvailable = lifecycleAvailable && hook.configured;
const explicitAvailable = Boolean(hostVersion && nodeVersion);
let selectedMode = "unavailable";
let reason = "verification_runtime_unavailable";
const defaultMode = adapter.verification?.default_mode ?? null;
const experimentalModes = new Set(adapter.verification?.experimental_modes ?? []);
const experimentalHookRequested = requestedMode === "async_hook" && experimentalModes.has("async_hook");

// An adapter may declare a safer automatic mode. This keeps runtime policy in
// adapter metadata instead of adding host-specific branches to the Core.
if (requestedMode === "auto" && defaultMode) {
  if (defaultMode === "explicit_dispatch" && explicitAvailable) {
    selectedMode = "explicit_dispatch";
    reason = `${adapter.id}_default_explicit_dispatch`;
  } else if (defaultMode === "async_hook" && hookAvailable) {
    selectedMode = "async_hook";
    reason = `${adapter.id}_default_async_hook`;
  } else if (defaultMode === "hook_dispatch" && hookAvailable) {
    selectedMode = "hook_dispatch";
    reason = `${adapter.id}_default_hook_dispatch`;
  } else if (explicitAvailable) {
    selectedMode = "explicit_dispatch";
    reason = `${adapter.id}_default_${defaultMode}_unavailable_using_explicit_dispatch`;
  }
} else if (experimentalHookRequested && hookAvailable) {
  selectedMode = "async_hook";
  reason = "experimental_async_hook_requested";
} else if (experimentalHookRequested && explicitAvailable) {
  selectedMode = "explicit_dispatch";
  reason = "requested_async_hook_unavailable_using_explicit_dispatch";
} else if (hookAvailable && (requestedMode === "auto" || requestedMode === "async_hook" || requestedMode === "hook_dispatch") && (!lifecycle?.requires_async || requestedMode === "async_hook")) {
  selectedMode = lifecycle.requires_async ? "async_hook" : "hook_dispatch";
  reason = lifecycle.requires_async ? "validated_async_hook_available" : "validated_hook_dispatch_available";
} else if (explicitAvailable) {
  selectedMode = "explicit_dispatch";
  reason = requestedMode === "explicit_dispatch"
    ? "explicit_dispatch_requested"
    : ["async_hook", "hook_dispatch"].includes(requestedMode)
    ? "requested_hook_unavailable_using_explicit_dispatch"
    : "explicit_dispatch_available";
}

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  detected_at: new Date().toISOString(),
  host: adapter.id,
  host_runtime: { binary: hostBinary, version: hostVersion, resolved_path: hostRuntime.resolved_path, sha256: hostRuntime.sha256, available: Boolean(hostVersion) },
  verifier_runtime: { binary: nodeBinary, version: nodeVersion, resolved_path: nodeRuntime.resolved_path, sha256: nodeRuntime.sha256, available: Boolean(nodeVersion) },
  lifecycle_async: {
    kind: lifecycle?.kind ?? null,
    minimum_version: hook.minimum,
    available: lifecycleAvailable,
    configured: hook.configured,
    reason: hook.reason
  },
  verification: { requested_mode: requestedMode, selected_mode: selectedMode, reason }
}, null, 2)}\n`);
