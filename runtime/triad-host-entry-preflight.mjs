#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUPPORTED = new Set(['codex', 'hermes']);
const MANIFEST_PATH = '.triad-plus/installation.json';
const SHA256 = /^[a-f0-9]{64}$/i;

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function assertNoSymlinkPath(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    const tempAlias = info.isSymbolicLink()
      && ((current === '/var' && await realpath(current) === '/private/var')
        || (current === '/tmp' && await realpath(current) === '/private/tmp'));
    if (info.isSymbolicLink() && !tempAlias) throw new Error(`path contains a symlink: ${current}`);
  }
  return absolute;
}

async function readRegularFile(target, { root = null, label = target } = {}) {
  const absolute = path.resolve(target);
  if (root && !within(root, absolute)) throw new Error(`${label} escapes the bound Control Workspace`);
  await assertNoSymlinkPath(absolute);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file`);
  if (path.resolve(await realpath(absolute)) !== absolute) throw new Error(`${label} is not a canonical path`);
  return readFile(absolute);
}

function parseArguments(argv) {
  let adapter = null;
  let workspace = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--adapter' && argv[index + 1]) adapter = argv[++index];
    else if (argv[index] === '--workspace' && argv[index + 1]) workspace = path.resolve(argv[++index]);
    else throw new Error(`unsupported argument: ${argv[index]}`);
  }
  if (!SUPPORTED.has(adapter)) throw new Error('usage: host-entry-preflight.mjs --adapter <codex|hermes> [--workspace <exact-path>]');
  return { adapter, workspace };
}

function assetList(value, label, { absolute = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const seen = new Set();
  const result = value.map((asset) => {
    if (!asset || typeof asset.path !== 'string' || !SHA256.test(asset.sha256)
      || !['file', 'managed_block'].includes(asset.kind)) throw new Error(`${label} contains an invalid entry`);
    const normalized = absolute ? path.resolve(asset.path) : asset.path.split('/').join(path.sep);
    if ((absolute && normalized !== asset.path)
      || (!absolute && (path.isAbsolute(asset.path) || normalized !== asset.path
        || asset.path.split('/').some((part) => !part || part === '.' || part === '..')))) {
      throw new Error(`${label} contains an unsafe path: ${asset.path}`);
    }
    if (seen.has(asset.path)) throw new Error(`${label} contains a duplicate path: ${asset.path}`);
    seen.add(asset.path);
    return { path: asset.path, kind: asset.kind, sha256: asset.sha256.toLowerCase() };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return result;
}

function adapterRecord(manifest, adapter) {
  if (manifest?.schema_version === 1 && manifest.adapter === adapter) return manifest;
  if (manifest?.schema_version === 2 && Array.isArray(manifest.adapters)) {
    return manifest.adapters.find((entry) => entry?.id === adapter) ?? null;
  }
  return null;
}

async function validateBinding({ adapter, workspace, bindingPath }) {
  const bindingBytes = await readRegularFile(bindingPath, { label: 'global host-entry binding' });
  let binding;
  try { binding = JSON.parse(bindingBytes.toString('utf8')); }
  catch { throw new Error('global host-entry binding is not valid JSON'); }
  if (binding?.schema_version !== 1 || binding.adapter !== adapter
    || typeof binding.workspace !== 'string' || path.resolve(binding.workspace) !== binding.workspace
    || binding.installation_manifest !== MANIFEST_PATH) {
    throw new Error('global host-entry binding is malformed or belongs to another adapter');
  }

  const declaredWorkspace = await realpath(workspace);
  if (declaredWorkspace !== workspace || declaredWorkspace !== binding.workspace) {
    throw new Error(`this host is open at ${declaredWorkspace}, not the owner-bound Control Workspace ${binding.workspace}`);
  }

  const expectedProject = assetList(binding.expected_project_assets, 'bound project assets');
  const expectedGlobal = assetList(binding.expected_global_assets, 'bound global bridge assets', { absolute: true });
  const manifestBytes = await readRegularFile(path.join(workspace, MANIFEST_PATH), { root: workspace, label: 'installation manifest' });
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('installation manifest is not valid JSON'); }
  const record = adapterRecord(manifest, adapter);
  if (!record || record.scope_status?.project !== 'installed' || record.scope_status?.global !== 'installed') {
    throw new Error(`${adapter} is not recorded as project- and global-installed in the bound manifest`);
  }

  const declaredProject = assetList((record.managed_assets ?? []).filter((asset) => asset.scope === 'project'), 'manifest project assets');
  if (JSON.stringify(declaredProject) !== JSON.stringify(expectedProject)) {
    throw new Error('project-managed asset list differs from the owner-bound manifest');
  }
  const bindingDigest = digest(bindingBytes);
  const declaredGlobal = (record.managed_assets ?? []).filter((asset) => asset.scope === 'global');
  const declaredBinding = declaredGlobal.find((asset) => path.resolve(asset.path) === bindingPath);
  if (!declaredBinding || declaredBinding.kind !== 'file' || declaredBinding.sha256 !== bindingDigest) {
    throw new Error('global binding is not recorded byte-for-byte in the installation manifest');
  }
  const otherGlobal = assetList(declaredGlobal.filter((asset) => path.resolve(asset.path) !== bindingPath), 'manifest global assets', { absolute: true });
  if (JSON.stringify(otherGlobal) !== JSON.stringify(expectedGlobal)) {
    throw new Error('global bridge asset list differs from the owner-bound manifest');
  }

  const boundRuntimeAssets = [];
  for (const asset of expectedProject) {
    const bytes = await readRegularFile(path.join(workspace, asset.path), { root: workspace, label: `managed project asset ${asset.path}` });
    if (digest(bytes) !== asset.sha256) throw new Error(`managed project asset hash differs from owner binding: ${asset.path}`);
    if (asset.path.startsWith('.triad-runtime/')) boundRuntimeAssets.push({ path: asset.path, bytes });
  }
  for (const asset of expectedGlobal) {
    const bytes = await readRegularFile(asset.path, { label: `managed global bridge asset ${asset.path}` });
    if (digest(bytes) !== asset.sha256) throw new Error(`managed global bridge asset hash differs from owner binding: ${asset.path}`);
  }

  const localEntry = path.join(workspace, '.triad-runtime', 'triad-host-entry.mjs');
  if (!expectedProject.some((asset) => asset.path === '.triad-runtime/triad-host-entry.mjs')) {
    throw new Error('owner-bound project assets do not include the local host validator');
  }
  if (!boundRuntimeAssets.some((asset) => asset.path === '.triad-runtime/triad-host-entry.mjs')) {
    throw new Error('owner-bound runtime snapshot does not include the local host validator');
  }
  return { localEntry, workspace, boundRuntimeAssets };
}

async function main() {
  const { adapter, workspace: requestedWorkspace } = parseArguments(process.argv.slice(2));
  const current = path.resolve(process.cwd());
  const workspace = requestedWorkspace ?? current;
  if (workspace !== current) throw new Error('explicit workspace does not match the host current directory; reopen/restart the host from the bound workspace');
  await assertNoSymlinkPath(workspace);
  const canonicalWorkspace = await realpath(workspace);
  if (canonicalWorkspace !== workspace) throw new Error('Control Workspace is not an exact canonical path; reopen the host from the owner-bound path');
  const bridgeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bindingKey = digest(Buffer.from(canonicalWorkspace));
  const bindingPath = path.join(bridgeDirectory, 'bindings', `${bindingKey}.json`);
  const result = await validateBinding({ adapter, workspace, bindingPath });
  const snapshotRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'triad-host-entry-preflight-'));
  try {
    for (const asset of result.boundRuntimeAssets) {
      const target = path.resolve(snapshotRoot, asset.path);
      if (!within(snapshotRoot, target)) throw new Error('bound runtime snapshot path escaped its temporary directory');
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, asset.bytes, { flag: 'wx', mode: 0o600 });
    }
    const snapshotEntry = path.join(snapshotRoot, '.triad-runtime', 'triad-host-entry.mjs');
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawnSync(process.execPath, [snapshotEntry, '--adapter', adapter, '--workspace', workspace], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (child.error) throw new Error(`bound validator could not run: ${child.error.message}`);
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.status !== 0) process.exitCode = child.status ?? 2;
  } finally {
    const info = await lstat(snapshotRoot).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink() && await realpath(snapshotRoot).catch(() => null) === snapshotRoot) {
      await rm(snapshotRoot, { recursive: true, force: true });
    }
  }
}

try { await main(); }
catch (error) {
  process.stderr.write(`BLOCKED: Triad not started. Trusted global preflight refused to execute local workspace code. ${error.message}\n`);
  process.stderr.write('Open/restart the host from the owner-bound Control Workspace or rerun the consent-gated setup wizard there. No workspace search or local runtime execution occurred.\n');
  process.exitCode = 2;
}
