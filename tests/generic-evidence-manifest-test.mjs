import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { calculateCandidateFingerprint } from "../runtime/lib/fingerprint.mjs";
import { loadEvidenceManifest } from "../runtime/lib/evidence-manifest.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const verifier = path.join(repositoryRoot, "runtime", "triad-verify.mjs");
const packetCli = path.join(repositoryRoot, "runtime", "triad-assignment-packet.mjs");

const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, json(value));
}

async function prepareFixture(root, { declareManifest = true, mutateCandidate = false } = {}) {
  const control = path.join(root, "control");
  const product = path.join(control, "product");
  const evidence = path.join(control, ".loop", "evidence", "VISUAL-001", "attempt-001");
  const assignmentDir = path.join(control, ".loop", "runtime", "assignments");
  await mkdir(path.join(control, "artifacts"), { recursive: true });
  await mkdir(path.join(control, "features"), { recursive: true });
  await mkdir(assignmentDir, { recursive: true });
  await mkdir(product, { recursive: true });
  await writeFile(path.join(product, "candidate.txt"), "baseline\n");
  for (const args of [["init", "-q"], ["config", "user.email", "triad-test@example.invalid"], ["config", "user.name", "Triad Test"], ["add", "."], ["commit", "-qm", "baseline"]]) {
    const result = run("git", args, product);
    assert.equal(result.status, 0, result.stderr);
  }
  const branch = run("git", ["branch", "--show-current"], product).stdout.trim();
  const prdPath = path.join(control, "artifacts", "prd.md");
  const cardPath = path.join(control, "features", "VISUAL-001.md");
  const gatesPath = path.join(control, ".loop", "quality-gates.yaml");
  await writeFile(prdPath, "# Visual evidence fixture\n");
  await writeFile(cardPath, "# VISUAL-001\n\n## Outcome and scope\n\nBounded evidence fixture.\n\n## Acceptance criteria\n\n- Capture is bound to the verified candidate.\n");
  const assignment = {
    schema_version: 1,
    assignment_id: "assignment-visual-001",
    status: "active",
    agent_id: "developer-visual-001",
    agent_type: "triad_developer",
    feature_id: "VISUAL-001",
    attempt: 1,
    project_root: path.resolve(control),
    worktree: path.resolve(product),
    expected_branch: branch,
    repository_id: "product",
    prd_path: "artifacts/prd.md",
    card_path: "features/VISUAL-001.md",
    gates_path: ".loop/quality-gates.yaml",
    expected_prd_sha256: digest(await readFile(prdPath)),
    expected_card_sha256: digest(await readFile(cardPath)),
    verification_run_id: "run-visual-001",
    evidence_directory: ".loop/evidence/VISUAL-001/attempt-001",
    ...(declareManifest ? { evidence_manifest_path: ".loop/evidence/VISUAL-001/attempt-001/manifest.json" } : {}),
  };
  const candidateFingerprint = (await calculateCandidateFingerprint(product)).value;
  const screenshot = Buffer.from("PNG-fixture-bytes\n");
  const textual = JSON.stringify({ story: "fixture", viewport: { width: 390, height: 844 }, visible_nodes: 3 }) + "\n";
  const emitter = path.join(root, mutateCandidate ? "emit-and-mutate.mjs" : "emit.mjs");
  await writeFile(emitter, `import { mkdir, writeFile } from "node:fs/promises";\nimport { createHash } from "node:crypto";\nconst root = ${JSON.stringify(evidence)};\nconst screenshot = Buffer.from(${JSON.stringify(screenshot.toString())});\nconst textual = ${JSON.stringify(textual)};\nawait mkdir(root, { recursive: true });\nawait writeFile(root + "/fixture.png", screenshot);\nawait writeFile(root + "/browser-facts.json", textual);\nconst digest = (value) => createHash("sha256").update(value).digest("hex");\nconst manifest = { schema_version: 1, run_id: "run-visual-001", assignment_id: "assignment-visual-001", feature_id: "VISUAL-001", attempt: 1, candidate_fingerprint: ${JSON.stringify(candidateFingerprint)}, status: "current", artifacts: [\n  { path: "fixture.png", media_type: "image/png", sha256: digest(screenshot), size_bytes: screenshot.length, producer_gate_id: "visual-check", run_id: "run-visual-001", assignment_id: "assignment-visual-001", candidate_fingerprint: ${JSON.stringify(candidateFingerprint)}, status: "current" },\n  { path: "browser-facts.json", media_type: "application/json", sha256: digest(textual), size_bytes: Buffer.byteLength(textual), producer_gate_id: "visual-check", run_id: "run-visual-001", assignment_id: "assignment-visual-001", candidate_fingerprint: ${JSON.stringify(candidateFingerprint)}, status: "current" }\n] };\nawait writeFile(root + "/manifest.json", JSON.stringify(manifest, null, 2) + "\\n");\n${mutateCandidate ? `await writeFile(${JSON.stringify(path.join(product, "candidate.txt"))}, "mutated during gate\\n");` : ""}\n`);
  const gateSource = JSON.stringify({
    schema_version: 1,
    gates: [{ id: "visual-check", command: `node ${JSON.stringify(emitter)}`, required: true, executor: "control-plane", timeout_seconds: 10 }]
  });
  await writeFile(gatesPath, `${gateSource}\n`);
  assignment.expected_gates_sha256 = digest(await readFile(gatesPath));
  const assignmentPath = path.join(assignmentDir, `${assignment.agent_id}.json`);
  await writeJson(assignmentPath, assignment);
  return { control, product, evidence, assignment, assignmentPath, emitter, candidateFingerprint };
}

function runVerifier(fixture) {
  const result = spawnSync(process.execPath, [verifier, "--project", fixture.control], {
    cwd: fixture.control,
    input: JSON.stringify({ event: "SubagentStop", agent_id: fixture.assignment.agent_id, agent_type: "triad_developer" }),
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = result.stdout.trim() ? JSON.parse(result.stdout.trim().split("\n").at(-1)) : null;
  const evidence = output?.evidence ? JSON.parse(readFileSync(output.evidence, "utf8")) : null;
  return { result, output, evidence };
}

async function bindPacket(fixture) {
  const packet = run(process.execPath, [packetCli, "--project", fixture.control, "--assignment", fixture.assignmentPath], fixture.control);
  assert.equal(packet.status, 0, packet.stderr);
  return JSON.parse(packet.stdout);
}

const root = await mkdtemp(path.join(os.tmpdir(), "triad-generic-evidence-manifest-"));
try {
  const fixture = await prepareFixture(path.join(root, "valid"));
  const packet = await bindPacket(fixture);
  const packetSource = await readFile(path.join(fixture.control, packet.packet_path), "utf8");
  assert.match(packetSource, /evidence_manifest_path/);
  const valid = runVerifier(fixture);
  assert.equal(valid.result.status, 0, `${valid.result.stderr}\n${valid.result.stdout}`);
  assert.equal(valid.evidence.status, "pass");
  assert.equal(valid.evidence.artifact_manifest.run_id, fixture.assignment.verification_run_id);
  assert.equal(valid.evidence.artifact_manifest.assignment_id, fixture.assignment.assignment_id);
  assert.equal(valid.evidence.artifact_manifest.candidate_fingerprint, fixture.candidateFingerprint);
  assert.deepEqual(valid.evidence.artifact_manifest.artifacts.map((item) => item.media_type), ["image/png", "application/json"]);

  const legacy = await prepareFixture(path.join(root, "legacy"), { declareManifest: false });
  const legacyResult = runVerifier(legacy);
  assert.equal(legacyResult.result.status, 0, legacyResult.result.stderr);
  assert.equal(legacyResult.evidence.status, "pass");
  assert.equal(legacyResult.evidence.artifact_manifest, undefined);

  const mutated = await prepareFixture(path.join(root, "mutated"), { mutateCandidate: true });
  const mutatedResult = runVerifier(mutated);
  assert.equal(mutatedResult.result.status, 2);
  assert.equal(mutatedResult.evidence.status, "invalidated");
  assert.equal(mutatedResult.evidence.failure.code, "candidate_changed_after_verification");

  const direct = await loadEvidenceManifest({
    projectRoot: fixture.control,
    manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json",
    expectedRunId: "run-visual-001",
    expectedAssignmentId: "assignment-visual-001",
    expectedFeatureId: "VISUAL-001",
    expectedAttempt: 1,
    expectedCandidateFingerprint: fixture.candidateFingerprint,
    producerGateIds: ["visual-check"],
  });
  assert.equal(direct.artifacts.length, 2);
  await assert.rejects(
    () => loadEvidenceManifest({
      projectRoot: fixture.control,
      manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json",
      expectedRunId: "run-visual-001",
      expectedAssignmentId: "assignment-visual-001",
      expectedFeatureId: "VISUAL-001",
      expectedAttempt: 1,
      expectedCandidateFingerprint: fixture.candidateFingerprint,
      producerGateIds: [],
    }),
    (error) => error?.code === "evidence_manifest_invalid" && /passing producer gate/.test(error.message)
  );
  await assert.rejects(
    () => loadEvidenceManifest({
      projectRoot: fixture.control,
      manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json",
      expectedRunId: "run-visual-001",
      expectedAssignmentId: "assignment-visual-001",
      expectedFeatureId: "VISUAL-001",
      expectedAttempt: 1,
      expectedCandidateFingerprint: null,
      producerGateIds: ["visual-check"],
    }),
    (error) => error?.code === "evidence_manifest_invalid" && /expected candidate fingerprint is required/.test(error.message)
  );

  const manifestPath = path.join(fixture.evidence, "manifest.json");
  const originalManifest = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(originalManifest);
  manifest.artifacts[0].sha256 = "0".repeat(64);
  await writeFile(manifestPath, json(manifest));
  await assert.rejects(
    () => loadEvidenceManifest({ projectRoot: fixture.control, manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json", expectedRunId: "run-visual-001", expectedAssignmentId: "assignment-visual-001", expectedFeatureId: "VISUAL-001", expectedAttempt: 1, expectedCandidateFingerprint: fixture.candidateFingerprint, producerGateIds: ["visual-check"] }),
    (error) => error?.code === "evidence_manifest_invalid" && /SHA-256 mismatch/.test(error.message)
  );
  await writeFile(manifestPath, originalManifest);
  const unknownManifestProperty = { ...JSON.parse(originalManifest), unexpected: true };
  await writeFile(manifestPath, json(unknownManifestProperty));
  await assert.rejects(
    () => loadEvidenceManifest({ projectRoot: fixture.control, manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json", expectedRunId: "run-visual-001", expectedAssignmentId: "assignment-visual-001", expectedFeatureId: "VISUAL-001", expectedAttempt: 1, expectedCandidateFingerprint: fixture.candidateFingerprint, producerGateIds: ["visual-check"] }),
    (error) => error?.code === "evidence_manifest_invalid" && /unknown property/.test(error.message)
  );
  await writeFile(manifestPath, originalManifest);
  const missing = { ...JSON.parse(originalManifest), artifacts: [{ ...JSON.parse(originalManifest).artifacts[0], path: "missing.png" }] };
  await writeFile(manifestPath, json(missing));
  await assert.rejects(
    () => loadEvidenceManifest({ projectRoot: fixture.control, manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json", expectedRunId: "run-visual-001", expectedAssignmentId: "assignment-visual-001", expectedFeatureId: "VISUAL-001", expectedAttempt: 1, expectedCandidateFingerprint: fixture.candidateFingerprint, producerGateIds: ["visual-check"] }),
    (error) => error?.code === "evidence_manifest_invalid" && /is missing/.test(error.message)
  );
  await writeFile(manifestPath, originalManifest);
  const wrongCandidate = JSON.parse(originalManifest);
  wrongCandidate.candidate_fingerprint = "f".repeat(64);
  wrongCandidate.artifacts = wrongCandidate.artifacts.map((item) => ({ ...item, candidate_fingerprint: wrongCandidate.candidate_fingerprint }));
  await writeFile(manifestPath, json(wrongCandidate));
  await assert.rejects(
    () => loadEvidenceManifest({ projectRoot: fixture.control, manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json", expectedRunId: "run-visual-001", expectedAssignmentId: "assignment-visual-001", expectedFeatureId: "VISUAL-001", expectedAttempt: 1, expectedCandidateFingerprint: fixture.candidateFingerprint, producerGateIds: ["visual-check"] }),
    (error) => error?.code === "evidence_manifest_invalid" && /candidate_fingerprint/.test(error.message)
  );
  await writeFile(manifestPath, originalManifest);
  const wrongSize = JSON.parse(originalManifest);
  wrongSize.artifacts[0].size_bytes += 1;
  await writeFile(manifestPath, json(wrongSize));
  await assert.rejects(
    () => loadEvidenceManifest({ projectRoot: fixture.control, manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json", expectedRunId: "run-visual-001", expectedAssignmentId: "assignment-visual-001", expectedFeatureId: "VISUAL-001", expectedAttempt: 1, expectedCandidateFingerprint: fixture.candidateFingerprint, producerGateIds: ["visual-check"] }),
    (error) => error?.code === "evidence_manifest_invalid" && /size mismatch/.test(error.message)
  );
  await writeFile(manifestPath, originalManifest);
  const outside = { ...JSON.parse(originalManifest), artifacts: [{ ...JSON.parse(originalManifest).artifacts[0], path: "../../outside.png" }] };
  await writeFile(manifestPath, json(outside));
  await assert.rejects(
    () => loadEvidenceManifest({ projectRoot: fixture.control, manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json", expectedRunId: "run-visual-001", expectedAssignmentId: "assignment-visual-001", expectedFeatureId: "VISUAL-001", expectedAttempt: 1, expectedCandidateFingerprint: fixture.candidateFingerprint, producerGateIds: ["visual-check"] }),
    (error) => error?.code === "evidence_manifest_invalid" && /(escapes|parent traversal)/.test(error.message)
  );
  await writeFile(manifestPath, originalManifest);
  const lexicalTraversal = { ...JSON.parse(originalManifest), artifacts: [{ ...JSON.parse(originalManifest).artifacts[0], path: "nested/../fixture.png" }] };
  await writeFile(manifestPath, json(lexicalTraversal));
  await assert.rejects(
    () => loadEvidenceManifest({ projectRoot: fixture.control, manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json", expectedRunId: "run-visual-001", expectedAssignmentId: "assignment-visual-001", expectedFeatureId: "VISUAL-001", expectedAttempt: 1, expectedCandidateFingerprint: fixture.candidateFingerprint, producerGateIds: ["visual-check"] }),
    (error) => error?.code === "evidence_manifest_invalid" && /parent traversal/.test(error.message)
  );
  await writeFile(manifestPath, originalManifest);
  const stale = { ...JSON.parse(originalManifest), run_id: "old-run" };
  stale.artifacts = stale.artifacts.map((item) => ({ ...item, run_id: "old-run" }));
  await writeFile(manifestPath, json(stale));
  await assert.rejects(
    () => loadEvidenceManifest({ projectRoot: fixture.control, manifestPath: ".loop/evidence/VISUAL-001/attempt-001/manifest.json", expectedRunId: "run-visual-001", expectedAssignmentId: "assignment-visual-001", expectedFeatureId: "VISUAL-001", expectedAttempt: 1, expectedCandidateFingerprint: fixture.candidateFingerprint, producerGateIds: ["visual-check"] }),
    (error) => error?.code === "evidence_manifest_invalid" && /run_id/.test(error.message)
  );
  await writeFile(manifestPath, originalManifest);
  console.log("Generic evidence manifest: valid binding PASS; legacy compatibility PASS; strict candidate/path binding PASS; tamper/out-of-root/stale rejection PASS; candidate mutation invalidation PASS.");
} finally {
  await rm(root, { recursive: true, force: true });
}
