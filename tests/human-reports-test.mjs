import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { calculateCandidateFingerprintAtCommit } from "../runtime/lib/fingerprint.mjs";
import { renderCardReport, renderHandoffReport } from "../runtime/lib/human-reports.mjs";

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
const attemptOneReviewer = ".loop/evidence/CARD-001/attempt-001/reviewer [v1](notes).md";
const attemptOneHtmlName = ".loop/evidence/CARD-001/attempt-001/reviewer-<script>alert(1)</script>.md";
const attemptOnePreview = ".loop/evidence/CARD-001/attempt-001/preview.json";
const attemptTwoVerification = ".loop/evidence/CARD-001/attempt-002/verification.json";
const attemptTwoGate = ".loop/evidence/CARD-001/attempt-002/logs/test.stdout.log";
const cardReviewer = ".loop/reviews/CARD-001.md";
const assignmentPath = ".loop/runtime/assignments/CARD-001.json";
const packetPath = ".loop/runtime/packets/CARD-001.md";
const sharedReference = ".loop/evidence/CARD-001/attempt-001/shared.log";
const controlSharedPath = path.join(control, sharedReference);
const productSharedPath = path.join(product, sharedReference);
const outsideEvidencePath = path.join(root, "outside-evidence.log");
const symlinkReferencePath = path.join(control, ".loop/evidence/CARD-001/attempt-001/escape.log");
await mkdir(path.dirname(controlSharedPath), { recursive: true });
await mkdir(path.dirname(productSharedPath), { recursive: true });
await writeFile(controlSharedPath, "CONTROL ROOT EVIDENCE\n", "utf8");
await writeFile(productSharedPath, "PRODUCT ROOT EVIDENCE\n", "utf8");
await writeFile(outsideEvidencePath, "outside evidence must not be linked\n", "utf8");
await symlink(outsideEvidencePath, symlinkReferencePath);
for (const reference of [attemptOneReviewer, attemptOneHtmlName, attemptOnePreview, sharedReference, attemptTwoVerification, attemptTwoGate, cardReviewer, assignmentPath, packetPath, ".loop/run-state.yaml"]) {
  const file = path.join(control, reference);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `synthetic ${path.basename(file)}\n`, "utf8");
}

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
    { attempt: 1, outcome: "rework", resolution_kind: "reviewer_rework", candidate_fingerprint: "a".repeat(64), evidence_refs: ["/Users/alice/control/log.txt", attemptOneReviewer, attemptOneHtmlName, attemptOnePreview, controlSharedPath, productSharedPath, sharedReference, symlinkReferencePath, "../../private/key.txt", "https://external.example/review"], notes: "Reviewer requested a bounded correction." },
    { attempt: 2, outcome: "pass", resolution_kind: "none", candidate_fingerprint: finalFingerprint, evidence_refs: [attemptTwoVerification], notes: "Current candidate verified." }
  ],
  verification: [{ run_id: "verify-2", status: "pass", candidate_fingerprint: finalFingerprint, evidence_path: attemptTwoVerification, gates: [{ id: "test", status: "pass", evidence_refs: ["/Users/alice/control/gate.log", attemptTwoGate], exit_code: 0, duration_ms: 12 }] }],
  review: { reviewer: "Yuri", decision: "approved", candidate_fingerprint: finalFingerprint, evidence_path: cardReviewer, risks: ["none"], findings: [{ severity: "low", finding: "No blocking finding.", evidence: "review", resolution: "accepted" }] },
  final: { repository: "product", branch: "feat/card", commit: finalCommit, base_commit: baseline, candidate_fingerprint: finalFingerprint, worktree: product },
  evidence_refs: [attemptTwoVerification],
  provenance: { assignment_path: assignmentPath, assignment_sha256: "c".repeat(64), packet_path: packetPath, packet_sha256: "d".repeat(64), verification_paths: [attemptTwoVerification], review_path: cardReviewer },
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
assert.match(report, /Attempt-local Reviewer document/);
assert.match(report, /Final Card-level Reviewer/);
assert.match(report, /Card-level decision: \*\*approved\*\*/i);
const reportLinks = [...report.matchAll(/\]\(([^)\n]+)\)/g)].map((match) => match[1]);
const attemptOneHref = "../.loop/evidence/CARD-001/attempt-001/reviewer%20%5Bv1%5D%28notes%29.md";
assert.ok(reportLinks.includes(attemptOneHref), "attempt-local Reviewer reference should be a safe relative link");
assert.equal(path.resolve(path.dirname(outputPath), decodeURIComponent(attemptOneHref)), path.join(control, attemptOneReviewer), "attempt-local Reviewer link should resolve from the report directory");
assert.ok(report.includes("&lt;script&gt;alert"), "HTML in a filename should be inert in Markdown link text");
assert.doesNotMatch(report, /<script>/i, "path-derived Markdown labels must not emit raw HTML");
assert.ok(reportLinks.includes("../.loop/reviews/CARD-001.md"), "Card-level Reviewer evidence should be linked separately");
assert.ok(reportLinks.includes("../.loop/runtime/assignments/CARD-001.json"), "assignment evidence should be linked");
assert.ok(reportLinks.includes("../.loop/runtime/packets/CARD-001.md"), "packet evidence should be linked");
assert.ok(reportLinks.includes("../.loop/evidence/CARD-001/attempt-002/verification.json"), "verifier evidence should be linked");
const attemptOneReportCells = report.split("\n").find((line) => line.startsWith("| 1 | rework"))?.split("|").map((cell) => cell.trim()).filter(Boolean) ?? [];
assert.ok(attemptOneReportCells[5]?.includes("reviewer"), "review-named evidence should occupy the Reviewer column");
assert.ok(attemptOneReportCells[6]?.includes("preview.json"), "preview-named evidence should remain ordinary evidence");
const attemptOneRow = report.split("\n").find((line) => line.startsWith("| 1 | rework")) ?? "";
const sharedLinks = [...attemptOneRow.matchAll(/\[[^\]]*\]\(([^)]+shared\.log)\)/g)].map((match) => match[1]);
assert.equal(sharedLinks.length, 1, `only the source whose absolute path belongs to the report root should link when roots contain duplicate relative paths: ${attemptOneRow}`);
assert.equal(path.resolve(path.dirname(outputPath), decodeURIComponent(sharedLinks[0])), controlSharedPath, "the control-root reference must resolve to its exact originating file");
assert.ok(attemptOneRow.includes(`\`${sharedReference}\``), "ambiguous relative evidence must remain plain text");
assert.doesNotMatch(attemptOneRow, /\[[^\]]*escape\.log[^\]]*\]\(/, "a symlink resolving outside declared roots must remain unlinked");
const productRootReport = renderCardReport(input, {
  projectRoot: product,
  worktree: product,
  outputPath: path.join(product, "card-reports", "CARD-001.md"),
});
const productSharedHref = [...productRootReport.matchAll(/\[[^\]]*\]\(([^)]+shared\.log)\)/g)].map((match) => match[1]);
assert.ok(productSharedHref.some((href) => path.resolve(path.dirname(path.join(product, "card-reports", "CARD-001.md")), decodeURIComponent(href)) === productSharedPath), "the product-root absolute reference should resolve to its exact source when the report is in that root");
assert.ok(!reportLinks.some((href) => href.includes("private") || /^https?:/i.test(href)), "traversal and external references must not become links");
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
  cards: [{ id: "CARD-001", title: "Produce a bounded candidate", status: "approved", summary: "Delivered.", report_path: "card-reports/CARD-001.md", commit: finalCommit, candidate_fingerprint: finalFingerprint, evaluator_report: "/Users/alice/control/evaluator/CARD-001.json", evidence_refs: [attemptTwoVerification], verification: "PASS", review: "approved" }],
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
  delivery_criteria: [{ id: "delivery-001", verdict: "PASS", evidence_refs: [attemptTwoGate, "/Users/alice/control/handoff"] }],
  demo: "not configured",
  evidence_refs: [".loop/run-state.yaml"],
  exceptions: [],
  risks: [],
  effort: {
    time: { total_ms: 8040000, basis: "measured", method: "sum of role wall-clock timings", sources: [".loop/run-state.yaml"] },
    tokens: { total: 184000, basis: "estimated", method: "host step_finish totals plus per-turn estimates", sources: [] },
    cost: { total_usd: 3.158971, basis: "measured", method: "sum of provider session cost for the run window", sources: [".loop/run-state.yaml"] },
    cards: [{ id: "CARD-001", elapsed_ms: 600000, tokens: 20000, cost_usd: 0.222637, basis: "estimated" }]
  }
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
assert.match(handoffReport, /## Effort estimate/);
assert.match(handoffReport, /Estimates are informational and are not verification, review, delivery, or billing evidence/i);
assert.match(handoffReport, /\| Project \| 2h 14m \| 184,000 \| \$3\.159 \| time: measured; tokens: estimated; cost: measured \|/);
assert.match(handoffReport, /\| CARD-001 \| 10m \| 20,000 \| \$0\.2226 \| estimated \|/);
assert.match(handoffReport, /Time basis: measured — sum of role wall-clock timings/);
assert.match(handoffReport, /Token basis: estimated — host step_finish totals plus per-turn estimates/);
assert.match(handoffReport, /Cost basis: measured — sum of provider session cost for the run window/);
assert.match(handoffReport, /Effort sources: \[\.loop\/run-state\.yaml\]\(\.loop\/run-state\.yaml\)/);
const noEffortHandoff = renderHandoffReport(
  { ...handoffInput, effort: undefined },
  { projectRoot: control, outputPath: path.join(control, "handoff-no-effort.md") }
);
assert.match(noEffortHandoff, /No effort estimate recorded/);
const summedEffortHandoff = renderHandoffReport(
  { ...handoffInput, effort: { cards: [{ id: "CARD-001", elapsed_ms: 600000, tokens: 20000, cost_usd: 0.2 }, { id: "CARD-002", elapsed_ms: 60000, tokens: 1000, cost_usd: 0.1 }] } },
  { projectRoot: control, outputPath: path.join(control, "handoff-summed-effort.md") }
);
assert.match(summedEffortHandoff, /\| Project \| 11m \| 21,000 \| \$0\.30 \| sum of per-card values \|/);
assert.throws(
  () => renderHandoffReport({ ...handoffInput, effort: { time: { total_ms: -1 } } }),
  /non-negative number/,
  "negative effort figures must be rejected"
);
assert.throws(
  () => renderHandoffReport({ ...handoffInput, effort: { cost: { total_usd: -0.01 } } }),
  /non-negative number/,
  "negative cost figures must be rejected"
);
assert.match(handoffReport, /<external path>/);
assert.match(handoffReport, /\[CARD-001 card report\]\(card-reports\/CARD-001\.md\)/);
assert.match(handoffReport, /\[\.loop\/evidence\/CARD-001\/attempt-002\/verification\.json\]\(\.loop\/evidence\/CARD-001\/attempt-002\/verification\.json\)/);
assert.match(handoffReport, /\[\.loop\/evidence\/CARD-001\/attempt-002\/logs\/test\.stdout\.log\]\(\.loop\/evidence\/CARD-001\/attempt-002\/logs\/test\.stdout\.log\)/);
const handoffLinks = [...handoffReport.matchAll(/\]\(([^)\n]+)\)/g)].map((match) => match[1]);
assert.ok(!handoffLinks.some((href) => href.includes("Users") || /^https?:/i.test(href)), "handoff must not link outside the declared project root");
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
