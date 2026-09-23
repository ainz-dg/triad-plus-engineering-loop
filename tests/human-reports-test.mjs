import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { calculateCandidateFingerprintAtCommit } from "../runtime/lib/fingerprint.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = path.join(repositoryRoot, "runtime", "triad-human-report.mjs");

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  return { ...result, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const root = await mkdtemp(path.join(tmpdir(), "triad-human-reports-"));
const product = path.join(root, "product");
const control = path.join(root, "control");
await spawnSync("mkdir", ["-p", product, control]);
git(product, "init", "-q");
await writeFile(path.join(product, "README.md"), "baseline\n", "utf8");
await writeFile(path.join(product, "original.js"), "original\n", "utf8");
git(product, "add", "README.md", "original.js");
git(product, "-c", "user.name=Triad Test", "-c", "user.email=triad@example.test", "commit", "-qm", "baseline");
const baseline = git(product, "rev-parse", "HEAD");
git(product, "mv", "original.js", "renamed.js");
spawnSync("rm", [path.join(product, "README.md")]);
await writeFile(path.join(product, "src.js"), "approved candidate\n", "utf8");
git(product, "add", "-A");
git(product, "-c", "user.name=Triad Test", "-c", "user.email=triad@example.test", "commit", "-qm", "candidate");
const finalCommit = git(product, "rev-parse", "HEAD");
const finalFingerprint = (await calculateCandidateFingerprintAtCommit(product, { baseCommit: baseline, commit: finalCommit })).value;

const input = {
  project_id: "human-report-fixture",
  card: {
    id: "CARD-001",
    title: "Produce a bounded candidate",
    goal: "A deterministic product outcome",
    outcome: "The candidate is ready for delivery.",
    target_repository: "product",
    card_path: "features/CARD-001.md"
  },
  status: "approved",
  implementation: { summary: "Implemented the bounded outcome." },
  attempts: [
    { attempt: 1, outcome: "rework", resolution_kind: "reviewer_rework", candidate_fingerprint: "a".repeat(64), evidence_refs: ["/Users/alice/control/log.txt"], notes: "Reviewer requested a bounded correction." },
    { attempt: 2, outcome: "pass", resolution_kind: "none", candidate_fingerprint: finalFingerprint, notes: "Current candidate verified." }
  ],
  verification: [{ run_id: "verify-2", status: "pass", candidate_fingerprint: finalFingerprint, evidence_path: ".loop/evidence/CARD-001/attempt-002/verification.json", gates: [{ id: "test", status: "pass", evidence_refs: ["/Users/alice/control/gate.log", ".loop/evidence/CARD-001/attempt-002/logs/test.stdout.log"], exit_code: 0, duration_ms: 12 }] }],
  review: { reviewer: "Yuri", decision: "approved", candidate_fingerprint: finalFingerprint, evidence_path: ".loop/reviews/CARD-001.md", risks: ["none"], findings: [{ severity: "low", finding: "No blocking finding.", evidence: "review", resolution: "accepted" }] },
  final: { repository: "product", branch: "feat/card", commit: finalCommit, base_commit: baseline, candidate_fingerprint: finalFingerprint, worktree: product },
  evidence_refs: [".loop/evidence/CARD-001/attempt-002/verification.json"],
  provenance: { assignment_path: ".loop/runtime/assignments/CARD-001.json", assignment_sha256: "c".repeat(64), packet_path: ".loop/runtime/packets/CARD-001.md", packet_sha256: "d".repeat(64), verification_paths: [".loop/evidence/CARD-001/attempt-002/verification.json"], review_path: ".loop/reviews/CARD-001.md" },
  risks: [],
  deferred: []
};
const inputPath = path.join(control, "card-context.json");
const outputPath = path.join(control, "card-reports", "CARD-001.md");
await writeJson(inputPath, input);
const first = run(["--mode", "card", "--project", control, "--input", "card-context.json", "--output", "card-reports/CARD-001.md", "--worktree", product, "--base-commit", baseline], control);
assert.equal(first.status, 0, first.stderr);
const report = await readFile(outputPath, "utf8");
assert.match(report, /# Card report — CARD-001/);
assert.match(report, /src\.js/);
assert.match(report, /renamed\.js/);
assert.match(report, /README\.md/);
assert.match(report, /Assignment Packet/);
assert.match(report, /test\.stdout\.log/);
assert.match(report, /<external path>/);
assert.doesNotMatch(report, /\/Users\/alice\/control/);
assert.match(report, /reviewer_rework/);
assert.match(report, /APPROVED/);
assert.doesNotMatch(report, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const firstContent = report;
await writeFile(path.join(product, "later-card.js"), "a later card on the same branch\n", "utf8");
git(product, "add", "later-card.js");
git(product, "-c", "user.name=Triad Test", "-c", "user.email=triad@example.test", "commit", "-qm", "later card");
const second = run(["--mode", "card", "--project", control, "--input", "card-context.json", "--output", "card-reports/CARD-001.md", "--worktree", product, "--base-commit", baseline], control);
assert.equal(second.status, 0, second.stderr);
assert.equal(await readFile(outputPath, "utf8"), firstContent, "report generation must be idempotent");
assert.doesNotMatch(await readFile(outputPath, "utf8"), /later-card\.js/);

const attemptedOverwrite = { ...input, status: "blocked", reason: "late non-terminal candidate" };
await writeJson(path.join(control, "overwrite.json"), attemptedOverwrite);
const overwrite = run(["--mode", "card", "--project", control, "--input", "overwrite.json", "--output", "card-reports/CARD-001.md"], control);
assert.notEqual(overwrite.status, 0);
assert.match(overwrite.stderr, /approved Card report cannot be overwritten/);

const blockedInput = { project_id: "human-report-fixture", card: { id: "CARD-002", title: "Blocked card" }, status: "blocked", reason: "required external capability is unavailable", attempts: [{ attempt: 1, outcome: "blocked", resolution_kind: "blocked" }], verification: [], review: null, final: { repository: "product", branch: "feat/card" } };
await writeJson(path.join(control, "blocked.json"), blockedInput);
const blocked = run(["--mode", "card", "--project", control, "--input", "blocked.json", "--output", "card-reports/CARD-002.md"], control);
assert.equal(blocked.status, 0, blocked.stderr);
const blockedReport = await readFile(path.join(control, "card-reports", "CARD-002.md"), "utf8");
assert.match(blockedReport, /BLOCKED/);
assert.match(blockedReport, /required external capability/);
assert.doesNotMatch(blockedReport, /approved status/);

const handoffInput = {
  project_id: "human-report-fixture",
  decision: "delivered",
  executive_summary: "One bounded card was approved and delivered.",
  cards: [{ id: "CARD-001", title: "Produce a bounded candidate", status: "approved", summary: "Delivered.", report_path: "card-reports/CARD-001.md", commit: finalCommit, candidate_fingerprint: finalFingerprint, evaluator_report: "/Users/alice/control/evaluator/CARD-001.json", evidence_refs: [".loop/evidence/CARD-001/attempt-002/verification.json"], verification: "PASS", review: "approved" }],
  code_areas: ["src.js"],
  residual: [],
  verification: "All required gates PASS.",
  review: "Independent Reviewer approved.",
  branch_commits: ["product: feat/card @ deadbeef"],
  practical_test: ["Run the product smoke."],
  evaluator: "not configured",
  delivery: "delivered",
  prd_baseline: "artifacts/prd.md @ sha256:prd",
  approved_cards: ["CARD-001"],
  push_evidence: ["origin/feat/card @ pushed"],
  gate_metrics: ["test: PASS"],
  local_worktree_integration: ["product: no separate integration needed"],
  delivery_closure_record: ".loop/run-state.yaml delivery.status=delivered",
  final_message: ".loop/evidence/final-owner-message.md",
  quality_contract: "not configured",
  delivery_criteria: [{ id: "delivery-001", verdict: "PASS", evidence_refs: ["/Users/alice/control/handoff"] }],
  demo: "not configured",
  evidence_refs: [".loop/run-state.yaml"],
  exceptions: [],
  risks: []
};
await writeJson(path.join(control, "handoff-context.json"), handoffInput);
const handoff = run(["--mode", "handoff", "--project", control, "--input", "handoff-context.json", "--output", "handoff.md"], control);
assert.equal(handoff.status, 0, handoff.stderr);
const handoffReport = await readFile(path.join(control, "handoff.md"), "utf8");
assert.match(handoffReport, /## Executive summary/);
assert.match(handoffReport, /Card-by-card results/);
assert.match(handoffReport, /card-reports\/CARD-001\.md/);
assert.match(handoffReport, /Independent Reviewer approved/);
assert.match(handoffReport, /PRD baseline/);
assert.match(handoffReport, /delivery-001/);
assert.match(handoffReport, /<external path>/);
assert.doesNotMatch(handoffReport, /\/Users\/alice\/control/);

const invalid = { ...input, final: { repository: "product", branch: "feat/card", base_commit: baseline } };
await writeJson(path.join(control, "invalid.json"), invalid);
const invalidRun = run(["--mode", "card", "--project", control, "--input", "invalid.json", "--output", "invalid.md"], control);
assert.notEqual(invalidRun.status, 0);
assert.match(invalidRun.stderr, /approved report requires final/);

const wrongFingerprint = { ...input, verification: [{ ...input.verification[0], candidate_fingerprint: "e".repeat(64) }], review: { ...input.review, candidate_fingerprint: "e".repeat(64) }, final: { ...input.final, candidate_fingerprint: "e".repeat(64) } };
await writeJson(path.join(control, "wrong-fingerprint.json"), wrongFingerprint);
const wrongFingerprintRun = run(["--mode", "card", "--project", control, "--input", "wrong-fingerprint.json", "--output", "wrong-fingerprint.md"], control);
assert.notEqual(wrongFingerprintRun.status, 0);
assert.match(wrongFingerprintRun.stderr, /does not match the final commit delta/);

console.log("human report tests passed");
