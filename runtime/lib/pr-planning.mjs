import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { candidateManifestsBind, calculateCandidateFingerprintAtCommit } from "./fingerprint.mjs";
import { validateReviewerResult } from "./reviewer-result.mjs";
import { validateVerificationEvidence } from "./verification-evidence.mjs";

export const PR_PLAN_SCHEMA_VERSION = 1;
export const PR_STRUCTURAL_APPROVAL_SCHEMA_VERSION = 1;
export const PR_PLAN_MODES = Object.freeze(["auto", "single", "compact", "review-friendly"]);
const SHA256 = /^[a-f0-9]{64}$/i;
const GIT_SHA = /^[a-f0-9]{40,64}$/i;

function objectLike(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(code, message, details = {}) { const error = new Error(message); error.code = code; Object.assign(error, details); throw error; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function list(value) { return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))].sort() : []; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!objectLike(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function stableHash(value) { return hash(JSON.stringify(canonical(value))); }
function idOf(card) { return text(card?.id); }
function repoOf(card) { return text(card?.target_repository ?? card?.repository_id ?? card?.repository); }
function depsOf(card) { return list(card?.depends_on ?? card?.dependencies); }
function pathsOf(card) { return list(card?.expected_paths ?? card?.changed_paths); }
function slug(value) { return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "group"; }

export function prGroupId(repositoryId, cardIds) {
  return "pr-" + slug(repositoryId) + "-" + hash(repositoryId + "\0" + [...cardIds].sort().join("\0")).slice(0, 10);
}

function validateSnapshot(snapshot) {
  if (!objectLike(snapshot) || !text(snapshot.project_id)) fail("pr_snapshot_invalid", "snapshot.project_id is required");
  if (!objectLike(snapshot.source) || !SHA256.test(snapshot.source.queue_sha256 ?? "") || !SHA256.test(snapshot.source.project_sha256 ?? "")) {
    fail("pr_snapshot_invalid", "snapshot.source must bind canonical queue and project.yaml SHA-256 values");
  }
  if (!Array.isArray(snapshot.repositories) || !Array.isArray(snapshot.cards)) fail("pr_snapshot_invalid", "snapshot requires repositories and cards arrays");
  const repoIds = snapshot.repositories.map((repo) => text(repo?.id));
  const cardIds = snapshot.cards.map(idOf);
  if (repoIds.some((id) => !id) || new Set(repoIds).size !== repoIds.length) fail("pr_snapshot_invalid", "repository IDs must be non-empty and unique");
  if (cardIds.some((id) => !id) || new Set(cardIds).size !== cardIds.length) fail("pr_snapshot_invalid", "Card IDs must be non-empty and unique");
  const canonicalIds = snapshot.canonical_card_ids ?? cardIds;
  if (!Array.isArray(canonicalIds) || new Set(canonicalIds).size !== canonicalIds.length || canonicalIds.some((id) => !cardIds.includes(id))) {
    fail("pr_snapshot_invalid", "canonical_card_ids must uniquely identify Cards in the snapshot");
  }
  return { repoIds: new Set(repoIds), cardIds: new Set(canonicalIds) };
}

function detectCycles(cards) {
  const byId = new Map(cards.map((card) => [idOf(card), card]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail = []) {
    if (visiting.has(id)) return [...trail, id];
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const dependency of depsOf(byId.get(id))) {
      if (!byId.has(dependency)) fail("pr_dependency_ambiguous", "Card " + id + " depends on missing Card " + dependency);
      const cycle = visit(dependency, [...trail, id]);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }
  for (const id of byId.keys()) {
    const cycle = visit(id);
    if (cycle) fail("pr_dependency_cycle", "Card dependency cycle: " + cycle.join(" -> "), { cycle });
  }
}

function groupCards(cards, mode, reviewLimitFiles) {
  const repos = new Map();
  for (const card of cards) {
    const repo = repoOf(card);
    if (!repo) fail("pr_card_repository_missing", "Card " + idOf(card) + " has no target repository");
    if (!repos.has(repo)) repos.set(repo, []);
    repos.get(repo).push(card);
  }
  const result = [];
  for (const [repo, cardsInRepo] of [...repos.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...cardsInRepo].sort((a, b) => idOf(a).localeCompare(idOf(b)));
    if (mode === "single") {
      result.push({ repository: repo, cards: sorted, rationale: "One PR for every selected Card in repository " + repo + "." });
      continue;
    }
    if (mode === "compact") {
      const buckets = new Map();
      for (const card of sorted) {
        const key = text(card.compatibility_key ?? card.delivery_group) ?? "compatible-default";
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(card);
      }
      for (const [key, group] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        result.push({ repository: repo, cards: group, rationale: "Compatible delivery key " + key + " is combined to reduce PR count." });
      }
      continue;
    }
    if (mode === "review-friendly") {
      const named = new Map();
      const unnamed = [];
      for (const card of sorted) {
        const key = text(card.review_group);
        if (!key) { unnamed.push(card); continue; }
        if (!named.has(key)) named.set(key, []);
        named.get(key).push(card);
      }
      for (const [key, group] of [...named.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        result.push({ repository: repo, cards: group, rationale: "Preserves declared review group " + key + " while retaining per-Card evidence." });
      }
      for (let i = 0; i < unnamed.length;) {
        const group = [unnamed[i++]];
        while (i < unnamed.length && group.length < 2 && new Set([...group.flatMap(pathsOf), ...pathsOf(unnamed[i])]).size <= reviewLimitFiles) group.push(unnamed[i++]);
        result.push({ repository: repo, cards: group, rationale: "Keeps this review group to " + new Set(group.flatMap(pathsOf)).size + " expected files; Cards remain independently reviewed." });
      }
      continue;
    }
    // Auto: combine dependency/shared-dependency components, then pair only
    // compatible singletons while their exact expected-path count stays small.
    const parent = new Map(sorted.map((card) => [idOf(card), idOf(card)]));
    const find = (id) => parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id));
    const union = (a, b) => { const left = find(a), right = find(b); if (left !== right) parent.set(right, left); };
    const byShared = new Map();
    for (const card of sorted) {
      const id = idOf(card);
      for (const dep of depsOf(card)) if (parent.has(dep)) union(id, dep);
      for (const dep of list(card.shared_dependencies)) {
        if (!byShared.has(dep)) byShared.set(dep, id);
        else union(id, byShared.get(dep));
      }
      const key = text(card.delivery_group);
      if (key) {
        const deliveryKey = "delivery:" + key;
        if (!byShared.has(deliveryKey)) byShared.set(deliveryKey, id);
        else union(id, byShared.get(deliveryKey));
      }
    }
    const components = new Map();
    for (const card of sorted) {
      const key = find(idOf(card));
      if (!components.has(key)) components.set(key, []);
      components.get(key).push(card);
    }
    const packed = [];
    for (const component of [...components.values()].sort((a, b) => idOf(a[0]).localeCompare(idOf(b[0])))) {
      const prior = packed.at(-1);
      const files = new Set([...(prior ?? []).flatMap(pathsOf), ...component.flatMap(pathsOf)]).size;
      if (prior && prior.length === 1 && component.length === 1 && files <= reviewLimitFiles) prior.push(...component);
      else packed.push([...component]);
    }
    for (const group of packed) {
      const shared = [...new Set(group.flatMap((card) => list(card.shared_dependencies)))].sort();
      const internalDependency = group.some((card) => depsOf(card).some((dep) => group.some((item) => idOf(item) === dep)));
      const reason = internalDependency ? "Keeps a dependency-linked Card set together."
        : shared.length ? "Cards share declared dependencies: " + shared.join(", ") + "."
          : "Pairs compatible independent Cards to reduce PR count without exceeding the expected-path bound.";
      result.push({ repository: repo, cards: group, rationale: reason + " Expected file count " + new Set(group.flatMap(pathsOf)).size + "." });
    }
  }
  return result;
}

function bindingFor(group, repo, count, bindings) {
  const source = bindings?.[group.id] ?? (count === 1 ? repo : {});
  return {
    branch: text(source.branch ?? source.project_branch),
    worktree: text(source.worktree),
    base_branch: text(source.base_branch ?? repo.base_branch),
    base_commit: text(source.base_commit ?? repo.base_commit),
    remote: text(source.remote ?? repo.remote),
    remote_url: text(source.remote_url ?? repo.remote_url),
  };
}

export function buildPrPlan(snapshot, { mode = "auto", bindings = {}, reviewLimitFiles = 12 } = {}) {
  const valid = validateSnapshot(snapshot);
  if (!PR_PLAN_MODES.includes(mode)) fail("pr_mode_invalid", "Unsupported PR planning mode: " + mode);
  if (!Number.isInteger(reviewLimitFiles) || reviewLimitFiles < 1) fail("pr_review_limit_invalid", "reviewLimitFiles must be a positive integer");
  detectCycles(snapshot.cards);
  const selected = snapshot.cards.filter((card) => card.selected !== false);
  if (!selected.length) fail("pr_no_selected_cards", "Select at least one canonical Card before creating a PR plan");
  const candidateGroups = groupCards(selected, mode, reviewLimitFiles).map((group) => ({ ...group, id: prGroupId(group.repository, group.cards.map(idOf)) }));
  const counts = new Map();
  for (const group of candidateGroups) counts.set(group.repository, (counts.get(group.repository) ?? 0) + 1);
  const repositories = new Map(snapshot.repositories.map((repo) => [text(repo.id), repo]));
  const groupForCard = new Map();
  for (const group of candidateGroups) for (const card of group.cards) groupForCard.set(idOf(card), group.id);
  const groups = candidateGroups.map((group) => {
    const repo = repositories.get(group.repository);
    if (!valid.repoIds.has(group.repository) || !repo) fail("pr_repository_unknown", "Undeclared repository " + group.repository);
    const binding = bindingFor(group, repo, counts.get(group.repository), bindings);
    const dependencies = new Set();
    for (const card of group.cards) for (const dep of depsOf(card)) {
      const other = groupForCard.get(dep);
      if (other && other !== group.id) dependencies.add(other);
    }
    return {
      id: group.id,
      card_ids: group.cards.map(idOf).sort(),
      target_repository: group.repository,
      branch: binding.branch,
      worktree: binding.worktree,
      base_branch: binding.base_branch,
      base_commit: binding.base_commit,
      remote: binding.remote,
      remote_url: binding.remote_url,
      dependencies: [...dependencies].sort(),
      expected_paths: [...new Set(group.cards.flatMap(pathsOf))].sort(),
      rationale: group.rationale,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const crossDependencies = groups.flatMap((group) => group.dependencies.map((dependency) => ({ group: group.id, depends_on: dependency })));
  const includedCards = new Set(groupForCard.keys());
  const dependenciesOutsidePlan = groups.flatMap((group) => group.card_ids.flatMap((id) => {
    const card = snapshot.cards.find((entry) => idOf(entry) === id);
    return depsOf(card).filter((dependency) => !includedCards.has(dependency)).map((dependency) => ({ group: group.id, card: id, depends_on: dependency }));
  }));
  const plan = {
    schema_version: PR_PLAN_SCHEMA_VERSION,
    project_id: snapshot.project_id,
    snapshot_sha256: stableHash(snapshot),
    mode,
    review_limit_files: reviewLimitFiles,
    source: {
      queue_path: text(snapshot.source.queue_path) ?? ".loop/work-queue.yaml",
      queue_sha256: snapshot.source.queue_sha256,
      project_path: text(snapshot.source.project_path) ?? "project.yaml",
      project_sha256: snapshot.source.project_sha256,
      canonical_card_ids: [...(snapshot.canonical_card_ids ?? snapshot.cards.map(idOf))].sort(),
    },
    groups,
    diagnostics: [
      ...(crossDependencies.length ? [{ code: "stacked_required/unsupported", dependencies: crossDependencies }] : []),
      ...(dependenciesOutsidePlan.length ? [{ code: "dependency_not_selected", dependencies: dependenciesOutsidePlan }] : []),
    ],
    approval: null,
    drafts: [],
  };
  plan.plan_sha256 = prPlanSha256(plan);
  return plan;
}

function forHash(plan) {
  const { approval, drafts, plan_sha256, ...stable } = plan;
  return stable;
}
export function prPlanSha256(plan) { return stableHash(forHash(plan)); }

function approvedGroups(plan) {
  return plan.groups.map((group) => ({
    id: group.id, card_ids: [...group.card_ids].sort(), target_repository: group.target_repository,
    branch: group.branch, worktree: group.worktree, base_branch: group.base_branch,
    base_commit: group.base_commit, remote: group.remote, remote_url: group.remote_url,
    dependencies: [...group.dependencies].sort(),
  }));
}

export function approvePrPlan(plan, { owner, approvedAt = new Date().toISOString() } = {}) {
  if (!text(owner)) fail("pr_owner_required", "An explicit owner identity is required");
  const digest = prPlanSha256(plan);
  return {
    ...plan,
    plan_sha256: digest,
    approval: {
      status: "approved", owner: text(owner), approved_at: approvedAt, plan_sha256: digest,
      permitted_repositories: [...new Set(plan.groups.map((group) => group.target_repository))].sort(),
      pr_count: plan.groups.length, groups: approvedGroups(plan), effect: "draft_pr_creation_only",
    },
  };
}

function structuralCard(card, snapshot) {
  const sourcePath = text(card.source_path);
  const sourceSha = card.source_sha256;
  const sourceEntry = (snapshot.source?.files ?? []).find((entry) => entry.path === sourcePath);
  if (!sourcePath || !SHA256.test(sourceSha ?? "") || sourceEntry?.sha256 !== sourceSha) {
    fail("pr_structural_card_source_missing", "Structural approval requires a byte-bound canonical Card source for " + idOf(card));
  }
  return {
    id: idOf(card),
    title: text(card.title),
    source_path: sourcePath,
    source_sha256: sourceSha,
    target_repository: repoOf(card),
    selected: card.selected !== false,
    depends_on: depsOf(card),
    expected_paths: pathsOf(card),
    compatibility_key: text(card.compatibility_key),
    delivery_group: text(card.delivery_group),
    shared_dependencies: list(card.shared_dependencies),
    review_group: text(card.review_group),
  };
}

/**
 * The pre-run approval boundary intentionally excludes execution state,
 * verifier/reviewer results, and final commits. It includes every input that
 * determines Card membership, grouping, dependencies, repository scope, and
 * exact delivery bindings.
 */
export function prStructuralIntent(plan, snapshot) {
  const shape = validateSnapshot(snapshot);
  const repos = snapshot.repositories.map((repo) => ({
    id: text(repo.id), path: text(repo.path), worktree: text(repo.worktree),
    base_branch: text(repo.base_branch), project_branch: text(repo.project_branch),
    remote: text(repo.remote), remote_url: text(repo.remote_url),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema_version: PR_STRUCTURAL_APPROVAL_SCHEMA_VERSION,
    project_id: snapshot.project_id,
    mode: plan.mode,
    review_limit_files: plan.review_limit_files,
    source: {
      queue_path: text(snapshot.source.queue_path) ?? ".loop/work-queue.yaml",
      project_path: text(snapshot.source.project_path) ?? "project.yaml",
      project_sha256: snapshot.source.project_sha256,
      canonical_card_ids: [...shape.cardIds].sort(),
    },
    repositories: repos,
    cards: snapshot.cards.map((card) => structuralCard(card, snapshot)).sort((a, b) => a.id.localeCompare(b.id)),
    groups: approvedGroups(plan).map((group) => ({
      ...group,
      expected_paths: [...(plan.groups.find((entry) => entry.id === group.id)?.expected_paths ?? [])].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    effect: "draft_pr_creation_only",
  };
}

export function createStructuralApproval(plan, snapshot, { owner, approvedAt = new Date().toISOString() } = {}) {
  if (!text(owner)) fail("pr_owner_required", "An explicit owner identity is required");
  const validation = validatePrPlan(plan, snapshot);
  if (!validation.valid) fail("pr_plan_invalid", validation.errors.map((item) => item.message).join("; "), { errors: validation.errors });
  const intent = prStructuralIntent(plan, snapshot);
  const structuralSha256 = stableHash(intent);
  return {
    schema_version: PR_STRUCTURAL_APPROVAL_SCHEMA_VERSION,
    intent,
    approval: {
      status: "approved", owner: text(owner), approved_at: approvedAt,
      structural_sha256: structuralSha256, effect: "draft_pr_creation_only",
    },
  };
}

export function validateStructuralApproval(document, plan, snapshot) {
  const errors = [];
  if (!objectLike(document) || document.schema_version !== PR_STRUCTURAL_APPROVAL_SCHEMA_VERSION || !objectLike(document.intent)) {
    return { valid: false, errors: [err("pr_structural_approval_invalid", "Malformed structural approval document")] };
  }
  const approval = document.approval;
  if (!objectLike(approval) || approval.status !== "approved" || !text(approval.owner)) errors.push(err("owner_approval_missing", "Explicit pre-run structural owner approval is required"));
  if (document.intent.effect !== "draft_pr_creation_only" || approval?.effect !== "draft_pr_creation_only") errors.push(err("pr_structural_effect_invalid", "Structural approval must be draft-only"));
  const recordedSha = stableHash(document.intent);
  if (approval?.structural_sha256 !== recordedSha) errors.push(err("pr_structural_approval_tampered", "Structural approval digest does not match its approved intent"));
  let currentSha = null;
  try { currentSha = stableHash(prStructuralIntent(plan, snapshot)); }
  catch (error) { errors.push(err(error.code ?? "pr_structural_intent_invalid", error.message)); }
  if (currentSha && recordedSha !== currentSha) errors.push(err("pr_structural_drift", "Card grouping, repository, dependency, or exact branch/worktree/base/remote binding changed; owner reapproval is required"));
  return { valid: errors.length === 0, errors, structural_sha256: currentSha };
}

function validateEmbeddedStructuralApproval(approval, plan, snapshot) {
  const errors = [];
  if (!objectLike(approval) || approval.status !== "approved" || !text(approval.owner)) errors.push(err("owner_approval_missing", "Explicit pre-run structural owner approval is required"));
  if (approval?.effect !== "draft_pr_creation_only") errors.push(err("pr_structural_effect_invalid", "Structural approval must be draft-only"));
  let structuralSha = null;
  try { structuralSha = stableHash(prStructuralIntent(plan, snapshot)); }
  catch (error) { errors.push(err(error.code ?? "pr_structural_intent_invalid", error.message)); }
  if (structuralSha && approval?.structural_sha256 !== structuralSha) errors.push(err("pr_structural_drift", "Card grouping, repository, dependency, or exact branch/worktree/base/remote binding changed; owner reapproval is required"));
  return { valid: errors.length === 0, errors, structural_sha256: structuralSha };
}

export function validatePlanApproval(plan) {
  const errors = [];
  const digest = prPlanSha256(plan);
  const approval = plan?.approval;
  if (!objectLike(approval) || approval.status !== "approved") errors.push({ code: "owner_approval_missing", message: "Explicit owner approval is required" });
  else {
    if (approval.plan_sha256 !== digest || plan.plan_sha256 !== digest) errors.push({ code: "approval_drift", message: "Plan changed after owner approval; new approval is required" });
    if (approval.effect !== "draft_pr_creation_only") errors.push({ code: "approval_effect_invalid", message: "Approval is not limited to draft PR creation" });
    if (approval.pr_count !== plan.groups?.length || stableHash(approval.groups) !== stableHash(approvedGroups(plan))) errors.push({ code: "approval_drift", message: "Approved groups or PR count changed" });
    const repos = [...new Set((plan.groups ?? []).map((group) => group.target_repository))].sort();
    if (stableHash(approval.permitted_repositories) !== stableHash(repos)) errors.push({ code: "approval_drift", message: "Approved repository scope changed" });
  }
  return { valid: errors.length === 0, errors, plan_sha256: digest };
}

function evidenceProblems(card) {
  const id = idOf(card);
  const final = card.final ?? {};
  const verifier = card.verifier ?? card.verification ?? {};
  const reviewer = card.reviewer ?? card.review ?? {};
  const docs = card.docs_impact ?? card.documentation_impact ?? {};
  const errors = [];
  if ((card.status ?? card.state) !== "approved") errors.push(id + ": Card is not approved");
  if (verifier.status !== "pass" || !text(verifier.candidate_fingerprint)) errors.push(id + ": passing verifier evidence is missing");
  if (!text(final.candidate_fingerprint) || verifier.candidate_fingerprint !== final.candidate_fingerprint) errors.push(id + ": verifier does not bind the final candidate");
  if (!["approved", "APPROVED"].includes(reviewer.decision ?? reviewer.verdict)) errors.push(id + ": independent Reviewer approval is missing");
  if (!text(reviewer.candidate_fingerprint) || reviewer.candidate_fingerprint !== final.candidate_fingerprint) errors.push(id + ": Reviewer does not bind the final candidate");
  for (const [label, reference] of [["verifier", verifier], ["reviewer", reviewer]]) {
    if (!text(reference.evidence_path ?? reference.path) || !SHA256.test(reference.sha256 ?? reference.evidence_sha256 ?? "")) errors.push(id + ": " + label + " evidence path/hash is missing");
  }
  if (!["reviewed", "not_affected"].includes(docs.status) || !text(docs.reference ?? docs.path)) errors.push(id + ": documentation-impact review is missing");
  for (const field of ["repository", "branch", "commit", "base_commit", "worktree", "candidate_fingerprint"]) if (!text(final[field])) errors.push(id + ": final." + field + " is missing");
  if (text(final.commit) && !GIT_SHA.test(final.commit)) errors.push(id + ": final.commit is invalid");
  if (text(final.base_commit) && !GIT_SHA.test(final.base_commit)) errors.push(id + ": final.base_commit is invalid");
  return errors;
}

function err(code, message) { return { code, message }; }

export function validatePrPlan(plan, snapshot) {
  const errors = [];
  let shape;
  try { shape = validateSnapshot(snapshot); } catch (error) { return { valid: false, errors: [err(error.code ?? "pr_snapshot_invalid", error.message)] }; }
  try { detectCycles(snapshot.cards); } catch (error) { return { valid: false, errors: [err(error.code ?? "pr_dependency_invalid", error.message)] }; }
  if (!objectLike(plan) || plan.schema_version !== PR_PLAN_SCHEMA_VERSION) return { valid: false, errors: [err("pr_plan_invalid", "Malformed or unsupported plan")] };
  if (!Array.isArray(plan.groups) || !plan.groups.length) errors.push(err("pr_plan_invalid", "Plan must contain at least one PR group"));
  if (plan.project_id !== snapshot.project_id) errors.push(err("pr_project_mismatch", "Plan belongs to another project"));
  if (plan.snapshot_sha256 !== stableHash(snapshot)) errors.push(err("pr_snapshot_drift", "PR plan is not bound to this exact Card/repository/evidence snapshot"));
  if (plan.plan_sha256 !== prPlanSha256(plan)) errors.push(err("pr_plan_hash_invalid", "Plan content does not match its SHA-256"));
  if (!Number.isInteger(plan.review_limit_files) || plan.review_limit_files < 1) errors.push(err("pr_review_limit_invalid", "Plan must retain a positive review file limit"));
  if (!PR_PLAN_MODES.includes(plan.mode)) errors.push(err("pr_mode_invalid", "Unsupported plan mode"));
  if (plan.source?.queue_sha256 !== snapshot.source.queue_sha256 || plan.source?.project_sha256 !== snapshot.source.project_sha256) errors.push(err("pr_source_drift", "Queue or project.yaml changed; regenerate and reapprove"));
  const canonicalIds = [...(snapshot.canonical_card_ids ?? snapshot.cards.map(idOf))].sort();
  if (stableHash(plan.source?.canonical_card_ids) !== stableHash(canonicalIds)) errors.push(err("pr_source_drift", "Canonical Card IDs changed; regenerate and reapprove"));
  const cards = new Map(snapshot.cards.map((card) => [idOf(card), card]));
  try {
    const expected = groupCards(snapshot.cards.filter((card) => card.selected !== false), plan.mode, plan.review_limit_files)
      .map((group) => ({
        id: prGroupId(group.repository, group.cards.map(idOf)),
        card_ids: group.cards.map(idOf).sort(),
        target_repository: group.repository,
        expected_paths: [...new Set(group.cards.flatMap(pathsOf))].sort(),
        rationale: group.rationale,
      })).sort((a, b) => a.id.localeCompare(b.id));
    const actual = (plan.groups ?? []).map((group) => ({
      id: group.id, card_ids: [...(group.card_ids ?? [])].sort(), target_repository: group.target_repository,
      expected_paths: [...(group.expected_paths ?? [])].sort(), rationale: group.rationale,
    })).sort((a, b) => a.id.localeCompare(b.id));
    if (stableHash(actual) !== stableHash(expected)) errors.push(err("pr_grouping_not_deterministic", "PR groups do not match the deterministic grouping for the selected mode"));
  } catch (error) {
    errors.push(err(error.code ?? "pr_grouping_invalid", error.message));
  }
  const repos = new Map(snapshot.repositories.map((repo) => [text(repo.id), repo]));
  const used = new Set();
  const branches = new Set();
  const worktrees = new Set();
  const groupIds = new Set();
  for (const group of plan.groups ?? []) {
    if (!text(group.id) || groupIds.has(group.id)) errors.push(err("pr_group_ambiguous", "Group IDs must be unique"));
    groupIds.add(group.id);
    if (!repos.has(group.target_repository)) errors.push(err("pr_repository_unknown", "Undeclared repository " + group.target_repository));
    if (!Array.isArray(group.card_ids) || !group.card_ids.length) errors.push(err("pr_group_empty", "Group " + group.id + " has no Cards"));
    for (const id of group.card_ids ?? []) {
      if (!shape.cardIds.has(id) || !cards.has(id)) errors.push(err("pr_card_not_canonical", "Non-canonical Card " + id));
      if (used.has(id)) errors.push(err("pr_card_double_assignment", "Card " + id + " is assigned more than once"));
      used.add(id);
      if (cards.has(id) && repoOf(cards.get(id)) !== group.target_repository) errors.push(err("pr_repository_mismatch", "Card " + id + " repository differs from its group"));
    }
    if (!text(group.branch) || !text(group.worktree)) errors.push(err("pr_group_binding_missing", "Group " + group.id + " needs explicit branch/worktree binding"));
    if (!text(group.base_branch) || !GIT_SHA.test(group.base_commit ?? "")) errors.push(err("pr_base_binding_missing", "Group " + group.id + " needs approved base branch/commit"));
    if (!text(group.remote) || !text(group.remote_url)) errors.push(err("pr_remote_binding_missing", "Group " + group.id + " needs approved remote binding"));
    if (repos.has(group.target_repository) && repos.get(group.target_repository).base_branch
      && group.base_branch !== repos.get(group.target_repository).base_branch) {
      errors.push(err("pr_base_not_declared", "Group " + group.id + " base branch is not declared by project.yaml"));
    }
    if (group.branch && group.branch === group.base_branch) errors.push(err("pr_branch_base_conflict", "Head and base branches must differ"));
    const branchKey = group.target_repository + "\0" + group.branch;
    const worktreeKey = group.target_repository + "\0" + path.resolve(group.worktree ?? ".");
    if (branches.has(branchKey)) errors.push(err("pr_branch_reused", "Branch reused across PR groups: " + group.branch));
    if (worktrees.has(worktreeKey)) errors.push(err("pr_worktree_reused", "Worktree reused across PR groups: " + group.worktree));
    branches.add(branchKey);
    worktrees.add(worktreeKey);
  }
  for (const card of snapshot.cards.filter((entry) => entry.selected !== false)) if (!used.has(idOf(card))) errors.push(err("pr_card_missing", "Selected Card missing from plan: " + idOf(card)));
  const groupByCard = new Map();
  for (const group of plan.groups ?? []) for (const id of group.card_ids ?? []) groupByCard.set(id, group.id);
  const groupIdsSet = new Set((plan.groups ?? []).map((group) => group.id));
  const expectedCrossDependencies = [];
  const expectedOutsideDependencies = [];
  for (const group of plan.groups ?? []) {
    const expected = new Set();
    for (const id of group.card_ids ?? []) for (const dep of depsOf(cards.get(id))) {
      if (!cards.has(dep)) errors.push(err("pr_dependency_ambiguous", "Card " + id + " depends on missing Card " + dep));
      const otherGroup = groupByCard.get(dep);
      if (otherGroup && otherGroup !== group.id) {
        expected.add(otherGroup);
        expectedCrossDependencies.push({ group: group.id, depends_on: otherGroup });
      } else if (cards.has(dep) && !otherGroup) expectedOutsideDependencies.push({ group: group.id, card: id, depends_on: dep });
    }
    if (stableHash([...(group.dependencies ?? [])].sort()) !== stableHash([...expected].sort())) errors.push(err("pr_dependency_mapping_invalid", "Group " + group.id + " dependencies do not match the canonical DAG"));
    for (const dep of group.dependencies ?? []) if (!groupIdsSet.has(dep)) errors.push(err("pr_dependency_mapping_invalid", "Missing dependent group " + dep));
  }
  const expectedDiagnostics = [
    ...(expectedCrossDependencies.length ? [{ code: "stacked_required/unsupported", dependencies: expectedCrossDependencies }] : []),
    ...(expectedOutsideDependencies.length ? [{ code: "dependency_not_selected", dependencies: expectedOutsideDependencies }] : []),
  ];
  if (stableHash(plan.diagnostics ?? []) !== stableHash(expectedDiagnostics)) errors.push(err("pr_diagnostics_invalid", "Plan diagnostics do not match the canonical dependency graph"));
  if (plan.mode === "single") {
    const counts = new Map();
    for (const group of plan.groups ?? []) counts.set(group.target_repository, (counts.get(group.target_repository) ?? 0) + 1);
    for (const [repo, count] of counts) if (count !== 1) errors.push(err("pr_single_mode_invalid", "Single mode requires one group for " + repo));
  }
  if (plan.structural_approval) {
    const structural = validateEmbeddedStructuralApproval(plan.structural_approval, plan, snapshot);
    errors.push(...structural.errors);
  }
  return { valid: errors.length === 0, errors, stacked_unsupported: (plan.groups ?? []).some((group) => (group.dependencies ?? []).length > 0) };
}

export function renderPrPlanTable(plan) {
  const rows = ["PR group | Card IDs | target repo | branch | worktree | base | remote | dependencies | review burden | rationale"];
  for (const group of plan.groups ?? []) rows.push([
    group.id, group.card_ids.join(", "), group.target_repository,
    group.branch ?? "<binding required>", group.worktree ?? "<binding required>",
    (group.base_branch ?? "<base required>") + "@" + String(group.base_commit ?? "<commit required>"),
    (group.remote ?? "<remote required>") + " " + (group.remote_url ?? "<URL required>"),
    group.dependencies.join(", ") || "none",
    (group.expected_paths?.length ?? 0) + " expected path(s); limit " + plan.review_limit_files,
    group.rationale,
  ].join(" | "));
  return rows.join("\n");
}

function defaultRunner(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}
function runChecked(command, args, cwd, runner) {
  const result = runner(command, args, cwd);
  if (result.status !== 0 || result.error) fail("pr_git_preflight_failed", command + " " + args.join(" ") + " failed: " + (result.stderr || result.error?.message || "non-zero exit"), { command: [command, ...args], cwd });
  return String(result.stdout ?? "").trim();
}
function githubRepo(remote) {
  const match = String(remote ?? "").trim().match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}
function parseJson(value, label) { try { return JSON.parse(value); } catch { fail("pr_host_response_invalid", label + " returned invalid JSON"); } }

function evidenceReferenceProblems(card, snapshot) {
  const problems = [];
  const files = new Map((snapshot.source?.files ?? []).map((entry) => [entry.path, entry.sha256]));
  const verifier = card.verifier ?? card.verification ?? {};
  const reviewer = card.reviewer ?? card.review ?? {};
  const docs = card.docs_impact ?? card.documentation_impact ?? {};
  for (const [label, reference] of [["verifier", verifier], ["reviewer", reviewer]]) {
    const refPath = reference.evidence_path ?? reference.path;
    const refHash = reference.sha256 ?? reference.evidence_sha256;
    if (files.size && files.get(refPath) !== refHash) problems.push(idOf(card) + ": " + label + " evidence is not bound to its source bytes");
  }
  const docsPath = docs.reference ?? docs.path;
  if (files.size && !files.has(docsPath)) problems.push(idOf(card) + ": documentation-impact source is not byte-bound");
  return problems;
}

async function readCanonicalJson(projectRoot, relativePath, expectedSha, sourceFiles, label) {
  if (!text(relativePath) || !SHA256.test(expectedSha ?? "")) fail("pr_canonical_evidence_invalid", label + " path/hash is missing");
  if (sourceFiles.get(relativePath) !== expectedSha) fail("pr_canonical_evidence_invalid", label + " is not byte-bound by the snapshot manifest");
  const resolved = path.resolve(projectRoot, relativePath);
  if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) fail("pr_canonical_evidence_invalid", label + " escapes the Control Workspace");
  const physical = await realpath(resolved).catch(() => null);
  if (!physical || (physical !== projectRoot && !physical.startsWith(projectRoot + path.sep))) fail("pr_canonical_evidence_invalid", label + " is missing or escapes the Control Workspace");
  const source = await readFile(physical);
  if (hash(source) !== expectedSha) fail("pr_canonical_evidence_invalid", label + " bytes changed after the snapshot was captured");
  let value;
  try { value = JSON.parse(source.toString("utf8")); }
  catch { fail("pr_canonical_evidence_invalid", label + " is not valid JSON"); }
  if (!objectLike(value)) fail("pr_canonical_evidence_invalid", label + " must contain a JSON object");
  return { value, source: source.toString("utf8") };
}

async function validateCanonicalDeliveryEvidence(snapshot, projectRoot) {
  if (snapshot.source?.canonical_evidence !== true) fail("pr_canonical_evidence_required", "Pre-run structural approval requires a refreshed snapshot marked canonical_evidence: true");
  const root = await realpath(projectRoot).catch(() => null);
  if (!root) fail("pr_canonical_evidence_invalid", "Control Workspace does not exist");
  const sourceFiles = new Map((snapshot.source?.files ?? []).map((entry) => [entry.path, entry.sha256]));
  const verifierByCard = new Map();
  for (const card of snapshot.cards.filter((entry) => entry.selected !== false)) {
    const id = idOf(card);
    const final = card.final ?? {};
    const verifierRef = card.verifier ?? card.verification ?? {};
    const verifierPath = verifierRef.evidence_path ?? verifierRef.path;
    const verifier = (await readCanonicalJson(root, verifierPath, verifierRef.sha256 ?? verifierRef.evidence_sha256, sourceFiles, id + " verifier evidence")).value;
    const verifierContract = validateVerificationEvidence(verifier);
    if (!verifierContract.valid) fail("pr_canonical_evidence_invalid", id + " verifier evidence is invalid: " + verifierContract.errors.join("; "));
    const candidateFingerprint = verifier.baseline?.candidate_fingerprint;
    if (verifier.status !== "pass" || verifier.feature_id !== id || candidateFingerprint !== final.candidate_fingerprint) {
      fail("pr_canonical_evidence_invalid", id + " verifier evidence does not bind a passing final Card candidate");
    }
    if (verifierRef.candidate_fingerprint && verifierRef.candidate_fingerprint !== candidateFingerprint) fail("pr_canonical_evidence_invalid", id + " verifier summary differs from the actual verifier evidence");
    if (verifierRef.run_id && verifierRef.run_id !== verifier.run_id) fail("pr_canonical_evidence_invalid", id + " verifier run identity differs from the snapshot");
    verifierByCard.set(id, verifier);

    const reviewerRef = card.reviewer ?? card.review ?? {};
    const bindingPath = reviewerRef.binding_path ?? reviewerRef.evidence_path ?? reviewerRef.path;
    const bindingSha = reviewerRef.binding_sha256 ?? reviewerRef.sha256 ?? reviewerRef.evidence_sha256;
    const runRecord = (await readCanonicalJson(root, bindingPath, bindingSha, sourceFiles, id + " Reviewer run record")).value;
    if (runRecord.status !== "done" || !objectLike(runRecord.reviewer_binding) || !["approved", "APPROVED"].includes(runRecord.reviewer?.decision)) {
      fail("pr_canonical_evidence_invalid", id + " has no completed independent Reviewer run record");
    }
    const binding = runRecord.reviewer_binding;
    const assignmentRecord = (await readCanonicalJson(root, binding.assignment_ref, binding.assignment_sha256, sourceFiles, id + " assignment")).value;
    if (assignmentRecord.assignment_id !== binding.assignment_id || assignmentRecord.feature_id !== id || binding.feature_id !== id
      || assignmentRecord.attempt !== binding.attempt || !binding.assignment_id) {
      fail("pr_canonical_evidence_invalid", id + " Reviewer binding does not match the canonical Assignment");
    }
    const assignmentRoot = assignmentRecord.project_root ? await realpath(path.resolve(assignmentRecord.project_root)).catch(() => null) : null;
    const assignedWorktree = assignmentRecord.worktree ? await realpath(path.resolve(root, assignmentRecord.worktree)).catch(() => null) : null;
    const finalWorktree = final.worktree ? await realpath(path.resolve(root, final.worktree)).catch(() => null) : null;
    if (assignmentRoot !== root || !assignedWorktree || assignedWorktree !== finalWorktree
      || assignmentRecord.repository_id !== final.repository || assignmentRecord.expected_branch !== final.branch) {
      fail("pr_canonical_evidence_invalid", id + " Assignment repository/worktree/branch differs from the final Card record");
    }
    if (binding.verifier_evidence?.path !== verifierPath || binding.verifier_evidence?.sha256 !== (verifierRef.sha256 ?? verifierRef.evidence_sha256)
      || binding.verifier_evidence?.candidate_fingerprint !== candidateFingerprint || binding.candidate_fingerprint !== candidateFingerprint) {
      fail("pr_canonical_evidence_invalid", id + " Reviewer run is not bound to the actual passing verifier bytes and candidate");
    }
    const resultRef = binding.reviewer_result_ref ?? {};
    const reviewerResult = (await readCanonicalJson(root, resultRef.path, resultRef.sha256, sourceFiles, id + " Reviewer result")).value;
    try { validateReviewerResult(reviewerResult); }
    catch (error) { fail("pr_canonical_evidence_invalid", id + " Reviewer result is invalid: " + error.message); }
    if (!['approved', 'APPROVED'].includes(reviewerResult.decision) || reviewerResult.decision !== runRecord.reviewer.decision) {
      fail("pr_canonical_evidence_invalid", id + " actual Reviewer result is not approved or differs from its run record");
    }
    if (reviewerRef.candidate_fingerprint && reviewerRef.candidate_fingerprint !== candidateFingerprint) fail("pr_canonical_evidence_invalid", id + " Reviewer summary differs from the bound candidate");

    const docs = card.docs_impact ?? card.documentation_impact ?? {};
    const docsPath = docs.reference ?? docs.path;
    const docsSha = sourceFiles.get(docsPath);
    if (!text(docsPath) || !SHA256.test(docsSha ?? "")) fail("pr_canonical_evidence_invalid", id + " documentation-impact source is not byte-bound");
    const resolvedDocs = path.resolve(root, docsPath);
    const physicalDocs = await realpath(resolvedDocs).catch(() => null);
    if (!physicalDocs || (physicalDocs !== root && !physicalDocs.startsWith(root + path.sep)) || hash(await readFile(physicalDocs)) !== docsSha) {
      fail("pr_canonical_evidence_invalid", id + " documentation-impact source is missing or stale");
    }
  }
  return verifierByCard;
}

async function preflightGroup(group, snapshot, runner, gh, checkHost, projectRoot, includedCards, canonicalVerifiers = null) {
  for (const id of group.card_ids) {
    const card = snapshot.cards.find((entry) => idOf(entry) === id);
    const final = card?.final ?? {};
    if (final.repository !== group.target_repository || final.branch !== group.branch) fail("pr_card_binding_mismatch", "Card " + id + " does not match its approved repository/branch", { group_id: group.id });
    if (path.resolve(projectRoot, final.worktree ?? ".") !== path.resolve(projectRoot, group.worktree)) fail("pr_card_binding_mismatch", "Card " + id + " worktree does not match its approved group worktree", { group_id: group.id });
    if (final.base_commit !== group.base_commit) fail("pr_card_binding_mismatch", "Card " + id + " base commit differs from approved base", { group_id: group.id });
  }
  const worktree = await realpath(path.resolve(projectRoot, group.worktree)).catch(() => null);
  if (!worktree) fail("pr_worktree_missing", "Group worktree does not exist: " + group.worktree, { group_id: group.id });
  if (path.resolve(runChecked("git", ["rev-parse", "--show-toplevel"], worktree, runner)) !== worktree) fail("pr_worktree_invalid", "Group path is not an independent Git worktree", { group_id: group.id });
  if (runChecked("git", ["branch", "--show-current"], worktree, runner) !== group.branch) fail("pr_branch_mismatch", "Current branch differs from approved group branch", { group_id: group.id });
  const head = runChecked("git", ["rev-parse", "HEAD"], worktree, runner);
  if (runChecked("git", ["status", "--porcelain=v1"], worktree, runner)) fail("pr_worktree_dirty", "Group worktree has uncommitted changes", { group_id: group.id });
  if (runChecked("git", ["remote", "get-url", group.remote], worktree, runner) !== group.remote_url) fail("pr_remote_mismatch", "Git remote URL differs from approved binding", { group_id: group.id });
  const baseRemote = runChecked("git", ["ls-remote", group.remote, "refs/heads/" + group.base_branch], worktree, runner).split(/\s+/)[0];
  if (baseRemote !== group.base_commit) fail("pr_base_drift", "Approved base moved or cannot be validated; obtain new owner approval", { group_id: group.id });
  const remoteHead = runChecked("git", ["ls-remote", group.remote, "refs/heads/" + group.branch], worktree, runner).split(/\s+/)[0];
  if (remoteHead !== head) fail("pr_upstream_unavailable", "Remote branch is missing or differs from local committed branch", { group_id: group.id });
  const actualPaths = runChecked("git", ["diff", "--name-only", group.base_commit, head], worktree, runner).split(/\r?\n/).filter(Boolean).sort();
  const cardsExpectedPaths = [...new Set(group.card_ids.flatMap((id) => {
    const card = snapshot.cards.find((entry) => idOf(entry) === id);
    return list(card?.changed_paths);
  }))].sort();
  const expectedPaths = cardsExpectedPaths.length ? cardsExpectedPaths : [...group.expected_paths].sort();
  if (stableHash(actualPaths) !== stableHash(expectedPaths)) fail("pr_group_delta_mismatch", "Branch diff does not equal the expected grouped Card delta", { group_id: group.id, expected: expectedPaths, actual: actualPaths });
  const expectedCommits = group.card_ids.map((id) => snapshot.cards.find((entry) => idOf(entry) === id)?.final?.commit);
  if (expectedCommits.some((commit) => !GIT_SHA.test(commit ?? "")) || new Set(expectedCommits).size !== expectedCommits.length) {
    fail("pr_group_commit_set_mismatch", "Each approved Card must bind one distinct final commit", { group_id: group.id, expected: expectedCommits });
  }
  const actualCommits = runChecked("git", ["rev-list", "--reverse", group.base_commit + ".." + head], worktree, runner).split(/\r?\n/).filter(Boolean);
  if (actualCommits.length !== expectedCommits.length || stableHash([...actualCommits].sort()) !== stableHash([...expectedCommits].sort())) {
    fail("pr_group_commit_set_mismatch", "Branch commit range does not exactly match one approved final commit per Card", {
      group_id: group.id,
      expected: expectedCommits,
      actual: actualCommits,
    });
  }
  if (canonicalVerifiers) {
    for (const id of group.card_ids) {
      const evidence = canonicalVerifiers.get(id);
      const commit = snapshot.cards.find((card) => idOf(card) === id)?.final?.commit;
      const committed = await calculateCandidateFingerprintAtCommit(worktree, { baseCommit: group.base_commit, commit });
      if (!candidateManifestsBind(evidence?.candidate_manifest, committed.manifest, { expectedBaseCommit: group.base_commit })) {
        fail("pr_card_commit_candidate_mismatch", "Final commit content differs from the independently verified candidate for Card " + id, { group_id: group.id, card_id: id });
      }
    }
  }
  for (const id of group.card_ids) {
    const card = snapshot.cards.find((entry) => idOf(entry) === id);
    for (const dependency of depsOf(card).filter((dep) => !includedCards.has(dep))) {
      const upstream = snapshot.cards.find((entry) => idOf(entry) === dependency);
      const commit = upstream?.final?.commit;
      if (!upstream || !["approved", "APPROVED"].includes(upstream.status ?? upstream.state) || !GIT_SHA.test(commit ?? "")) {
        fail("pr_dependency_unverified", "Unselected dependency " + dependency + " is not approved with a final commit", { group_id: group.id, card_id: id });
      }
      if (runner("git", ["merge-base", "--is-ancestor", commit, group.base_commit], worktree).status !== 0) {
        fail("pr_dependency_unverified", "Unselected dependency " + dependency + " is not contained in the approved base", { group_id: group.id, card_id: id });
      }
    }
  }
  for (const id of group.card_ids) {
    const commit = snapshot.cards.find((card) => idOf(card) === id).final.commit;
    if (runner("git", ["merge-base", "--is-ancestor", commit, head], worktree).status !== 0) fail("pr_card_commit_missing", "Approved Card commit is absent from group branch history: " + id, { group_id: group.id });
  }
  const identity = githubRepo(group.remote_url);
  if (!identity) return { group_id: group.id, worktree, head, manual_handoff: true, reason: "unsupported_git_host" };
  if (!checkHost) return { group_id: group.id, worktree, head, host_repo: identity, manual_handoff: false };
  const view = parseJson(runChecked(gh, ["repo", "view", "--json", "nameWithOwner,url"], worktree, runner), "gh repo view");
  if (String(view.nameWithOwner ?? "").toLowerCase() !== identity) fail("pr_remote_mismatch", "GitHub repository identity differs from the approved remote", { group_id: group.id });
  return { group_id: group.id, worktree, head, host_repo: identity, manual_handoff: false };
}

function prBody(plan, group, snapshot) {
  const marker = "<!-- triad-pr-plan:" + plan.plan_sha256 + ";group:" + group.id + " -->";
  const included = new Set(plan.groups.flatMap((entry) => entry.card_ids));
  const externalDependencies = group.card_ids.flatMap((id) => {
    const card = snapshot.cards.find((entry) => idOf(entry) === id);
    return depsOf(card).filter((dependency) => !included.has(dependency)).map((dependency) => "- " + id + " depends on " + dependency + " (verified in the approved base)");
  });
  const cards = group.card_ids.map((id) => {
    const card = snapshot.cards.find((entry) => idOf(entry) === id);
    const verify = card.verifier ?? card.verification;
    const review = card.reviewer ?? card.review;
    const docs = card.docs_impact ?? card.documentation_impact;
    return "- **" + id + "** — verifier: " + (verify.evidence_path ?? verify.path) + "; Reviewer: " + (review.evidence_path ?? review.path) + "; docs: " + docs.status + " (" + (docs.reference ?? docs.path) + ")";
  });
  const tests = group.card_ids.map((id) => {
    const card = snapshot.cards.find((entry) => idOf(entry) === id);
    return card.test_summary ? "- " + id + ": " + card.test_summary : null;
  }).filter(Boolean);
  return [
    marker, "## Triad+ draft delivery: " + group.card_ids.join(", "), "",
    "**Cards:** " + group.card_ids.join(", "),
    "**Dependencies:** " + (group.dependencies.join(", ") || "none"),
    ...(externalDependencies.length ? ["**Dependencies already in base:**", ...externalDependencies] : []),
    "**Planning rationale:** " + group.rationale,
    "**Documentation impact:** reviewed per Card; details follow.", "",
    "### Independent Card evidence", ...cards, "", "### Test summary",
    ...(tests.length ? tests : ["Consult each Card report for full required-gate output."]), "",
    "### Reviewer instructions",
    "Review the grouped diff against the Card scopes and independent verifier/Reviewer evidence. Check cross-Card integration and documentation impact. This is draft-only; CI is not merge approval.",
  ].join("\n");
}

export async function prepareDraftPullRequests(plan, snapshot, { execute = false, runner = defaultRunner, gh = "gh", onDraft = null, projectRoot = process.cwd() } = {}) {
  const validation = validatePrPlan(plan, snapshot);
  if (!validation.valid) fail("pr_plan_invalid", validation.errors.map((item) => item.message).join("; "), { errors: validation.errors });
  const approval = plan.structural_approval
    ? validateEmbeddedStructuralApproval(plan.structural_approval, plan, snapshot)
    : validatePlanApproval(plan);
  if (!approval.valid) fail("pr_plan_approval_invalid", approval.errors.map((item) => item.message).join("; "), { errors: approval.errors });
  const canonicalVerifiers = plan.structural_approval ? await validateCanonicalDeliveryEvidence(snapshot, projectRoot) : null;
  if (validation.stacked_unsupported) fail("stacked_required/unsupported", "Cross-PR dependencies require stacked execution; automatic creation is refused", {
    dependencies: plan.groups.filter((group) => group.dependencies.length).map((group) => ({ group: group.id, depends_on: group.dependencies })),
  });
  const readiness = [];
  const includedCards = new Set(plan.groups.flatMap((group) => group.card_ids));
  for (const group of plan.groups) {
    const cardErrors = group.card_ids.flatMap((id) => {
      const card = snapshot.cards.find((entry) => idOf(entry) === id);
      return card ? [...evidenceProblems(card), ...evidenceReferenceProblems(card, snapshot)] : ["missing Card " + id];
    });
    if (cardErrors.length) fail("pr_group_evidence_incomplete", cardErrors.join("; "), { group_id: group.id, errors: cardErrors });
    readiness.push(await preflightGroup(group, snapshot, runner, gh, execute, projectRoot, includedCards, canonicalVerifiers));
  }
  const manual = readiness.filter((item) => item.manual_handoff);
  if (manual.length) return { status: "manual_handoff", reason: "unsupported_git_host", details: manual, plan_sha256: approval.plan_sha256, writes_performed: false };
  if (!execute) return {
    status: "dry_run", plan_sha256: approval.plan_sha256, draft_count: plan.groups.length, writes_performed: false,
    groups: readiness.map((item, index) => ({ ...item, effect: "create_draft_pr_only", title: "Triad+ delivery: " + plan.groups[index].card_ids.join(", ") })),
  };
  const auth = runner(gh, ["auth", "status", "--hostname", "github.com"], process.cwd());
  if (auth.status !== 0 || auth.error) fail("pr_host_auth_unavailable", "GitHub CLI authentication is unavailable; no PR was created", { stderr: auth.stderr ?? "" });
  const results = [];
  for (let i = 0; i < plan.groups.length; i += 1) {
    const group = plan.groups[i];
    const ready = readiness[i];
    const marker = "<!-- triad-pr-plan:" + plan.plan_sha256 + ";group:" + group.id + " -->";
    const listText = runChecked(gh, ["pr", "list", "--state", "all", "--head", group.branch, "--json", "number,url,state,isDraft,title,body,baseRefName,headRefName"], ready.worktree, runner);
    const prs = parseJson(listText, "gh pr list");
    if (!Array.isArray(prs)) fail("pr_host_response_invalid", "gh pr list must return an array");
    const existing = prs.filter((pr) => pr.headRefName === group.branch);
    if (existing.length > 1) fail("pr_existing_ambiguous", "Multiple PRs already use branch " + group.branch);
    if (existing.length === 1) {
      const pr = existing[0];
      if (pr.body?.includes(marker) && pr.baseRefName === group.base_branch && pr.isDraft === true && pr.state === "OPEN") {
        const prior = { group_id: group.id, number: pr.number, url: pr.url, status: "already_created" };
        results.push(prior);
        await onDraft?.(prior, results);
        continue;
      }
      fail("pr_existing_conflict", "Existing PR does not match approved draft binding; recovery is required", { group_id: group.id, number: pr.number, url: pr.url });
    }
    const title = "Triad+ delivery: " + group.card_ids.join(", ");
    const body = prBody(plan, group, snapshot);
    const url = runChecked(gh, ["pr", "create", "--draft", "--head", group.branch, "--base", group.base_branch, "--title", title, "--body", body], ready.worktree, runner);
    if (!/^https:\/\/github\.com\//i.test(url)) fail("pr_host_response_invalid", "gh pr create returned no GitHub PR URL");
    const created = { group_id: group.id, url, branch: group.branch, base_branch: group.base_branch, status: "created_draft" };
    results.push(created);
    await onDraft?.(created, results);
  }
  return { status: "created", plan_sha256: approval.plan_sha256, drafts: results, writes_performed: results.some((item) => item.status === "created_draft") };
}

export async function validateSnapshotSources(snapshot, projectRoot, { queueParser } = {}) {
  const errors = [];
  const root = await realpath(projectRoot).catch(() => null);
  if (!root) return { valid: false, errors: [err("pr_source_missing", "Control Workspace does not exist")] };
  if (!Array.isArray(snapshot?.source?.files)) return { valid: false, errors: [err("pr_source_manifest_missing", "Snapshot must bind source file paths and SHA-256 values")] };
  for (const entry of snapshot.source.files) {
    if (!text(entry?.path) || !SHA256.test(entry.sha256 ?? "")) { errors.push(err("pr_source_manifest_invalid", "Malformed source binding")); continue; }
    const resolved = path.resolve(root, entry.path);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) { errors.push(err("pr_source_path_escape", "Source path escapes Control Workspace: " + entry.path)); continue; }
    const physical = await realpath(resolved).catch(() => null);
    if (!physical || (physical !== root && !physical.startsWith(root + path.sep))) { errors.push(err("pr_source_missing", "Source is missing or escapes Control Workspace: " + entry.path)); continue; }
    const actual = hash(await readFile(physical));
    if (actual !== entry.sha256) errors.push(err("pr_source_drift", "Canonical source changed: " + entry.path));
  }
  const sourceFiles = new Map(snapshot.source.files.map((entry) => [entry.path, entry.sha256]));
  for (const card of snapshot.cards ?? []) {
    if (!card.source_path && !card.source_sha256) continue;
    if (!text(card.source_path) || !SHA256.test(card.source_sha256 ?? "") || sourceFiles.get(card.source_path) !== card.source_sha256) {
      errors.push(err("pr_card_source_binding_invalid", "Card source path/hash is not byte-bound: " + idOf(card)));
      continue;
    }
    const physical = await realpath(path.resolve(root, card.source_path)).catch(() => null);
    if (!physical || (physical !== root && !physical.startsWith(root + path.sep))) continue;
    const cardText = await readFile(physical, "utf8");
    const heading = cardText.match(/^#\s+([^\s—–]+)(?:\s+[—–-]\s+(.+))?\s*$/m);
    if (!heading || heading[1] !== idOf(card)) errors.push(err("pr_card_identity_mismatch", "Card source heading does not identify " + idOf(card)));
    else if (heading[2] && text(card.title) && heading[2].trim() !== text(card.title)) errors.push(err("pr_card_identity_mismatch", "Card source title differs from the snapshot: " + idOf(card)));
    const metadata = new Map();
    for (const line of cardText.split(/\r?\n/)) {
      const match = line.match(/^\s*[-*]\s*(Target repository|Dependencies):\s*(.*?)\s*$/i);
      if (match) metadata.set(match[1].toLowerCase(), match[2].replaceAll("`", "").trim());
    }
    const declaredRepository = metadata.get("target repository");
    if (declaredRepository && !/^<.*>$/.test(declaredRepository) && declaredRepository !== "not applicable" && declaredRepository !== repoOf(card)) {
      errors.push(err("pr_card_repository_drift", "Card source repository differs from the snapshot: " + idOf(card)));
    }
    const declaredDependencies = metadata.get("dependencies");
    if (declaredDependencies && !/^<.*>$/.test(declaredDependencies)) {
      const parsedDependencies = /^(?:none|n\/a|not applicable)$/i.test(declaredDependencies)
        ? []
        : list(declaredDependencies.split(/[,;]/));
      if (stableHash(parsedDependencies) !== stableHash(depsOf(card))) errors.push(err("pr_card_dependency_drift", "Card source dependencies differ from the snapshot: " + idOf(card)));
    }
  }
  const files = snapshot.source.files;
  const queue = files.find((entry) => entry.path === (snapshot.source.queue_path ?? ".loop/work-queue.yaml"));
  const project = files.find((entry) => entry.path === (snapshot.source.project_path ?? "project.yaml"));
  if (!queue || queue.sha256 !== snapshot.source.queue_sha256) errors.push(err("pr_queue_binding_invalid", "Canonical queue path/hash is not bound"));
  if (!project || project.sha256 !== snapshot.source.project_sha256) errors.push(err("pr_project_binding_invalid", "project.yaml path/hash is not bound"));
  if (queue && queueParser) {
    const parsed = queueParser(await readFile(path.resolve(root, queue.path), "utf8"));
    if (parsed.unreadable) errors.push(err("pr_queue_unreadable", (parsed.warnings ?? []).join("; ")));
    else {
      const ids = parsed.items.map((item) => item.id).sort();
      if (stableHash(ids) !== stableHash([...(snapshot.canonical_card_ids ?? [])].sort())) errors.push(err("pr_queue_card_set_drift", "Snapshot Card IDs differ from canonical work queue"));
      const cards = new Map((snapshot.cards ?? []).map((card) => [idOf(card), card]));
      for (const item of parsed.items) {
        const card = cards.get(item.id);
        if (!card) continue;
        if (item.title !== undefined && text(item.title) !== text(card.title)) errors.push(err("pr_queue_card_drift", "Snapshot Card title differs from canonical work queue: " + item.id));
        if (item.target_repository !== undefined && text(item.target_repository) !== repoOf(card)) errors.push(err("pr_queue_card_drift", "Snapshot repository differs from canonical work queue: " + item.id));
        if (stableHash(depsOf(card)) !== stableHash(list(item.depends_on))) errors.push(err("pr_queue_card_drift", "Snapshot dependencies differ from canonical work queue: " + item.id));
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
