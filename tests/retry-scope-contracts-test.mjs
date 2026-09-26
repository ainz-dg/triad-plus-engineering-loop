import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { classifyVerifierResolution, evaluateAutomaticRetry, resolutionRecord, retryPolicyMode } from "../runtime/lib/retry-accounting.mjs";
import { collectCandidateChanges } from "../runtime/lib/fingerprint.mjs";
import { evaluateScopeContract, parseScopeContract } from "../runtime/lib/scope-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const runner = path.join(repositoryRoot, "runtime", "triad-verify.mjs");

function command(commandName, args, cwd) {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${commandName} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

function causeAttempt(kind) {
  return { resolution: resolutionRecord(kind, [], true) };
}

function assertRetryAccounting() {
  const policy = { max_runtime_recoveries_per_item: 2, max_candidate_remediations_per_item: 2 };

  assert.equal(retryPolicyMode({ max_rework_attempts_per_item: 2 }), "legacy", "a complete valid legacy policy remains legacy");
  assert.equal(retryPolicyMode(policy), "cause_coded", "a complete valid modern policy is cause-coded");
  assert.equal(
    retryPolicyMode({ max_rework_attempts_per_item: 2, ...policy }),
    "cause_coded",
    "a valid modern policy takes precedence when the legacy key is also present"
  );
  for (const invalidPolicy of [
    { max_runtime_recoveries_per_item: 2 },
    { max_candidate_remediations_per_item: 2 },
    { max_runtime_recoveries_per_item: 2, max_candidate_remediations_per_item: "2" },
    { max_runtime_recoveries_per_item: 2, max_candidate_remediations_per_item: -1 },
    {}
  ]) {
    assert.throws(
      () => retryPolicyMode(invalidPolicy),
      /retry policy must define either a valid legacy max_rework_attempts_per_item or both max_runtime_recoveries_per_item and max_candidate_remediations_per_item/,
      "partial, malformed, or empty retry policies must fail closed"
    );
  }
  assert.throws(
    () => evaluateAutomaticRetry({ policy: { max_runtime_recoveries_per_item: 2 }, attempts: [], kind: "runtime_recovery" }),
    /retry policy must define either a valid legacy max_rework_attempts_per_item or both max_runtime_recoveries_per_item and max_candidate_remediations_per_item/,
    "accounting rejects an ambiguous policy at evaluation time"
  );

  const runtimeHistory = [];
  assert.equal(evaluateAutomaticRetry({ policy, attempts: runtimeHistory, kind: "runtime_recovery" }).allowed, true, "runtime recovery #1 must continue");
  runtimeHistory.push(causeAttempt("runtime_recovery"));
  assert.equal(evaluateAutomaticRetry({ policy, attempts: runtimeHistory, kind: "runtime_recovery" }).allowed, true, "runtime recovery #2 must continue");
  runtimeHistory.push(causeAttempt("runtime_recovery"));
  assert.equal(evaluateAutomaticRetry({ policy, attempts: runtimeHistory, kind: "runtime_recovery" }).allowed, false, "runtime recovery #3 must escalate");

  const candidateHistory = [];
  assert.equal(evaluateAutomaticRetry({ policy, attempts: candidateHistory, kind: "reviewer_rework" }).allowed, true, "candidate remediation #1 must continue");
  candidateHistory.push(causeAttempt("reviewer_rework"));
  assert.equal(evaluateAutomaticRetry({ policy, attempts: candidateHistory, kind: "scope_cleanup" }).allowed, true, "candidate remediation #2 must continue");
  candidateHistory.push(causeAttempt("scope_cleanup"));
  assert.equal(evaluateAutomaticRetry({ policy, attempts: candidateHistory, kind: "verifier_candidate_failure" }).allowed, false, "candidate remediation #3 must escalate");

  const jsf017 = [causeAttempt("runtime_recovery"), causeAttempt("verifier_infrastructure_failure")];
  const jsf017Decision = evaluateAutomaticRetry({ policy, attempts: jsf017, kind: "reviewer_rework" });
  assert.equal(jsf017Decision.allowed, true, "JSF-017 Reviewer rework must permit attempt 4");
  assert.equal(jsf017Decision.previous_automatic_transitions, 0, "runtime history must not consume candidate remediation budget");
  assert.equal(classifyVerifierResolution({ status: "fail", developer_claim: "infrastructure" }), "verifier_candidate_failure", "Developer infrastructure claim is not authority");
  assert.equal(classifyVerifierResolution({ status: "infrastructure_error" }), "verifier_infrastructure_failure");
  assert.equal(evaluateAutomaticRetry({ policy, attempts: [], kind: "blocked" }).allowed, false, "blocked never retries automatically");

  const legacy = evaluateAutomaticRetry({ policy: { max_rework_attempts_per_item: 2 }, attempts: [{ state: "rework" }, { state: "rework" }], kind: "reviewer_rework" });
  assert.equal(legacy.mode, "legacy");
  assert.equal(legacy.allowed, false, "legacy accounting must preserve the single budget");
}

function contract(surface) {
  return { schema_version: 1, mode: "enforce", repositories: { product: surface } };
}

async function createVerifierFixture(root, { gateCommand = "true", scope = true, initialState = "clean" } = {}) {
  const worktree = path.join(root, "product");
  await mkdir(path.join(worktree, "src", "component"), { recursive: true });
  await mkdir(path.join(worktree, "tests", "component"), { recursive: true });
  await writeFile(path.join(worktree, "src", "component", "Foo.tsx"), "export const Foo = 'base';\n");
  await writeFile(path.join(worktree, "server.js"), "console.log('base');\n");
  await writeFile(path.join(worktree, "package-lock.json"), "{}\n");
  command("git", ["init", "-q"], worktree);
  command("git", ["config", "user.email", "triad-test@example.invalid"], worktree);
  command("git", ["config", "user.name", "Triad Test"], worktree);
  command("git", ["add", "."], worktree);
  command("git", ["commit", "-qm", "baseline"], worktree);
  const baseline = command("git", ["rev-parse", "HEAD"], worktree);
  const branch = command("git", ["branch", "--show-current"], worktree);
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await mkdir(path.join(root, "features"), { recursive: true });
  await writeFile(path.join(root, "artifacts", "prd.md"), "# PRD\n");
  await writeFile(path.join(root, "features", "TEST-001.md"), "# TEST-001\n");
  const gatesPath = path.join(root, ".loop", "quality-gates.yaml");
  await mkdir(path.dirname(gatesPath), { recursive: true });
  await writeFile(gatesPath, `version: 2\ngates:\n  - id: expensive\n    command: ${gateCommand}\n    required: true\n    executor: control-plane\n    timeout_seconds: 5\n`);
  const assignment = {
    schema_version: 1, assignment_id: "assignment-1", status: "active", agent_id: "developer-1", agent_type: "triad_developer", feature_id: "TEST-001", attempt: 1,
    project_root: root, worktree, expected_branch: branch, allow_external_worktree: true,
    prd_path: "artifacts/prd.md", card_path: "features/TEST-001.md", gates_path: ".loop/quality-gates.yaml",
    expected_prd_sha256: await digest(path.join(root, "artifacts", "prd.md")), expected_card_sha256: await digest(path.join(root, "features", "TEST-001.md")),
    expected_gates_sha256: await digest(gatesPath), verification_run_id: "run-1"
  };
  if (scope === true) {
    const contractPath = path.join(root, "scope-contracts", "TEST-001.json");
    const source = contract({
      allowed_paths: ["src/component/**", "tests/component/**"],
      allowed_incidental_paths: [],
      forbidden_paths: ["server.js", "package.json", "package-lock.json"]
    });
    await writeJson(contractPath, source);
    assignment.scope_contract = {
      path: "scope-contracts/TEST-001.json", sha256: await digest(contractPath), repository_id: "product",
      card_baseline: { repository_id: "product", git_head: baseline, initial_state: initialState }
    };
  } else if (scope === null) {
    // Preserve the historical v1.12.1 generated-assignment sentinel so the
    // compatibility path proves that trusted gates still execute.
    assignment.scope_contract = null;
  }
  const assignmentPath = path.join(root, ".loop", "runtime", "assignments", "developer-1.json");
  await writeJson(assignmentPath, assignment);
  return { worktree, baseline, assignment, assignmentPath };
}

async function invoke(root, agentId) {
  const result = spawnSync("node", [runner, "--project", root], {
    input: JSON.stringify({ event: "explicit_dispatch", agent_id: agentId, agent_type: "triad_developer" }), encoding: "utf8", timeout: 15_000
  });
  const output = JSON.parse(result.stdout);
  const evidence = output.evidence ? JSON.parse(await readFile(output.evidence, "utf8")) : null;
  return { result, evidence };
}

async function assertVerifierScopeBehavior(root) {
  const passRoot = path.join(root, "scope-pass");
  const pass = await createVerifierFixture(passRoot);
  await writeFile(path.join(pass.worktree, "src", "component", "Foo.tsx"), "export const Foo = 'changed';\n");
  await writeFile(path.join(pass.worktree, "tests", "component", "Foo.test.ts"), "export {};\n");
  const passRun = await invoke(passRoot, "developer-1");
  assert.equal(passRun.result.status, 0, JSON.stringify(passRun.evidence));
  assert.equal(passRun.evidence.scope.status, "pass");
  assert.ok(passRun.evidence.scope.changed_paths.some((entry) => entry.path === "src/component/Foo.tsx" && entry.status === "modified"));
  assert.ok(passRun.evidence.scope.changed_paths.some((entry) => entry.path === "tests/component/Foo.test.ts" && entry.status === "untracked"));
  assert.ok(passRun.evidence.scope.changed_paths.every((entry) => entry.repository === "product"), "scope manifest must retain repository identity");

  const failRoot = path.join(root, "scope-fail");
  const failing = await createVerifierFixture(failRoot, { gateCommand: "touch .scope-gate-ran" });
  await writeFile(path.join(failing.worktree, "src", "component", "Foo.tsx"), "export const Foo = 'changed';\n");
  await writeFile(path.join(failing.worktree, "server.js"), "console.log('changed');\n");
  const failRun = await invoke(failRoot, "developer-1");
  assert.equal(failRun.result.status, 2);
  assert.equal(failRun.evidence.scope.status, "fail");
  assert.deepEqual(failRun.evidence.gates, [], "scope failure must skip expensive gates");
  assert.ok(failRun.evidence.scope.offending_paths.some((entry) => entry.path === "server.js" && entry.reason === "forbidden_path"));
  assert.equal(await exists(path.join(failing.worktree, ".scope-gate-ran")), false, "scope failure must not run the expensive gate");

  const reworkRoot = path.join(root, "scope-rework-baseline");
  const rework = await createVerifierFixture(reworkRoot);
  await writeFile(path.join(rework.worktree, "src", "component", "Foo.tsx"), "export const Foo = 'attempt-one';\n");
  const first = await invoke(reworkRoot, "developer-1");
  assert.equal(first.evidence.scope.status, "pass");
  rework.assignment.assignment_id = "assignment-2";
  rework.assignment.agent_id = "developer-2";
  rework.assignment.attempt = 2;
  rework.assignment.verification_run_id = "run-2";
  rework.assignment.evidence_directory = ".loop/evidence/TEST-001/attempt-002";
  await writeFile(path.join(rework.worktree, "tests", "component", "Foo.test.ts"), "export {};\n");
  await writeJson(path.join(reworkRoot, ".loop", "runtime", "assignments", "developer-2.json"), rework.assignment);
  const second = await invoke(reworkRoot, "developer-2");
  assert.equal(second.result.status, 0, JSON.stringify(second.evidence));
  assert.equal(second.evidence.scope.baseline.git_head, rework.baseline, "rework must retain the original card baseline");
  assert.equal(second.evidence.scope.status, "pass", "preserved dirty rework candidate must be compared to card baseline");

  const legacyRoot = path.join(root, "legacy-no-scope");
  const legacy = await createVerifierFixture(legacyRoot, { scope: false });
  await writeFile(path.join(legacy.worktree, "server.js"), "console.log('legacy change');\n");
  const legacyRun = await invoke(legacyRoot, "developer-1");
  assert.equal(legacyRun.result.status, 0, JSON.stringify(legacyRun.evidence));
  assert.equal(legacyRun.evidence.scope.status, "not_configured");

  const nullRoot = path.join(root, "legacy-null-scope");
  const nullGateMarker = path.join(nullRoot, "null-scope-gate-ran");
  await createVerifierFixture(nullRoot, { scope: null, gateCommand: `touch ${nullGateMarker}` });
  const nullRun = await invoke(nullRoot, "developer-1");
  assert.equal(nullRun.result.status, 0, JSON.stringify(nullRun.evidence));
  assert.equal(nullRun.evidence.scope.status, "not_configured", "historical null scope sentinel must use legacy behavior");
  assert.equal(await exists(nullGateMarker), true, "null scope sentinel must not suppress trusted gates");

  for (const [label, malformed] of [["string", "not-a-scope-contract"], ["array", []]]) {
    const malformedRoot = path.join(root, `malformed-${label}-scope`);
    const malformedFixture = await createVerifierFixture(malformedRoot, { scope: false });
    malformedFixture.assignment.scope_contract = malformed;
    await writeJson(malformedFixture.assignmentPath, malformedFixture.assignment);
    const malformedRun = await invoke(malformedRoot, "developer-1");
    assert.equal(malformedRun.result.status, 3, `${label} scope contract must fail closed`);
    assert.equal(malformedRun.evidence.status, "invalid_context");
    assert.match(malformedRun.evidence.failure.reason, /scope_contract (?:must be an object when declared|requires path, sha256, and repository_id)/);
  }

  const dirtyRoot = path.join(root, "dirty-baseline");
  const dirty = await createVerifierFixture(dirtyRoot, { initialState: "dirty" });
  const dirtyRun = await invoke(dirtyRoot, "developer-1");
  assert.equal(dirtyRun.result.status, 3);
  assert.equal(dirtyRun.evidence.status, "invalid_context");
  assert.match(dirtyRun.evidence.failure.reason, /clean card_baseline/);
}

async function assertScopeEdgeCases(root) {
  const narrow = contract({
    allowed_paths: ["src/component/**", "tests/component/**", "test/visual/snapshots/specific-*.png"],
    allowed_incidental_paths: ["package-lock.json"],
    forbidden_paths: ["server.js"]
  });
  assert.equal(evaluateScopeContract({ contract: narrow, repository: "product", changes: [{ status: "deleted", path: "src/component/Foo.tsx" }] }).status, "pass");
  const renamed = evaluateScopeContract({ contract: narrow, repository: "product", changes: [{ status: "renamed", source: "src/component/Foo.tsx", destination: "server.js" }] });
  assert.equal(renamed.status, "fail");
  assert.ok(renamed.offending_paths.some((entry) => entry.path === "server.js" && entry.side === "destination"));
  assert.equal(evaluateScopeContract({ contract: narrow, repository: "product", changes: [{ status: "modified", path: "package-lock.json" }] }).status, "pass");
  assert.equal(evaluateScopeContract({ contract: narrow, repository: "product", changes: [{ status: "untracked", path: "test/visual/snapshots/unrelated.png" }] }).status, "fail");
  assert.throws(() => parseScopeContract(JSON.stringify(contract({ allowed_paths: ["test/visual/snapshots/**"], allowed_incidental_paths: [], forbidden_paths: [] }))), /snapshot pattern is too broad/);
  assert.throws(() => parseScopeContract(JSON.stringify(contract({ allowed_paths: ["snapshots/**"], allowed_incidental_paths: [], forbidden_paths: [] }))), /snapshot pattern is too broad/);
  const multi = { schema_version: 1, mode: "enforce", repositories: {
    ketchup2: { allowed_paths: ["src/component/**"], allowed_incidental_paths: [], forbidden_paths: [] },
    webup: { allowed_paths: ["src/webup/**"], allowed_incidental_paths: [], forbidden_paths: [] }
  } };
  assert.equal(evaluateScopeContract({ contract: multi, repository: "webup", changes: [{ status: "modified", path: "src/component/Foo.tsx" }] }).status, "fail", "repository surfaces must remain isolated");

  const ignoredRoot = path.join(root, "ignored-generated");
  const fixture = await createVerifierFixture(ignoredRoot, { scope: false });
  await mkdir(path.join(fixture.worktree, "dist"), { recursive: true });
  await writeFile(path.join(fixture.worktree, "dist", "generated.js"), "generated\n");
  const manifest = await collectCandidateChanges(fixture.worktree);
  assert.ok(manifest.ignored_paths.includes("dist/generated.js"), "ignored generated artifact must not enter candidate scope");
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "triad-retry-scope-test-"));
try {
  assertRetryAccounting();
  await assertVerifierScopeBehavior(temporaryRoot);
  await assertScopeEdgeCases(temporaryRoot);
  const orchestrator = await readFile(path.join(repositoryRoot, "skills", "triad-loop-orchestrator", "SKILL.md"), "utf8");
  assert.match(orchestrator, /Attempts are historical execution numbers, not a retry budget/);
  assert.match(orchestrator, /scope fail[\s\S]*never dispatches the Reviewer/i);
  console.log("Triad retry accounting and scope contracts: PASS");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
