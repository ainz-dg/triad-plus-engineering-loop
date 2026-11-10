// Manifest inspection only. No executable probing, package-manager calls or activation.
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseRepositoryMappings } from './assignment-packet.mjs';

export const GATE_DRAFT = '.triad-plus/quality-gates.draft.json';
const LIMIT = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT = /^(test|lint|typecheck|type-check|check:types|build)(?::[a-z0-9][a-z0-9:_-]{0,63})?$/;
const FORBIDDEN = /(?:^|[^a-z0-9])(?:publish|deploy|install|uninstall|docker|podman|vrt|visual|snapshot|update|fix|write|clean|release|migrate|migration|seed|rm|sudo|curl|wget|start|serve|watch|dev)(?:[^a-z0-9]|$)/i;
const RUNNERS = new Set(['node', 'vitest', 'jest', 'mocha', 'eslint', 'biome', 'tsc', 'vue-tsc', 'vite', 'rollup', 'webpack', 'tsup', 'astro', 'next']);
const COMMON = ['pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Makefile'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function safePath(target) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      const alias = (current === '/tmp' && await realpath(current) === '/private/tmp')
        || (current === '/var' && await realpath(current) === '/private/var');
      if (!alias) throw new Error('unsafe-path');
    }
  }
  return absolute;
}

/** Bounded regular-file read; all errors are codes, never file text or OS messages. */
export async function readGateSource(target) {
  let handle;
  try {
    await safePath(target);
    if (!(await lstat(target)).isFile()) return { status: 'unsupported-file' };
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > LIMIT) return { status: 'unsupported-file' };
    // Read at most LIMIT + 1 even if a regular file grows after stat.
    const buffer = Buffer.alloc(LIMIT + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > LIMIT) return { status: 'unsupported-file' };
    const bytes = buffer.subarray(0, total);
    return { status: 'read', text: bytes.toString('utf8'), sha256: hash(bytes) };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'unreadable-or-unsafe' };
  } finally { await handle?.close(); }
}

function category(name) {
  if (name.startsWith('type') || name.startsWith('check:types')) return 'typecheck';
  return name.split(':')[0];
}

async function inspectScript(name, body, directory, scripts) {
  if (typeof body !== 'string' || !body.trim() || body.length > 4096 || /[\u0000-\u001f\u007f]/.test(body)) return 'invalid-script';
  if (FORBIDDEN.test(name) || FORBIDDEN.test(body)) return 'mutating-or-specialized-command';
  if (Object.hasOwn(scripts, 'pre' + name) || Object.hasOwn(scripts, 'post' + name)) return 'lifecycle-hooks-require-manual-review';
  // Deliberately conservative: composites, substitutions and inline code need manual review.
  if (/[|&;<>$`(){}\[\]*?\\"']/.test(body)) return 'opaque-shell-command';
  const argv = body.trim().split(/\s+/);
  if (!RUNNERS.has(argv[0])) return 'unsupported-runner';
  if (argv.some((arg) => /^--?(?:watch\w*|update\w*|write\w*|inspect\w*|w|u)(?:=|$)/i.test(arg))) return 'interactive-or-mutating-mode';
  if (argv[0] === 'vitest' && !argv.includes('run') && !argv.includes('--run')) return 'interactive-runner-mode';
  if (['vite', 'next', 'astro'].includes(argv[0]) && argv[1] !== 'build') return 'interactive-runner-mode';
  if (argv[0] === 'biome' && !['lint', 'check', 'ci'].includes(argv[1])) return 'unsupported-runner-mode';
  if (argv[0] === 'node') {
    if (argv.some((arg) => /^(?:-e|-p|-r|--eval|--print|--import|--require|--loader|--experimental-loader)(?:=|$)/.test(arg))) return 'inline-or-imported-code';
    const files = argv.slice(1).filter((arg) => !arg.startsWith('-'));
    if (!files.length && !argv.includes('--test')) return 'missing-script-file';
    for (const file of files) {
      const target = path.resolve(directory, file);
      if (!target.startsWith(directory + path.sep)) return 'script-path-outside-source';
      if ((await readGateSource(target)).status !== 'read') return 'missing-or-unsafe-script-file';
    }
  }
  return null;
}

async function inspectMapping(root, mapping) {
  if (!ID.test(mapping?.id ?? '') || typeof mapping.path !== 'string' || !mapping.path
    || typeof mapping.worktree !== 'string' || !mapping.worktree) {
    return { status: 'invalid-mapping', candidates: [] };
  }
  const repository = path.resolve(root, mapping.path);
  const worktree = path.resolve(root, mapping.worktree);
  const result = {
    id: mapping.id, repository: mapping.path, worktree: mapping.worktree,
    context_verified: false, requires_review: true, candidates: [], excluded: [], notes: [],
  };
  let sourceRoot;
  try {
    await safePath(repository);
    if (!(await lstat(repository)).isDirectory()) throw new Error('not-directory');
    try {
      await safePath(worktree);
      if (!(await lstat(worktree)).isDirectory()) throw new Error('not-directory');
      sourceRoot = worktree;
      result.source_context = 'declared-worktree';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      sourceRoot = repository;
      result.source_context = 'repository-preview';
      result.notes.push('mapped-worktree-missing; re-discover there before confirmation');
    }
  } catch {
    return { ...result, status: 'unsafe-or-missing-mapping' };
  }
  const source = await readGateSource(path.join(sourceRoot, 'package.json'));
  if (source.status !== 'read') {
    for (const manifest of COMMON) {
      if ((await readGateSource(path.join(sourceRoot, manifest))).status === 'read') result.notes.push('manual-gate-configuration:' + manifest);
    }
    return { ...result, status: source.status === 'missing' ? 'no-supported-manifest' : source.status };
  }
  result.source = { manifest: 'package.json', sha256: source.sha256 };
  let manifest;
  try { manifest = JSON.parse(source.text); }
  catch { return { ...result, status: 'malformed-manifest' }; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ...result, status: 'malformed-manifest' };
  const manager = manifest.packageManager;
  if (manager !== undefined && (typeof manager !== 'string' || !/^npm@[0-9][^\s]*$/.test(manager))) {
    return { ...result, status: 'package-manager-requires-manual-review' };
  }
  for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    if ((await readGateSource(path.join(sourceRoot, lock))).status !== 'missing') {
      return { ...result, status: 'package-manager-requires-manual-review' };
    }
  }
  const scripts = manifest.scripts;
  if (scripts === undefined) return { ...result, status: 'no-scripts' };
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts) || Object.keys(scripts).length > 128) {
    return { ...result, status: 'invalid-scripts' };
  }
  result.prerequisites = ['node', 'npm', 'repository dependencies', 'verify mapped repository/worktree identity'];
  for (const name of Object.keys(scripts).sort()) {
    if (!SCRIPT.test(name)) continue;
    const reason = await inspectScript(name, scripts[name], sourceRoot, scripts);
    if (reason) { result.excluded.push({ script: name, reason }); continue; }
    result.candidates.push({
      id: name, category: category(name), command: 'npm --ignore-scripts run ' + name,
      executor: 'control-plane', timeout_seconds: 600,
      execution_verified: false, requires_confirmation: true,
      command_source: { manifest_sha256: source.sha256, script: name, script_sha256: hash(scripts[name]) },
    });
  }
  return { ...result, status: result.candidates.length ? 'proposed' : 'no-candidates' };
}

/** Caller supplies explicit mappings or reads only the selected workspace's project.yaml. */
export async function discoverQualityGates(controlRoot, mappings = undefined) {
  const root = path.resolve(controlRoot);
  const draft = { schema_version: 1, active: false, discovery: 'manifest-read-only', repositories: [] };
  if (mappings === undefined) {
    const project = await readGateSource(path.join(root, 'project.yaml'));
    if (project.status !== 'read') return { ...draft, status: 'mapping-' + project.status };
    try { mappings = parseRepositoryMappings(project.text); }
    catch { return { ...draft, status: 'invalid-mappings' }; }
  }
  if (!Array.isArray(mappings) || mappings.length > 64) return { ...draft, status: 'invalid-mappings' };
  const ids = new Set();
  for (const mapping of mappings) {
    if (ids.has(mapping?.id)) return { ...draft, status: 'duplicate-mapping' };
    ids.add(mapping?.id);
    draft.repositories.push(await inspectMapping(root, mapping));
  }
  return { ...draft, status: mappings.length ? 'discovered' : 'no-mappings' };
}
