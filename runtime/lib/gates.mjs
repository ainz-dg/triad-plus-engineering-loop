import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

/** Structure-only lint for the existing JSON / list-of-maps YAML contract.
 * Does not resolve executables, probe versions, invoke a shell or run any gate.
 */
export function lintQualityGateSource(source) {
  const issues = [];
  let gates;
  try {
    const document = JSON.parse(source);
    if (!document || typeof document !== 'object' || Array.isArray(document)
      || document.active === false || !Array.isArray(document.gates)) {
      return { valid: false, executed: false, gate_count: 0, issues: ['Expected an active gate catalog, not a proposal or another JSON document.'] };
    }
    if (document.version !== undefined && ![1, 2].includes(document.version)) issues.push('Unsupported gate catalog version.');
    gates = document.gates;
  } catch {
    const rootFields = new Set();
    let entryFields = new Set();
    let entryIndent = null;
    const parents = [];
    for (const raw of String(source).split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, '');
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = line.match(/^( *)(-\s+)?([a-z_][a-z0-9_]*):\s*(.*?)\s*$/i);
      if (!match || raw.includes('\t')) { issues.push('Unsupported YAML syntax; use the documented list-of-maps format or JSON.'); break; }
      const [, spaces, item, key, value] = match;
      const indent = spaces.length;
      if (!indent && !['version', 'gates'].includes(key)) { issues.push('Unsupported root YAML field.'); break; }
      if (!indent && key === 'version' && !['1', '2'].includes(value)) issues.push('Unsupported gate catalog version.');
      if (!indent && key === 'gates' && value !== '' && value !== '[]') issues.push('gates must be a list.');
      if (item) {
        if (!indent || !rootFields.has('gates') || (entryIndent !== null && indent !== entryIndent)) issues.push('Malformed YAML gate list indentation.');
        entryIndent = indent;
        entryFields = new Set(); parents.length = 0;
      }
      while (parents.length && parents.at(-1).indent >= indent) parents.pop();
      if (!item && indent && (entryIndent === null || indent <= entryIndent || (!parents.length && indent !== entryIndent + 2))) issues.push('Malformed YAML gate field indentation.');
      const field = [...parents.map((parent) => parent.key), key].join('.');
      const seen = indent ? entryFields : rootFields;
      if (seen.has(field)) { issues.push('Duplicate YAML field.'); break; }
      seen.add(field);
      if (/^[>|][-+]?\s*$/.test(value) || /^[&*!]/.test(value)) { issues.push('YAML blocks, tags and aliases are unsupported; use a scalar command.'); break; }
      if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'"))) issues.push('Unterminated YAML scalar.');
      if (!value && key !== 'gates') parents.push({ indent, key });
    }
    if (!rootFields.has('gates')) issues.push('Missing gates list.');
    gates = parseQualityGates(String(source));
  }
  if (!gates.length) issues.push('At least one gate is required; commands must be explicitly configured.');
  const ids = new Set();
  gates.forEach((gate, index) => {
    const label = `Gate ${index + 1}`;
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) { issues.push(`${label}: invalid definition.`); return; }
    if (typeof gate.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gate.id) || ids.has(gate.id)) issues.push(`${label}: missing, unsafe or duplicate ID.`);
    ids.add(gate.id);
    if (typeof gate.command !== 'string' || !gate.command.trim() || /REPLACE_ME/.test(gate.command)
      || /[\u0000-\u001f\u007f]/.test(gate.command) || gate.command.length > 8192) issues.push(`${label}: missing, placeholder or malformed command.`);
    if ((gate.executor ?? 'control-plane') !== 'control-plane') issues.push(`${label}: executor must be control-plane.`);
    if (gate.required !== undefined && typeof gate.required !== 'boolean') issues.push(`${label}: required must be boolean.`);
    if (gate.timeout_seconds !== undefined && (!Number.isInteger(gate.timeout_seconds) || gate.timeout_seconds < 1 || gate.timeout_seconds > 3600)) issues.push(`${label}: timeout_seconds must be 1..3600 (default 600).`);
    for (const key of ['toolchain', 'provenance']) {
      const binding = gate[key];
      if (binding === undefined) continue;
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)
        || Object.keys(binding).length === 0 || Object.keys(binding).some((field) => !['executable', 'sha256', 'version'].includes(field))
        || (binding.executable !== undefined && (typeof binding.executable !== 'string' || !path.isAbsolute(binding.executable)))
        || (binding.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(binding.sha256))
        || (binding.version !== undefined && (typeof binding.version !== 'string' || !binding.version.trim() || binding.version.length > 500))) {
        issues.push(`${label}: invalid toolchain binding (identity is not probed by lint).`);
      }
    }
  });
  return { valid: issues.length === 0, executed: false, gate_count: gates.length, issues: [...new Set(issues)] };
}

export async function loadTrustedGates(gatesPath, expectedHash) {
  const source = await readFile(gatesPath, "utf8");
  const actualHash = createHash("sha256").update(source).digest("hex");
  if (!expectedHash || actualHash !== expectedHash) {
    return { valid: false, actualHash, gates: [] };
  }
  // A correctly hashed proposal is still not an approved verifier catalog.
  let document;
  try { document = JSON.parse(source); } catch {}
  if (document?.active === false || document?.discovery === 'manifest-read-only') {
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
