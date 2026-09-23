#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeCardReport, writeHandoffReport } from "./lib/human-reports.mjs";

function parseArgs(argv) {
  const args = { mode: null, input: null, output: null, project: process.cwd(), worktree: null, baseCommit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write("Usage: node .triad-runtime/triad-human-report.mjs --mode <card|handoff> --input <derived-report-context.json> --output <report.md> [--project <control-workspace>] [--worktree <product-worktree>] [--base-commit <card-baseline> ]\n");
      return null;
    }
    const key = { "--mode": "mode", "--input": "input", "--output": "output", "--project": "project", "--worktree": "worktree", "--base-commit": "baseCommit" }[flag];
    if (!key) throw Object.assign(new Error(`unknown option: ${flag}`), { code: "human_report_cli_invalid" });
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw Object.assign(new Error(`${flag} requires a value`), { code: "human_report_cli_invalid" });
    args[key] = value;
    index += 1;
  }
  if (!args.mode || !["card", "handoff"].includes(args.mode)) throw Object.assign(new Error("--mode must be card or handoff"), { code: "human_report_cli_invalid" });
  if (!args.input || !args.output) throw Object.assign(new Error("--input and --output are required"), { code: "human_report_cli_invalid" });
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  const projectRoot = await realpath(args.project);
  const inputPath = path.resolve(projectRoot, args.input);
  const outputPath = path.resolve(projectRoot, args.output);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const result = args.mode === "card"
    ? await writeCardReport(input, {
      outputPath,
      projectRoot,
      worktree: args.worktree ? await realpath(path.resolve(projectRoot, args.worktree)) : input?.final?.worktree ?? null,
      baseCommit: args.baseCommit ?? input?.final?.base_commit ?? null,
    })
    : await writeHandoffReport(input, { outputPath, projectRoot });
  process.stdout.write(`${JSON.stringify({ valid: true, mode: args.mode, output: path.relative(projectRoot, result.outputPath) })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 2;
  });
}
