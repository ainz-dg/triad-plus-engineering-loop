import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMultiAdapterManifest, validateInstallationManifest } from '../runtime/lib/installation-manifest.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(repositoryRoot, 'bin/triad-plus.js');
const digest = (value) => createHash('sha256').update(value).digest('hex');

function run(args, { home, pathValue = '', timeout = 30_000 } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), PATH: pathValue },
  });
}

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function snapshot(directory) {
  const entries = [];
  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      const target = path.join(current, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) entries.push(`${path.relative(directory, target)} link ${info.mtimeMs}`);
      else if (info.isDirectory()) { entries.push(`${path.relative(directory, target)} dir ${info.mtimeMs}`); await walk(target); }
      else entries.push(`${path.relative(directory, target)} ${info.size} ${info.mtimeMs} ${digest(await readFile(target))}`);
    }
  }
  await walk(directory);
  return entries.join('\n');
}

async function filesUnder(directory) {
  const files = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else files.push(path.relative(directory, target).split(path.sep).join('/'));
    }
  }
  await walk(directory);
  return files.sort();
}

function teamConfiguration() {
  const roles = {};
  for (const id of ['orchestrator', 'developer', 'reviewer', 'evaluator']) {
    roles[id] = { displayName: id, persona: `${id} persona`, model: null, reasoning_effort: null, enabled: id !== 'evaluator' };
  }
  return { schema_version: 1, interaction: { language: 'English', owner_name: 'Test Owner', communication_style: 'concise' }, roles };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'triad-multi-adapter-'));
const home = path.join(root, 'home');
const control = path.join(root, 'control');
await mkdir(home, { recursive: true });
await mkdir(control, { recursive: true });
try {
  // Retained owner data must survive install, migration, and adapter removal.
  const ownerFiles = {
    'artifacts/prd.md': '# PRD\nOwner intent.\n',
    'project.yaml': 'project:\n  id: fixture\n',
    '.loop/run-state.yaml': 'version: 1\nproject_decision: running\n',
    '.loop/evidence/attempt.json': '{"status":"pass"}\n',
    'features/FEATURE-1.md': '# Feature\n',
  };
  for (const [relative, content] of Object.entries(ownerFiles)) await put(path.join(control, relative), content);
  await put(path.join(control, '.triad-plus/team.json'), `${JSON.stringify(teamConfiguration(), null, 2)}\n`);

  // A legacy v1 install remains readable through list/doctor without migration.
  const initialInstall = run(['init', '--host', 'claude-code', '--control', control], { home });
  assert.equal(initialInstall.status, 0, initialInstall.stderr);
  const manifestPath = path.join(control, '.triad-plus/installation.json');
  const v1Source = await readFile(manifestPath);
  const v1 = JSON.parse(v1Source.toString('utf8'));
  assert.equal(v1.schema_version, 1);
  const claudeHashes = new Map(v1.managed_assets.filter((asset) => asset.scope === 'project').map((asset) => [asset.path, asset.sha256]));
  const listedV1 = run(['adapter', 'list', '--control', control], { home });
  assert.equal(listedV1.status, 0, listedV1.stderr);
  assert.match(listedV1.stdout, /claude-code/);
  const doctorV1 = run(['adapter', 'doctor', 'claude-code', '--control', control], { home });
  assert.equal(doctorV1.status, 0, doctorV1.stderr);
  assert.match(doctorV1.stdout, /schema 1/);
  assert.deepEqual(await readFile(manifestPath), v1Source, 'read-only commands do not migrate v1');

  const beforeMigrationOwnerFiles = new Map();
  for (const relative of Object.keys(ownerFiles)) beforeMigrationOwnerFiles.set(relative, digest(await readFile(path.join(control, relative))));
  const dryAdd = run(['adapter', 'add', 'copilot', '--control', control], { home });
  assert.equal(dryAdd.status, 0, dryAdd.stderr);
  assert.match(dryAdd.stdout, /Dry run only/);
  assert.deepEqual(await readFile(manifestPath), v1Source, 'add dry-run does not migrate');

  const add = run(['adapter', 'add', 'copilot', '--control', control, '--apply'], { home });
  assert.equal(add.status, 0, `${add.stderr}\n${add.stdout}`);
  const multi = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateInstallationManifest(multi);
  assert.equal(multi.schema_version, 2);
  assert.deepEqual(multi.adapters.map((entry) => entry.id), ['claude-code', 'copilot']);
  assert.ok(multi.shared_assets.some((asset) => asset.path === '.triad-runtime/triad-control-run.mjs' && asset.owners.includes('claude-code') && asset.owners.includes('copilot')));
  assert.equal(multi.adapters.find((entry) => entry.id === 'claude-code').managed_assets.find((asset) => asset.path === '.triad-runtime/adapter.json').sha256, claudeHashes.get('.triad-runtime/adapter.json'));
  for (const [relative, expected] of claudeHashes) assert.equal(digest(await readFile(path.join(control, relative))), expected, `Claude asset unchanged: ${relative}`);
  for (const [relative, expected] of beforeMigrationOwnerFiles) assert.equal(digest(await readFile(path.join(control, relative))), expected, `owner file unchanged: ${relative}`);
  const copilot = multi.adapters.find((entry) => entry.id === 'copilot');
  assert.ok(copilot.managed_assets.some((asset) => asset.path === '.triad-runtime/adapters/copilot/adapter.json'));
  assert.ok(!copilot.managed_assets.some((asset) => asset.path === '.triad-runtime/adapter.json'), 'adding a host does not replace the existing singleton runtime selector');

  const missingBinaryList = run(['adapter', 'list', '--control', control], { home, pathValue: '' });
  assert.equal(missingBinaryList.status, 0, missingBinaryList.stderr);
  assert.match(missingBinaryList.stdout, /copilot\s+project=installed global=not_configured host=unavailable/);
  const doctorMulti = run(['adapter', 'doctor', '--control', control], { home, pathValue: '' });
  assert.equal(doctorMulti.status, 0, doctorMulti.stderr);
  assert.match(doctorMulti.stdout, /host=unavailable/);
  assert.match(doctorMulti.stdout, /attempt dispatch=unsupported/);
  const beforeDoctor = await readFile(manifestPath);
  const doctorAgain = run(['adapter', 'doctor', '--control', control], { home, pathValue: '' });
  assert.equal(doctorAgain.status, 0, doctorAgain.stderr);
  assert.deepEqual(await readFile(manifestPath), beforeDoctor, 'doctor is read-only');

  const idempotentAdd = run(['adapter', 'add', 'copilot', '--control', control, '--apply'], { home });
  assert.equal(idempotentAdd.status, 0, idempotentAdd.stderr);
  assert.match(idempotentAdd.stdout, /already installed and healthy/);
  const removeDry = run(['adapter', 'remove', 'copilot', '--control', control], { home });
  assert.equal(removeDry.status, 0, removeDry.stderr);
  assert.match(removeDry.stdout, /Dry run only/);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).adapters.length, 2, 'remove dry-run preserves membership');

  const removeCopilot = run(['adapter', 'remove', 'copilot', '--control', control, '--apply'], { home });
  assert.equal(removeCopilot.status, 0, `${removeCopilot.stderr}\n${removeCopilot.stdout}`);
  const afterRemove = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(afterRemove.adapters.map((entry) => entry.id), ['claude-code']);
  assert.equal(digest(await readFile(path.join(control, '.triad-runtime/triad-control-run.mjs'))), claudeHashes.get('.triad-runtime/triad-control-run.mjs'));
  for (const [relative, expected] of beforeMigrationOwnerFiles) assert.equal(digest(await readFile(path.join(control, relative))), expected);

  // A modified managed file blocks removal instead of being deleted or falsely
  // reported as uninstalled.
  const modifiedControl = path.join(root, 'modified/control');
  await mkdir(modifiedControl, { recursive: true });
  assert.equal(run(['init', '--host', 'claude-code', '--control', modifiedControl], { home }).status, 0);
  assert.equal(run(['adapter', 'add', 'copilot', '--control', modifiedControl, '--apply'], { home }).status, 0);
  const modifiedManifestPath = path.join(modifiedControl, '.triad-plus/installation.json');
  const modifiedManifest = JSON.parse(await readFile(modifiedManifestPath, 'utf8'));
  const modifiedEntry = modifiedManifest.adapters.find((entry) => entry.id === 'copilot');
  const sharedPaths = new Set(modifiedManifest.shared_assets.map((asset) => `${asset.scope}:${asset.path}`));
  const changedAsset = modifiedEntry.managed_assets.find((asset) => asset.scope === 'project' && !sharedPaths.has(`${asset.scope}:${asset.path}`));
  assert.ok(changedAsset);
  const changedPath = path.join(modifiedControl, changedAsset.path);
  await writeFile(changedPath, 'user-edited host file\n');
  const removeModified = run(['adapter', 'remove', 'copilot', '--control', modifiedControl, '--apply'], { home });
  assert.notEqual(removeModified.status, 0);
  assert.match(removeModified.stderr, /modified; preserved/);
  assert.equal(await readFile(changedPath, 'utf8'), 'user-edited host file\n');
  assert.equal(JSON.parse(await readFile(modifiedManifestPath, 'utf8')).adapters.length, 2, 'failed removal retains truthful membership');
  const modifiedDoctor = run(['adapter', 'doctor', 'copilot', '--control', modifiedControl], { home });
  assert.match(modifiedDoctor.stdout, /modified/);

  const upgradeControl = path.join(root, 'upgrade/control');
  await mkdir(upgradeControl, { recursive: true });
  assert.equal(run(['init', '--host', 'claude-code', '--control', upgradeControl], { home }).status, 0);
  assert.equal(run(['adapter', 'add', 'copilot', '--control', upgradeControl, '--apply'], { home }).status, 0);
  const upgradeManifestPath = path.join(upgradeControl, '.triad-plus/installation.json');
  const upgradeManifest = JSON.parse(await readFile(upgradeManifestPath, 'utf8'));
  const upgradeAsset = upgradeManifest.adapters.find((entry) => entry.id === 'copilot').managed_assets.find((asset) => asset.scope === 'project' && !upgradeManifest.shared_assets.some((shared) => shared.scope === asset.scope && shared.path === asset.path));
  assert.ok(upgradeAsset);
  const upgradeTarget = path.join(upgradeControl, upgradeAsset.path);
  await rm(upgradeTarget);
  const upgradeDry = run(['adapter', 'upgrade', 'copilot', '--control', upgradeControl], { home });
  assert.equal(upgradeDry.status, 0, upgradeDry.stderr);
  assert.match(upgradeDry.stdout, /Dry run only/);
  await assert.rejects(() => readFile(upgradeTarget), { code: 'ENOENT' });
  const upgradeApply = run(['adapter', 'upgrade', 'copilot', '--control', upgradeControl, '--apply'], { home });
  assert.equal(upgradeApply.status, 0, `${upgradeApply.stderr}\n${upgradeApply.stdout}`);
  assert.equal(digest(await readFile(upgradeTarget)), JSON.parse(await readFile(upgradeManifestPath, 'utf8')).adapters.find((entry) => entry.id === 'copilot').managed_assets.find((asset) => asset.path === upgradeAsset.path).sha256);

  // Last-adapter removal clears only hash-matching Triad assets and leaves
  // PRD, project config, cards, run history, snapshots, and evidence intact.
  const lastControl = path.join(root, 'last/control');
  await mkdir(lastControl, { recursive: true });
  for (const [relative, content] of Object.entries(ownerFiles)) await put(path.join(lastControl, relative), content);
  await put(path.join(lastControl, '.triad-plus/team.json'), `${JSON.stringify(teamConfiguration(), null, 2)}\n`);
  assert.equal(run(['adapter', 'add', 'opencode', '--control', lastControl, '--apply'], { home }).status, 0);
  const lastRemove = run(['adapter', 'remove', 'opencode', '--control', lastControl, '--apply'], { home });
  assert.equal(lastRemove.status, 0, `${lastRemove.stderr}\n${lastRemove.stdout}`);
  const emptyManifest = JSON.parse(await readFile(path.join(lastControl, '.triad-plus/installation.json'), 'utf8'));
  assert.equal(emptyManifest.schema_version, 2);
  assert.deepEqual(emptyManifest.adapters, []);
  for (const [relative, content] of Object.entries(ownerFiles)) assert.equal(await readFile(path.join(lastControl, relative), 'utf8'), content);
  assert.equal((await readFile(path.join(lastControl, '.triad-plus/team.json'), 'utf8')).length > 0, true);

  // Invalid ownership and path/hash tampering are rejected by the validator.
  const baseAdapter = {
    id: 'opencode', installed_at: '2026-10-11T00:00:00.000Z', updated_at: '2026-10-11T00:00:00.000Z',
    scopes: { project: true, global: false }, scope_status: { project: 'installed', global: 'not_configured' },
    managed_assets: [{ scope: 'project', path: '.triad-runtime/shared.txt', kind: 'file', sha256: 'a'.repeat(64) }],
  };
  assert.throws(() => buildMultiAdapterManifest({ triadVersion: '1.16.0', adapters: [baseAdapter, { ...baseAdapter, id: 'copilot', managed_assets: [{ ...baseAdapter.managed_assets[0], sha256: 'b'.repeat(64) }] }] }), /conflicting shared asset content/);
  assert.throws(() => buildMultiAdapterManifest({ triadVersion: '1.16.0', adapters: [{ ...baseAdapter, managed_assets: [...baseAdapter.managed_assets, baseAdapter.managed_assets[0]] }] }), /duplicate asset ownership/);
  assert.throws(() => buildMultiAdapterManifest({ triadVersion: '1.16.0', adapters: [{ ...baseAdapter, managed_assets: [{ ...baseAdapter.managed_assets[0], path: '../escape' }] }] }), /traversal/);
  const invalidControl = path.join(root, 'invalid/control');
  await mkdir(path.join(invalidControl, '.triad-plus'), { recursive: true });
  const invalidBytes = '{"schema_version":2,"adapters":[]}\n';
  await writeFile(path.join(invalidControl, '.triad-plus/installation.json'), invalidBytes);
  const invalidList = run(['adapter', 'list', '--control', invalidControl], { home });
  assert.notEqual(invalidList.status, 0);
  assert.equal(await readFile(path.join(invalidControl, '.triad-plus/installation.json'), 'utf8'), invalidBytes);

  // An unowned common-file conflict is detected before any asset is copied.
  const conflictControl = path.join(root, 'conflict/control');
  await mkdir(path.join(conflictControl, '.triad-runtime'), { recursive: true });
  await writeFile(path.join(conflictControl, '.triad-runtime/triad-control-run.mjs'), 'not the package asset\n');
  const conflictBefore = await snapshot(conflictControl);
  const conflictAdd = run(['adapter', 'add', 'opencode', '--control', conflictControl, '--apply'], { home });
  assert.notEqual(conflictAdd.status, 0);
  assert.match(conflictAdd.stderr, /collision; existing bytes differ/);
  assert.equal(await snapshot(conflictControl), conflictBefore, 'collision preflight has no partial writes');

  // A copy failure after the first asset group is placed rolls back only the
  // files created by that add attempt.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const failedCopyControl = path.join(root, 'failed-copy/control');
    await mkdir(path.join(failedCopyControl, '.github/skills/triad'), { recursive: true });
    const blockedSkillDirectory = path.join(failedCopyControl, '.github/skills/triad');
    await chmod(blockedSkillDirectory, 0o555);
    let failedCopyAdd;
    try { failedCopyAdd = run(['adapter', 'add', 'copilot', '--control', failedCopyControl, '--apply'], { home }); }
    finally { await chmod(blockedSkillDirectory, 0o755); }
    assert.notEqual(failedCopyAdd.status, 0);
    assert.match(failedCopyAdd.stderr, /EACCES|permission denied/i);
    assert.match(failedCopyAdd.stderr, /rolled back; previous workspace state was preserved/);
    assert.deepEqual(await filesUnder(path.join(failedCopyControl, '.github')), [], 'earlier copied adapter files were rolled back');
    assert.equal(await readFile(path.join(failedCopyControl, '.triad-plus/installation.json')).then(() => true, () => false), false);
  }

  // A post-copy manifest-write failure rolls back only the new adapter files
  // and preserves the v1 manifest and original adapter bytes.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const failedWriteControl = path.join(root, 'failed-write/control');
    await mkdir(failedWriteControl, { recursive: true });
    assert.equal(run(['init', '--host', 'claude-code', '--control', failedWriteControl], { home }).status, 0);
    const failedWriteManifestPath = path.join(failedWriteControl, '.triad-plus/installation.json');
    const failedWriteManifestBefore = await readFile(failedWriteManifestPath);
    const failedWriteV1 = JSON.parse(failedWriteManifestBefore.toString('utf8'));
    const failedWriteOriginalAssets = failedWriteV1.managed_assets.filter((asset) => asset.scope === 'project');
    const manifestDirectory = path.dirname(failedWriteManifestPath);
    const manifestDirectoryMode = (await lstat(manifestDirectory)).mode & 0o777;
    await chmod(manifestDirectory, 0o555);
    let failedWriteAdd;
    try { failedWriteAdd = run(['adapter', 'add', 'copilot', '--control', failedWriteControl, '--apply'], { home }); }
    finally { await chmod(manifestDirectory, manifestDirectoryMode); }
    assert.notEqual(failedWriteAdd.status, 0);
    assert.match(failedWriteAdd.stderr, /EACCES|permission denied/i);
    assert.match(failedWriteAdd.stderr, /rolled back; previous workspace state was preserved/);
    assert.deepEqual(await readFile(failedWriteManifestPath), failedWriteManifestBefore);
    for (const asset of failedWriteOriginalAssets) assert.equal(digest(await readFile(path.join(failedWriteControl, asset.path))), asset.sha256);
    assert.deepEqual(await filesUnder(path.join(failedWriteControl, '.github')), [], 'new Copilot files rolled back after manifest write failure');
    assert.equal(await readFile(path.join(failedWriteControl, '.triad-runtime/adapters/copilot/adapter.json')).then(() => true, () => false), false);
  }

  // A symlinked Control Workspace root cannot redirect project writes.
  const symlinkTarget = path.join(root, 'symlink-target/control');
  const symlinkAlias = path.join(root, 'symlink-alias');
  await mkdir(symlinkTarget, { recursive: true });
  await symlink(symlinkTarget, symlinkAlias, 'dir');
  const symlinkBefore = await snapshot(symlinkTarget);
  const symlinkAdd = run(['adapter', 'add', 'opencode', '--control', symlinkAlias, '--apply'], { home });
  assert.notEqual(symlinkAdd.status, 0);
  assert.match(symlinkAdd.stderr, /Control Workspace path is unsafe/);
  assert.equal(await snapshot(symlinkTarget), symlinkBefore, 'symlinked control root receives no writes');

  // Upgrade backup paths are also checked: a symlink under .triad-plus must
  // not redirect backups outside the Control Workspace.
  const backupControl = path.join(root, 'backup/control');
  const outsideBackup = path.join(root, 'backup/outside');
  await mkdir(backupControl, { recursive: true });
  await mkdir(outsideBackup, { recursive: true });
  assert.equal(run(['adapter', 'add', 'claude-code', '--control', backupControl, '--apply'], { home }).status, 0);
  assert.equal(run(['adapter', 'add', 'copilot', '--control', backupControl, '--apply'], { home }).status, 0);
  const backupManifestPath = path.join(backupControl, '.triad-plus/installation.json');
  const backupManifest = JSON.parse(await readFile(backupManifestPath, 'utf8'));
  const copilotRecord = backupManifest.adapters.find((entry) => entry.id === 'copilot');
  const backupAsset = copilotRecord.managed_assets.find((asset) => asset.scope === 'project' && asset.path.startsWith('.triad-runtime/adapters/copilot/'));
  assert.ok(backupAsset);
  const backupTarget = path.join(backupControl, backupAsset.path);
  const oldBytes = 'previous managed adapter bytes\n';
  await writeFile(backupTarget, oldBytes);
  copilotRecord.managed_assets = copilotRecord.managed_assets.map((asset) => asset.path === backupAsset.path ? { ...asset, sha256: digest(oldBytes) } : asset);
  const resealedBackupManifest = buildMultiAdapterManifest({
    triadVersion: backupManifest.triad_version,
    installedAt: backupManifest.installed_at,
    updatedAt: backupManifest.updated_at,
    adapters: backupManifest.adapters,
  });
  await writeFile(backupManifestPath, `${JSON.stringify(resealedBackupManifest, null, 2)}\n`);
  await symlink(outsideBackup, path.join(backupControl, '.triad-plus/backups'), 'dir');
  const outsideBefore = await snapshot(outsideBackup);
  const backupUpgrade = run(['adapter', 'upgrade', 'copilot', '--control', backupControl, '--apply'], { home });
  assert.notEqual(backupUpgrade.status, 0);
  assert.match(backupUpgrade.stderr, /Managed project asset parent is unsafe/);
  assert.equal(await snapshot(outsideBackup), outsideBefore, 'backup symlink cannot write outside control root');
  assert.equal(await readFile(backupTarget, 'utf8'), oldBytes, 'failed upgrade preserves previous managed bytes');

  // A second installation reports membership and shared ownership truthfully
  // while dispatch remains absent rather than falling back to last-added host.
  const boundControl = path.join(root, 'dispatch/control');
  await mkdir(boundControl, { recursive: true });
  assert.equal(run(['adapter', 'add', 'claude-code', '--control', boundControl, '--apply'], { home }).status, 0);
  assert.equal(run(['adapter', 'add', 'copilot', '--control', boundControl, '--apply'], { home }).status, 0);
  const dispatchManifest = JSON.parse(await readFile(path.join(boundControl, '.triad-plus/installation.json'), 'utf8'));
  assert.deepEqual(dispatchManifest.adapters.map((entry) => entry.id), ['claude-code', 'copilot']);
  assert.match(run(['version', '--control', boundControl], { home }).stdout, /Attempt-bound host dispatch: unsupported/);

  process.stdout.write('Multi-adapter manifest migration, ownership, and conservative lifecycle tests passed.\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
