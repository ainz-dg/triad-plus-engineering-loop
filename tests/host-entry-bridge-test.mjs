import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInstallationManifest, buildMultiAdapterManifest, loadInstallationManifest, writeInstallationManifest } from '../runtime/lib/installation-manifest.mjs';
import { validateHostEntry } from '../runtime/triad-host-entry.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'triad-host-entry-')));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function safeEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i.test(name)));
  Object.assign(env, extra);
  for (const [name, value] of Object.entries(extra)) if (value === null) delete env[name];
  return env;
}

function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, { cwd, env: safeEnvironment(env), encoding: 'utf8', timeout: 30_000 });
}

function runCli(args, cwd, env = {}) {
  return run(process.execPath, [path.join(repositoryRoot, 'bin/triad-plus.js'), ...args], cwd, env);
}

// Explicit controlled-fixture owner confirmations, never implicit production consent.
function confirmFixtureReadiness(adapter, root, env) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const base = ['preflight', '--host', adapter, '--control', root, '--non-interactive', '--json'];
    let result = runCli(base, root, env);
    let report = JSON.parse(result.stdout);
    if (report.ready) return;
    const action = report.actions[0];
    assert.notEqual(action.kind, 'manual', JSON.stringify(report));
    const extra = action.kind === 'confirm-gates' ? ['--catalog', '.loop/quality-gates.yaml'] : [];
    if (extra.length) { result = runCli([...base, ...extra], root, env); report = JSON.parse(result.stdout); }
    result = runCli([...base, ...extra, '--approve', action.id, '--expected-state', report.state_sha256], root, env);
    assert.ok([0, 2].includes(result.status), result.stderr);
  }
  assert.fail('fixture readiness did not converge');
}

function runEntry(adapter, cwd, env = {}, extraArgs = []) {
  return run(process.execPath, [path.join(repositoryRoot, 'runtime/triad-host-entry.mjs'), '--adapter', adapter, '--structural-only', ...extraArgs], cwd, env);
}

function runPreflight(workspace, cwd = workspace.root, extra = {}, args = []) {
  return run(process.execPath, [workspace.preflightPath, '--adapter', workspace.adapter, ...args], cwd, { ...workspace.env, ...extra });
}

async function runDocumentedHermesPreflight(workspace, cwd = workspace.root, env = workspace.env) {
  const skillPath = path.join(env.HERMES_HOME, 'skills/triad/SKILL.md');
  const skill = await readFile(skillPath, 'utf8');
  const command = /^node "\$HOME\/.hermes\/triad-plus\/host-entry-preflight\.mjs" --adapter hermes --json$/m.exec(skill)?.[0];
  assert.ok(command, 'installed Hermes skill documents the canonical wrapper invocation');
  return run('/bin/sh', ['-c', command], cwd, env);
}

function git(cwd, args) {
  const result = run('git', ['-C', cwd, ...args], cwd, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function listFiles(root) {
  const output = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else output.push(path.relative(root, target).split(path.sep).join('/'));
    }
  }
  try { await walk(root); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output.sort();
}

async function snapshot(root) {
  const entries = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target).split(path.sep).join('/');
      const info = await lstat(target);
      if (info.isSymbolicLink()) entries.push({ path: relative, kind: 'symlink', target: await readlink(target) });
      else if (info.isDirectory()) await walk(target);
      else entries.push({ path: relative, kind: 'file', sha256: digest(await readFile(target)) });
    }
  }
  try { await walk(root); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return entries;
}

async function makeRepo(root) {
  await mkdir(root, { recursive: true });
  const init = run('git', ['init', '--initial-branch=main', root], root, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(init.status, 0, init.stderr);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  await writeFile(path.join(root, 'README.md'), 'temporary host-entry repository\n');
  await writeFile(path.join(root, 'package.json'), '{"name":"temporary-product"}\n');
  git(root, ['add', 'README.md', 'package.json']);
  git(root, ['commit', '-m', 'temporary host-entry baseline']);
}

async function makeWorkspace(adapter, name, { activeHermesProfile = null, explicitHermesHome = false, confirm = true } = {}) {
  const base = path.join(fixture, name);
  const root = path.join(base, 'control');
  const home = path.join(base, 'home');
  const codexHome = path.join(base, 'codex-home');
  const hermesHome = path.join(home, '.hermes');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const explicitHermesProfile = activeHermesProfile ? path.join(hermesHome, 'profiles', activeHermesProfile) : hermesHome;
  const env = { HOME: home, CODEX_HOME: codexHome,
    HERMES_HOME: adapter === 'hermes' && explicitHermesHome ? explicitHermesProfile : null,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const init = runCli(['init', '--host', adapter, '--control', root], root, env);
  assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);

  const repo = path.join(root, 'product');
  const worktree = path.join(root, 'worktrees', 'sample-feature');
  await makeRepo(repo);
  await mkdir(path.dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '-b', 'triad/sample-feature', worktree, 'main']);
  await writeFile(path.join(root, 'project.yaml'), [
    'project:',
    '  id: host-entry-fixture',
    'repositories:',
    '  - id: sample',
    '    path: ./product',
    '    base_branch: main',
    '    project_branch: triad/sample-feature',
    '    worktree: ./worktrees/sample-feature',
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'PRD.md'), '# Temporary host-entry fixture\n');
  await mkdir(path.join(root, '.loop'), { recursive: true });
  await writeFile(path.join(root, '.loop/quality-gates.yaml'), [
    'version: 2',
    'gates:',
    '  - id: fixture-check',
    '    command: true',
    '    required: true',
    '    executor: control-plane',
    '    timeout_seconds: 2',
    '',
  ].join('\n'));

  const globalAssets = [];
  const preflightSource = path.join(repositoryRoot, 'runtime/triad-host-entry-preflight.mjs');
  const bridgeRoot = adapter === 'codex' ? path.join(codexHome, 'triad-plus') : path.join(hermesHome, 'triad-plus');
  const preflightPath = path.join(bridgeRoot, 'host-entry-preflight.mjs');
  await mkdir(bridgeRoot, { recursive: true });
  await cp(preflightSource, preflightPath);
  if (adapter === 'codex') {
    const source = path.join(repositoryRoot, 'adapters/codex/skills/triad/SKILL.md');
    const target = path.join(codexHome, 'skills/triad/SKILL.md');
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
    globalAssets.push({ scope: 'global', path: target, kind: 'file', sha256: digest(await readFile(target)) });
  } else {
    const activeMarker = path.join(hermesHome, 'active_profile');
    let targetRoot = hermesHome;
    if (activeHermesProfile) {
      await mkdir(hermesHome, { recursive: true });
      await writeFile(activeMarker, `${activeHermesProfile}\n`);
      targetRoot = path.join(hermesHome, 'profiles', activeHermesProfile);
    }
    const sourceRoot = path.join(repositoryRoot, 'adapters/hermes/skills/triad');
    const destinationRoot = path.join(targetRoot, 'skills/triad');
    await cp(sourceRoot, destinationRoot, { recursive: true });
    for (const relative of await listFiles(sourceRoot)) {
      const target = path.join(destinationRoot, relative);
      globalAssets.push({ scope: 'global', path: target, kind: 'file', sha256: digest(await readFile(target)) });
    }
  }
  globalAssets.push({ scope: 'global', path: preflightPath, kind: 'file', sha256: digest(await readFile(preflightPath)) });

  const loaded = await loadInstallationManifest(root);
  assert.equal(loaded.manifest.schema_version, 1);
  const now = new Date().toISOString();
  const workspacePath = await realpath(root);
  const bindingKey = digest(Buffer.from(workspacePath));
  const bindingPath = path.join(bridgeRoot, 'bindings', `${bindingKey}.json`);
  const expectedProjectAssets = loaded.manifest.managed_assets
    .filter((asset) => asset.scope === 'project')
    .map(({ path: assetPath, kind, sha256 }) => ({ path: assetPath, kind, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expectedGlobalAssets = globalAssets
    .map(({ path: assetPath, kind, sha256 }) => ({ path: path.resolve(assetPath), kind, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const bindingBytes = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    adapter,
    workspace: workspacePath,
    installation_manifest: '.triad-plus/installation.json',
    expected_project_assets: expectedProjectAssets,
    expected_global_assets: expectedGlobalAssets,
  }, null, 2)}\n`);
  await mkdir(path.dirname(bindingPath), { recursive: true });
  await writeFile(bindingPath, bindingBytes);
  globalAssets.push({ scope: 'global', path: bindingPath, kind: 'file', sha256: digest(bindingBytes) });
  const record = {
    id: adapter,
    installed_at: loaded.manifest.installed_at,
    updated_at: now,
    scopes: { project: true, global: true },
    scope_status: { project: 'installed', global: 'installed' },
    managed_assets: [...loaded.manifest.managed_assets, ...globalAssets],
  };
  const multi = buildMultiAdapterManifest({
    triadVersion: loaded.manifest.triad_version,
    installedAt: loaded.manifest.installed_at,
    updatedAt: now,
    adapters: [record],
  });
  await writeInstallationManifest(root, multi);
  if (confirm) confirmFixtureReadiness(adapter, root, env);
  return { adapter, base, root, home, codexHome, hermesHome, env, repo, worktree, globalAssets, preflightPath, bindingPath };
}

async function makeOpenCodePrimaryMultiAdapterWorkspace(name) {
  const base = path.join(fixture, name);
  const root = path.join(base, 'control');
  const home = path.join(base, 'home');
  const codexHome = path.join(base, 'codex-home');
  const hermesHome = path.join(base, 'hermes-home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(hermesHome, { recursive: true });
  const env = { HOME: home, CODEX_HOME: codexHome, HERMES_HOME: hermesHome, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };

  for (const args of [
    ['init', '--host', 'opencode', '--control', root],
    ['adapter', 'add', 'codex', '--control', root, '--apply'],
    ['adapter', 'add', 'hermes', '--control', root, '--apply'],
  ]) {
    const result = runCli(args, root, env);
    assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}\n${result.stdout}`);
  }

  const repo = path.join(root, 'product');
  const worktree = path.join(root, 'worktrees', 'sample-feature');
  await makeRepo(repo);
  await mkdir(path.dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '-b', 'triad/sample-feature', worktree, 'main']);
  await writeFile(path.join(root, 'project.yaml'), [
    'project:',
    '  id: multi-host-entry-fixture',
    'repositories:',
    '  - id: sample',
    '    path: ./product',
    '    base_branch: main',
    '    project_branch: triad/sample-feature',
    '    worktree: ./worktrees/sample-feature',
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'PRD.md'), '# Multi-adapter host-entry fixture\n');
  await mkdir(path.join(root, '.loop'), { recursive: true });
  await writeFile(path.join(root, '.loop/quality-gates.yaml'), [
    'version: 2',
    'gates:',
    '  - id: fixture-check',
    '    command: true',
    '    required: true',
    '    executor: control-plane',
    '    timeout_seconds: 2',
    '',
  ].join('\n'));

  const codexSource = path.join(repositoryRoot, 'adapters/codex/skills/triad');
  const codexTarget = path.join(codexHome, 'skills/triad');
  await cp(codexSource, codexTarget, { recursive: true });
  const hermesSource = path.join(repositoryRoot, 'adapters/hermes/skills/triad');
  const hermesTarget = path.join(hermesHome, 'skills/triad');
  await cp(hermesSource, hermesTarget, { recursive: true });
  const codexGlobalAssets = [{
    scope: 'global', path: path.join(codexTarget, 'SKILL.md'), kind: 'file',
    sha256: digest(await readFile(path.join(codexTarget, 'SKILL.md'))),
  }];
  const hermesGlobalAssets = await Promise.all((await listFiles(hermesTarget)).map(async (relative) => ({
    scope: 'global', path: path.join(hermesTarget, relative), kind: 'file',
    sha256: digest(await readFile(path.join(hermesTarget, relative))),
  })));

  const loaded = await loadInstallationManifest(root);
  assert.equal(loaded.manifest.schema_version, 2);
  const primaryMetadata = loaded.manifest.adapters.find((entry) => entry.id === 'opencode')
    .managed_assets.find((asset) => asset.scope === 'project' && asset.path === '.triad-runtime/adapter.json');
  assert.ok(primaryMetadata, 'OpenCode owns the singleton primary runtime metadata');
  const now = new Date().toISOString();
  const adapters = loaded.manifest.adapters.map((record) => {
    if (!['codex', 'hermes'].includes(record.id)) return record;
    const globalAssets = record.id === 'codex' ? codexGlobalAssets : hermesGlobalAssets;
    return {
      ...record,
      updated_at: now,
      scopes: { ...record.scopes, global: true },
      scope_status: { ...record.scope_status, global: 'installed' },
      // Shared primary metadata can be present in an adapter's validated asset
      // inventory. It must not override that adapter's own runtime metadata.
      managed_assets: [...record.managed_assets, primaryMetadata, ...globalAssets],
    };
  });
  await writeInstallationManifest(root, buildMultiAdapterManifest({
    triadVersion: loaded.manifest.triad_version,
    installedAt: loaded.manifest.installed_at,
    updatedAt: now,
    adapters,
  }));

  confirmFixtureReadiness('codex', root, env);
  confirmFixtureReadiness('hermes', root, env);
  return { adapter: 'codex', base, root, home, codexHome, hermesHome, env, repo, worktree };
}

async function assertBlockedWithoutWrites(workspace, label, mutate, expected) {
  await mutate();
  const before = await snapshot(workspace.base);
  const result = await validateInEnvironment(workspace);
  assert.equal(result.ready, false, `${label} must fail closed`);
  assert.ok(result.problems.some((problem) => expected.test(problem)), `${label} reports actionable reason: ${result.problems.join('; ')}`);
  assert.deepEqual(await snapshot(workspace.base), before, `${label} does not mutate the workspace or profile`);
}

async function validateInEnvironment(workspace, cwd = workspace.root, adapter = workspace.adapter) {
  const names = ['HOME', 'CODEX_HOME', 'HERMES_HOME'];
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    const value = workspace.env[name];
    if (value === null || value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { return await validateHostEntry({ adapter, cwd }); }
  finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function staleOwnedEntry(workspace) {
  const loaded = await loadInstallationManifest(workspace.root);
  const record = loaded.manifest.adapters.find((item) => item.id === workspace.adapter);
  const binding = JSON.parse(await readFile(workspace.bindingPath, 'utf8'));
  for (const asset of record.managed_assets.filter((item) => item.scope === 'global' && item.path !== workspace.bindingPath)) {
    const suffix = asset.path.endsWith('.mjs') ? '\n// Earlier owned bridge\n' : asset.path.endsWith('.sh') ? '\n# Earlier owned bridge\n' : '\n<!-- Earlier owned bridge -->\n';
    await writeFile(asset.path, await readFile(asset.path, 'utf8') + suffix);
    binding.expected_global_assets.find((item) => item.path === asset.path).sha256 = digest(await readFile(asset.path));
  }
  binding.expected_project_assets[0].sha256 = '0'.repeat(64);
  await writeFile(workspace.bindingPath, JSON.stringify(binding, null, 2) + '\n');
  for (const asset of record.managed_assets.filter((item) => item.scope === 'global')) asset.sha256 = digest(await readFile(asset.path));
  await writeInstallationManifest(workspace.root, buildMultiAdapterManifest({ triadVersion: loaded.manifest.triad_version,
    installedAt: loaded.manifest.installed_at, updatedAt: loaded.manifest.updated_at, adapters: loaded.manifest.adapters }));
}

try {
  for (const adapter of ['codex', 'hermes']) {
    const workspace = await makeWorkspace(adapter, adapter + '-entry-refresh', { activeHermesProfile: adapter === 'hermes' ? 'owner-profile' : null });
    await staleOwnedEntry(workspace);
    assert.equal(runPreflight(workspace).status, 2, 'stale owner binding blocks the native wrapper');
    const secret = 'PRIVATE-FIXTURE-CREDENTIAL-DO-NOT-PRINT';
    const privateFile = path.join(workspace.home, 'unrelated-credentials.txt');
    await writeFile(privateFile, secret);
    const args = ['entry', 'refresh', '--host', adapter, '--control', workspace.root];
    const before = await snapshot(workspace.base);
    const preview = runCli(args, workspace.root, workspace.env);
    assert.equal(preview.status, 0, preview.stderr);
    assert.ok(preview.stdout.includes(JSON.stringify(workspace.bindingPath)));
    assert.ok(preview.stdout.includes(JSON.stringify(workspace.preflightPath)));
    const state = /Expected state: ([a-f0-9]{64})/.exec(preview.stdout)?.[1];
    assert.ok(state);
    assert.deepEqual(await snapshot(workspace.base), before, 'preview cannot mutate local or global files');
    for (const extra of [['--apply'], ['--apply', '--expected-state', '0'.repeat(64)]]) {
      const denied = runCli([...args, ...extra], workspace.root, workspace.env);
      assert.equal(denied.status, 2);
      assert.deepEqual(await snapshot(workspace.base), before, 'automation fails closed without current explicit consent');
      assert.doesNotMatch(denied.stdout + denied.stderr, new RegExp(secret));
    }
    const projectBefore = await snapshot(path.join(workspace.root, '.triad-runtime'));
    const receiptBefore = await readFile(path.join(workspace.root, '.triad-plus/readiness.json'));
    const applied = runCli([...args, '--apply', '--expected-state', state], workspace.root, workspace.env);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Entry refreshed/);
    assert.doesNotMatch(applied.stdout + applied.stderr, new RegExp(secret + '|READY:'));
    assert.deepEqual(await snapshot(path.join(workspace.root, '.triad-runtime')), projectBefore);
    assert.deepEqual(await readFile(path.join(workspace.root, '.triad-plus/readiness.json')), receiptBefore);
    assert.equal(await readFile(privateFile, 'utf8'), secret);
    assert.equal(runPreflight(workspace).status, 0, 'actual trusted native wrapper recovers after scoped refresh');
    const currentPreview = runCli(args, workspace.root, workspace.env);
    const currentState = /Expected state: ([a-f0-9]{64})/.exec(currentPreview.stdout)[1];
    const current = await snapshot(workspace.base);
    const unchanged = runCli([...args, '--apply', '--expected-state', currentState], workspace.root, workspace.env);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.deepEqual(await snapshot(workspace.base), current, 'current refresh is idempotent, including backups and manifest');
    const bindingBefore = await readFile(workspace.bindingPath);
    const manifestFile = path.join(workspace.root, '.triad-plus/installation.json');
    const manifestBeforeCorruption = await readFile(manifestFile);
    for (const body of ['{"secret":"' + secret, JSON.stringify({ ...JSON.parse(bindingBefore), workspace: workspace.base })]) {
      await writeFile(workspace.bindingPath, body);
      const manifest = JSON.parse(manifestBeforeCorruption);
      const record = manifest.adapters.find((item) => item.id === adapter);
      record.managed_assets.find((asset) => asset.path === workspace.bindingPath).sha256 = digest(Buffer.from(body));
      await writeInstallationManifest(workspace.root, buildMultiAdapterManifest({ triadVersion: manifest.triad_version,
        installedAt: manifest.installed_at, updatedAt: manifest.updated_at, adapters: manifest.adapters }));
      const corrupt = await snapshot(workspace.base);
      const rejected = runCli(args, workspace.root, workspace.env);
      assert.equal(rejected.status, 2);
      assert.doesNotMatch(rejected.stdout + rejected.stderr, new RegExp(secret));
      assert.deepEqual(await snapshot(workspace.base), corrupt, 'malformed/foreign bindings cannot be refreshed even with recorded fixture hashes');
    }
    await writeFile(workspace.bindingPath, bindingBefore);
    await writeFile(manifestFile, manifestBeforeCorruption);
    const originalWrapper = await readFile(workspace.preflightPath);
    await writeFile(workspace.preflightPath, secret);
    const tampered = await snapshot(workspace.base);
    const blocked = runCli(args, workspace.root, workspace.env);
    assert.equal(blocked.status, 2);
    assert.doesNotMatch(blocked.stdout + blocked.stderr, new RegExp(secret));
    assert.deepEqual(await snapshot(workspace.base), tampered, 'modified global bytes are preserved');
    await writeFile(workspace.preflightPath, originalWrapper);
    await rm(workspace.preflightPath);
    await symlink(privateFile, workspace.preflightPath);
    const linked = await snapshot(workspace.base);
    assert.equal(runCli(args, workspace.root, workspace.env).status, 2);
    assert.deepEqual(await snapshot(workspace.base), linked, 'symlinked entries are preserved and never followed for refresh');
    await rm(workspace.preflightPath);
    await writeFile(workspace.preflightPath, originalWrapper);
    if (adapter === 'hermes') {
      const active = path.join(workspace.hermesHome, 'active_profile');
      await writeFile(active, 'different-profile\n');
      const changedProfile = await snapshot(workspace.base);
      assert.equal(runCli([...args, '--apply', '--expected-state', currentState], workspace.root, workspace.env).status, 2);
      assert.deepEqual(await snapshot(workspace.base), changedProfile, 'profile switch never retargets consent');
      await writeFile(active, 'owner-profile\n');
    }
    const projectEntry = path.join(workspace.root, '.triad-runtime/triad-host-entry.mjs');
    const projectBytes = await readFile(projectEntry);
    await writeFile(projectEntry, secret);
    assert.equal(runCli(args, workspace.root, workspace.env).status, 2, 'refresh cannot bless changed project code');
    await writeFile(projectEntry, projectBytes);
    await staleOwnedEntry(workspace);
    await writeFile(path.join(path.dirname(workspace.bindingPath), 'another-workspace.json'), '{}');
    const shared = await snapshot(workspace.base);
    assert.equal(runCli(args, workspace.root, workspace.env).status, 2);
    assert.deepEqual(await snapshot(workspace.base), shared, 'shared global files require coordinated owner review');
    await rm(path.join(path.dirname(workspace.bindingPath), 'another-workspace.json'));
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const retryPreview = runCli(args, workspace.root, workspace.env);
      const retryState = /Expected state: ([a-f0-9]{64})/.exec(retryPreview.stdout)[1];
      const globalsBefore = await snapshot(workspace.adapter === 'codex' ? workspace.codexHome : workspace.hermesHome);
      const manifestBefore = await readFile(path.join(workspace.root, '.triad-plus/installation.json'));
      // A later target cannot be replaced: earlier global replacements must roll back.
      await chmod(path.dirname(workspace.preflightPath), 0o500);
      try {
        assert.equal(runCli([...args, '--apply', '--expected-state', retryState], workspace.root, workspace.env).status, 2);
      } finally { await chmod(path.dirname(workspace.preflightPath), 0o700); }
      assert.deepEqual(await snapshot(workspace.adapter === 'codex' ? workspace.codexHome : workspace.hermesHome), globalsBefore);
      assert.deepEqual(await readFile(path.join(workspace.root, '.triad-plus/installation.json')), manifestBefore);
    }
    // A supported legacy project upgrade leaves global bytes/binding untouched;
    // the separately approved refresh must then recover the real trusted entry.
    const loaded = await loadInstallationManifest(workspace.root);
    const record = loaded.manifest.adapters.find((item) => item.id === adapter);
    const oldProjectPath = path.join(workspace.root, '.triad-runtime/triad-host-entry.mjs');
    await writeFile(oldProjectPath, '// Earlier project runtime\n' + await readFile(oldProjectPath, 'utf8'));
    record.managed_assets.find((asset) => asset.path === '.triad-runtime/triad-host-entry.mjs').sha256 = digest(await readFile(oldProjectPath));
    await writeInstallationManifest(workspace.root, buildInstallationManifest({ adapter, triadVersion: '1.22.2',
      installedAt: record.installed_at, updatedAt: record.updated_at, scopes: record.scopes,
      scopeStatus: record.scope_status, managedAssets: record.managed_assets, status: 'installed' }));
    assert.equal(runCli(args, workspace.root, workspace.env).status, 2, 'old project version must be upgraded separately');
    const upgraded = runCli(['upgrade', '--host', adapter, '--control', workspace.root, '--apply'], workspace.root, workspace.env);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(runPreflight(workspace).status, 2, 'project upgrade does not silently rebind global entry');
    const migrationPreview = runCli(args, workspace.root, workspace.env);
    assert.equal(migrationPreview.status, 0, migrationPreview.stderr);
    const migrationState = /Expected state: ([a-f0-9]{64})/.exec(migrationPreview.stdout)[1];
    const migrated = runCli([...args, '--apply', '--expected-state', migrationState], workspace.root, workspace.env);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(runPreflight(workspace).status, 0, 'legacy project upgrade plus separately consented refresh recovers native entry');
  }
  const pending = await makeWorkspace('codex', 'pending-readiness', { confirm: false });
  const pendingBefore = await snapshot(pending.base);
  let pendingResult = runPreflight(pending, pending.root, {}, ['--json']);
  assert.equal(pendingResult.status, 2);
  assert.deepEqual(await snapshot(pending.base), pendingBefore, 'native unconsented entry is read-only');
  let pendingReport = JSON.parse(pendingResult.stdout);
  for (let i = 0; i < 6 && !pendingReport.ready; i += 1) {
    const action = pendingReport.actions[0];
    const selection = action.kind === 'confirm-gates' ? ['--catalog', '.loop/quality-gates.yaml'] : [];
    pendingReport = JSON.parse(runPreflight(pending, pending.root, {}, ['--json', ...selection]).stdout);
    pendingResult = runPreflight(pending, pending.root, {}, ['--json', ...selection, '--approve', action.id, '--expected-state', pendingReport.state_sha256]);
    pendingReport = JSON.parse(pendingResult.stdout);
  }
  assert.equal(pendingReport.ready, true, 'scoped approvals use the same owner-bound temporary snapshot');
  assert.equal(runPreflight(pending).status, 0);
  const codex = await makeWorkspace('codex', 'codex');
  const validCodex = await validateInEnvironment(codex);
  assert.equal(validCodex.ready, true, validCodex.problems.join('\n'));
  assert.equal(runEntry('codex', codex.root, codex.env).status, 0);
  assert.equal(runPreflight(codex).status, 0, 'trusted preflight runs a bound temporary validator snapshot');
  assert.deepEqual(await listFiles(codex.codexHome), [
    'skills/triad/SKILL.md',
    `triad-plus/bindings/${digest(Buffer.from(codex.root))}.json`,
    'triad-plus/host-entry-preflight.mjs',
  ].sort(), 'Codex global entry owns only the native skill and managed preflight/binding files');
  const beforeBlockedUpgrade = await snapshot(codex.base);
  const blockedUpgrade = runCli(['upgrade', '--host', 'codex', '--control', codex.root, '--global'], codex.root, codex.env);
  assert.equal(blockedUpgrade.status, 2);
  assert.match(blockedUpgrade.stderr, /Global Codex entry refresh requires exact-path consent/);
  assert.deepEqual(await snapshot(codex.base), beforeBlockedUpgrade, 'direct global upgrade cannot bypass exact-path consent');

  const invalidRoot = path.join(codex.base, 'wrong-cwd');
  await mkdir(invalidRoot);
  const wrongCwdBefore = await snapshot(codex.base);
  const wrongCwd = runEntry('codex', invalidRoot, codex.env);
  assert.equal(wrongCwd.status, 2);
  assert.match(wrongCwd.stderr, /BLOCKED: Triad not started/);
  assert.match(wrongCwd.stderr, /No other workspace was searched/);
  assert.match(wrongCwd.stderr, /setup wizard there, or cancel/);
  assert.deepEqual(await snapshot(codex.base), wrongCwdBefore, 'wrong cwd performs no search or writes');
  const preflightWrongCwd = runPreflight(codex, invalidRoot);
  assert.equal(preflightWrongCwd.status, 2);
  assert.match(preflightWrongCwd.stderr, /owner-bound Control Workspace/);
  const explicitMismatch = runEntry('codex', invalidRoot, codex.env, ['--workspace', codex.root]);
  assert.equal(explicitMismatch.status, 2);
  assert.match(explicitMismatch.stderr, /Reopen\/restart the host from that exact workspace/);

  const corruptManifest = await readFile(path.join(codex.root, '.triad-plus/installation.json'));
  await assertBlockedWithoutWrites(codex, 'malformed manifest', async () => {
    await writeFile(path.join(codex.root, '.triad-plus/installation.json'), '{}\n');
  }, /installation manifest is invalid/);
  await writeFile(path.join(codex.root, '.triad-plus/installation.json'), corruptManifest);

  const codexLocalAsset = path.join(codex.root, '.triad-runtime/adapters/codex/run-role.mjs');
  const codexLocalAssetBytes = await readFile(codexLocalAsset);
  await assertBlockedWithoutWrites(codex, 'managed project asset hash drift', async () => {
    await writeFile(codexLocalAsset, `${codexLocalAssetBytes}\nmodified\n`);
  }, /hash differs from installation manifest/);
  await writeFile(codexLocalAsset, codexLocalAssetBytes);

  const validatorPath = path.join(codex.root, '.triad-runtime/triad-host-entry.mjs');
  const validatorBytes = await readFile(validatorPath);
  const sentinelPath = path.join(codex.base, 'malicious-validator-ran.txt');
  const maliciousValidator = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'executed');\n`;
  const originalManifestBytes = await readFile(path.join(codex.root, '.triad-plus/installation.json'));
  const originalManifest = JSON.parse(originalManifestBytes);
  const codexRecord = originalManifest.adapters.find((record) => record.id === 'codex');
  const validatorAsset = codexRecord.managed_assets.find((asset) => asset.scope === 'project' && asset.path === '.triad-runtime/triad-host-entry.mjs');
  assert.ok(validatorAsset, 'fixture records the validator in the owner-bound project asset list');
  await writeFile(validatorPath, maliciousValidator);
  validatorAsset.sha256 = digest(Buffer.from(maliciousValidator));
  await writeInstallationManifest(codex.root, buildMultiAdapterManifest({
    triadVersion: originalManifest.triad_version,
    installedAt: originalManifest.installed_at,
    updatedAt: new Date().toISOString(),
    adapters: originalManifest.adapters,
  }));
  const blockedMaliciousPreflight = runPreflight(codex, codex.root, { SENTINEL_PATH: sentinelPath });
  assert.equal(blockedMaliciousPreflight.status, 2);
  assert.match(blockedMaliciousPreflight.stderr, /project-managed asset list differs from the owner-bound manifest/);
  assert.equal(await readFile(sentinelPath).then(() => true, () => false), false, 'a self-edited local manifest cannot authorize execution of a malicious runtime sentinel');
  await writeFile(validatorPath, validatorBytes);
  await writeFile(path.join(codex.root, '.triad-plus/installation.json'), originalManifestBytes);

  const prdBytes = await readFile(path.join(codex.root, 'PRD.md'));
  await assertBlockedWithoutWrites(codex, 'empty PRD', async () => {
    await writeFile(path.join(codex.root, 'PRD.md'), ' \n');
  }, /PRD\.md is empty/);
  await writeFile(path.join(codex.root, 'PRD.md'), prdBytes);

  const gatePath = path.join(codex.root, '.loop/quality-gates.yaml');
  const gateBytes = await readFile(gatePath);
  await assertBlockedWithoutWrites(codex, 'empty quality gates', async () => {
    await writeFile(gatePath, 'version: 2\ngates: []\n');
  }, /quality gates contain no gate definitions/);
  await writeFile(gatePath, gateBytes);
  await assertBlockedWithoutWrites(codex, 'unsupported quality-gate executor', async () => {
    await writeFile(gatePath, gateBytes.toString().replace('executor: control-plane', 'executor: shell'));
  }, /quality gate definition is unsupported or malformed: fixture-check/);
  await writeFile(gatePath, gateBytes);

  const projectYamlPath = path.join(codex.root, 'project.yaml');
  const projectYamlBytes = await readFile(projectYamlPath);
  await assertBlockedWithoutWrites(codex, 'missing declared worktree', async () => {
    await writeFile(projectYamlPath, projectYamlBytes.toString().replace('./worktrees/sample-feature', './worktrees/missing'));
  }, /sample worktree: missing/);
  await writeFile(projectYamlPath, projectYamlBytes);

  const alternateRepo = path.join(codex.base, 'independent-repository');
  await makeRepo(alternateRepo);
  const independentProjectYaml = projectYamlBytes.toString().replace('./worktrees/sample-feature', '../independent-repository');
  await assertBlockedWithoutWrites(codex, 'unrelated mapped Git root', async () => {
    await writeFile(projectYamlPath, independentProjectYaml);
  }, /worktree: belongs to a different repository/);
  await writeFile(projectYamlPath, projectYamlBytes);

  const ownerFile = path.join(codex.base, 'owner-file.txt');
  await writeFile(ownerFile, 'owner data\n');
  const savedAsset = path.join(codex.base, 'run-role.saved');
  await rm(codexLocalAsset);
  await symlink(ownerFile, codexLocalAsset);
  const symlinkProject = runEntry('codex', codex.root, codex.env);
  assert.equal(symlinkProject.status, 2);
  assert.match(symlinkProject.stderr, /path contains a symlink/);
  assert.equal(await readFile(ownerFile, 'utf8'), 'owner data\n', 'symlink target is read-only');
  await rm(codexLocalAsset);
  await writeFile(codexLocalAsset, codexLocalAssetBytes);
  await rm(savedAsset, { force: true });

  const globalAsset = codex.globalAssets[0];
  const globalBytes = await readFile(globalAsset.path);
  await assertBlockedWithoutWrites(codex, 'global native skill hash drift', async () => {
    await writeFile(globalAsset.path, `${globalBytes}\nmodified\n`);
  }, /global entry hash differs from installation manifest/);
  await writeFile(globalAsset.path, globalBytes);

  const codexAlias = path.join(codex.base, 'control-alias');
  await symlink(codex.root, codexAlias);
  const aliasResult = await validateInEnvironment(codex, codexAlias);
  assert.equal(aliasResult.ready, false);
  assert.match(aliasResult.problems.join('\n'), /symlink/);

  const codexHomeMismatch = runEntry('codex', codex.root, { ...codex.env, CODEX_HOME: path.join(codex.base, 'other-codex-home') });
  assert.equal(codexHomeMismatch.status, 2);
  assert.match(codexHomeMismatch.stderr, /global entry is not recorded/);

  for (const adapter of ['codex', 'hermes']) {
    const script = path.join(repositoryRoot, `adapters/${adapter}/install.sh`);
    const globalRoot = path.join(fixture, `${adapter}-script-profile`);
    const result = run('bash', [script, '--global'], fixture, {
      HOME: globalRoot,
      CODEX_HOME: path.join(globalRoot, '.codex'),
      HERMES_HOME: path.join(globalRoot, '.hermes'),
    });
    assert.equal(result.status, 2, `${adapter}: ${result.stderr}`);
    assert.match(result.stderr, /consent-gated npx triad-plus wizard/);
    assert.deepEqual(await listFiles(globalRoot), [], `${adapter} legacy --global changes no files`);
  }

  const directInit = runCli(['init', '--host', 'hermes', '--control', path.join(fixture, 'blocked-hermes-init'), '--global'], fixture, {
    HOME: path.join(fixture, 'blocked-home'), HERMES_HOME: path.join(fixture, 'blocked-hermes-profile'),
  });
  assert.equal(directInit.status, 2);
  assert.match(directInit.stderr, /only through the interactive setup wizard/);
  assert.equal(await lstat(path.join(fixture, 'blocked-hermes-init')).then(() => true, () => false), false, 'blocked direct global init creates no workspace');

  const hermes = await makeWorkspace('hermes', 'hermes-active-profile', { activeHermesProfile: 'team-profile' });
  const validHermes = await validateInEnvironment(hermes);
  assert.equal(validHermes.ready, true, validHermes.problems.join('\n'));
  assert.equal(runPreflight(hermes).status, 0, 'Hermes preflight runs only the owner-bound runtime snapshot');
  assert.deepEqual(await listFiles(path.join(hermes.hermesHome, 'profiles/team-profile/skills/triad')),
    (await listFiles(path.join(repositoryRoot, 'adapters/hermes/skills/triad'))).sort(),
    'Hermes owns only the approved wrapper directory in the active profile');

  const marker = path.join(hermes.hermesHome, 'active_profile');
  const markerBytes = await readFile(marker);
  const hermesSnapshot = await snapshot(hermes.base);
  await writeFile(marker, 'another-profile\n');
  const profileChanged = runEntry('hermes', hermes.root, hermes.env);
  assert.equal(profileChanged.status, 2);
  assert.match(profileChanged.stderr, /global entry is not recorded at/);
  await writeFile(marker, markerBytes);
  assert.deepEqual(await snapshot(hermes.base), hermesSnapshot, 'active-profile mismatch does not mutate files');

  const hermesExplicit = await makeWorkspace('hermes', 'hermes-explicit-profile', {
    activeHermesProfile: 'named-profile', explicitHermesHome: true,
  });
  assert.equal((await runDocumentedHermesPreflight(hermesExplicit)).status, 0,
    'the installed skill command works with explicit HERMES_HOME');
  await staleOwnedEntry(hermesExplicit);
  assert.equal((await runDocumentedHermesPreflight(hermesExplicit)).status, 2,
    'the documented named-profile command blocks a stale binding');
  const refreshArgs = ['entry', 'refresh', '--host', 'hermes', '--control', hermesExplicit.root];
  const wrongProfile = path.join(hermes.hermesHome, 'profiles', 'wrong-profile');
  const beforeWrongProfile = await snapshot(hermesExplicit.base);
  assert.equal(runCli(refreshArgs, hermesExplicit.root, { ...hermesExplicit.env, HERMES_HOME: wrongProfile }).status, 2,
    'explicit refresh refuses a different HERMES_HOME profile');
  assert.deepEqual(await snapshot(hermesExplicit.base), beforeWrongProfile);
  const refreshPreview = runCli(refreshArgs, hermesExplicit.root, hermesExplicit.env);
  assert.equal(refreshPreview.status, 0, refreshPreview.stderr);
  const refreshState = /Expected state: ([a-f0-9]{64})/.exec(refreshPreview.stdout)[1];
  assert.equal(runCli([...refreshArgs, '--apply', '--expected-state', refreshState], hermesExplicit.root, hermesExplicit.env).status, 0);
  assert.equal((await runDocumentedHermesPreflight(hermesExplicit)).status, 0,
    'consented refresh restores the exact documented named-profile preflight');
  const foreignWorkspace = path.join(hermesExplicit.base, 'foreign-control');
  await mkdir(foreignWorkspace);
  assert.equal((await runDocumentedHermesPreflight(hermesExplicit, foreignWorkspace)).status, 2,
    'documented wrapper refuses an unrelated Control Workspace');
  assert.equal(runCli(['entry', 'refresh', '--host', 'hermes', '--control', foreignWorkspace], foreignWorkspace, hermesExplicit.env).status, 2,
    'consented refresh refuses an unrelated Control Workspace');

  const unsafeMarker = path.join(hermes.hermesHome, 'active_profile.unsafe-target');
  await writeFile(unsafeMarker, 'team-profile\n');
  await rm(marker);
  await symlink(unsafeMarker, marker);
  const beforeUnsafeProfile = await snapshot(hermes.base);
  const unsafeProfile = runEntry('hermes', hermes.root, hermes.env);
  assert.equal(unsafeProfile.status, 2);
  assert.match(unsafeProfile.stderr, /active profile cannot be determined safely/);
  assert.deepEqual(await snapshot(hermes.base), beforeUnsafeProfile, 'unsafe Hermes marker is never followed or repaired');

  const noProfileWorkspace = await makeWorkspace('hermes', 'hermes-default-profile');
  assert.equal((await validateInEnvironment(noProfileWorkspace)).ready, true);

  const multi = await makeOpenCodePrimaryMultiAdapterWorkspace('opencode-primary-codex-hermes-secondary');
  const multiManifest = (await loadInstallationManifest(multi.root)).manifest;
  assert.deepEqual(multiManifest.adapters.map((entry) => entry.id), ['codex', 'hermes', 'opencode']);
  assert.equal(JSON.parse(await readFile(path.join(multi.root, '.triad-runtime/adapter.json'), 'utf8')).id, 'opencode');
  for (const adapter of ['codex', 'hermes']) {
    const record = multiManifest.adapters.find((entry) => entry.id === adapter);
    assert.ok(record.managed_assets.some((asset) => asset.path === `.triad-runtime/adapters/${adapter}/adapter.json`), `${adapter} owns its own local runtime metadata`);
    assert.ok(record.managed_assets.some((asset) => asset.path === '.triad-runtime/adapter.json'), `${adapter} also validates the shared OpenCode singleton without treating it as its identity`);
    const view = { ...multi, adapter };
    const valid = await validateInEnvironment(view);
    assert.equal(valid.ready, true, `${adapter} secondary guard passes: ${valid.problems.join('; ')}`);
    assert.equal(runEntry(adapter, multi.root, multi.env).status, 0, `${adapter} native entry guard succeeds in the multi-adapter fixture`);
  }
  const withoutHermes = buildMultiAdapterManifest({
    triadVersion: multiManifest.triad_version,
    installedAt: multiManifest.installed_at,
    updatedAt: new Date().toISOString(),
    adapters: multiManifest.adapters.filter((entry) => entry.id !== 'hermes'),
  });
  await writeInstallationManifest(multi.root, withoutHermes);
  const missingMultiAdapter = await validateInEnvironment(multi, multi.root, 'hermes');
  assert.equal(missingMultiAdapter.ready, false);
  assert.match(missingMultiAdapter.problems.join('\n'), /project-local hermes adapter is not installed/);
  await writeInstallationManifest(multi.root, multiManifest);

  const codexSecondary = { ...multi, adapter: 'codex' };
  const codexSecondaryMetadata = path.join(multi.root, '.triad-runtime/adapters/codex/adapter.json');
  const codexSecondaryBytes = await readFile(codexSecondaryMetadata);
  await assertBlockedWithoutWrites(codexSecondary, 'multi-adapter malformed secondary metadata', async () => {
    await writeFile(codexSecondaryMetadata, '{invalid json\n');
  }, /codex local adapter metadata is malformed/);
  await writeFile(codexSecondaryMetadata, codexSecondaryBytes);
  await assertBlockedWithoutWrites(codexSecondary, 'multi-adapter secondary metadata identity mismatch', async () => {
    await writeFile(codexSecondaryMetadata, '{"id":"opencode"}\n');
  }, /codex local adapter metadata belongs to opencode/);
  await writeFile(codexSecondaryMetadata, codexSecondaryBytes);
  await assertBlockedWithoutWrites(codexSecondary, 'multi-adapter secondary metadata hash mismatch', async () => {
    await writeFile(codexSecondaryMetadata, '{"id":"codex","tampered":true}\n');
  }, /managed asset .*hash differs from installation manifest/);
  await writeFile(codexSecondaryMetadata, codexSecondaryBytes);

  const unreadyProduct = runEntry('codex', codex.repo, codex.env);
  assert.equal(unreadyProduct.status, 2);
  assert.match(unreadyProduct.stderr, /product repository, not a Triad\+ Control Workspace/);
  assert.match(unreadyProduct.stderr, /No other workspace was searched/);

  process.stdout.write('Host-entry bridge fixtures passed: Codex/Hermes exact profile paths, manifest/hash/workspace/readiness guards, no-search/no-write blocks, and consent-gated global install paths.\n');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
