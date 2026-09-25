import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const runtimeRoot = process.env.TRIAD_PACKAGE_ROOT || repositoryRoot;
const verifier = path.join(runtimeRoot, "runtime", "triad-verify.mjs");
const humanReport = path.join(runtimeRoot, "runtime", "triad-human-report.mjs");
const { calculateCandidateFingerprintAtCommit, candidateManifestsBind } = await import(pathToFileURL(path.join(runtimeRoot, "runtime", "lib", "fingerprint.mjs")).href);

function command(name, args, cwd, options = {}) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 20_000, ...options });
  assert.equal(result.status, 0, `${name} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function git(cwd, ...args) {
  return command("git", args, cwd);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256(file) {
  return digest(await readFile(file));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runVerifier(control, assignment) {
  const result = spawnSync(process.execPath, [verifier, "--project", control], {
    cwd: control,
    input: JSON.stringify({ event: "SubagentStop", agent_id: assignment.agent_id, agent_type: "triad_developer" }),
    encoding: "utf8",
    timeout: 20_000,
  });
  const output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  const evidence = output?.evidence ? JSON.parse(readFileSync(output.evidence, "utf8")) : null;
  return { result, output, evidence };
}

function runReport(control, inputPath, outputPath, product, baseline) {
  return spawnSync(process.execPath, [
    humanReport,
    "--mode", "card",
    "--project", control,
    "--input", inputPath,
    "--output", outputPath,
    "--worktree", product,
    "--base-commit", baseline,
  ], { cwd: control, encoding: "utf8", timeout: 20_000 });
}

const root = await mkdtemp(path.join(os.tmpdir(), "triad-human-report-binding-"));
try {
  const control = path.join(root, "control");
  const product = path.join(root, "product");
  await mkdir(path.join(control, "artifacts"), { recursive: true });
  await mkdir(path.join(control, "features"), { recursive: true });
  await mkdir(path.join(control, ".loop", "runtime", "assignments"), { recursive: true });
  await mkdir(product, { recursive: true });
  await writeFile(path.join(product, "README.md"), "baseline\n", "utf8");
  command("git", ["init", "-q"], product);
  command("git", ["config", "user.name", "Triad Test"], product);
  command("git", ["config", "user.email", "triad@example.invalid"], product);
  command("git", ["add", "README.md"], product);
  command("git", ["commit", "-qm", "baseline"], product);
  const baseline = git(product, "rev-parse", "HEAD");
  const branch = git(product, "branch", "--show-current");
  const controlRoot = await realpath(control);
  const productRoot = await realpath(product);

  const prdPath = path.join(control, "artifacts", "prd.md");
  const cardPath = path.join(control, "features", "BIND-001.md");
  const gatesPath = path.join(control, ".loop", "quality-gates.yaml");
  await writeFile(prdPath, "# Binding fixture\n\n## Goal\nBind a verified candidate to its commit.\n", "utf8");
  await writeFile(cardPath, "# BIND-001\n\n- In scope: candidate.txt\n", "utf8");
  await writeFile(gatesPath, [
    "version: 2",
    "gates:",
    "  - id: candidate-file",
    "    command: test -f candidate.txt",
    "    required: true",
    "    executor: control-plane",
    "    timeout_seconds: 5",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(control, "project.yaml"), [
    "repositories:",
    "  - id: product",
    `    worktree: ${productRoot}`,
    "",
  ].join("\n"), "utf8");

  const assignment = {
    schema_version: 1,
    assignment_id: "assignment-bind-001",
    status: "active",
    agent_id: "developer-bind-001",
    agent_type: "triad_developer",
    feature_id: "BIND-001",
    attempt: 1,
    project_root: controlRoot,
    worktree: productRoot,
    repository_id: "product",
    allow_external_worktree: false,
    expected_branch: branch,
    prd_path: "artifacts/prd.md",
    card_path: "features/BIND-001.md",
    gates_path: ".loop/quality-gates.yaml",
    expected_prd_sha256: await sha256(prdPath),
    expected_card_sha256: await sha256(cardPath),
    expected_gates_sha256: await sha256(gatesPath),
    verification_run_id: "run-bind-001",
    evidence_directory: ".loop/evidence/BIND-001/attempt-001",
  };
  const assignmentPath = path.join(control, ".loop", "runtime", "assignments", `${assignment.agent_id}.json`);
  await writeJson(assignmentPath, assignment);

  // The candidate is intentionally untracked at verification time. The real
  // verifier must persist the independent path/content manifest before gates.
  await writeFile(path.join(product, "candidate.txt"), "verified candidate\n", "utf8");
  const binaryBytes = Buffer.from([0x00, 0xff, 0x80, 0x42, 0x00, 0xc3]);
  await writeFile(path.join(product, "asset.bin"), binaryBytes);
  const verified = runVerifier(controlRoot, assignment);
  assert.equal(verified.result.status, 0, verified.result.stderr);
  assert.equal(verified.output.status, "pass");
  assert.equal(verified.evidence.status, "pass");
  assert.ok(verified.evidence.candidate_manifest, "verifier must persist candidate manifest");
  assert.equal(verified.evidence.baseline.candidate_fingerprint.length, 64);
  assert.deepEqual(verified.evidence.candidate_manifest.files, [
    { path: "asset.bin", sha256: digest(binaryBytes) },
    { path: "candidate.txt", sha256: digest("verified candidate\n") },
  ]);
  assert.deepEqual(verified.evidence.candidate_manifest.changes, [
    { status: "untracked", path: "asset.bin" },
    { status: "untracked", path: "candidate.txt" },
  ]);

  command("git", ["add", "candidate.txt", "asset.bin"], product);
  command("git", ["commit", "-qm", "verified candidate"], product);
  const finalCommit = git(product, "rev-parse", "HEAD");
  const committedFingerprint = (await calculateCandidateFingerprintAtCommit(product, {
    baseCommit: baseline,
    commit: finalCommit,
  })).value;
  assert.notEqual(committedFingerprint, verified.evidence.baseline.candidate_fingerprint, "commit identity must not be confused with verified identity");

  const context = {
    project_id: "human-report-binding-fixture",
    card: {
      id: "BIND-001",
      title: "Bind verified candidate to commit",
      goal: "A committed candidate must contain exactly the independently verified files.",
      outcome: "The candidate is ready for delivery.",
      target_repository: "product",
      card_path: "features/BIND-001.md",
    },
    status: "approved",
    implementation: { summary: "Created the verified candidate." },
    attempts: [{ attempt: 1, outcome: "pass", resolution_kind: "none", candidate_fingerprint: verified.evidence.baseline.candidate_fingerprint }],
    verification: [{
      run_id: verified.evidence.run_id,
      status: "pass",
      candidate_fingerprint: verified.evidence.baseline.candidate_fingerprint,
      candidate_manifest: verified.evidence.candidate_manifest,
      evidence_path: path.relative(controlRoot, verified.output.evidence),
      gates: [{ id: "candidate-file", status: "pass", exit_code: 0, duration_ms: 1 }],
    }],
    review: {
      reviewer: "Independent Reviewer",
      decision: "approved",
      candidate_fingerprint: verified.evidence.baseline.candidate_fingerprint,
      findings: [],
    },
    final: {
      repository: "product",
      branch,
      commit: finalCommit,
      base_commit: baseline,
      candidate_fingerprint: verified.evidence.baseline.candidate_fingerprint,
      worktree: productRoot,
    },
  };
  await writeJson(path.join(control, "report-context.json"), context);
  const first = runReport(controlRoot, "report-context.json", "card-reports/BIND-001.md", productRoot, baseline);
  assert.equal(first.status, 0, first.stderr);
  const report = await readFile(path.join(control, "card-reports", "BIND-001.md"), "utf8");
  assert.match(report, /Verified candidate fingerprint/);
  assert.match(report, /Committed candidate fingerprint/);
  assert.match(report, new RegExp(verified.evidence.baseline.candidate_fingerprint));
  assert.match(report, new RegExp(committedFingerprint));
  const firstReport = report;
  const second = runReport(controlRoot, "report-context.json", "card-reports/BIND-001.md", productRoot, baseline);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(path.join(control, "card-reports", "BIND-001.md"), "utf8"), firstReport, "report publication must remain idempotent");

  // Add a file after verification but before the commit being reported. The
  // report must reject the commit instead of silently widening the verified
  // candidate.
  await writeFile(path.join(product, "rogue-unverified.txt"), "not reviewed\n", "utf8");
  command("git", ["add", "rogue-unverified.txt"], product);
  command("git", ["commit", "-qm", "unverified file"], product);
  const rogueCommit = git(product, "rev-parse", "HEAD");
  const rogueContext = {
    ...context,
    final: { ...context.final, commit: rogueCommit },
  };
  await writeJson(path.join(control, "rogue-context.json"), rogueContext);
  const rogue = runReport(controlRoot, "rogue-context.json", "card-reports/rogue.md", productRoot, baseline);
  assert.notEqual(rogue.status, 0);
  assert.match(rogue.stderr, /committed candidate does not match the independently verified candidate manifest/);

  const renameAndDeletion = {
    base_commit: "base",
    git_head: "verified-head",
    changes: [
      { status: "renamed", source: "old.txt", destination: "new.txt" },
      { status: "deleted", path: "removed.txt" },
    ],
    files: [
      { path: "new.txt", sha256: digest("new\n") },
      { path: "old.txt", sha256: "DELETED" },
      { path: "removed.txt", sha256: "DELETED" },
    ],
  };
  assert.equal(candidateManifestsBind(renameAndDeletion, {
    ...renameAndDeletion,
    git_head: "committed-head",
  }, { expectedBaseCommit: "base" }), true, "rename/deletion binding must survive the commit identity change");
  assert.equal(candidateManifestsBind(renameAndDeletion, {
    ...renameAndDeletion,
    git_head: "committed-head",
    files: [...renameAndDeletion.files, { path: "rogue.txt", sha256: digest("rogue\n") }],
  }, { expectedBaseCommit: "base" }), false, "extra committed paths must fail closed");
  assert.equal(candidateManifestsBind(renameAndDeletion, {
    ...renameAndDeletion,
    git_head: "committed-head",
    ignored_paths: ["secrets.pem"],
  }, { expectedBaseCommit: "base" }), false, "new ignored paths must fail closed too");

  console.log(`Human report fingerprint binding passed: verifier=${verified.evidence.baseline.candidate_fingerprint}, committed=${committedFingerprint}, rogue commit rejected.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
