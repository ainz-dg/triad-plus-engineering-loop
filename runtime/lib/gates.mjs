import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { redactAndCap, writeLog } from "./evidence.mjs";
import { describeCommandProvenance, runProcess } from "./process.mjs";

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "[]") return [];
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function unquoteWhole(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Supports the deliberately small, list-of-maps YAML contract used by quality-gates.yaml.
export function parseQualityGates(source) {
  try {
    const parsed = JSON.parse(source);
    return parsed.gates ?? [];
  } catch {}
  const gates = [];
  let current = null;
  let nested = null;
  let nestedIndent = -1;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "");
    const match = line.match(/^(\s*)(?:-\s+)?([a-z_][a-z0-9_]*):\s*(.*?)\s*$/i);
    if (!match) continue;
    const [, indentation, key, value] = match;
    const parsedValue = key === "command" || key === "description" ? unquoteWhole(value) : scalar(value);
    if (line.trimStart().startsWith("- ")) {
      if (current) gates.push(current);
      current = { [key]: parsedValue };
      nested = null;
      nestedIndent = -1;
    } else if (current && nested && indentation.length > nestedIndent) {
      nested[key] = key === "description" ? unquoteWhole(value) : scalar(value);
    } else if (current && value === "" && ["toolchain", "provenance"].includes(key)) {
      nested = {};
      current[key] = nested;
      nestedIndent = indentation.length;
    } else if (current) {
      current[key] = parsedValue;
      nested = null;
      nestedIndent = -1;
    }
  }
  if (current) gates.push(current);
  return gates;
}

export async function loadTrustedGates(gatesPath, expectedHash) {
  const source = await readFile(gatesPath, "utf8");
  const actualHash = createHash("sha256").update(source).digest("hex");
  if (!expectedHash || actualHash !== expectedHash) {
    return { valid: false, actualHash, gates: [] };
  }
  return { valid: true, actualHash, gates: parseQualityGates(source) };
}

function normalizeRequiredGateIds(requiredGateIds) {
  if (requiredGateIds === undefined) return [];
  if (!Array.isArray(requiredGateIds)) throw new Error("required_gate_ids must be an array");
  const seen = new Set();
  const normalized = [];
  for (const value of requiredGateIds) {
    if (typeof value !== "string" || !value.trim()) throw new Error("required_gate_ids must contain non-empty strings");
    const id = value.trim();
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}

function selectedGateIssues(gate) {
  if (!gate || typeof gate !== "object" || typeof gate.id !== "string" || !gate.id.trim()) return "invalid_definition";
  if (typeof gate.command !== "string" || !gate.command.trim() || /^REPLACE_ME/.test(gate.command.trim())) return "missing_trusted_command";
  if ((gate.executor ?? "control-plane") !== "control-plane") return "unsupported_executor";
  return null;
}

/**
 * Resolve the repository gate catalog and an optional card-level additive
 * selection. The returned gate objects are copies so a selected optional gate
 * can be promoted to required without mutating the trusted catalog.
 */
export function resolveGateSelection(gates, requiredGateIds = undefined) {
  if (!Array.isArray(gates)) throw new Error("trusted gates must be an array");
  const cardRequiredGateIds = normalizeRequiredGateIds(requiredGateIds);
  const selected = new Set(cardRequiredGateIds);
  const definitions = new Map();
  const duplicateGateIds = new Set();
  for (const gate of gates) {
    if (typeof gate?.id !== "string" || !gate.id.trim()) continue;
    const id = gate.id.trim();
    if (definitions.has(id)) duplicateGateIds.add(id);
    else definitions.set(id, gate);
  }

  const missingGateIds = cardRequiredGateIds.filter((id) => !definitions.has(id));
  const invalidGateIds = cardRequiredGateIds
    .filter((id) => definitions.has(id) && (duplicateGateIds.has(id) || selectedGateIssues(definitions.get(id))))
    .map((id) => ({ id, reason: duplicateGateIds.has(id) ? "duplicate_definition" : selectedGateIssues(definitions.get(id)) }));
  const baselineRequiredGateIds = [];
  const baselineRequired = new Set();
  for (const gate of gates) {
    const id = typeof gate?.id === "string" ? gate.id.trim() : "";
    if (id && gate.required !== false && !baselineRequired.has(id)) {
      baselineRequired.add(id);
      baselineRequiredGateIds.push(id);
    }
  }

  const mode = cardRequiredGateIds.length > 0 ? "selected" : "legacy";
  if (mode === "legacy") {
    return {
      mode,
      card_required_gate_ids: [],
      baseline_required_gate_ids: baselineRequiredGateIds,
      effective_gate_ids: gates.map((gate) => typeof gate?.id === "string" && gate.id.trim() ? gate.id.trim() : "unknown"),
      effective_required_gate_ids: baselineRequiredGateIds,
      missing_gate_ids: [],
      invalid_gate_ids: [],
      effective_gates: gates.map((gate) => ({ ...gate }))
    };
  }

  const effectiveGateIds = [];
  const effectiveRequiredGateIds = [];
  const effectiveGates = [];
  const emitted = new Set();
  for (const gate of gates) {
    const id = typeof gate?.id === "string" ? gate.id.trim() : "";
    if (!id || emitted.has(id)) continue;
    const isSelected = selected.has(id);
    const isGlobalRequired = gate.required !== false;
    if (mode === "selected" && !isGlobalRequired && !isSelected) continue;
    emitted.add(id);
    effectiveGateIds.push(id);
    if (isGlobalRequired || isSelected) effectiveRequiredGateIds.push(id);
    effectiveGates.push(isSelected ? { ...gate, required: true } : { ...gate });
  }
  for (const id of cardRequiredGateIds) {
    if (!effectiveGateIds.includes(id)) effectiveGateIds.push(id);
    if (!effectiveRequiredGateIds.includes(id)) effectiveRequiredGateIds.push(id);
  }

  return {
    mode,
    card_required_gate_ids: cardRequiredGateIds,
    baseline_required_gate_ids: baselineRequiredGateIds,
    effective_gate_ids: effectiveGateIds,
    effective_required_gate_ids: effectiveRequiredGateIds,
    missing_gate_ids: missingGateIds,
    invalid_gate_ids: invalidGateIds,
    effective_gates: effectiveGates
  };
}

export function gateSelectionEvidence(selection) {
  if (!selection) return null;
  return {
    mode: selection.mode,
    card_required_gate_ids: selection.card_required_gate_ids,
    baseline_required_gate_ids: selection.baseline_required_gate_ids,
    effective_gate_ids: selection.effective_gate_ids,
    effective_required_gate_ids: selection.effective_required_gate_ids,
    missing_gate_ids: selection.missing_gate_ids,
    invalid_gate_ids: selection.invalid_gate_ids
  };
}

export async function executeGates(gates, worktree, logDirectory) {
  const results = [];
  const prepared = [];
  // Resolve every declared toolchain before executing any gate. A bound gate
  // that no longer resolves to the approved executable must fail closed before
  // another gate can produce side effects.
  for (const gate of gates) {
    const required = gate.required !== false;
    const executor = gate.executor ?? "control-plane";
    if (executor !== "control-plane") {
      prepared.push({ gate, skip: { id: gate.id ?? "unknown", required, executor, status: "unsupported_executor", reason: `executor_${executor}_is_not_supported_in_v1` } });
      continue;
    }
    if (!gate.id || !gate.command || /^REPLACE_ME/.test(gate.command)) {
      prepared.push({ gate, skip: { id: gate.id ?? "unknown", required, executor, status: "invalid_gate", reason: "missing_trusted_command" } });
      continue;
    }
    const provenance = await describeCommandProvenance(gate.command, [], {
      cwd: worktree,
      shell: true,
      toolchain: gate.toolchain ?? gate.provenance
    });
    prepared.push({ gate, required, executor, provenance });
  }
  for (const entry of prepared) {
    if (entry.skip) {
      results.push(entry.skip);
      continue;
    }
    const { gate, required, executor, provenance } = entry;
    const startedAt = Date.now();
    const result = await runProcess(gate.command, [], { cwd: worktree, shell: true, timeoutMs: (gate.timeout_seconds ?? 600) * 1000 });
    const stdout = redactAndCap(result.stdout);
    const stderr = redactAndCap(result.stderr);
    const stdoutLog = await writeLog(logDirectory, gate.id, "stdout", result.stdout);
    const stderrLog = await writeLog(logDirectory, gate.id, "stderr", result.stderr);
    results.push({
      id: gate.id,
      required,
      executor,
      status: result.timedOut ? "timeout" : result.exitCode === 0 ? "pass" : "fail",
      exit_code: result.exitCode,
      duration_ms: Date.now() - startedAt,
      stdout_ref: stdoutLog.ref,
      stderr_ref: stderrLog.ref,
      output_truncated: stdout.truncated || stderr.truncated,
      provenance,
    });
  }
  return results;
}
