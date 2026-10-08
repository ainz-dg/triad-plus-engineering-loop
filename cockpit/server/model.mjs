import { validateAssignmentPacket } from "../../runtime/lib/assignment-packet.mjs";
import { validateInstallationManifest } from "../../runtime/lib/installation-manifest.mjs";
import { validateTeamConfiguration } from "../../runtime/lib/model-config.mjs";
import { validateReviewerResult } from "../../runtime/lib/reviewer-result.mjs";
import { validateEvaluatorResult } from "../../runtime/triad-evaluator-validate.mjs";
import { AccessError, normalizeRelative } from "./safe-fs.mjs";
import { parseWorkQueueItems } from "./work-queue.mjs";

// Provenance vocabulary. Every value the API returns is tagged with one of
// these so a client can never present an agent declaration as a fact.
export const PROVENANCE = Object.freeze({
  // Written by Triad+ runtime code (verifier, packet writer, installer, driver).
  code: "code-written",
  // Written by an agent but accepted by an existing Core validator.
  validated: "code-validated",
  // Written by an agent with no Core validation (YAML, Markdown, assignments).
  declared: "agent-declared",
  // Computed by the Cockpit from the artifacts above.
  derived: "cockpit-derived",
});

const VERIFICATION_STATUSES = new Set(["pass", "fail", "invalid_context", "infrastructure_error", "invalidated"]);
const CONTROL_RUN_PATH = ".loop/runtime/deterministic-control-run.json";

function sanitizeError(error) {
  // Core validators return contract messages; filesystem errors may carry
  // absolute paths, so only a code survives for those.
  if (error instanceof AccessError) return error.message;
  if (error?.code && /^[a-z_]+$/.test(error.code) && typeof error.message === "string" && !error.message.includes("/")) return error.message;
  if (error?.code) return error.code;
  return "validation failed";
}

async function safeJson(reader, base, relative) {
  try { return await reader.readJson(base, relative); }
  catch (error) {
    if (error instanceof AccessError) return { status: "refused", path: String(relative), error: error.message };
    throw error;
  }
}

async function safeText(reader, base, relative, options) {
  try { return await reader.readText(base, relative, options); }
  catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

function normalizedOrNull(value) {
  try { return normalizeRelative(value); } catch { return null; }
}

function projectFile(project, relative) {
  return project.base ? `${project.base}/${relative}` : relative;
}

// ---------------------------------------------------------------------------
// Discovery

/** Projects are the control root and/or projects/<id> directories with a .loop. */
export async function discoverProjects(reader) {
  const projects = [];
  if (await reader.isDirectory("", ".loop")) projects.push({ id: "root", base: "", layout: "control-root" });
  for (const name of await reader.listProjectDirectories()) {
    const base = `projects/${name}`;
    if (await reader.isDirectory(base, ".loop")) projects.push({ id: name === "root" ? "projects-root" : name, base, layout: "projects-directory" });
  }
  return projects;
}

// ---------------------------------------------------------------------------
// Workspace overview

async function installation(reader) {
  const loaded = await safeJson(reader, "", ".triad-plus/installation.json");
  if (loaded.status === "missing") {
    return { status: "missing", provenance: PROVENANCE.code, source: loaded.path, note: "no installation manifest (legacy or uninitialized workspace)" };
  }
  if (loaded.status !== "ok") return { status: "invalid", provenance: PROVENANCE.code, source: loaded.path, error: loaded.error };
  try {
    const manifest = validateInstallationManifest(loaded.value);
    return {
      status: "valid",
      provenance: PROVENANCE.code,
      source: loaded.path,
      triad_version: manifest.triad_version,
      adapter: manifest.adapter,
      installation_status: manifest.status,
      scope_status: manifest.scope_status,
      installed_at: manifest.installed_at,
      updated_at: manifest.updated_at,
      managed_asset_count: manifest.managed_assets.length,
    };
  } catch (error) {
    return { status: "invalid", provenance: PROVENANCE.code, source: loaded.path, error: sanitizeError(error) };
  }
}

async function team(reader) {
  const loaded = await safeJson(reader, "", ".triad-plus/team.json");
  if (loaded.status === "missing") return { status: "missing", provenance: PROVENANCE.validated, source: loaded.path };
  if (loaded.status !== "ok") return { status: "invalid", provenance: PROVENANCE.validated, source: loaded.path, error: loaded.error };
  try {
    const value = validateTeamConfiguration(loaded.value);
    const roles = Object.entries(value.roles).map(([id, role]) => ({
      id,
      display_name: role.displayName,
      model: role.model ?? null,
      reasoning_effort: role.reasoning_effort ?? null,
      enabled: role.enabled !== false,
    }));
    return {
      status: "valid",
      provenance: PROVENANCE.validated,
      source: loaded.path,
      note: "desired configuration; the model actually used by a host session is not observable here",
      language: value.interaction?.language ?? null,
      roles,
    };
  } catch (error) {
    return { status: "invalid", provenance: PROVENANCE.validated, source: loaded.path, error: sanitizeError(error) };
  }
}

export async function readWorkspace(reader, { cockpitVersion }) {
  const projects = await discoverProjects(reader);
  return {
    cockpit: { version: cockpitVersion, read_only: true },
    installation: await installation(reader),
    team: await team(reader),
    projects: projects.map((project) => ({ id: project.id, base: project.base || ".", layout: project.layout })),
    limits: [
      "Run liveness is not recorded by Triad+; no endpoint reports whether a role is currently running.",
      "Card states come from agent-written YAML and are reported as declarations, not facts.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Artifact collection for one project

async function collectAssignments(reader, project, diagnostics) {
  const assignments = [];
  for (const entry of await reader.list(project.base, ".loop/runtime/assignments")) {
    if (!entry.file || !entry.name.endsWith(".json") || entry.name.endsWith(".template.json")) continue;
    const relative = `.loop/runtime/assignments/${entry.name}`;
    const loaded = await safeJson(reader, project.base, relative);
    if (loaded.status !== "ok") {
      diagnostics.push({ source: projectFile(project, relative), problem: loaded.error ?? loaded.status });
      continue;
    }
    const value = loaded.value;
    if (!value || typeof value !== "object" || typeof value.feature_id !== "string" || !Number.isInteger(value.attempt)) {
      diagnostics.push({ source: projectFile(project, relative), problem: "assignment has no string feature_id and integer attempt" });
      continue;
    }
    assignments.push({ relative, sha256: loaded.sha256, value });
  }
  return assignments;
}

async function collectVerifications(reader, project, assignments, diagnostics) {
  const candidates = new Set();
  for (const feature of await reader.list(project.base, ".loop/evidence")) {
    if (!feature.directory) continue;
    for (const attempt of await reader.list(project.base, `.loop/evidence/${feature.name}`)) {
      if (attempt.directory) candidates.add(`.loop/evidence/${feature.name}/${attempt.name}`);
    }
  }
  // Assignments may bind a non-default evidence directory.
  for (const assignment of assignments) {
    const declared = normalizedOrNull(assignment.value.evidence_directory);
    if (declared) candidates.add(declared);
  }
  const verifications = [];
  for (const directory of [...candidates].sort()) {
    const relative = `${directory}/verification.json`;
    const loaded = await safeJson(reader, project.base, relative);
    if (loaded.status === "missing") continue;
    if (loaded.status !== "ok") {
      verifications.push({ relative, directory, status: "unreadable", error: loaded.error ?? loaded.status });
      continue;
    }
    const value = loaded.value;
    if (!value || typeof value !== "object" || typeof value.feature_id !== "string" || !VERIFICATION_STATUSES.has(value.status)) {
      verifications.push({ relative, directory, status: "unreadable", error: "verification evidence does not match the verifier contract" });
      continue;
    }
    verifications.push({ relative, directory, status: "ok", value });
  }
  for (const verification of verifications) {
    if (verification.status === "unreadable") diagnostics.push({ source: projectFile(project, verification.relative), problem: verification.error });
  }
  return verifications;
}

async function collectEvaluations(reader, project) {
  const evaluations = [];
  for (const entry of await reader.list(project.base, "artifacts/evaluator-plus")) {
    if (!entry.file || !entry.name.endsWith(".json")) continue;
    const relative = `artifacts/evaluator-plus/${entry.name}`;
    const loaded = await safeJson(reader, project.base, relative);
    evaluations.push({ relative, loaded });
  }
  return evaluations;
}

async function readWorkQueue(reader, project) {
  const relative = ".loop/work-queue.yaml";
  const text = await safeText(reader, project.base, relative);
  if (!text) return { status: "missing", source: projectFile(project, relative), items: [], warnings: [] };
  if (text.truncated) return { status: "invalid", source: projectFile(project, relative), items: [], warnings: ["work queue exceeds the size bound"] };
  const parsed = parseWorkQueueItems(text.text);
  const status = parsed.unreadable ? "unreadable" : parsed.warnings.length ? "partial" : "ok";
  return { status, source: projectFile(project, relative), sha256: text.sha256, items: parsed.items, warnings: parsed.warnings };
}

async function collectProject(reader, project) {
  const diagnostics = [];
  const assignments = await collectAssignments(reader, project, diagnostics);
  const verifications = await collectVerifications(reader, project, assignments, diagnostics);
  const evaluations = await collectEvaluations(reader, project);
  const workQueue = await readWorkQueue(reader, project);
  return { diagnostics, assignments, verifications, evaluations, workQueue };
}

// ---------------------------------------------------------------------------
// Freshness of verifier evidence

async function fileHash(reader, project, declared) {
  const relative = normalizedOrNull(declared);
  if (!relative) return { status: "unavailable" };
  let text;
  try { text = await reader.readText(project.base, relative, { maxBytes: 64 * 1024 * 1024 }); }
  catch (error) {
    if (error instanceof AccessError) return { status: "outside_allowlist" };
    throw error;
  }
  if (!text) return { status: "missing" };
  if (text.truncated) return { status: "too_large" };
  return { status: "ok", sha256: text.sha256 };
}

/**
 * Describe one verification along three independent axes so no single word
 * can be read as "the candidate was re-verified":
 * - control_bindings: do the control-workspace files the verifier hashed
 *   (assignment, card, PRD, gates) still have those hashes?
 * - recency: is this the newest verification recorded for the card?
 * - candidate: never checked; the product worktree is not inspected.
 */
async function freshness(reader, project, verification, assignment, newerExists) {
  const checks = [];
  const evidence = verification.value;
  const compare = async (name, declaredPath, expected) => {
    if (!expected) {
      checks.push({ check: name, result: "not_recorded" });
      return;
    }
    const observed = await fileHash(reader, project, declaredPath);
    if (observed.status !== "ok") checks.push({ check: name, result: observed.status });
    else checks.push({ check: name, result: observed.sha256 === String(expected).toLowerCase() ? "match" : "mismatch" });
  };
  await compare("assignment_sha256", evidence.assignment_ref, evidence.assignment_sha256);
  await compare("card_sha256", assignment?.value.card_path, evidence.baseline?.card_sha256);
  await compare("prd_sha256", assignment?.value.prd_path, evidence.baseline?.prd_sha256);
  await compare("gates_sha256", assignment?.value.gates_path, evidence.baseline?.gates_sha256);

  let bindings = "unchanged";
  if (checks.some((check) => check.result === "mismatch")) bindings = "changed";
  else if (checks.some((check) => check.result !== "match")) bindings = "unverifiable";
  return {
    provenance: PROVENANCE.derived,
    control_bindings: { status: bindings, checks },
    recency: { status: newerExists ? "superseded" : "latest_for_card" },
    candidate: {
      status: "not_checked",
      recorded_fingerprint: evidence.baseline?.candidate_fingerprint ?? null,
      reason: "the product worktree is not inspected; whether the current candidate still matches this evidence is unknown",
    },
  };
}

function gateView(verification, gate) {
  const logRef = (ref) => {
    if (typeof ref !== "string") return null;
    const relative = normalizedOrNull(`${verification.directory}/${ref}`);
    return relative;
  };
  return {
    id: gate.id ?? null,
    required: gate.required === true,
    status: gate.status ?? null,
    exit_code: gate.exit_code ?? null,
    duration_ms: gate.duration_ms ?? null,
    output_truncated: gate.output_truncated === true,
    stdout_log: logRef(gate.stdout_ref),
    stderr_log: logRef(gate.stderr_ref),
  };
}

async function verificationView(reader, project, verification, assignment, newerExists) {
  if (verification.status !== "ok") {
    return { source: projectFile(project, verification.relative), provenance: PROVENANCE.code, status: "unreadable", error: verification.error };
  }
  const value = verification.value;
  return {
    source: projectFile(project, verification.relative),
    provenance: PROVENANCE.code,
    status: value.status,
    run_id: value.run_id ?? null,
    assignment_id: value.assignment_id ?? null,
    attempt: Number.isInteger(value.attempt) ? value.attempt : null,
    created_at: value.created_at ?? null,
    required_gates_passed: value.required_gates_passed === true,
    failure: value.failure ?? null,
    candidate_fingerprint: value.baseline?.candidate_fingerprint ?? null,
    git_head: value.baseline?.git_head ?? null,
    branch: value.baseline?.branch ?? null,
    scope_status: value.scope?.status ?? null,
    gates: Array.isArray(value.gates) ? value.gates.map((gate) => gateView(verification, gate)) : [],
    freshness: await freshness(reader, project, verification, assignment, newerExists),
  };
}

async function packetView(reader, project, assignment) {
  const declared = assignment.value.assignment_packet_path;
  if (!declared && !assignment.value.assignment_packet_sha256) return { status: "not_bound", provenance: PROVENANCE.derived };
  const relative = normalizedOrNull(declared);
  try {
    // Confine the declared path before the Core validator reads it.
    if (!relative || !(await reader.readBytes(project.base, relative, { maxBytes: 1 }))) {
      return { status: "missing", provenance: PROVENANCE.code, source: relative ? projectFile(project, relative) : null };
    }
    const validated = await validateAssignmentPacket(assignment.value, `${reader.root}/${project.base}`);
    return {
      status: "valid",
      provenance: PROVENANCE.code,
      source: projectFile(project, validated.path),
      sha256: validated.sha256,
      branch: validated.metadata.branch ?? null,
      required_gate_ids: validated.metadata.required_gate_ids ?? [],
      mandatory_skills: (validated.metadata.mandatory_skills ?? []).map((skill) => skill.path),
    };
  } catch (error) {
    return { status: "invalid", provenance: PROVENANCE.code, source: projectFile(project, relative), error: sanitizeError(error) };
  }
}

function attemptDocuments(attemptEntries, verification) {
  return attemptEntries
    .filter((entry) => entry.file && entry.name !== "verification.json" && !entry.name.endsWith(".tmp"))
    .map((entry) => ({ source: `${verification.directory}/${entry.name}`, provenance: PROVENANCE.declared }));
}

// ---------------------------------------------------------------------------
// Cards

// Cards come from the queue, assignments, and verifier evidence. Evaluator+
// results never create a card: agents may label them with composite IDs.
function cardIds(collected) {
  const ids = new Set();
  for (const item of collected.workQueue.items) ids.add(item.id);
  for (const assignment of collected.assignments) ids.add(assignment.value.feature_id);
  for (const verification of collected.verifications) if (verification.status === "ok") ids.add(verification.value.feature_id);
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function unmatchedEvaluations(collected, project, ids) {
  return collected.evaluations
    .filter((evaluation) => !(evaluation.loaded.status === "ok" && ids.includes(evaluation.loaded.value?.feature_id)))
    .map((evaluation) => ({
      source: projectFile(project, evaluation.relative),
      provenance: PROVENANCE.declared,
      feature_id: evaluation.loaded.status === "ok" && typeof evaluation.loaded.value?.feature_id === "string" ? evaluation.loaded.value.feature_id : null,
      readable: evaluation.loaded.status === "ok",
    }));
}

function declaredCount(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value ?? null;
}

function declaredCard(collected, id) {
  const item = collected.workQueue.items.find((entry) => entry.id === id);
  if (!item) {
    // Absence is only meaningful when the whole queue was read.
    const complete = collected.workQueue.status === "ok";
    return {
      status: complete ? "not_declared" : "not_determinable",
      provenance: PROVENANCE.declared,
      source: collected.workQueue.source,
      ...(complete ? {} : { reason: `work queue is ${collected.workQueue.status}` }),
    };
  }
  return {
    status: "declared",
    provenance: PROVENANCE.declared,
    source: `${collected.workQueue.source}#L${item.source_line}`,
    title: item.title ?? null,
    state: item.state ?? null,
    attempts: declaredCount(item.attempts),
    // Returned as written (list, scalar, or null); a missing or unread key is
    // null, never an invented empty list.
    depends_on: item.depends_on ?? null,
    required_gates: item.required_gates ?? null,
    card_path: item.card ?? null,
    // Keys present in the YAML but deliberately not read; their absence above
    // means "not interpreted", never "empty".
    unsupported_keys: item.unsupported_keys,
  };
}

function latestVerification(verifications) {
  const readable = verifications.filter((verification) => verification.status === "ok");
  readable.sort((a, b) => String(a.value.created_at ?? "").localeCompare(String(b.value.created_at ?? "")));
  return readable.at(-1) ?? null;
}

export async function listCards(reader, project) {
  const collected = await collectProject(reader, project);
  const ids = cardIds(collected);
  const cards = ids.map((id) => {
    const verifications = collected.verifications.filter((verification) => verification.status === "ok" && verification.value.feature_id === id);
    const latest = latestVerification(verifications);
    const assignments = collected.assignments.filter((assignment) => assignment.value.feature_id === id);
    return {
      id,
      declared: declaredCard(collected, id),
      observed: {
        provenance: PROVENANCE.derived,
        assignment_count: assignments.length,
        attempt_numbers: [...new Set([...assignments.map((a) => a.value.attempt), ...verifications.map((v) => v.value.attempt).filter(Number.isInteger)])].sort((a, b) => a - b),
        verification_count: verifications.length,
        latest_verification: latest
          ? { status: latest.value.status, created_at: latest.value.created_at ?? null, source: projectFile(project, latest.relative), provenance: PROVENANCE.code }
          : null,
      },
    };
  });
  return {
    project: project.id,
    work_queue: {
      status: collected.workQueue.status,
      source: collected.workQueue.source,
      provenance: PROVENANCE.declared,
      warnings: collected.workQueue.warnings,
    },
    cards,
    unmatched_evaluations: unmatchedEvaluations(collected, project, ids),
    diagnostics: collected.diagnostics,
    limits: [
      "`declared.state` is copied from agent-written YAML; Triad+ code does not maintain it.",
      "Evaluator+ results whose feature_id names no known card are listed in `unmatched_evaluations`, never merged.",
      "`observed` summarizes code-written evidence only; it does not imply review or approval.",
    ],
  };
}

async function evaluatorViews(reader, project, collected, id, latestPass) {
  const views = [];
  let qualityBaseline = null;
  const baselinePath = collected.assignments.find((a) => a.value.feature_id === id && a.value.quality_baseline_path)?.value.quality_baseline_path;
  if (baselinePath) {
    const loaded = await safeJson(reader, project.base, baselinePath);
    if (loaded.status === "ok") qualityBaseline = loaded.value;
  }
  for (const evaluation of collected.evaluations) {
    const { loaded } = evaluation;
    if (loaded.status !== "ok" || loaded.value?.feature_id !== id) {
      if (loaded.status !== "ok" && evaluation.relative.includes(id)) {
        views.push({ source: projectFile(project, evaluation.relative), provenance: PROVENANCE.declared, status: "unreadable", error: loaded.error });
      }
      continue;
    }
    const view = { source: projectFile(project, evaluation.relative), verdict: loaded.value.verdict ?? null, created_at: loaded.value.created_at ?? null };
    try {
      const validated = validateEvaluatorResult(loaded.value, { qualityBaseline });
      view.status = "valid";
      view.provenance = PROVENANCE.validated;
      view.validation = validated.legacy ? "legacy contract (no quality baseline bound)" : "quality baseline contract";
    } catch (error) {
      view.status = "invalid";
      view.provenance = PROVENANCE.declared;
      view.error = sanitizeError(error);
    }
    const fingerprint = loaded.value.candidate_fingerprint;
    const expected = latestPass?.value.baseline?.candidate_fingerprint;
    view.candidate_binding = {
      provenance: PROVENANCE.derived,
      result: !expected ? "no_passing_verification" : fingerprint === expected ? "same_as_latest_pass_record" : "differs_from_latest_pass_record",
      note: "compares recorded fingerprints only; the product worktree is not inspected",
    };
    views.push(view);
  }
  return views;
}

async function controlRunView(reader, project, cardId) {
  const loaded = await safeJson(reader, project.base, CONTROL_RUN_PATH);
  if (loaded.status === "missing") return null;
  const source = projectFile(project, CONTROL_RUN_PATH);
  if (loaded.status !== "ok") return { source, provenance: PROVENANCE.code, status: "unreadable", error: loaded.error };
  const value = loaded.value;
  const featureId = value.packet?.metadata?.feature_id ?? value.assignment_context?.feature_id ?? null;
  if (cardId !== undefined && featureId !== cardId) return null;
  let reviewer = null;
  if (value.reviewer !== undefined) {
    const boundSkillPaths = (value.packet?.metadata?.mandatory_skills ?? []).map((skill) => skill?.path).filter(Boolean);
    try {
      const contract = validateReviewerResult(value.reviewer, { boundSkillPaths });
      reviewer = {
        status: "valid",
        provenance: PROVENANCE.validated,
        decision: contract.decision,
        summary: contract.summary ?? null,
        findings: contract.findings ?? [],
        evidence_refs: contract.evidence_refs ?? [],
        skill_compliance: contract.skill_compliance ?? [],
      };
    } catch (error) {
      reviewer = { status: "invalid", provenance: PROVENANCE.declared, error: sanitizeError(error) };
    }
  }
  return {
    source,
    provenance: PROVENANCE.code,
    path_kind: "optional deterministic driver (runtime/triad-control-run.mjs); host-governed runs do not write this file",
    status: value.status ?? null,
    feature_id: featureId,
    stop_action: value.stop_action ?? null,
    trace: Array.isArray(value.trace)
      ? value.trace.map((entry) => ({ at: Number.isFinite(entry.at) ? new Date(entry.at).toISOString() : null, phase: entry.phase ?? null, action: entry.action ?? null, reason: entry.reason ?? null }))
      : [],
    timings: value.timings ?? null,
    tokens: value.tokens ?? null,
    reviewer,
    evaluator: value.evaluator ? { verdict: value.evaluator.verdict ?? null } : null,
    limit: "only the default output path is discovered; a driver configured with another output path is not visible",
  };
}

async function reviewDocuments(reader, project, cardId) {
  const documents = [];
  const lower = cardId.toLowerCase();
  for (const directory of [".loop/reviews", "card-reports"]) {
    for (const entry of await reader.list(project.base, directory)) {
      if (entry.file && entry.name.toLowerCase().includes(lower)) {
        documents.push({ source: projectFile(project, `${directory}/${entry.name}`), provenance: directory === "card-reports" ? PROVENANCE.code : PROVENANCE.declared });
      }
    }
  }
  return documents;
}

export async function readCard(reader, project, cardId) {
  const collected = await collectProject(reader, project);
  if (!cardIds(collected).includes(cardId)) return null;
  const verifications = collected.verifications.filter((verification) => verification.status === "ok" && verification.value.feature_id === cardId);
  const assignments = collected.assignments.filter((assignment) => assignment.value.feature_id === cardId);
  const latest = latestVerification(verifications);
  const latestPass = latestVerification(verifications.filter((verification) => verification.value.status === "pass"));

  const attemptNumbers = new Set([...assignments.map((a) => a.value.attempt), ...verifications.map((v) => v.value.attempt).filter(Number.isInteger)]);
  const attempts = [];
  for (const number of [...attemptNumbers].sort((a, b) => a - b)) {
    const attemptAssignments = assignments.filter((assignment) => assignment.value.attempt === number);
    const attemptVerifications = verifications.filter((verification) => verification.value.attempt === number);
    const views = [];
    const documents = [];
    for (const verification of attemptVerifications) {
      const assignment = attemptAssignments.find((candidate) => candidate.relative === normalizedOrNull(verification.value.assignment_ref))
        ?? attemptAssignments.find((candidate) => candidate.value.assignment_id === verification.value.assignment_id)
        ?? null;
      views.push(await verificationView(reader, project, verification, assignment, latest !== verification));
      documents.push(...attemptDocuments(await reader.list(project.base, verification.directory), verification).map((document) => ({ ...document, source: projectFile(project, document.source) })));
    }
    const assignmentViews = [];
    for (const assignment of attemptAssignments) {
      assignmentViews.push({
        source: projectFile(project, assignment.relative),
        provenance: PROVENANCE.declared,
        sha256: assignment.sha256,
        assignment_id: assignment.value.assignment_id ?? null,
        agent_type: assignment.value.agent_type ?? null,
        declared_status: assignment.value.status ?? null,
        expected_branch: assignment.value.expected_branch ?? null,
        required_gate_ids: Array.isArray(assignment.value.required_gate_ids) ? assignment.value.required_gate_ids : [],
        verification_run_id: assignment.value.verification_run_id ?? null,
        packet: await packetView(reader, project, assignment),
      });
    }
    attempts.push({ attempt: number, assignments: assignmentViews, verifications: views, documents });
  }

  return {
    project: project.id,
    id: cardId,
    declared: declaredCard(collected, cardId),
    attempts,
    evaluations: await evaluatorViews(reader, project, collected, cardId, latestPass),
    reviewer: {
      provenance: PROVENANCE.derived,
      note: "Host-governed runs record Reviewer outcomes in agent-written files; only the deterministic driver persists a validated Reviewer contract.",
      documents: await reviewDocuments(reader, project, cardId),
    },
    control_run: await controlRunView(reader, project, cardId),
    limits: [
      "`assignments[].declared_status` is never updated by runtime code and does not indicate completion.",
      "`freshness.control_bindings` compares control-workspace hashes only; `freshness.candidate` is always `not_checked`.",
      "Re-verifying the same attempt overwrites its verification.json; earlier results for that directory are not recoverable.",
    ],
  };
}

export async function readControlRun(reader, project) {
  return controlRunView(reader, project, undefined);
}

/** Bounded raw read of one allowlisted file, returned inside a JSON envelope. */
export async function readArtifact(reader, project, relative) {
  const text = await reader.readText(project.base, relative);
  if (!text) return null;
  const binary = text.bytes.includes(0);
  return {
    source: projectFile(project, text.path),
    provenance: text.path.startsWith(".loop/evidence/") && text.path.includes("/logs/") ? PROVENANCE.code : "unclassified",
    size: text.size,
    modified_at: text.modified_at,
    truncated: text.truncated,
    sha256: text.sha256,
    encoding: binary ? "omitted-binary" : "utf8",
    content: binary ? null : text.text,
  };
}
