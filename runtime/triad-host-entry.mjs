#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateHostEntry } from './lib/host-entry-validation.mjs';

function parseArgs(argv) {
  const result = { adapter: null, workspace: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--adapter' && argv[index + 1]) result.adapter = argv[++index];
    else if (argv[index] === '--workspace' && argv[index + 1]) result.workspace = path.resolve(argv[++index]);
    else throw new Error(`unsupported argument: ${argv[index]}`);
  }
  if (!result.adapter) throw new Error('usage: node triad-host-entry.mjs --adapter <adapter-id> [--workspace <explicit-path>]');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (!process.argv.includes('--structural-only')) {
      const { parseReadinessArguments, runReadinessCommand } = await import('./lib/readiness.mjs');
      const options = parseReadinessArguments(process.argv.slice(2));
      if (options.cwd && path.resolve(options.cwd) !== path.resolve(process.cwd())) throw new Error('Explicit workspace does not match the host current directory.');
      const result = await runReadinessCommand({ ...options, cwd: process.cwd(), requireGlobalEntry: ['codex', 'hermes'].includes(options.adapter) });
      process.exitCode = result.ready ? 0 : 2;
    } else {
      const options = parseArgs(process.argv.slice(2).filter((arg) => arg !== '--structural-only'));
      if (options.workspace && options.workspace !== path.resolve(process.cwd())) {
        process.stderr.write(`BLOCKED: Triad not started. Host is open in ${path.resolve(process.cwd())}, not the explicitly supplied workspace ${options.workspace}. Reopen/restart the host from that exact workspace; no workspace search was performed.\n`);
        process.exitCode = 2;
      } else {
        const result = await validateHostEntry(options);
        if (result.ready) process.stdout.write(`STRUCTURE OK: ${options.adapter} Triad+ workspace validated at ${result.root}. Continue only from this workspace.\n`);
        else {
          process.stderr.write(`BLOCKED: Triad not started. No files, settings, or delegation were changed.\n${result.problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
          process.stderr.write('Use an explicit Control Workspace path: reopen/restart the host there, run the Triad+ setup wizard there, or cancel. No other workspace was searched.\n');
          process.exitCode = 2;
        }
      }
    }
  } catch (error) {
    const message = !process.argv.includes('--structural-only') && error.code !== 'READINESS_BLOCKED'
      ? 'Preflight evidence is unavailable or changed; inspect locally.' : error.message;
    process.stderr.write(`BLOCKED: Triad not started.${!process.argv.includes('--structural-only') ? '' : ' No files, settings, or delegation were changed.'} ${message}\n`);
    process.stderr.write('Reopen/restart the host at the exact Control Workspace, run the setup wizard there, or cancel. No other workspace was searched.\n');
    process.exitCode = 2;
  }
}

export { validateHostEntry };
