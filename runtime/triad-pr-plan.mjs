#!/usr/bin/env node
import { open, readFile, realpath, rename, rm, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseWorkQueueItems } from "../cockpit/server/work-queue.mjs";
import { parseRepositoryMappings } from "./lib/assignment-packet.mjs";
import {
  approvePrPlan,
  buildPrPlan,
  prepareDraftPullRequests,
  renderPrPlanTable,
  validatePlanApproval,
  validatePrPlan,
  validateSnapshotSources,
} from "./lib/pr-planning.mjs";

function args(argv) {
  const [command, ...tail] = argv;
  if (command === "--help" || command === "-h") return { help: true };
  const result = { command, execute: false };
  const valueOptions = new Set(["--project", "--snapshot", "--plan", "--output", "--mode", "--owner"]);
  for (let i = 0; i < tail.length; i += 1) {
    const key = tail[i];
    if (key === "--execute") { result.execute = true; continue; }
    if (key === "--help" || key === "-h") return { help: true };
    if (!valueOptions.has(key) || !tail[i + 1] || tail[i + 1].startsWith("--")) throw new Error("Unknown or incomplete option: " + key);
    result[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = tail[++i];
  }
  return result;
}

function usage() {
  return [
    "Triad+ PR planning",
    "",
    "  node runtime/triad-pr-plan.mjs preview --project <control-workspace> --snapshot <snapshot.json> --mode <auto|single|compact|review-friendly> [--output <pr_plan.json>]",
    "  node runtime/triad-pr-plan.mjs approve --project <control-workspace> --snapshot <snapshot.json> --plan <pr_plan.json> --owner <owner-name>",
    "  node runtime/triad-pr-plan.mjs draft --project <control-workspace> --snapshot <snapshot.json> --plan <pr_plan.json> [--execute]",
    "",
    "Preview and draft are read-only by default. Draft creation requires an approved plan and --execute; it creates draft PRs only.",
  ].join("\n");
}

async function readJson(file, label) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw new Error(label + " could not be read as JSON: " + error.message); }
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function projectFile(root, value, label, { mustExist = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error("--" + label + " must name a path inside the Control Workspace");
  const candidate = path.resolve(root, value);
  if (!isWithin(root, candidate)) throw new Error("--" + label + " escapes the Control Workspace");
  const physical = await realpath(candidate).catch(() => null);
  if (physical) {
    if (!isWithin(root, physical)) throw new Error("--" + label + " resolves outside the Control Workspace");
    return physical;
  }
  if (mustExist) throw new Error("--" + label + " does not exist inside the Control Workspace");
  let ancestor = path.dirname(candidate);
  while (!isWithin(root, ancestor)) ancestor = path.dirname(ancestor);
  for (;;) {
    const resolved = await realpath(ancestor).catch(() => null);
    if (resolved) {
      if (!isWithin(root, resolved)) throw new Error("--" + label + " parent resolves outside the Control Workspace");
      break;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("--" + label + " has no safe parent inside the Control Workspace");
    ancestor = parent;
  }
  return candidate;
}

async function writePlanJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(targetPath), "." + path.basename(targetPath) + "." + randomUUID() + ".tmp");
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.close();
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function verifiedSnapshot(snapshotPath, projectRoot) {
  const snapshot = await readJson(snapshotPath, "PR snapshot");
  const source = await validateSnapshotSources(snapshot, projectRoot, { queueParser: parseWorkQueueItems });
  if (!source.valid) throw new Error(source.errors.map((item) => item.code + ": " + item.message).join("\n"));
  const projectYaml = await readFile(path.resolve(projectRoot, snapshot.source.project_path ?? "project.yaml"), "utf8");
  const mappings = parseRepositoryMappings(projectYaml);
  const declared = new Map(mappings.map((item) => [item.id, item]));
  const snapshotRepos = new Map((snapshot.repositories ?? []).map((item) => [item.id, item]));
  for (const id of declared.keys()) if (!snapshotRepos.has(id)) throw new Error("Snapshot omits declared repository " + id);
  for (const [id, repo] of snapshotRepos) {
    const mapping = declared.get(id);
    if (!mapping) throw new Error("Snapshot includes undeclared repository " + id);
    if (mapping.path && repo.path && path.resolve(projectRoot, mapping.path) !== path.resolve(projectRoot, repo.path)) throw new Error("Snapshot repository path differs from project.yaml: " + id);
    if (mapping.worktree && repo.worktree && path.resolve(projectRoot, mapping.worktree) !== path.resolve(projectRoot, repo.worktree)) throw new Error("Snapshot default worktree differs from project.yaml: " + id);
    if (mapping.base_branch && repo.base_branch !== mapping.base_branch) throw new Error("Snapshot base branch differs from project.yaml: " + id);
    if (mapping.project_branch && repo.project_branch !== mapping.project_branch) throw new Error("Snapshot default branch differs from project.yaml: " + id);
  }
  return snapshot;
}

function showValidation(plan, snapshot) {
  const result = validatePrPlan(plan, snapshot);
  stdout.write(renderPrPlanTable(plan) + "\n");
  stdout.write("Plan SHA-256: " + plan.plan_sha256 + "\n");
  for (const diagnostic of plan.diagnostics ?? []) stdout.write("Diagnostic: " + diagnostic.code + " — " + JSON.stringify(diagnostic.dependencies) + "\n");
  if (!result.valid) for (const item of result.errors) stdout.write("BLOCKED " + item.code + ": " + item.message + "\n");
  return result;
}

async function commandMain(options) {
  if (options.help) { stdout.write(usage() + "\n"); return 0; }
  if (!options.command || !["preview", "approve", "draft"].includes(options.command)) throw new Error(usage());
  const project = await realpath(options.project ?? "").catch(() => null);
  if (!project) throw new Error("--project must name an existing Control Workspace");
  const snapshotPath = await projectFile(project, options.snapshot, "snapshot", { mustExist: true });
  const snapshot = await verifiedSnapshot(snapshotPath, project);

  if (options.command === "preview") {
    const plan = buildPrPlan(snapshot, { mode: options.mode ?? "auto", bindings: snapshot.group_bindings ?? {} });
    const validation = showValidation(plan, snapshot);
    if (!validation.valid) return 2;
    const output = await projectFile(project, options.output ?? ".loop/runtime/pr_plan.json", "output");
    await writePlanJson(output, plan);
    stdout.write("Preview saved: " + path.relative(project, output) + "\n");
    return 0;
  }

  const planPath = await projectFile(project, options.plan, "plan", { mustExist: true });
  const plan = await readJson(planPath, "PR plan");
  const validation = showValidation(plan, snapshot);
  if (!validation.valid) return 2;

  if (options.command === "approve") {
    if (!options.owner) throw new Error("--owner is required to record explicit owner approval");
    if (plan.approval?.status === "approved" && !validatePlanApproval(plan).valid) throw new Error("Existing plan approval has drifted; regenerate the plan and request a new approval");
    const expected = "approve " + plan.plan_sha256.slice(0, 12);
    stdout.write("\nThis authorizes only " + plan.groups.length + " draft PR(s) in " + [...new Set(plan.groups.map((group) => group.target_repository))].join(", ") + ".\n");
    stdout.write("Type exactly " + JSON.stringify(expected) + " to approve: ");
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question("");
    rl.close();
    if (answer.trim() !== expected) throw new Error("Approval phrase did not match; no authorization was recorded");
    const approved = approvePrPlan(plan, { owner: options.owner });
    await writePlanJson(planPath, approved);
    stdout.write("Owner approval recorded for snapshot " + approved.plan_sha256 + " (draft-only).\n");
    return 0;
  }

  const approval = validatePlanApproval(plan);
  if (!approval.valid) throw new Error(approval.errors.map((item) => item.code + ": " + item.message).join("\n"));
  const result = await prepareDraftPullRequests(plan, snapshot, {
    execute: options.execute,
    projectRoot: project,
    onDraft: async (draft, drafts) => {
      plan.drafts = [...drafts];
      await writePlanJson(planPath, plan);
      stdout.write((draft.status === "created_draft" ? "Created " : "Found ") + draft.url + "\n");
    },
  });
  if (result.status === "manual_handoff") stdout.write(JSON.stringify(result, null, 2) + "\n");
  else stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

try {
  const status = await commandMain(args(process.argv.slice(2)));
  process.exitCode = status;
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.code ?? "pr_plan_error", message: error.message, details: error.errors ?? null }) + "\n");
  process.exitCode = 1;
}
