#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomicJson } from "./lib/evidence.mjs";
import { calculateCandidateFingerprint, collectCandidateChanges, worktreeBranch } from "./lib/fingerprint.mjs";
import { executeGates, gateSelectionEvidence, loadTrustedGates, resolveGateSelection } from "./lib/gates.mjs";
import { resolveQualityContract } from "./lib/quality-baseline.mjs";
import { evaluateScopeContract, parseScopeContract } from "./lib/scope-contract.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? JSON.parse(input) : {};
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceFingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value : null;
}

async function sha256File(value) {
  return sha256(await readFile(value));
}

async function validateRepositorySkills(required, worktree) {
  if (required === undefined) return { declared: false, skills: [] };
  if (!Array.isArray(required) || required.length === 0) throw new Error("repository skill binding must declare at least one skill");
  const root = await realpath(worktree);
  const skills = [];
  for (const item of required) {
    if (!item || typeof item.path !== "string" || typeof item.sha256 !== "string") {
      throw new Error("repository skill binding entries require path and sha256");
    }
    const candidate = path.resolve(root, item.path);
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error("repository skill path escapes worktree");
    try { await access(candidate); }
    catch { throw new Error(`repository skill missing: ${item.path}`); }
    const actual = await sha256File(candidate);
    if (actual !== item.sha256) throw new Error(`repository skill hash mismatch: ${item.path}`);
    skills.push({ path: item.path, sha256: actual });
  }
  return { declared: true, skills };
}

function triggerFrom(payload) {
  return {
    event: payload.event ?? payload.hook_event_name ?? "manual",
    session_id: payload.session_id ?? payload.sessionId ?? null,
    agent_id: payload.agent_id ?? payload.agentId ?? payload?.agent?.id ?? null,
    agent_type: payload.agent_type ?? payload.agentType ?? payload?.agent?.type ?? null,
  };
}

async function resolveAssignment(projectRoot, trigger, explicitAssignment) {
  const assignmentPath = explicitAssignment
    ? path.resolve(explicitAssignment)
    : path.join(projectRoot, ".loop", "runtime", "assignments", `${trigger.agent_id}.json`);
  const source = await readFile(assignmentPath, "utf8");
  return { assignmentPath, assignment: JSON.parse(source), assignmentHash: sha256(source) };
}

async function buildInvalidEvidence({ runId, trigger, assignment, reason, outputPath, failureCode = "verification_context_invalid", gateSelection = null, qualityBaselineFingerprint = null }) {
  const evidence = {
    schema_version: 1,
    run_id: runId,
    feature_id: assignment?.feature_id ?? "unknown",
    attempt: assignment?.attempt ?? null,
    assignment_id: assignment?.assignment_id ?? null,
    assignment_sha256: null,
    trigger,
    baseline: {
      prd_sha256: assignment?.expected_prd_sha256 ?? null,
      card_sha256: assignment?.expected_card_sha256 ?? null,
      quality_baseline_fingerprint: evidenceFingerprint(qualityBaselineFingerprint ?? assignment?.expected_quality_baseline_fingerprint),
      git_head: null,
      candidate_fingerprint: null,
    },
    gates: [],
    required_gates_passed: false,
    status: "invalid_context",
    failure: { code: failureCode, reason },
    created_at: new Date().toISOString(),
  };
  if (gateSelection) evidence.gate_selection = gateSelectionEvidence(gateSelection);
  if (outputPath) await writeAtomicJson(outputPath, evidence);
  return evidence;
}

function withinRoot(root, candidate, label) {
  const resolved = path.resolve(root, candidate);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes project root`);
  return resolved;
}

async function scopePreflight(projectRoot, worktree, assignment) {
  const specification = assignment.scope_contract;
  if (specification === undefined) {
    const candidate = await collectCandidateChanges(worktree);
    return {
      configured: false,
      status: "not_configured",
      baseline: null,
      changed_paths: candidate.changes,
      ignored_paths: candidate.ignored_paths,
      offending_paths: []
    };
  }
  if (!specification || typeof specification !== "object") throw new Error("scope_contract must be an object when declared");
  if (typeof specification.path !== "string" || typeof specification.sha256 !== "string" || typeof specification.repository_id !== "string") {
    throw new Error("scope_contract requires path, sha256, and repository_id");
  }
  const baseline = specification.card_baseline;
  if (!baseline || baseline.initial_state !== "clean" || typeof baseline.git_head !== "string" || typeof baseline.repository_id !== "string") {
    throw new Error("scope_contract requires a clean card_baseline with repository_id and git_head");
  }
  if (baseline.repository_id !== specification.repository_id) throw new Error("scope contract repository does not match card baseline repository");
  const contractPath = withinRoot(projectRoot, specification.path, "scope contract");
  const source = await readFile(contractPath, "utf8");
  const actualHash = sha256(source);
  if (actualHash !== specification.sha256) throw new Error("scope contract hash mismatch");
  const contract = parseScopeContract(source);
  const candidate = await collectCandidateChanges(worktree, { baseCommit: baseline.git_head });
  const changes = candidate.changes.map((change) => ({ ...change, repository: specification.repository_id }));
  const result = evaluateScopeContract({ contract, repository: specification.repository_id, changes });
  return {
    ...result,
    contract_ref: path.relative(projectRoot, contractPath),
    contract_sha256: actualHash,
    baseline: { repository_id: baseline.repository_id, git_head: baseline.git_head },
    ignored_paths: candidate.ignored_paths
  };
}

async function main() {
  const payload = await readStdin();
  const trigger = triggerFrom(payload);
  const requestedRunId = payload.run_id ?? option("--run-id") ?? null;
  let runId = requestedRunId ?? randomUUID();
  const projectArgument = option("--project") ?? payload.project_root ?? process.cwd();
  const projectRoot = await realpath(projectArgument);
  let assignment;
  let assignmentPath;
  let outputPath;
  let gateSelection = null;
  let qualityBaseline = null;
  try {
    let assignmentHash;
    ({ assignmentPath, assignment, assignmentHash } = await resolveAssignment(projectRoot, trigger, option("--assignment")));
    if (assignment.verification_run_id && requestedRunId && assignment.verification_run_id !== requestedRunId) throw new Error("verification run ID does not match assignment");
    runId = assignment.verification_run_id ?? runId;
    const evidenceDirectory = assignment.evidence_directory
      ? path.resolve(projectRoot, assignment.evidence_directory)
      : path.join(projectRoot, ".loop", "evidence", assignment.feature_id, `attempt-${String(assignment.attempt).padStart(3, "0")}`);
    outputPath = path.join(evidenceDirectory, "verification.json");
    if (assignment.status !== "active") throw new Error("assignment is not active");
    if (!assignment.assignment_id) throw new Error("assignment ID is required");
    if (assignment.agent_id !== trigger.agent_id || assignment.agent_type !== "triad_developer") throw new Error("developer assignment does not match trigger");
    if ((await realpath(path.resolve(assignment.project_root ?? projectRoot))) !== projectRoot) throw new Error("assignment project root mismatch");
    const worktree = await realpath(path.resolve(projectRoot, assignment.worktree));
    if (!worktree.startsWith(`${projectRoot}${path.sep}`) && !assignment.allow_external_worktree) throw new Error("undeclared external worktree");
    const prdPath = path.resolve(projectRoot, assignment.prd_path ?? "artifacts/prd.md");
    const cardPath = path.resolve(projectRoot, assignment.card_path);
    await access(prdPath);
    await access(cardPath);
    // Resolve the optional immutable Quality Contract before any baseline or
    // expensive-gate check so a bound source drift keeps its precise failure
    // classification (including when the source is the PRD itself).
    qualityBaseline = await resolveQualityContract(assignment, projectRoot);
    if ((await sha256File(prdPath)) !== assignment.expected_prd_sha256) throw new Error("PRD baseline hash mismatch");
    if ((await sha256File(cardPath)) !== assignment.expected_card_sha256) throw new Error("feature card hash mismatch");
    const repositorySkills = await validateRepositorySkills(assignment.required_repository_skills, worktree);
    const before = await calculateCandidateFingerprint(worktree);
    const branch = await worktreeBranch(worktree);
    if (assignment.expected_branch && assignment.expected_branch !== branch) throw new Error("worktree branch does not match assignment");
    const gatesPath = path.resolve(projectRoot, assignment.gates_path ?? ".loop/quality-gates.yaml");
    const trusted = await loadTrustedGates(gatesPath, assignment.expected_gates_sha256);
    if (!trusted.valid) throw new Error("quality gates are missing or changed from their declared hash");
    try {
      gateSelection = resolveGateSelection(trusted.gates, assignment.required_gate_ids);
    } catch (error) {
      error.code = "unavailable_required_gate";
      throw error;
    }
    if (gateSelection.missing_gate_ids.length > 0 || gateSelection.invalid_gate_ids.length > 0) {
      const missing = gateSelection.missing_gate_ids.join(", ");
      const invalid = gateSelection.invalid_gate_ids.map(({ id, reason }) => `${id} (${reason})`).join(", ");
      const details = [missing && `missing: ${missing}`, invalid && `invalid: ${invalid}`].filter(Boolean).join("; ");
      const error = new Error(`unavailable_required_gate: ${details}`);
      error.code = "unavailable_required_gate";
      throw error;
    }
    const scope = await scopePreflight(projectRoot, worktree, assignment);
    if (scope.status === "fail") {
      const evidence = {
        schema_version: 1,
        run_id: runId,
        feature_id: assignment.feature_id,
        attempt: assignment.attempt,
        assignment_id: assignment.assignment_id,
        assignment_sha256: assignmentHash,
        trigger,
        assignment_ref: path.relative(projectRoot, assignmentPath),
        baseline: {
          prd_sha256: assignment.expected_prd_sha256,
          card_sha256: assignment.expected_card_sha256,
          quality_baseline_fingerprint: qualityBaseline?.fingerprint ?? null,
          gates_sha256: null,
          git_head: before.git_head,
          candidate_fingerprint: before.value,
          branch,
        },
        repository_skills: repositorySkills,
        scope,
        gates: [],
        gate_selection: gateSelectionEvidence(gateSelection),
        required_gates_passed: false,
        status: "fail",
        failure: { code: "candidate_scope_violation", reason: "candidate changed paths exceed the declared scope contract" },
        created_at: new Date().toISOString(),
      };
      await writeAtomicJson(outputPath, evidence);
      process.stdout.write(`${JSON.stringify({ run_id: runId, status: evidence.status, evidence: outputPath })}\n`);
      process.exitCode = 2;
      return;
    }
    const logDirectory = path.join(evidenceDirectory, "logs");
    const gates = await executeGates(gateSelection.effective_gates, worktree, logDirectory);
    const after = await calculateCandidateFingerprint(worktree);
    const candidateChanged = before.value !== after.value;
    const requiredGatesPassed = !candidateChanged && gates.filter((gate) => gate.required).every((gate) => gate.status === "pass");
    const evidence = {
      schema_version: 1,
      run_id: runId,
      feature_id: assignment.feature_id,
      attempt: assignment.attempt,
      assignment_id: assignment.assignment_id,
      assignment_sha256: assignmentHash,
      trigger,
      assignment_ref: path.relative(projectRoot, assignmentPath),
      baseline: {
          prd_sha256: assignment.expected_prd_sha256,
          card_sha256: assignment.expected_card_sha256,
          quality_baseline_fingerprint: qualityBaseline?.fingerprint ?? null,
          gates_sha256: trusted.actualHash,
        git_head: before.git_head,
        candidate_fingerprint: before.value,
        branch,
      },
      repository_skills: repositorySkills,
      scope,
      gate_selection: gateSelectionEvidence(gateSelection),
      gates,
      required_gates_passed: requiredGatesPassed,
      status: candidateChanged ? "invalidated" : requiredGatesPassed ? "pass" : "fail",
      failure: candidateChanged ? { code: "candidate_changed_after_verification", reason: "worktree changed while gates ran" } : null,
      created_at: new Date().toISOString(),
    };
    await writeAtomicJson(outputPath, evidence);
    process.stdout.write(`${JSON.stringify({ run_id: runId, status: evidence.status, evidence: outputPath })}\n`);
    process.exitCode = evidence.status === "pass" ? 0 : 2;
  } catch (error) {
    const fallbackAssignment = assignment ?? null;
    if (!outputPath && fallbackAssignment?.feature_id) {
      const directory = path.join(projectRoot, ".loop", "evidence", fallbackAssignment.feature_id, `attempt-${String(fallbackAssignment.attempt).padStart(3, "0")}`);
      outputPath = path.join(directory, "verification.json");
    }
    const evidence = await buildInvalidEvidence({
      runId,
      trigger,
      assignment: fallbackAssignment,
      reason: error.message,
      outputPath,
      failureCode: error.code ?? "verification_context_invalid",
      gateSelection,
      qualityBaselineFingerprint: qualityBaseline?.fingerprint ?? null
    });
    process.stdout.write(`${JSON.stringify({ run_id: runId, status: evidence.status, evidence: outputPath ?? null })}\n`);
    process.exitCode = 3;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
