import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveAssignmentContext } from "../runtime/lib/assignment-packet.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packetCli = path.join(repositoryRoot, "runtime", "triad-assignment-packet.mjs");
const verifier = path.join(repositoryRoot, "runtime", "triad-verify.mjs");

function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${name} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256(file) {
  return digest(await readFile(file));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function prepareFixture(root) {
  const control = path.join(root, "control");
  const product = path.join(root, "product");
  await mkdir(path.join(control, "artifacts"), { recursive: true });
  await mkdir(path.join(control, "features"), { recursive: true });
  await mkdir(path.join(control, ".loop", "runtime", "assignments"), { recursive: true });
  await mkdir(path.join(product, ".agents", "skills", "router"), { recursive: true });
  await writeFile(path.join(product, "candidate.txt"), "baseline\n");
  await writeFile(path.join(product, ".agents", "skills", "router", "SKILL.md"), "# Bound repository router\n");
  command("git", ["init", "-q"], product);
  command("git", ["config", "user.email", "triad-test@example.invalid"], product);
  command("git", ["config", "user.name", "Triad Test"], product);
  command("git", ["add", "."], product);
  command("git", ["commit", "-qm", "baseline"], product);
  const branch = command("git", ["branch", "--show-current"], product);
  const controlRoot = await realpath(control);
  const productRoot = await realpath(product);

  const prd = [
    "# Product PRD",
    "\n## Goal\n",
    "Implement the bounded packet fixture behavior.",
    "\n## Unrelated full source\n",
    "FULL_PRD_SENTINEL_SHOULD_NOT_BE_IN_PACKET",
    "\n",
    "filler ".repeat(3000)
  ].join("\n");
  await writeFile(path.join(control, "artifacts", "prd.md"), prd);
  await writeFile(path.join(control, "features", "PACKET-001.md"), [
    "# PACKET-001 — deterministic packet",
    "\n## Outcome and scope\n",
    "- Target repository: product",
    "- Branch/worktree: declared",
    "- Outcome: useful edit starts in the product worktree",
    "- In scope: candidate.txt and its focused test",
    "- Out of scope: control records and unrelated files",
    "\n## Acceptance criteria\n",
    "1. Given the packet, the Developer starts from the assigned worktree.",
    "2. The verifier still validates real repository skills.",
    "\n## Metrics and gates\n",
    "| ID | Target | Evidence command or observation |",
    "| M-001 | packet-first | packet path is read before broad discovery |",
    "\n## Integration, practical test, and risk\n",
    "- Owner practical test: inspect the bounded candidate.",
    ""
  ].join("\n"));
  await writeFile(path.join(control, "project.yaml"), [
    "repositories:",
    "  - id: product",
    `    worktree: ${productRoot}`,
    ""
  ].join("\n"));
  const gatesPath = path.join(control, ".loop", "quality-gates.yaml");
  await mkdir(path.dirname(gatesPath), { recursive: true });
  const gates = "version: 2\ngates:\n  - id: packet-check\n    command: test \"$(pwd)\" = \"" + productRoot + "\"\n    required: true\n    executor: control-plane\n    timeout_seconds: 2\n";
  await writeFile(gatesPath, gates);
  const assignment = {
    schema_version: 1,
    assignment_id: "assignment-packet-001",
    status: "active",
    agent_id: "developer-packet-001",
    agent_type: "triad_developer",
    feature_id: "PACKET-001",
    attempt: 1,
    project_root: controlRoot,
    worktree: productRoot,
    expected_branch: branch,
    // The project.yaml mapping, not an assignment escape hatch, authorizes
    // this product worktree which intentionally lives outside control/.
    allow_external_worktree: false,
    prd_path: "artifacts/prd.md",
    card_path: "features/PACKET-001.md",
    gates_path: ".loop/quality-gates.yaml",
    expected_prd_sha256: await sha256(path.join(control, "artifacts", "prd.md")),
    expected_card_sha256: await sha256(path.join(control, "features", "PACKET-001.md")),
    expected_gates_sha256: await sha256(gatesPath),
    required_repository_skills: [{
      path: ".agents/skills/router/SKILL.md",
      sha256: await sha256(path.join(product, ".agents", "skills", "router", "SKILL.md"))
    }],
    verification_run_id: "run-packet-001",
    evidence_directory: ".loop/evidence/PACKET-001/attempt-001",
    context: {
      relevant_prd_excerpts: [{ path: "artifacts/prd.md#Goal", text: "Implement the bounded packet fixture behavior." }],
      relevant_adr_excerpts: [{ path: "artifacts/adr.md#Context", text: "The product worktree is the operational cwd." }],
      acceptance_criteria: ["Given the packet, the Developer starts from the assigned worktree."],
      verification_mapping: ["AC-1 → packet dispatch cwd; AC-2 → packet-check gate and skill hash."],
      expected_paths: ["candidate.txt", "focused test"],
      constraints: ["Do not edit control-plane records from the product worktree."],
      risks: ["A stale packet must fail closed before gates."],
      previous_evidence: ["none for first attempt"]
    }
  };
  const assignmentPath = path.join(control, ".loop", "runtime", "assignments", `${assignment.agent_id}.json`);
  await writeJson(assignmentPath, assignment);
  return { control: controlRoot, product: productRoot, assignment, assignmentPath, prdBytes: Buffer.byteLength(prd), adrBytes: 80 };
}

function runPacket(fixture) {
  const result = spawnSync(process.execPath, [packetCli, "--project", fixture.control, "--assignment", fixture.assignmentPath], {
    cwd: fixture.control,
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function runVerifier(fixture) {
  const result = spawnSync(process.execPath, [verifier, "--project", fixture.control], {
    cwd: fixture.control,
    input: JSON.stringify({ event: "SubagentStop", agent_id: fixture.assignment.agent_id, agent_type: "triad_developer" }),
    encoding: "utf8",
    timeout: 15_000
  });
  const output = JSON.parse(result.stdout);
  const evidence = output.evidence ? JSON.parse(readFileSync(output.evidence, "utf8")) : null;
  return { result, output, evidence };
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "triad-assignment-packet-test-"));
try {
  const fixture = await prepareFixture(temporaryRoot);
  const first = runPacket(fixture);
  assert.equal(first.status, "ready");
  assert.equal(first.dispatch.cwd, fixture.product, "Developer dispatch cwd must be the assigned product worktree");
  assert.equal(first.dispatch.control_workspace, fixture.control, "control workspace remains explicit");
  assert.equal(first.dispatch.repository, "product");
  assert.equal(first.dispatch.branch, fixture.assignment.expected_branch);
  assert.deepEqual(first.dispatch.mandatory_skill_paths, [".agents/skills/router/SKILL.md"]);

  const bound = JSON.parse(await readFile(fixture.assignmentPath, "utf8"));
  assert.equal(bound.assignment_packet_path, first.packet_path);
  assert.equal(bound.assignment_packet_sha256, first.packet_sha256);
  const packetPath = path.isAbsolute(first.packet_path) ? first.packet_path : path.join(fixture.control, first.packet_path);
  const packet = await readFile(packetPath, "utf8");
  assert.match(packet, /PACKET-001/);
  assert.match(packet, /assigned product worktree/);
  assert.match(packet, /AC-1/);
  assert.match(packet, /artifacts\/prd\.md#Goal/);
  assert.match(packet, /artifacts\/adr\.md#Context/);
  assert.match(packet, /\.agents\/skills\/router\/SKILL\.md/);
  assert.match(packet, /packet-check gate/);
  assert.doesNotMatch(packet, /FULL_PRD_SENTINEL_SHOULD_NOT_BE_IN_PACKET/);
  const second = runPacket(fixture);
  assert.equal(second.packet_sha256, first.packet_sha256, "same assignment must produce deterministic packet bytes");
  assert.equal(await readFile(packetPath, "utf8"), packet);

  const context = await resolveAssignmentContext(bound, { projectRoot: fixture.control });
  assert.equal(context.cwd, fixture.product);
  assert.equal(context.controlWorkspace, fixture.control);
  assert.equal(context.repository, "product");
  assert.equal(context.external, true);

  const unrelated = path.join(temporaryRoot, "unrelated-product");
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, "candidate.txt"), "unrelated\n");
  command("git", ["init", "-q"], unrelated);
  command("git", ["config", "user.email", "triad-test@example.invalid"], unrelated);
  command("git", ["config", "user.name", "Triad Test"], unrelated);
  command("git", ["add", "."], unrelated);
  command("git", ["commit", "-qm", "baseline"], unrelated);
  const unrelatedBranch = command("git", ["branch", "--show-current"], unrelated);
  const undeclared = {
    ...bound,
    worktree: unrelated,
    expected_branch: unrelatedBranch,
    repository_id: "unrelated",
    allow_external_worktree: false
  };
  await assert.rejects(
    () => resolveAssignmentContext(undeclared, { projectRoot: fixture.control }),
    (error) => error?.code === "assignment_packet_invalid" && /not declared by a project\.yaml repository mapping/.test(error.message)
  );

  const projectYamlPath = path.join(fixture.control, "project.yaml");
  const originalProjectYaml = await readFile(projectYamlPath, "utf8");
  await writeFile(projectYamlPath, [
    "repositories:",
    "  - id: product",
    "    metadata:",
    `      worktree: ${fixture.product}`,
    ""
  ].join("\n"));
  await assert.rejects(
    () => resolveAssignmentContext(bound, { projectRoot: fixture.control }),
    (error) => error?.code === "assignment_packet_invalid" && /not declared by a project\.yaml repository mapping/.test(error.message),
    "nested metadata.worktree must not authorize an external worktree"
  );

  await writeFile(projectYamlPath, [
    "repositories:",
    `  - worktree: ${fixture.product}`,
    "    id: product",
    ""
  ].join("\n"));
  const reorderedMapping = await resolveAssignmentContext(bound, { projectRoot: fixture.control });
  assert.equal(reorderedMapping.repository, "product", "repository id need not be the first YAML property");

  await writeFile(projectYamlPath, [
    "project:",
    "  repositories:",
    "    - id: product",
    `      worktree: ${fixture.product}`,
    ""
  ].join("\n"));
  const projectChildMapping = await resolveAssignmentContext(bound, { projectRoot: fixture.control });
  assert.equal(projectChildMapping.repository, "product", "project.repositories is a supported direct section");

  await writeFile(projectYamlPath, [
    "repositories:",
    "  - id: product",
    "    metadata:",
    "      repositories:",
    "        - id: evil",
    `          worktree: ${fixture.product}`,
    ""
  ].join("\n"));
  await assert.rejects(
    () => resolveAssignmentContext(bound, { projectRoot: fixture.control }),
    (error) => error?.code === "assignment_packet_invalid" && /not declared by a project\.yaml repository mapping/.test(error.message),
    "nested metadata.repositories must not replace the root repository mapping"
  );

  await writeFile(projectYamlPath, originalProjectYaml);

  const verified = runVerifier(fixture);
  assert.equal(verified.result.status, 0, JSON.stringify(verified.evidence));
  assert.equal(verified.evidence.status, "pass");
  assert.deepEqual(verified.evidence.assignment_packet, {
    path: first.packet_path,
    sha256: first.packet_sha256,
    metadata: verified.evidence.assignment_packet.metadata
  });
  assert.equal(verified.evidence.assignment_packet.metadata.cwd, fixture.product);
  assert.equal(verified.evidence.repository_skills.declared, true, "real skill binding remains verifier-authoritative");
  const pristinePacket = packet;
  await writeFile(packetPath, `${packet}\nTAMPERED\n`);
  const tampered = runVerifier(fixture);
  assert.equal(tampered.result.status, 3);
  assert.equal(tampered.evidence.status, "invalid_context");
  assert.equal(tampered.evidence.failure.code, "assignment_packet_invalid");
  assert.deepEqual(tampered.evidence.gates, [], "packet failure must occur before gate execution");
  await writeFile(packetPath, pristinePacket);

  const contracts = [
    "skills/triad-loop-orchestrator/SKILL.md",
    "skills/triad-loop-developer/SKILL.md",
    "skills/triad-loop-reviewer/SKILL.md",
    "adapters/codex/prompts/triad.md",
    "adapters/claude-code/.claude/commands/triad.md",
    "adapters/opencode/.opencode/commands/triad.md",
    "adapters/opencode/.opencode/agents/triad-orchestrator.md",
    "adapters/opencode/.opencode/agents/triad-developer.md",
    "adapters/opencode/.opencode/agents/triad-reviewer.md",
    "adapters/antigravity/.agents/skills/triad/SKILL.md",
    "adapters/antigravity/.agents/agents/triad-orchestrator/agent.md",
    "adapters/antigravity/.agents/agents/triad-developer/agent.md",
    "adapters/antigravity/.agents/agents/triad-reviewer/agent.md",
    "adapters/hermes/skills/triad/SKILL.md",
    "adapters/copilot/.github/skills/triad/SKILL.md",
    "adapters/copilot/.github/agents/triad-orchestrator.agent.md",
    "adapters/copilot/.github/agents/triad-developer.agent.md",
    "adapters/copilot/.github/agents/triad-reviewer.agent.md"
  ];
  for (const relative of contracts) {
    const source = await readFile(path.join(repositoryRoot, relative), "utf8");
    assert.match(source, /packet/i, `${relative} must mention the packet`);
    if (/developer|reviewer|orchestrator|triad\.md|SKILL\.md/i.test(relative)) assert.match(source, /cwd|workdir|worktree/i, `${relative} must state operational worktree context`);
  }
  const packetBytes = Buffer.byteLength(packet);
  assert.ok(packetBytes < fixture.prdBytes + fixture.adrBytes, "packet benchmark fixture should be smaller than a full PRD/ADR reread");
  console.log(`Assignment packet tests passed: cwd=${fixture.product}, external mapping=PASS, undeclared external mapping=FAIL-CLOSED, packet=${packetBytes} bytes, full PRD/ADR source=${fixture.prdBytes + fixture.adrBytes} bytes.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
