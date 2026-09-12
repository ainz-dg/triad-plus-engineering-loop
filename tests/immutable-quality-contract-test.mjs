import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadQualityBaseline,
  qualityBaselineFingerprint,
  validateQualityBaselineManifest,
} from "../runtime/lib/quality-baseline.mjs";
import {
  aggregateEvaluatorVerdict,
  validateDeliveryClosureCriteria,
  validateEvaluatorResult,
} from "../runtime/triad-evaluator-validate.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const verifier = path.join(repositoryRoot, "runtime", "triad-verify.mjs");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fileDigest = async (file) => digest(await readFile(file));

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${name} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function expectCode(action, code) {
  assert.throws(action, (error) => error?.code === code, `expected ${code}`);
}

async function expectAsyncCode(action, code) {
  await assert.rejects(action, (error) => error?.code === code, `expected ${code}`);
}

async function makeManifest(root, { criteria = true, sourcePath = "artifacts/quality-bar.md" } = {}) {
  const prdPath = path.join(root, "artifacts", "prd.md");
  const qualityBarPath = path.join(root, "artifacts", "quality-bar.md");
  await mkdir(path.dirname(prdPath), { recursive: true });
  await writeFile(prdPath, "# Product intent\n", "utf8");
  await writeFile(qualityBarPath, "# Quality target\n", "utf8");
  const manifest = {
    schema_version: 1,
    id: "quality-test",
    revision: 1,
    sources: [
      { id: "prd", role: "intent", path: "artifacts/prd.md", sha256: await fileDigest(prdPath) },
      { id: "quality-bar", role: "quality_target", path: sourcePath, sha256: await fileDigest(qualityBarPath) },
    ],
    criteria: criteria ? [
      { id: "QB-001", scope: "product_quality", requirement: "The product meets its target." },
      { id: "QB-010", scope: "delivery_closure", requirement: "The final handoff is complete." },
    ] : [],
  };
  manifest.fingerprint = qualityBaselineFingerprint(manifest);
  const manifestPath = path.join(root, "artifacts", "quality-baseline.json");
  await writeJson(manifestPath, manifest);
  return { manifest, manifestPath, prdPath, qualityBarPath };
}

async function prepareVerifier(root, { gateCommand = "true", quality = true } = {}) {
  const worktree = path.join(root, "product");
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, "candidate.txt"), "candidate\n", "utf8");
  command("git", ["init", "-q"], worktree);
  command("git", ["config", "user.email", "triad-test@example.invalid"], worktree);
  command("git", ["config", "user.name", "Triad Test"], worktree);
  command("git", ["add", "."], worktree);
  command("git", ["commit", "-qm", "baseline"], worktree);
  const branch = command("git", ["branch", "--show-current"], worktree);
  const qualityFiles = quality ? await makeManifest(root) : null;
  if (!quality) {
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await writeFile(path.join(root, "artifacts", "prd.md"), "# Product intent\n", "utf8");
  }
  await mkdir(path.join(root, "features"), { recursive: true });
  const cardPath = path.join(root, "features", "TEST-QUALITY.md");
  await writeFile(cardPath, "# TEST-QUALITY\n", "utf8");
  const gatesPath = path.join(root, ".loop", "quality-gates.yaml");
  await mkdir(path.dirname(gatesPath), { recursive: true });
  await writeFile(gatesPath, `version: 2\ngates:\n  - id: verification\n    command: ${gateCommand}\n    required: true\n    executor: control-plane\n    timeout_seconds: 2\n`, "utf8");
  const assignment = {
    schema_version: 1,
    assignment_id: "assignment-quality",
    status: "active",
    agent_id: "developer-quality",
    agent_type: "triad_developer",
    feature_id: "TEST-QUALITY",
    attempt: 1,
    project_root: root,
    worktree,
    expected_branch: branch,
    allow_external_worktree: true,
    prd_path: "artifacts/prd.md",
    card_path: "features/TEST-QUALITY.md",
    gates_path: ".loop/quality-gates.yaml",
    expected_prd_sha256: await fileDigest(path.join(root, "artifacts", "prd.md")),
    expected_card_sha256: await fileDigest(cardPath),
    expected_gates_sha256: await fileDigest(gatesPath),
    verification_run_id: "run-quality",
  };
  if (quality) {
    assignment.quality_baseline_path = "artifacts/quality-baseline.json";
    assignment.expected_quality_baseline_fingerprint = qualityFiles.manifest.fingerprint;
  }
  const assignmentPath = path.join(root, ".loop", "runtime", "assignments", `${assignment.agent_id}.json`);
  await writeJson(assignmentPath, assignment);
  return { assignment, assignmentPath, qualityFiles, marker: gateCommand.includes("quality-marker") ? gateCommand.split(" ").at(-1) : null };
}

async function runVerifier(root, agentId = "developer-quality") {
  const result = spawnSync(process.execPath, [verifier, "--project", root], {
    input: JSON.stringify({ event: "SubagentStop", agent_id: agentId, agent_type: "triad_developer" }),
    encoding: "utf8",
  });
  assert.ok(result.stdout.trim(), `verifier emitted no output: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  const evidence = output.evidence ? JSON.parse(await readFile(output.evidence, "utf8")) : null;
  return { result, evidence };
}

const root = await mkdtemp(path.join(tmpdir(), "triad-quality-contract-"));
try {
  // Canonical JSON ignores object formatting and key order while preserving arrays.
  const semanticA = {
    schema_version: 1, id: "format", revision: 1,
    sources: [{ id: "prd", role: "intent", path: "artifacts/prd.md", sha256: "a".repeat(64) }],
    criteria: [{ id: "QB-001", scope: "product_quality", requirement: "Pass." }],
  };
  const semanticB = {
    criteria: [{ requirement: "Pass.", scope: "product_quality", id: "QB-001" }],
    revision: 1,
    sources: [{ sha256: "a".repeat(64), path: "artifacts/prd.md", role: "intent", id: "prd" }],
    id: "format", schema_version: 1,
  };
  assert.equal(qualityBaselineFingerprint(semanticA), qualityBaselineFingerprint(semanticB));
  const valid = await makeManifest(root);
  assert.equal((await loadQualityBaseline("artifacts/quality-baseline.json", { projectRoot: root })).fingerprint, valid.manifest.fingerprint);

  // Shape and source-integrity failures are fail-closed and separately classified.
  const missing = structuredClone(valid.manifest);
  missing.sources[1].path = "artifacts/missing.md";
  missing.sources[1].sha256 = "b".repeat(64);
  missing.fingerprint = qualityBaselineFingerprint(missing);
  await writeJson(path.join(root, "artifacts", "quality-baseline.json"), missing);
  await expectAsyncCode(() => loadQualityBaseline("artifacts/quality-baseline.json", { projectRoot: root }), "quality_baseline_invalid");
  await writeFile(valid.qualityBarPath, "# changed quality target\n", "utf8");
  await writeJson(path.join(root, "artifacts", "quality-baseline.json"), valid.manifest);
  await expectAsyncCode(() => loadQualityBaseline("artifacts/quality-baseline.json", { projectRoot: root }), "quality_baseline_drift");
  await writeFile(valid.qualityBarPath, "# Quality target\n", "utf8");

  const invalidPath = structuredClone(valid.manifest);
  invalidPath.sources[0].path = "../outside.md";
  invalidPath.fingerprint = qualityBaselineFingerprint(invalidPath);
  await writeJson(path.join(root, "artifacts", "quality-baseline.json"), invalidPath);
  await expectAsyncCode(() => loadQualityBaseline("artifacts/quality-baseline.json", { projectRoot: root }), "quality_baseline_invalid");
  const duplicateSource = structuredClone(valid.manifest);
  duplicateSource.sources[1].id = duplicateSource.sources[0].id;
  duplicateSource.fingerprint = qualityBaselineFingerprint(duplicateSource);
  expectCode(() => validateQualityBaselineManifest(duplicateSource), "quality_baseline_invalid");
  const duplicateCriterion = structuredClone(valid.manifest);
  duplicateCriterion.criteria[1].id = duplicateCriterion.criteria[0].id;
  duplicateCriterion.fingerprint = qualityBaselineFingerprint(duplicateCriterion);
  expectCode(() => validateQualityBaselineManifest(duplicateCriterion), "quality_baseline_invalid");
  const invalidScope = structuredClone(valid.manifest);
  invalidScope.criteria[0].scope = "security";
  invalidScope.fingerprint = qualityBaselineFingerprint(invalidScope);
  expectCode(() => validateQualityBaselineManifest(invalidScope), "quality_baseline_invalid");
  const wrongFingerprint = structuredClone(valid.manifest);
  wrongFingerprint.fingerprint = "0".repeat(64);
  expectCode(() => validateQualityBaselineManifest(wrongFingerprint), "quality_baseline_invalid");
  await writeJson(path.join(root, "artifacts", "quality-baseline.json"), valid.manifest);

  const legacyRoot = await mkdtemp(path.join(root, "legacy-"));
  const legacy = await prepareVerifier(legacyRoot, { quality: false });
  const legacyRun = await runVerifier(legacyRoot);
  assert.equal(legacyRun.result.status, 0, JSON.stringify(legacyRun.evidence));
  assert.equal(legacyRun.evidence.baseline.quality_baseline_fingerprint, null);

  const correctRoot = await mkdtemp(path.join(root, "correct-"));
  const correct = await prepareVerifier(correctRoot, { gateCommand: "true" });
  const correctRun = await runVerifier(correctRoot);
  assert.equal(correctRun.result.status, 0, JSON.stringify(correctRun.evidence));
  assert.equal(correctRun.evidence.baseline.quality_baseline_fingerprint, correct.qualityFiles.manifest.fingerprint);

  const mismatchRoot = await mkdtemp(path.join(root, "assignment-mismatch-"));
  const mismatch = await prepareVerifier(mismatchRoot, { gateCommand: "true" });
  mismatch.assignment.expected_quality_baseline_fingerprint = "f".repeat(64);
  await writeJson(mismatch.assignmentPath, mismatch.assignment);
  const mismatchRun = await runVerifier(mismatchRoot);
  assert.equal(mismatchRun.result.status, 3);
  assert.equal(mismatchRun.evidence.failure.code, "quality_baseline_drift");

  const gateSkippedRoot = await mkdtemp(path.join(root, "gate-skipped-"));
  const marker = path.join(gateSkippedRoot, "quality-marker");
  const gateSkipped = await prepareVerifier(gateSkippedRoot, { gateCommand: `touch ${marker}` });
  await writeFile(gateSkipped.qualityFiles.qualityBarPath, "# drifted\n", "utf8");
  const gateSkippedRun = await runVerifier(gateSkippedRoot);
  assert.equal(gateSkippedRun.result.status, 3);
  assert.equal(gateSkippedRun.evidence.failure.code, "quality_baseline_drift");
  assert.equal(spawnSync("test", ["-e", marker]).status, 1, "drift must skip expensive gates");

  const baseline = (await loadQualityBaseline("artifacts/quality-baseline.json", { projectRoot: root })).manifest;
  const candidate = "c".repeat(64);
  const productCriteria = [
    { id: "QB-001", scope: "product_quality", verdict: "PASS", summary: "Observed.", evidence_refs: ["evidence/product.json"] },
  ];
  const baseResult = {
    schema_version: 1, feature_id: "TEST-QUALITY", candidate_fingerprint: candidate,
    summary: "Product evaluated.", evidence_refs: ["evidence/product.json"], created_at: "2026-09-12T10:00:00.000Z",
  };
  const validResult = {
    ...baseResult, quality_baseline_fingerprint: baseline.fingerprint, criteria: productCriteria, verdict: "PASS",
  };
  assert.equal(validateEvaluatorResult(validResult, { qualityBaseline: baseline, expectedCandidateFingerprint: candidate }).verdict, "PASS");
  assert.equal(validateEvaluatorResult({ ...baseResult, verdict: "PASS" }).legacy, true);
  expectCode(() => validateEvaluatorResult({ ...validResult, quality_baseline_fingerprint: "0".repeat(64) }, { qualityBaseline: baseline, expectedCandidateFingerprint: candidate }), "evaluator_quality_baseline_mismatch");
  expectCode(() => validateEvaluatorResult({ ...validResult, candidate_fingerprint: "d".repeat(64) }, { qualityBaseline: baseline, expectedCandidateFingerprint: candidate }), "evaluator_candidate_fingerprint_mismatch");
  expectCode(() => validateEvaluatorResult({ ...validResult, criteria: [] }, { qualityBaseline: baseline, expectedCandidateFingerprint: candidate }), "evaluator_result_invalid");
  expectCode(() => validateEvaluatorResult({ ...validResult, criteria: [...productCriteria, ...productCriteria] }, { qualityBaseline: baseline, expectedCandidateFingerprint: candidate }), "evaluator_result_invalid");
  expectCode(() => validateEvaluatorResult({ ...validResult, criteria: [{ ...productCriteria[0], id: "QB-010", scope: "delivery_closure" }] }, { qualityBaseline: baseline, expectedCandidateFingerprint: candidate }), "evaluator_result_invalid");

  assert.equal(aggregateEvaluatorVerdict([{ verdict: "PASS" }, { verdict: "PASS" }]), "PASS");
  assert.equal(aggregateEvaluatorVerdict([{ verdict: "PASS" }, { verdict: "INDETERMINATE" }]), "INDETERMINATE");
  assert.equal(aggregateEvaluatorVerdict([{ verdict: "PASS" }, { verdict: "FAIL" }]), "FAIL");
  assert.equal(aggregateEvaluatorVerdict([{ verdict: "FAIL" }, { verdict: "INDETERMINATE" }]), "FAIL");
  const deliveryResults = [{ id: "QB-010", scope: "delivery_closure", verdict: "PASS", summary: "Closed.", evidence_refs: ["handoff"] }];
  assert.equal(validateDeliveryClosureCriteria(baseline, deliveryResults).can_deliver, true);
  assert.equal(validateDeliveryClosureCriteria(baseline, [{ ...deliveryResults[0], verdict: "FAIL" }]).can_deliver, false);
  assert.equal(validateDeliveryClosureCriteria(baseline, [{ ...deliveryResults[0], verdict: "INDETERMINATE" }]).can_deliver, false);

  console.log("Immutable Quality Contract tests passed: canonical baseline, drift fail-closed, legacy compatibility, evaluator criteria, aggregate verdict, and delivery closure.");
} finally {
  await rm(root, { recursive: true, force: true });
}
