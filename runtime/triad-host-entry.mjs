#!/usr/bin/env node

import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { loadInstallationManifest } from './lib/installation-manifest.mjs';
import { parseRepositoryMappings } from './lib/assignment-packet.mjs';
import { parseQualityGates } from './lib/gates.mjs';

const SUPPORTED = new Set(['codex', 'hermes']);
const PRODUCT_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'go.mod', 'Gemfile'];

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000 });
}

async function expectedGlobalEntry(adapter) {
  if (adapter === 'codex') {
    return path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'prompts', 'triad.md');
  }
  const hermesHome = process.env.HERMES_HOME || path.join(homedir(), '.hermes');
  if (process.env.HERMES_HOME) return path.resolve(hermesHome, 'skills', 'triad', 'SKILL.md');
  const activePath = path.join(hermesHome, 'active_profile');
  try {
    const info = await lstat(activePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('active profile marker is unsafe');
    const active = (await readFile(activePath, 'utf8')).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(active) || active === '.' || active === '..') throw new Error('active profile name is unsafe');
    return path.join(hermesHome, 'profiles', active, 'skills', 'triad', 'SKILL.md');
  } catch (error) {
    if (error.code === 'ENOENT') return path.join(hermesHome, 'skills', 'triad', 'SKILL.md');
    throw new Error(`Hermes active profile cannot be determined safely: ${error.message}`);
  }
}

async function assertNoSymlinkPath(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    const tempAlias = info.isSymbolicLink()
      && ((current === '/var' && await realpath(current) === '/private/var') || (current === '/tmp' && await realpath(current) === '/private/tmp'));
    if (info.isSymbolicLink() && !tempAlias) throw new Error(`path contains a symlink: ${current}`);
  }
  return absolute;
}

async function regularFile(root, relativePath, problems, label) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    problems.push(`${label}: unsafe or missing relative path`);
    return null;
  }
  const target = path.resolve(root, relativePath);
  if (!within(root, target)) {
    problems.push(`${label}: path escapes the Control Workspace`);
    return null;
  }
  try {
    await assertNoSymlinkPath(target);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('not a regular file');
    return target;
  } catch (error) {
    problems.push(`${label}: ${error.code === 'ENOENT' ? 'missing' : error.message}`);
    return null;
  }
}

async function checkDeclaredWorkspaces(root, problems) {
  const config = await regularFile(root, 'project.yaml', problems, 'project.yaml');
  if (!config) return;
  let mappings;
  try { mappings = parseRepositoryMappings(await readFile(config, 'utf8')); }
  catch { mappings = []; }
  if (!mappings.length) {
    problems.push('project.yaml: no valid declared repository/worktree mappings');
    return;
  }
  const ids = new Set();
  for (const mapping of mappings) {
    if (!mapping.id || ids.has(mapping.id) || !mapping.path || !mapping.worktree) {
      problems.push(`project.yaml: malformed or duplicate repository mapping${mapping.id ? ` ${mapping.id}` : ''}`);
      continue;
    }
    ids.add(mapping.id);
    const repo = path.isAbsolute(mapping.path) ? path.resolve(mapping.path) : path.resolve(root, mapping.path);
    const worktree = path.isAbsolute(mapping.worktree) ? path.resolve(mapping.worktree) : path.resolve(root, mapping.worktree);
    for (const [label, target] of [[`${mapping.id} repository`, repo], [`${mapping.id} worktree`, worktree]]) {
      try {
        await assertNoSymlinkPath(target);
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('not a directory');
        const top = git(target, ['rev-parse', '--show-toplevel']);
        if (top.status !== 0 || path.resolve(top.stdout.trim()) !== path.resolve(await realpath(target))) throw new Error('not an independent Git root/worktree');
        const head = git(target, ['rev-parse', '--verify', 'HEAD']);
        if (head.status !== 0) throw new Error('missing initial Git baseline');
      } catch (error) {
        problems.push(`${label}: ${error.code === 'ENOENT' ? 'missing' : error.message}`);
      }
    }
    const commonRepo = git(repo, ['rev-parse', '--git-common-dir']);
    const commonWorktree = git(worktree, ['rev-parse', '--git-common-dir']);
    if (commonRepo.status !== 0 || commonWorktree.status !== 0) continue;
    const resolveCommon = async (base, value) => realpath(path.resolve(base, value.trim())).catch(() => null);
    const repoCommon = await resolveCommon(repo, commonRepo.stdout);
    const worktreeCommon = await resolveCommon(worktree, commonWorktree.stdout);
    if (!repoCommon || repoCommon !== worktreeCommon) problems.push(`${mapping.id} worktree: belongs to a different repository`);
  }
}

async function validateHostEntry({ adapter, cwd = process.cwd() }) {
  const problems = [];
  if (!SUPPORTED.has(adapter)) return { ready: false, root: path.resolve(cwd), problems: [`unsupported adapter ${adapter}`] };
  const declaredCwd = path.resolve(cwd);
  let root;
  try {
    root = await assertNoSymlinkPath(declaredCwd);
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('not a directory');
    if (path.resolve(await realpath(root)) !== root) throw new Error('path is not canonical');
  } catch (error) {
    problems.push(`current directory is not a safe Control Workspace: ${error.message}`);
    return { ready: false, root: declaredCwd, problems };
  }

  const gitRoot = git(root, ['rev-parse', '--show-toplevel']);
  const isProductRepo = gitRoot.status === 0 && path.resolve(gitRoot.stdout.trim()) === root
    && (await Promise.all(PRODUCT_MARKERS.map(async (name) => {
      try { await lstat(path.join(root, name)); return true; } catch { return false; }
    }))).some(Boolean);
  if (isProductRepo) problems.push('current directory is a product repository, not a Triad+ Control Workspace');

  let loaded;
  try { loaded = await loadInstallationManifest(root); }
  catch (error) {
    problems.push(`installation manifest is invalid: ${error.message}`);
    loaded = null;
  }
  if (!loaded) problems.push('missing valid project-local Triad+ installation manifest');

  const manifest = loaded?.manifest;
  const records = manifest?.schema_version === 2 ? manifest.adapters : manifest ? [{ id: manifest.adapter, ...manifest }] : [];
  const record = records.find((entry) => entry.id === adapter);
  if (!record) problems.push(`project-local ${adapter} adapter is not installed`);
  if (record && record.scope_status?.project !== 'installed') problems.push(`${adapter} project-local adapter is not marked installed`);
  if (record && record.scope_status?.global !== 'installed') problems.push(`${adapter} global entry is not marked installed`);

  if (record) {
    const assets = record.managed_assets ?? [];
    const projectAssets = assets.filter((asset) => asset.scope === 'project');
    const runtimeMetadata = projectAssets.find((asset) => asset.path.endsWith('/adapter.json') && asset.path.startsWith('.triad-runtime/'));
    if (!runtimeMetadata) problems.push(`${adapter} local adapter metadata is missing`);
    else {
      const metadataPath = await regularFile(root, runtimeMetadata.path, problems, `${adapter} local adapter metadata`);
      if (metadataPath) {
        try {
          const value = JSON.parse(await readFile(metadataPath, 'utf8'));
          if (value.id !== adapter) problems.push(`${adapter} local adapter metadata belongs to ${value.id ?? 'an unknown adapter'}`);
        } catch { problems.push(`${adapter} local adapter metadata is malformed`); }
      }
    }
    const neededAssets = adapter === 'codex'
      ? ['.triad-runtime/adapters/codex/run-role.mjs', '.agents/skills/triad-loop-orchestrator/SKILL.md']
      : ['.triad-runtime/triad-runtime-capabilities.mjs', runtimeMetadata.path];
    const byPath = new Map(projectAssets.map((asset) => [asset.path, asset]));
    for (const needed of neededAssets) if (!byPath.has(needed)) problems.push(`${adapter} local adapter asset is not recorded: ${needed}`);
    for (const asset of projectAssets) {
      const target = await regularFile(root, asset.path, problems, `managed asset ${asset.path}`);
      if (!target) continue;
      const digest = createHash('sha256').update(await readFile(target)).digest('hex');
      if (digest !== asset.sha256) problems.push(`managed asset ${asset.path} hash differs from installation manifest`);
    }
    const globalAssets = assets.filter((asset) => asset.scope === 'global');
    const expected = await expectedGlobalEntry(adapter);
    if (!globalAssets.some((asset) => asset.path === expected)) problems.push(`${adapter} global entry is not recorded at ${expected}`);
    for (const asset of globalAssets) {
      try {
        await assertNoSymlinkPath(asset.path);
        const info = await lstat(asset.path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('not a regular file');
        const digest = createHash('sha256').update(await readFile(asset.path)).digest('hex');
        if (digest !== asset.sha256) problems.push(`${adapter} global entry hash differs from installation manifest`);
      } catch (error) {
        problems.push(`${adapter} global entry: ${error.code === 'ENOENT' ? 'missing' : error.message}`);
      }
    }
  }

  const prd = await regularFile(root, 'PRD.md', problems, 'root PRD.md');
  if (prd && !(await readFile(prd, 'utf8')).trim()) problems.push('root PRD.md is empty');
  const gatesPath = await regularFile(root, '.loop/quality-gates.yaml', problems, '.loop/quality-gates.yaml');
  if (gatesPath) {
    try {
      const gates = parseQualityGates(await readFile(gatesPath, 'utf8'));
      const ids = new Set();
      if (!gates.length) problems.push('quality gates contain no gate definitions');
      for (const gate of gates) {
        if (!gate?.id || ids.has(gate.id) || !gate.command || /^REPLACE_ME/.test(gate.command.trim())) {
          problems.push(`quality gate definition is malformed${gate?.id ? `: ${gate.id}` : ''}`);
          break;
        }
        if ((gate.executor ?? 'control-plane') !== 'control-plane'
          || (gate.required !== undefined && typeof gate.required !== 'boolean')
          || (gate.timeout_seconds !== undefined && (!Number.isFinite(gate.timeout_seconds) || gate.timeout_seconds <= 0))) {
          problems.push(`quality gate definition is unsupported or malformed: ${gate.id}`);
          break;
        }
        ids.add(gate.id);
      }
    } catch (error) { problems.push(`quality gates are invalid: ${error.message}`); }
  }
  await checkDeclaredWorkspaces(root, problems);
  return { ready: problems.length === 0, root, problems };
}

function parseArgs(argv) {
  const result = { adapter: null, workspace: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--adapter' && argv[index + 1]) result.adapter = argv[++index];
    else if (argv[index] === '--workspace' && argv[index + 1]) result.workspace = path.resolve(argv[++index]);
    else throw new Error(`unsupported argument: ${argv[index]}`);
  }
  if (!result.adapter) throw new Error('usage: node triad-host-entry.mjs --adapter <codex|hermes> [--workspace <explicit-path>]');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.workspace && options.workspace !== path.resolve(process.cwd())) {
      process.stderr.write(`BLOCKED: Triad not started. Host is open in ${path.resolve(process.cwd())}, not the explicitly supplied workspace ${options.workspace}. Reopen/restart the host from that exact workspace; no workspace search was performed.\n`);
      process.exitCode = 2;
    } else {
      const result = await validateHostEntry(options);
      if (result.ready) process.stdout.write(`READY: ${options.adapter} Triad+ workspace validated at ${result.root}. Continue only from this workspace.\n`);
      else {
        process.stderr.write(`BLOCKED: Triad not started. No files, settings, or delegation were changed.\n${result.problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
        process.stderr.write('Use an explicit Control Workspace path: reopen/restart the host there, run the Triad+ setup wizard there, or cancel. No other workspace was searched.\n');
        process.exitCode = 2;
      }
    }
  } catch (error) {
    process.stderr.write(`BLOCKED: Triad not started. No files, settings, or delegation were changed. ${error.message}\n`);
    process.stderr.write('Reopen/restart the host at the exact Control Workspace, run the setup wizard there, or cancel. No other workspace was searched.\n');
    process.exitCode = 2;
  }
}

export { validateHostEntry };
