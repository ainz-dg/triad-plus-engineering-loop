#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROLES = new Set(['orchestrator', 'developer', 'reviewer', 'evaluator']);

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function fail(message) {
  throw new Error(message);
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('Usage: node adapters/opencode/run-role.mjs --role <role> --control <path> --cwd <path> --prompt-file <path> [--model <provider/model>] [--opencode <binary>]\n');
  process.exit(exitCode);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) usage(0);
  const role = option(argv, '--role');
  const control = option(argv, '--control');
  const cwd = option(argv, '--cwd');
  const promptFile = option(argv, '--prompt-file');
  const model = option(argv, '--model');
  const binary = option(argv, '--opencode') ?? process.env.TRIAD_OPENCODE_BIN ?? 'opencode';
  if (!ROLES.has(role)) fail(`unsupported role: ${role ?? '<missing>'}`);
  if (!control || !cwd || !promptFile) fail('--control, --cwd, and --prompt-file are required');

  const controlRoot = path.resolve(control);
  const productRoot = path.resolve(cwd);
  const opencodeConfigRoot = path.join(controlRoot, '.opencode');
  const profilePath = path.join(controlRoot, '.opencode', 'agents', `triad-${role}.md`);
  const original = await readFile(profilePath, 'utf8').catch((error) => fail(`cannot read ${profilePath}: ${error.message}`));
  const mode = /^mode:\s*(subagent|primary)\s*$/m.exec(original);
  if (!mode) fail(`role profile has no supported mode: ${profilePath}`);

  // `opencode run --agent` is a supported primary-agent entry point. The
  // normal Triad profiles remain subagents for the Orchestrator Task tool; the
  // standalone deterministic driver temporarily materializes the same role as
  // primary, then restores the exact managed asset byte-for-byte.
  const standalone = original.slice(0, mode.index) + original.slice(mode.index).replace(mode[0], 'mode: primary');
  try {
    await writeFile(profilePath, standalone);
    const sourcePrompt = await readFile(path.resolve(promptFile), 'utf8');
    const prompt = [
      'Triad control workspace (authoritative control-plane paths):',
      controlRoot,
      'The product worktree is your current working directory. Read control-plane artifacts such as .triad-plus/team.json, assignments, packets, and verifier evidence from this workspace using explicit absolute paths; never copy them into the product worktree.',
      '',
      sourcePrompt.trim(),
    ].join('\n');
    const command = [binary, 'run', '--dir', productRoot, '--agent', `triad-${role}`];
    if (model) command.push('--model', model);
    command.push('--format', 'json', '--auto', '--', prompt.trim());
    const result = spawnSync(command[0], command.slice(1), {
      cwd: productRoot,
      env: { ...process.env, OPENCODE_CONFIG_DIR: opencodeConfigRoot },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await writeFile(profilePath, original);
  }
}

main().catch((error) => {
  process.stderr.write(`opencode role launcher: ${error.message}\n`);
  process.exitCode = 2;
});
