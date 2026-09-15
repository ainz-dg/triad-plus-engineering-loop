#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAssignmentPacket } from "./lib/assignment-packet.mjs";

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function usage() {
  process.stderr.write(`Usage: node .triad-runtime/triad-assignment-packet.mjs --project <control-workspace> --assignment <assignment.json> [--output <packet.md>]\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }
  const project = option(argv, "--project") ?? process.cwd();
  const assignmentOption = option(argv, "--assignment");
  if (!assignmentOption) throw Object.assign(new Error("--assignment is required"), { code: "assignment_packet_invalid" });
  const projectRoot = path.resolve(project);
  const assignmentPath = path.resolve(projectRoot, assignmentOption);
  const assignment = JSON.parse(await readFile(assignmentPath, "utf8"));
  const output = option(argv, "--output");
  const result = await writeAssignmentPacket(assignment, {
    projectRoot,
    assignmentPath,
    packetPath: output ? path.resolve(projectRoot, output) : null,
  });
  process.stdout.write(`${JSON.stringify({
    status: "ready",
    assignment: {
      id: result.assignment.assignment_id,
      feature_id: result.assignment.feature_id,
      attempt: result.assignment.attempt,
    },
    packet_path: result.assignment.assignment_packet_path,
    packet_absolute_path: result.packetPath,
    packet_sha256: result.sha256,
    dispatch: {
      cwd: result.context.cwd,
      control_workspace: result.context.controlWorkspace,
      repository: result.context.repository,
      branch: result.context.branch,
      card_path: result.assignment.card_path,
      packet_path: result.assignment.assignment_packet_path,
      mandatory_skill_paths: result.context.requiredSkills.map((skill) => skill.path),
    },
  })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 2;
  });
}
