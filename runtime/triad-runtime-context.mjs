#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAssignmentContext, validateAssignmentPacket } from "./lib/assignment-packet.mjs";
import { inspectRepositoryContext } from "./lib/repository-context.mjs";

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function usage() {
  process.stderr.write("Usage: node .triad-runtime/triad-runtime-context.mjs --project <control-workspace> --assignment <assignment.json>\n");
}

function issue(code, message) {
  return { code, message };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }
  const projectRoot = path.resolve(option(argv, "--project") ?? process.cwd());
  const assignmentOption = option(argv, "--assignment");
  if (!assignmentOption) throw Object.assign(new Error("--assignment is required"), { code: "runtime_context_invalid" });
  const assignmentPath = path.resolve(projectRoot, assignmentOption);
  const assignment = JSON.parse(await readFile(assignmentPath, "utf8"));
  const output = {
    status: "blocked",
    assignment: {
      id: assignment.assignment_id ?? null,
      feature_id: assignment.feature_id ?? null,
      attempt: assignment.attempt ?? null,
      worktree: assignment.worktree ?? null,
      packet_metadata_cwd: null
    },
    repository_mapping: null,
    expected: null,
    actual: null,
    repository_skills: [],
    issues: []
  };
  try {
    const context = await resolveAssignmentContext(assignment, { projectRoot });
    output.assignment.worktree = context.worktree;
    output.repository_mapping = context.repositoryMapping;
    output.expected = {
      worktree: context.worktree,
      git_top_level: context.repositoryContext.assigned_git_top_level,
      repository: context.repository
    };
    if (assignment.assignment_packet_path || assignment.assignment_packet_sha256) {
      const packet = await validateAssignmentPacket(assignment, projectRoot);
      output.assignment.packet_metadata_cwd = packet.metadata.cwd ?? null;
    }
    const inspected = await inspectRepositoryContext({
      worktree: context.worktree,
      requiredSkills: context.requiredSkills,
      actualCwd: process.cwd(),
      checkActualCwd: true
    });
    output.actual = inspected.actual;
    output.repository_skills = inspected.skills;
    output.issues = inspected.issues;
    output.status = inspected.status;
  } catch (error) {
    if (error.repositoryContext) {
      output.actual = error.repositoryContext.actual ?? null;
      output.repository_skills = error.repositoryContext.skills ?? [];
      output.issues = error.repositoryContext.issues ?? [];
    }
    output.issues.push(issue(error.code ?? "runtime_context_invalid", error.message));
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status !== "pass") process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 2;
  });
}
