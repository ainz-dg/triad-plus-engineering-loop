import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packetCli = path.join(repositoryRoot, "runtime", "triad-assignment-packet.mjs");
const verifier = path.join(repositoryRoot, "runtime", "triad-verify.mjs");
const contextCli = path.join(repositoryRoot, "runtime", "triad-runtime-context.mjs");

function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${name} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileDigest(file) {
  return digest(await readFile(file));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function initializeRepo(root, files) {
  await mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  command("git", ["init", "-q"], root);
  command("git", ["config", "user.email", "triad-context@example.invalid"], root);
  command("git", ["config", "user.name", "Triad Context Test"], root);
  command("git", ["add", "."], root);
  command("git", ["commit", "-qm", "baseline"], root);
  return command("git", ["branch", "--show-current"], root);
}

async function prepareFixture(root) {
  const control = path.join(root, "control");
  const parent = path.join(root, "project-folder");
  const ketchup2 = path.join(parent, "ketchup2");
  const embedded = path.join(ketchup2, "embedded-tools");
  await initializeRepo(parent, {
    "parent.txt": "parent baseline\n",
    ".agents/skills/router/SKILL.md": "# Parent router\n"
  });
  const ketchupBranch = await initializeRepo(ketchup2, {
    "component.txt": "ketchup2 baseline\n",
    ".agents/skills/router/SKILL.md": "# Ketchup2 router\n",
    ".agents/skills/new-ketchup2-component/SKILL.md": "# Ketchup2 component skill\n"
  });
  await initializeRepo(embedded, {
    ".agents/skills/embedded/SKILL.md": "# Embedded repository skill\n"
  });

  await mkdir(path.join(control, "artifacts"), { recursive: true });
  await mkdir(path.join(control, "features"), { recursive: true });
  await mkdir(path.join(control, ".loop", "runtime", "assignments"), { recursive: true });
  await writeFile(path.join(control, "artifacts", "prd.md"), "# Nested repository context PRD\n");
  await writeFile(path.join(control, "features", "GRAPH-001.md"), "# GRAPH-001\n\n## Outcome and scope\nUse the Ketchup2 repository context.\n");
  await writeFile(path.join(control, ".loop", "quality-gates.yaml"), [
    "version: 2",
    "gates:",
    "  - id: context-check",
    "    command: true",
    "    required: true",
    "    executor: control-plane",
    "    timeout_seconds: 2",
    ""
  ].join("\n"));
  await writeFile(path.join(control, "project.yaml"), [
    "repositories:",
    `  - id: parent\n    worktree: ${parent}`,
    `  - id: ketchup2\n    worktree: ${ketchup2}`,
    ""
  ].join("\n"));
  const controlRoot = await realpath(control);
  const parentRoot = await realpath(parent);
  const productRoot = await realpath(ketchup2);
  const embeddedRoot = await realpath(embedded);
  const skillEntries = [
    ".agents/skills/router/SKILL.md",
    ".agents/skills/new-ketchup2-component/SKILL.md"
  ];
  const assignment = {
    schema_version: 1,
    assignment_id: "assignment-graph-001",
    status: "active",
    agent_id: "developer-graph-001",
    agent_type: "triad_developer",
    feature_id: "GRAPH-001",
    attempt: 1,
    project_root: controlRoot,
    repository_id: "ketchup2",
    worktree: productRoot,
    expected_branch: ketchupBranch,
    allow_external_worktree: true,
    prd_path: "artifacts/prd.md",
    card_path: "features/GRAPH-001.md",
    gates_path: ".loop/quality-gates.yaml",
    expected_prd_sha256: await fileDigest(path.join(control, "artifacts", "prd.md")),
    expected_card_sha256: await fileDigest(path.join(control, "features", "GRAPH-001.md")),
    expected_gates_sha256: await fileDigest(path.join(control, ".loop", "quality-gates.yaml")),
    required_repository_skills: await Promise.all(skillEntries.map(async (relative) => ({
      path: relative,
      sha256: await fileDigest(path.join(productRoot, relative))
    }))),
    verification_run_id: "run-graph-001",
    evidence_directory: ".loop/evidence/GRAPH-001/attempt-001"
  };
  const assignmentPath = path.join(control, ".loop", "runtime", "assignments", `${assignment.agent_id}.json`);
  await writeJson(assignmentPath, assignment);
  return { controlRoot, parent: parentRoot, productRoot, embedded: embeddedRoot, assignment, assignmentPath, skillEntries };
}

function runJson(script, args, cwd, input = "") {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    input,
    encoding: "utf8",
    timeout: 15_000
  });
  let parsed = null;
  if (result.stdout.trim()) parsed = JSON.parse(result.stdout);
  return { result, parsed };
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "triad-repository-context-test-"));
try {
  const fixture = await prepareFixture(temporaryRoot);
  const packetRun = runJson(packetCli, ["--project", fixture.controlRoot, "--assignment", fixture.assignmentPath], fixture.controlRoot);
  assert.equal(packetRun.result.status, 0, packetRun.result.stderr);
  assert.equal(packetRun.parsed.dispatch.cwd, fixture.productRoot);
  assert.deepEqual(packetRun.parsed.dispatch.mandatory_skill_paths, fixture.skillEntries);
  const packetPath = path.join(fixture.controlRoot, packetRun.parsed.packet_path);
  const packet = JSON.parse((await readFile(packetPath, "utf8")).match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(packet.repository_mapping.id, "ketchup2");
  assert.equal(packet.repository_mapping.resolved_worktree, fixture.productRoot);
  assert.equal(packet.cwd, fixture.productRoot);
  assert.equal(packet.repository_context.assigned_git_top_level, fixture.productRoot);
  assert.deepEqual(packet.repository_context.skills.map((skill) => skill.path), fixture.skillEntries);
  assert.ok(packet.repository_context.skills.every((skill) => skill.resolved_path.startsWith(`${fixture.productRoot}${path.sep}`)));
  assert.ok(packet.repository_context.skills.every((skill) => skill.repository_root === fixture.productRoot));

  const verifierRun = runJson(verifier, ["--project", fixture.controlRoot], fixture.controlRoot, JSON.stringify({
    event: "SubagentStop",
    agent_id: fixture.assignment.agent_id,
    agent_type: "triad_developer"
  }));
  assert.equal(verifierRun.result.status, 0, verifierRun.result.stderr);
  const verifierEvidence = JSON.parse(await readFile(verifierRun.parsed.evidence, "utf8"));
  assert.equal(verifierEvidence.status, "pass");
  assert.equal(verifierEvidence.repository_skills.context.assigned_git_top_level, fixture.productRoot);
  assert.deepEqual(verifierEvidence.repository_skills.skills, fixture.assignment.required_repository_skills);
  assert.ok(verifierEvidence.repository_skills.context.skills.every((skill) => skill.repository_root === fixture.productRoot));

  const contextPass = runJson(contextCli, ["--project", fixture.controlRoot, "--assignment", fixture.assignmentPath], fixture.productRoot);
  assert.equal(contextPass.result.status, 0, contextPass.result.stderr);
  assert.equal(contextPass.parsed.status, "pass");
  assert.equal(contextPass.parsed.assignment.packet_metadata_cwd, fixture.productRoot);
  assert.equal(contextPass.parsed.actual.process_cwd, fixture.productRoot);
  assert.equal(contextPass.parsed.actual.shell_pwd, fixture.productRoot);
  assert.equal(contextPass.parsed.actual.git_top_level, fixture.productRoot);
  assert.equal(contextPass.parsed.repository_skills.length, 2);

  const contextWrongCwd = runJson(contextCli, ["--project", fixture.controlRoot, "--assignment", fixture.assignmentPath], fixture.parent);
  assert.equal(contextWrongCwd.result.status, 2);
  assert.equal(contextWrongCwd.parsed.status, "blocked");
  assert.ok(contextWrongCwd.parsed.issues.some((item) => item.code === "runtime_cwd_mismatch"));
  assert.notEqual(contextWrongCwd.parsed.actual.git_top_level, fixture.productRoot);

  const parentAssignment = {
    ...fixture.assignment,
    assignment_id: "assignment-parent-mixed",
    agent_id: "developer-parent-mixed",
    repository_id: "parent",
    worktree: fixture.parent,
    expected_branch: command("git", ["branch", "--show-current"], fixture.parent),
    required_repository_skills: fixture.skillEntries.map((relative) => ({
      path: `ketchup2/${relative}`,
      sha256: fixture.assignment.required_repository_skills.find((entry) => entry.path === relative).sha256
    }))
  };
  const parentAssignmentPath = path.join(fixture.controlRoot, ".loop", "runtime", "assignments", `${parentAssignment.agent_id}.json`);
  await writeJson(parentAssignmentPath, parentAssignment);
  const parentPacket = runJson(packetCli, ["--project", fixture.controlRoot, "--assignment", parentAssignmentPath], fixture.controlRoot);
  assert.equal(parentPacket.result.status, 2);
  assert.match(parentPacket.result.stderr, /different Git root|repository context/i);

  const mixedAssignment = {
    ...fixture.assignment,
    assignment_id: "assignment-mixed-root",
    agent_id: "developer-mixed-root",
    required_repository_skills: [
      ...fixture.assignment.required_repository_skills,
      { path: "embedded-tools/.agents/skills/embedded/SKILL.md", sha256: await fileDigest(path.join(fixture.embedded, ".agents/skills/embedded/SKILL.md")) }
    ]
  };
  const mixedAssignmentPath = path.join(fixture.controlRoot, ".loop", "runtime", "assignments", `${mixedAssignment.agent_id}.json`);
  await writeJson(mixedAssignmentPath, mixedAssignment);
  const mixedRun = runJson(verifier, ["--project", fixture.controlRoot, "--assignment", mixedAssignmentPath], fixture.controlRoot, JSON.stringify({
    event: "SubagentStop",
    agent_id: mixedAssignment.agent_id,
    agent_type: "triad_developer"
  }));
  assert.equal(mixedRun.result.status, 3);
  const mixedEvidence = JSON.parse(await readFile(mixedRun.parsed.evidence, "utf8"));
  assert.equal(mixedEvidence.failure.code, "repository_context_invalid");
  assert.deepEqual(mixedEvidence.gates, [], "mixed repository roots must fail before gates");
  assert.ok(mixedEvidence.repository_skills.issues.some((item) => item.code === "repository_skill_root_mismatch"));

  const controlOnlySkillPath = path.join(fixture.controlRoot, ".agents", "skills", "router", "SKILL.md");
  await mkdir(path.dirname(controlOnlySkillPath), { recursive: true });
  await writeFile(controlOnlySkillPath, "# Control-only duplicate\n");
  const missingProductAssignment = {
    ...fixture.assignment,
    assignment_id: "assignment-control-fallback",
    agent_id: "developer-control-fallback",
    required_repository_skills: [{ path: ".agents/skills/does-not-exist/SKILL.md", sha256: await fileDigest(controlOnlySkillPath) }]
  };
  const missingAssignmentPath = path.join(fixture.controlRoot, ".loop", "runtime", "assignments", `${missingProductAssignment.agent_id}.json`);
  await writeJson(missingAssignmentPath, missingProductAssignment);
  const missingRun = runJson(verifier, ["--project", fixture.controlRoot, "--assignment", missingAssignmentPath], fixture.controlRoot, JSON.stringify({
    event: "SubagentStop",
    agent_id: missingProductAssignment.agent_id,
    agent_type: "triad_developer"
  }));
  assert.equal(missingRun.result.status, 3);
  const missingEvidence = JSON.parse(await readFile(missingRun.parsed.evidence, "utf8"));
  assert.equal(missingEvidence.failure.code, "repository_context_invalid");
  assert.ok(missingEvidence.repository_skills.issues.some((item) => item.code === "repository_skill_missing"));
  assert.deepEqual(missingEvidence.gates, []);

  console.log(`Repository context tests passed: nested repository=${fixture.productRoot}, packet mapping=PASS, actual cwd=PASS, mixed roots=FAIL-CLOSED, control fallback=FAIL-CLOSED.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
