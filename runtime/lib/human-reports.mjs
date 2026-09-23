import path from "node:path";
import { readFile } from "node:fs/promises";
import { calculateCandidateFingerprintAtCommit, collectCandidateChangesAtCommit } from "./fingerprint.mjs";
import { writeAtomicText } from "./evidence.mjs";

export const HUMAN_REPORT_SCHEMA_VERSION = 1;

function reportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function objectLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw reportError("human_report_invalid", `${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null;
  return requiredString(value, label);
}

function statusLabel(value) {
  return {
    approved: "APPROVED",
    blocked: "BLOCKED",
    not_delivered: "NOT DELIVERED",
    delivery_blocked: "DELIVERY BLOCKED",
    rework: "REWORK",
  }[value] ?? String(value ?? "UNKNOWN").toUpperCase();
}

function text(value, fallback = "Not recorded.") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value).trim() || fallback;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function tableCell(value) {
  return text(value, "—").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function markdownBullet(value) {
  return `- ${text(value)}`;
}

function within(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

/**
 * Reports are views. Absolute machine paths are never emitted in them. A path
 * inside a declared project/worktree is converted to a portable relative ref;
 * an unrelated path is deliberately redacted rather than leaked.
 */
export function reportPath(value, { projectRoot = null, worktree = null } = {}) {
  if (value === null || value === undefined || value === "") return "—";
  const raw = String(value);
  if (!path.isAbsolute(raw)) return raw.replaceAll(path.sep, "/");
  const roots = [projectRoot, worktree].filter(Boolean).map((root) => path.resolve(root));
  for (const root of roots) {
    if (within(root, raw)) {
      const relative = path.relative(root, path.resolve(raw));
      return (relative || ".").split(path.sep).join("/");
    }
  }
  return "<external path>";
}

function changedPathLabel(change, context) {
  if (change?.status === "renamed") {
    return `${reportPath(change.source, context)} → ${reportPath(change.destination, context)}`;
  }
  return reportPath(change?.path, context);
}

function normalizeChangedPaths(changes, context) {
  return list(changes).map((change) => ({
    status: text(change?.status, "modified"),
    path: change?.path,
    source: change?.source,
    destination: change?.destination,
    repository: change?.repository ?? null,
    label: changedPathLabel(change, context),
  }));
}

function validateAttempt(attempt, index, context = {}) {
  if (!objectLike(attempt)) throw reportError("human_report_invalid", `attempt ${index + 1} must be an object`);
  return {
    number: attempt.number ?? attempt.attempt ?? index + 1,
    outcome: text(attempt.outcome ?? attempt.status, "not recorded"),
    resolution: text(attempt.resolution ?? attempt.resolution_kind, "none"),
    candidate_fingerprint: optionalString(attempt.candidate_fingerprint, `attempt ${index + 1} candidate_fingerprint`),
    evidence_refs: list(attempt.evidence_refs).map((ref) => reportPath(ref, context)),
    notes: text(attempt.notes, "—"),
  };
}

function validateVerification(run, index, context = {}) {
  if (!objectLike(run)) throw reportError("human_report_invalid", `verification ${index + 1} must be an object`);
  return {
    run_id: text(run.run_id ?? run.id, `verification-${index + 1}`),
    status: text(run.status, "not recorded"),
    gates: list(run.gates).map((gate) => ({
      id: text(gate?.id, "unknown"),
      status: text(gate?.status, "not recorded"),
      evidence_refs: list(gate?.evidence_refs).map((ref) => reportPath(ref, context)),
      exit_code: gate?.exit_code ?? "—",
      duration_ms: gate?.duration_ms ?? "—",
    })),
    evidence_path: reportPath(run.evidence_path ?? run.path, context),
    candidate_fingerprint: optionalString(run.candidate_fingerprint, `verification ${index + 1} candidate_fingerprint`),
    notes: text(run.notes, "—"),
  };
}

function validateReview(review, context = {}) {
  if (review === null || review === undefined) return null;
  if (!objectLike(review)) throw reportError("human_report_invalid", "review must be an object");
  return {
    decision: text(review.decision, "not recorded"),
    reviewer: text(review.reviewer, "independent Reviewer"),
    evidence_path: reportPath(review.evidence_path ?? review.path, context),
    candidate_fingerprint: optionalString(review.candidate_fingerprint, "review candidate_fingerprint"),
    findings: list(review.findings).map((finding) => ({
      severity: text(finding?.severity, "unspecified"),
      finding: text(finding?.finding, "not recorded"),
      resolution: text(finding?.resolution, "none"),
      evidence: text(finding?.evidence, "not recorded"),
    })),
    risks: list(review.risks),
  };
}

function validateFinal(final, status) {
  if (!objectLike(final)) throw reportError("human_report_invalid", "final must be an object");
  const normalized = {
    branch: optionalString(final.branch, "final branch"),
    commit: optionalString(final.commit ?? final.final_commit, "final commit"),
    base_commit: optionalString(final.base_commit, "final base_commit"),
    candidate_fingerprint: optionalString(final.candidate_fingerprint, "final candidate_fingerprint"),
    worktree: optionalString(final.worktree, "final worktree"),
    repository: optionalString(final.repository, "final repository"),
  };
  if (status === "approved") {
    for (const [key, value] of Object.entries(normalized)) {
      if (["branch", "commit", "candidate_fingerprint", "repository"].includes(key) && !value) {
        throw reportError("human_report_invalid", `approved report requires final.${key}`);
      }
    }
  }
  return normalized;
}

/** Validate and normalize the derived context supplied by the Orchestrator. */
export function normalizeCardReportInput(input, { projectRoot = null, worktree = null } = {}) {
  if (!objectLike(input)) throw reportError("human_report_invalid", "card report input must be an object");
  const card = objectLike(input.card) ? input.card : input;
  const cardId = requiredString(card.id ?? input.card_id, "card id");
  const status = requiredString(input.status ?? input.terminal_status, "terminal status").toLowerCase();
  if (!new Set(["approved", "blocked", "not_delivered", "delivery_blocked"]).has(status)) {
    throw reportError("human_report_invalid", `unsupported terminal status: ${status}`);
  }
  const context = { projectRoot, worktree };
  const final = validateFinal(input.final ?? {}, status);
  const attempts = list(input.attempts).map((attempt, index) => validateAttempt(attempt, index, context));
  const verification = list(input.verification ?? input.verification_runs).map((run, index) => validateVerification(run, index, context));
  const review = validateReview(input.review, context);
  if (status === "approved") {
    const passingRuns = verification.filter((run) => run.status === "pass" || run.status === "PASS");
    if (!passingRuns.length) {
      throw reportError("human_report_invalid", "approved report requires a passing verification run");
    }
    if (!review || !["approved", "APPROVED"].includes(review.decision)) {
      throw reportError("human_report_invalid", "approved report requires an independent Reviewer approval");
    }
    if (!passingRuns.some((run) => run.candidate_fingerprint === final.candidate_fingerprint)) {
      throw reportError("human_report_invalid", "approved report requires passing verifier evidence bound to the final candidate fingerprint");
    }
    if (review.candidate_fingerprint && review.candidate_fingerprint !== final.candidate_fingerprint) {
      throw reportError("human_report_invalid", "Reviewer evidence is bound to a different candidate fingerprint");
    }
  }
  if (status !== "approved" && !text(input.block_reason ?? input.reason, "").trim()) {
    throw reportError("human_report_invalid", "non-approved terminal report requires a truthful reason");
  }
  return {
    schema_version: HUMAN_REPORT_SCHEMA_VERSION,
    project_id: text(input.project_id, "unnamed-project"),
    card: {
      id: cardId,
      title: text(card.title, cardId),
      goal: text(card.goal ?? card.observable_goal ?? card.outcome, "Not recorded."),
      outcome: text(card.outcome ?? input.outcome, "Not recorded."),
      repository: text(card.target_repository ?? card.repository ?? final.repository, "Not recorded."),
      card_path: reportPath(card.card_path, context),
      context: text(card.context, "Not recorded."),
    },
    status,
    block_reason: text(input.block_reason ?? input.reason, "None recorded."),
    implementation: {
      summary: text(input.implementation?.summary ?? input.implemented, status === "approved" ? "Implementation completed." : "No delivered implementation claimed."),
      paths: normalizeChangedPaths(input.implementation?.paths ?? [], context),
    },
    attempts,
    verification,
    review,
    final,
    provenance: {
      assignment_path: reportPath(input.provenance?.assignment_path, context),
      assignment_sha256: text(input.provenance?.assignment_sha256, "not recorded"),
      packet_path: reportPath(input.provenance?.packet_path, context),
      packet_sha256: text(input.provenance?.packet_sha256, "not recorded"),
      verification_paths: list(input.provenance?.verification_paths).map((ref) => reportPath(ref, context)),
      review_path: reportPath(input.provenance?.review_path, context),
    },
    risks: list(input.risks),
    deferred: list(input.deferred),
    evidence_refs: list(input.evidence_refs).map((ref) => reportPath(ref, context)),
    generated_from: text(input.generated_from, "canonical control-plane evidence"),
    changed_paths: input.changed_paths === undefined ? null : normalizeChangedPaths(input.changed_paths, context),
    changed_paths_base: input.changed_paths_base ?? final.base_commit ?? null,
    context,
  };
}

function changedPathsForReport(report) {
  if (report.changed_paths !== null) return report.changed_paths;
  return [];
}

export function renderCardReport(input, options = {}) {
  const report = input.schema_version === HUMAN_REPORT_SCHEMA_VERSION && input.card?.id
    ? input
    : normalizeCardReportInput(input, options);
  const changed = changedPathsForReport(report);
  const status = statusLabel(report.status);
  const verificationRows = report.verification.flatMap((run) => run.gates.length
    ? run.gates.map((gate) => `| ${tableCell(run.run_id)} | ${tableCell(gate.id)} | ${tableCell(gate.status)} | ${tableCell(gate.exit_code)} | ${tableCell(gate.duration_ms)} | ${tableCell([run.evidence_path, ...gate.evidence_refs].filter((ref) => ref && ref !== "—").join(", "))} |`)
    : [`| ${tableCell(run.run_id)} | — | ${tableCell(run.status)} | — | — | ${tableCell(run.evidence_path)} |`]);
  const attemptRows = report.attempts.length
    ? report.attempts.map((attempt) => `| ${tableCell(attempt.number)} | ${tableCell(attempt.outcome)} | ${tableCell(attempt.resolution)} | ${tableCell(attempt.candidate_fingerprint)} | ${tableCell(attempt.notes)} | ${tableCell(attempt.evidence_refs.join(", "))} |`)
    : ["| — | No attempts recorded | — | — | — | — |"];
  const changedRows = changed.length
    ? changed.map((entry) => `| ${tableCell(entry.status)} | ${tableCell(entry.label)} | ${tableCell(entry.repository ?? report.card.repository)} |`)
    : ["| — | No changed paths recorded from the card baseline | — |"];
  const review = report.review;
  const findings = review?.findings?.length
    ? review.findings.map((finding) => `| ${tableCell(finding.severity)} | ${tableCell(finding.finding)} | ${tableCell(finding.evidence)} | ${tableCell(finding.resolution)} |`)
    : ["| — | No findings recorded | — | None |"];
  const finalEvidence = report.status === "approved"
    ? `- Final commit: \`${tableCell(report.final.commit)}\`\n- Candidate fingerprint: \`${tableCell(report.final.candidate_fingerprint)}\`\n- Reviewer decision: \`${tableCell(review?.decision)}\``
    : `- Terminal state: \`${status}\`\n- Reason: ${text(report.block_reason)}`;
  return `# Card report — ${report.card.id}: ${report.card.title}

> Derived human-readable view of canonical Triad+ evidence. This report is not a new source of truth.

## Result

**${status}**

- Project: ${tableCell(report.project_id)}
- Repository: ${tableCell(report.card.repository)}
- Goal: ${tableCell(report.card.goal)}
- Outcome: ${tableCell(report.card.outcome)}
- Card path: \`${tableCell(report.card.card_path)}\`

## What was implemented

${text(report.implementation.summary)}

## Card-attributable changed paths

Baseline: \`${tableCell(report.changed_paths_base)}\`

| Status | Path | Repository |
| --- | --- | --- |
${changedRows.join("\n")}

## Verification and gates

| Verification run | Gate | Status | Exit code | Duration (ms) | Evidence |
| --- | --- | --- | --- | --- | --- |
${verificationRows.join("\n")}

## Attempts and rework

| Attempt | Outcome | Resolution | Candidate fingerprint | Notes | Evidence |
| --- | --- | --- | --- | --- | --- |
${attemptRows.join("\n")}

## Independent Reviewer

- Reviewer: ${tableCell(review?.reviewer ?? "Not dispatched")}
- Decision: **${tableCell(review?.decision ?? "not recorded")}**
- Evidence: \`${tableCell(review?.evidence_path ?? "not recorded")}\`

| Severity | Finding | Evidence | Resolution |
| --- | --- | --- | --- |
${findings.join("\n")}

${review?.risks?.length ? `Reviewer risks:\n${review.risks.map(markdownBullet).join("\n")}` : "Reviewer risks: none recorded."}

## Final evidence and provenance

${finalEvidence}

- Branch: \`${tableCell(report.final.branch)}\`
- Repository baseline: \`${tableCell(report.final.base_commit)}\`
- Source: ${tableCell(report.generated_from)}
- Evidence references: ${report.evidence_refs.length ? report.evidence_refs.map((ref) => `\`${tableCell(ref)}\``).join(", ") : "none recorded"}
- Assignment: \`${tableCell(report.provenance.assignment_path)}\` (${tableCell(report.provenance.assignment_sha256)})
- Assignment Packet: \`${tableCell(report.provenance.packet_path)}\` (${tableCell(report.provenance.packet_sha256)})
- Verification references: ${report.provenance.verification_paths.length ? report.provenance.verification_paths.map((ref) => `\`${tableCell(ref)}\``).join(", ") : "none recorded"}

## Risks, deferred work, and terminal notes

${report.risks.length ? report.risks.map(markdownBullet).join("\n") : "- No residual risks recorded."}
${report.deferred.length ? report.deferred.map((item) => `- Deferred: ${text(item)}`).join("\n") : "- No deferred items recorded."}
${report.status !== "approved" ? `- Terminal reason: ${text(report.block_reason)}` : "- The card reached approved status after current verification and independent review."}
`;
}

function normalizeHandoffInput(input, options = {}) {
  if (!objectLike(input)) throw reportError("human_report_invalid", "handoff input must be an object");
  const cards = list(input.cards).map((card) => ({
    id: requiredString(card.id, "handoff card id"),
    title: text(card.title, card.id),
    status: text(card.status, "not recorded"),
    summary: text(card.summary ?? card.outcome, "Not recorded."),
    report_path: reportPath(card.report_path, options),
    commit: optionalString(card.commit, `handoff card ${card.id} commit`),
    candidate_fingerprint: optionalString(card.candidate_fingerprint, `handoff card ${card.id} candidate_fingerprint`),
    verification: text(card.verification, "Not recorded."),
    review: text(card.review, "Not recorded."),
    evaluator_report: reportPath(card.evaluator_report, options),
    evidence_refs: list(card.evidence_refs).map((ref) => reportPath(ref, options)),
  }));
  if (!cards.length) throw reportError("human_report_invalid", "handoff requires at least one card result");
  return {
    project_id: text(input.project_id, "unnamed-project"),
    decision: requiredString(input.decision, "handoff decision"),
    executive_summary: text(input.executive_summary ?? input.summary, "Not recorded."),
    cards,
    code_areas: list(input.code_areas),
    residual: list(input.residual ?? input.deferred),
    verification: text(input.verification, "Not recorded."),
    review: text(input.review, "Not recorded."),
    branch_commits: list(input.branch_commits),
    practical_test: list(input.practical_test),
    evaluator: text(input.evaluator, "Not configured."),
    delivery: text(input.delivery, "Not recorded."),
    quality_contract: text(input.quality_contract, "Not configured."),
    delivery_criteria: list(input.delivery_criteria).map((criterion) => ({
      ...criterion,
      evidence_refs: list(criterion?.evidence_refs).map((ref) => reportPath(ref, options)),
    })),
    demo: text(input.demo, "Not configured."),
    evidence_refs: list(input.evidence_refs).map((ref) => reportPath(ref, options)),
    exceptions: list(input.exceptions),
    prd_baseline: text(input.prd_baseline, "Not recorded."),
    approved_cards: list(input.approved_cards),
    push_evidence: list(input.push_evidence),
    gate_metrics: list(input.gate_metrics),
    local_worktree_integration: list(input.local_worktree_integration),
    delivery_closure_record: text(input.delivery_closure_record, "Not recorded."),
    final_message: text(input.final_message, "Not recorded."),
    risks: list(input.risks),
    generated_from: text(input.generated_from, "canonical control-plane evidence"),
  };
}

export function renderHandoffReport(input, options = {}) {
  const handoff = input.project_id && Array.isArray(input.cards) && input.cards[0]?.report_path !== undefined
    ? input
    : normalizeHandoffInput(input, options);
  const cardRows = handoff.cards.map((card) => `| ${tableCell(card.id)} | ${tableCell(card.title)} | **${tableCell(statusLabel(card.status))}** | ${tableCell(card.summary)} | ${tableCell(card.commit)} | ${tableCell(card.candidate_fingerprint)} | ${tableCell(card.evaluator_report)} | [Card report](${tableCell(card.report_path)}) |`);
  const links = handoff.cards.map((card) => `- [${card.id} card report](${card.report_path})`).join("\n");
  return `# Delivery handoff — ${handoff.project_id}

## Executive summary

**${tableCell(statusLabel(handoff.decision))}**

${handoff.executive_summary}

## Card-by-card results

| Card | Title | Result | Outcome | Commit | Candidate fingerprint | Evaluator+ | Human-readable report |
| --- | --- | --- | --- | --- | --- | --- | --- |
${cardRows.join("\n")}

${links}

## Main code areas, problem, and resolution

${handoff.code_areas.length ? handoff.code_areas.map((item) => `- ${text(item)}`).join("\n") : "- Not recorded."}

## Residual, deferred, and blocked items

${handoff.residual.length ? handoff.residual.map((item) => `- ${text(item)}`).join("\n") : "- None recorded."}

## Verification and review status

- Verification: ${handoff.verification}
- Independent review: ${handoff.review}
- Evaluator+: ${handoff.evaluator}
- Delivery closure: ${handoff.delivery}

- PRD baseline: ${handoff.prd_baseline}
- Approved cards: ${handoff.approved_cards.length ? handoff.approved_cards.map((item) => text(item)).join(", ") : "Not recorded."}
- Push evidence: ${handoff.push_evidence.length ? handoff.push_evidence.map((item) => text(item)).join("; ") : "Not recorded."}
- Gates and metrics: ${handoff.gate_metrics.length ? handoff.gate_metrics.map((item) => text(item)).join("; ") : "Not recorded."}

## Quality and delivery closure

- Quality Contract: ${handoff.quality_contract}
- Demo: ${handoff.demo}

${handoff.delivery_criteria.length ? `| Criterion | Verdict | Evidence |\n| --- | --- | --- |\n${handoff.delivery_criteria.map((criterion) => `| ${tableCell(criterion?.id)} | ${tableCell(criterion?.verdict)} | ${tableCell(criterion?.evidence_refs?.join(", "))} |`).join("\n")}` : "No delivery criteria recorded."}

- Delivery closure record: ${handoff.delivery_closure_record}
- Final delivery message: ${handoff.final_message}

## Branch, commit, and evidence map

${handoff.branch_commits.length ? handoff.branch_commits.map((item) => `- ${text(item)}`).join("\n") : "- Not recorded."}

${handoff.local_worktree_integration.length ? `### Local-worktree integration\n${handoff.local_worktree_integration.map((item) => `- ${text(item)}`).join("\n")}` : "### Local-worktree integration\n- Not recorded."}

## Practical test / follow-up

${handoff.practical_test.length ? handoff.practical_test.map((item) => `- ${text(item)}`).join("\n") : "- No practical test recorded."}

## Exceptions and evidence references

${handoff.exceptions.length ? handoff.exceptions.map((item) => `- ${text(item)}`).join("\n") : "- No exceptions recorded."}
${handoff.evidence_refs.length ? handoff.evidence_refs.map((item) => `- \`${tableCell(item)}\``).join("\n") : "- No additional evidence references recorded."}

## Risks

${handoff.risks.length ? handoff.risks.map((item) => `- ${text(item)}`).join("\n") : "- None recorded."}

## Canonical record boundary

This Markdown handoff is a derived view generated from ${handoff.generated_from}. Technical delivery gates, evaluator results, evidence paths, branch/commit data, demo details, and quality-contract closure remain authoritative in the control records referenced above.
`;
}

/**
 * Generate a card report while attributing paths to the complete card baseline.
 * The changed-path manifest is collected from Git, never from Developer prose.
 */
export async function writeCardReport(input, { outputPath, projectRoot = null, worktree = null, baseCommit = null } = {}) {
  const preliminary = normalizeCardReportInput(input, { projectRoot, worktree });
  let changedPaths = preliminary.changed_paths;
  let changedPathsBase = preliminary.changed_paths_base ?? baseCommit;
  if (preliminary.status === "approved") {
    if (!worktree || !(baseCommit ?? preliminary.final.base_commit) || !preliminary.final.commit) {
      throw reportError("human_report_invalid", "approved card report requires a worktree, card baseline, and final commit for canonical evidence");
    }
    const candidate = await collectCandidateChangesAtCommit(worktree, {
      baseCommit: baseCommit ?? preliminary.final.base_commit,
      commit: preliminary.final.commit,
    });
    changedPaths = normalizeChangedPaths(candidate.changes, { projectRoot, worktree });
    changedPathsBase = candidate.base_commit;
    const actualFingerprint = await calculateCandidateFingerprintAtCommit(worktree, {
      baseCommit: candidate.base_commit,
      commit: candidate.git_head,
    });
    if (actualFingerprint.value !== preliminary.final.candidate_fingerprint) {
      throw reportError("human_report_invalid", "final candidate fingerprint does not match the final commit delta");
    }
  }
  const report = { ...preliminary, changed_paths: changedPaths ?? [], changed_paths_base: changedPathsBase };
  const markdown = renderCardReport(report, { projectRoot, worktree });
  if (outputPath) {
    try {
      const previous = await readFile(outputPath, "utf8");
      const previousApproved = /\n\*\*APPROVED\*\*\n/.test(previous);
      if (previousApproved && report.status !== "approved") {
        throw reportError("human_report_immutable", "an approved Card report cannot be overwritten by a non-approved terminal view");
      }
      if (previousApproved && previous !== markdown) {
        throw reportError("human_report_immutable", "an approved Card report cannot be changed after publication");
      }
      if (previous === markdown) return { report, markdown, outputPath };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeAtomicText(outputPath, markdown);
  }
  return { report, markdown, outputPath: outputPath ?? null };
}

export async function writeHandoffReport(input, { outputPath, projectRoot = null } = {}) {
  const handoff = normalizeHandoffInput(input, { projectRoot });
  const markdown = renderHandoffReport(handoff, { projectRoot });
  if (outputPath) await writeAtomicText(outputPath, markdown);
  return { handoff, markdown, outputPath: outputPath ?? null };
}
