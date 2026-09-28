#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseCodexReviewerResultJsonl } from './reviewer-result.mjs';

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
  stream.write('Usage: node adapters/codex/run-role.mjs --role <role> --cwd <path> --prompt-file <path> [--control <path>] [--model <model>] [--local-provider <provider>] [--profile-source <path>] [--codex <binary>]\n');
  process.exit(exitCode);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) usage(0);
  const role = option(argv, '--role');
  const cwd = option(argv, '--cwd');
  const promptFile = option(argv, '--prompt-file');
  const control = option(argv, '--control');
  const model = option(argv, '--model');
  const localProvider = option(argv, '--local-provider');
  const binary = option(argv, '--codex') ?? process.env.TRIAD_CODEX_BIN ?? 'codex';
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const profileSource = path.resolve(option(argv, '--profile-source') ?? path.join(codexHome, 'agents', `triad_${role}.toml`));
  if (!ROLES.has(role)) fail(`unsupported role: ${role ?? '<missing>'}`);
  if (!cwd || !promptFile) fail('--cwd and --prompt-file are required');

  const profile = await readFile(profileSource, 'utf8').catch((error) => fail(`cannot read configured profile ${profileSource}: ${error.message}`));
  const profileName = `triad_${role}`;
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'triad-codex-role-'));
  try {
    const isolatedProfile = path.join(isolatedHome, `${profileName}.config.toml`);
    const prompt = await readFile(path.resolve(promptFile), 'utf8').catch((error) => fail(`cannot read prompt ${promptFile}: ${error.message}`));
    await writeFile(isolatedProfile, profile);
    // Native authenticated runs need the existing host route, while the role
    // profile must remain isolated. Copy only the ephemeral user config/auth
    // inputs; never mutate the user's Codex home or persist these copies.
    if (!localProvider) {
      for (const file of ['config.toml', 'auth.json']) {
        const source = path.join(codexHome, file);
        const destination = path.join(isolatedHome, file);
        try {
          await access(source);
          await copyFile(source, destination);
          await chmod(destination, 0o600);
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error(`cannot stage Codex ${file}: ${error.message}`);
        }
      }
    }

    const dispatch = {
      type: 'triad.codex.role_dispatch',
      role,
      profile: profileName,
      profile_source: profileSource,
      profile_sha256: sha256(profile),
      invocation: 'codex exec --profile',
      isolated_codex_home: isolatedHome,
      cwd: path.resolve(cwd),
      control: control ? path.resolve(control) : null,
      model: model ?? 'profile-default',
      provider: localProvider ?? null
    };
    process.stdout.write(`${JSON.stringify(dispatch)}\n`);

    const command = [binary, 'exec', '--profile', profileName, '--ephemeral', '--json', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-C', path.resolve(cwd)];
    if (control) command.push('--add-dir', path.resolve(control));
    if (model) command.push('--model', model);
    if (localProvider) command.push('--oss', '--local-provider', localProvider);
    command.push('-');
    const result = spawnSync(command[0], command.slice(1), {
      cwd: path.resolve(cwd),
      env: { ...process.env, CODEX_HOME: isolatedHome },
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
    if (role === 'reviewer') {
      const reviewerResult = parseCodexReviewerResultJsonl(result.stdout ?? '');
      process.stdout.write(`${JSON.stringify({ type: 'text', part: { type: 'text', text: `TRIAD_REVIEW_RESULT: ${JSON.stringify(reviewerResult)}` } })}\n`);
    }
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`codex role launcher: ${error.message}\n`);
  process.exitCode = 2;
});
