import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packetCli = path.join(repositoryRoot, "runtime", "triad-assignment-packet.mjs");
const developerSkillPath = path.join(repositoryRoot, "skills", "triad-loop-developer", "SKILL.md");

function run(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${name} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const skill = await readFile(developerSkillPath, "utf8");
assert.match(skill, /Triad process identifiers and bookkeeping metadata/);
assert.match(skill, /Do not introduce them into product-owned/);
assert.match(skill, /Repository-owned\s+naming conventions and explicit product requirements remain authoritative/);

const root = await mkdtemp(path.join(os.tmpdir(), "triad-process-product-naming-test-"));
try {
  const control = path.join(root, "control");
  const product = path.join(root, "product");
  await mkdir(path.join(control, "features"), { recursive: true });
  await mkdir(path.join(control, ".loop", "runtime", "assignments"), { recursive: true });
  await mkdir(path.join(product, ".agents", "skills", "router"), { recursive: true });
  await writeFile(path.join(product, ".agents", "skills", "router", "SKILL.md"), "# Product repository policy\n");
  await writeFile(path.join(control, "features", "NAMING-001.md"), [
    "# Customer-facing form title",
    "",
    "## Outcome and scope",
    "- Target repository: product",
    "- Branch/worktree: declared",
    "- Outcome: preserve the product-owned title",
    "- In scope: src/",
    "- Out of scope: control records",
    "",
    "## Acceptance criteria",
    "1. The product-owned title remains repository-defined.",
    "",
    "## Metrics and gates",
    "| ID | Target | Evidence command or observation |",
    "| M-001 | title preserved | focused test |",
    "",
    "## Integration, practical test, and risk",
    "- Owner practical test: inspect the title.",
    ""
  ].join("\n"));
  run("git", ["init", "-q"], product);
  run("git", ["config", "user.email", "triad-test@example.invalid"], product);
  run("git", ["config", "user.name", "Triad Test"], product);
  run("git", ["add", "."], product);
  run("git", ["commit", "-qm", "baseline"], product);
  const branch = run("git", ["branch", "--show-current"], product);
  await writeFile(path.join(control, "project.yaml"), [
    "repositories:",
    "  - id: product",
    `    worktree: ${product}`,
    ""
  ].join("\n"));
  const assignmentPath = path.join(control, ".loop", "runtime", "assignments", "developer.json");
  await writeJson(assignmentPath, {
    schema_version: 1,
    assignment_id: "assignment-naming-001",
    status: "active",
    agent_id: "developer-naming-001",
    agent_type: "triad_developer",
    feature_id: "NAMING-001",
    attempt: 1,
    project_root: control,
    worktree: product,
    expected_branch: branch,
    card_path: "features/NAMING-001.md",
    required_repository_skills: [{
      path: ".agents/skills/router/SKILL.md",
      sha256: "0".repeat(64)
    }]
  });
  const skillPath = path.join(product, ".agents", "skills", "router", "SKILL.md");
  const { createHash } = await import("node:crypto");
  const skillSha = createHash("sha256").update(await readFile(skillPath)).digest("hex");
  const assignment = JSON.parse(await readFile(assignmentPath, "utf8"));
  assignment.required_repository_skills[0].sha256 = skillSha;
  await writeJson(assignmentPath, assignment);
  const packetOutput = JSON.parse(run(process.execPath, [packetCli, "--project", control, "--assignment", assignmentPath], control));
  const packet = await readFile(path.join(control, packetOutput.packet_path), "utf8");
  const outcome = packet.split("## Card outcome and scope\n\n", 2)[1].split("\n\n## Acceptance criteria", 1)[0];
  assert.match(outcome, /product-owned title/);
  assert.doesNotMatch(outcome, /NAMING-001|assignment-naming-001/);
  assert.match(packet, /"feature_id": "NAMING-001"/);
  assert.match(packet, /"assignment_id": "assignment-naming-001"/);
  console.log("Process/product naming separation tests passed: developer contract=PASS, card content remains repository-owned, control metadata remains traceable.");
} finally {
  await rm(root, { recursive: true, force: true });
}
