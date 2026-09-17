import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installationManifestFingerprint, validateInstallationManifest } from '../runtime/lib/installation-manifest.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = await mkdtemp(join(tmpdir(), 'triad-plus-installation-manifest-'));
const packageVersion = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).version;

function run(args, env = {}) {
  return spawnSync(process.execPath, ['bin/triad-plus.js', ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function assertOk(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function envFor(host, homeRoot) {
  if (host === 'codex') return { CODEX_HOME: join(homeRoot, 'codex-home') };
  if (host === 'hermes') return { HERMES_HOME: join(homeRoot, 'hermes-home') };
  return { HOME: join(homeRoot, `${host}-home`) };
}

async function manifestAt(control) {
  const manifest = JSON.parse(await readFile(join(control, '.triad-plus', 'installation.json'), 'utf8'));
  validateInstallationManifest(manifest);
  return manifest;
}

try {
  assert.equal(run(['--version']).stdout.trim(), packageVersion);

  const hosts = ['codex', 'opencode', 'claude-code', 'antigravity', 'hermes', 'copilot'];
  for (const host of hosts) {
    const control = join(fixtureRoot, `${host}-control`);
    const env = envFor(host, fixtureRoot);
    assertOk(run(['init', '--host', host, '--control', control], env));
    const manifest = await manifestAt(control);
    assert.equal(manifest.adapter, host);
    assert.equal(manifest.triad_version, packageVersion);
    assert.equal(manifest.scopes.project, true);
    assert.equal(manifest.scopes.global, false);
    assert.ok(manifest.managed_assets.length > 0);

    const version = assertOk(run(['version', '--control', control])).stdout;
    assert.match(version, new RegExp(`Installed Triad\\s+${packageVersion}`));
    const doctor = assertOk(run(['doctor', '--host', host, '--control', control, '--hook-config', join(control, 'missing-hooks.json')], { NO_COLOR: '1' })).stdout;
    assert.match(doctor, /Triad\+ installation/);
    assert.match(doctor, new RegExp(`CLI version\\s+${packageVersion}`));
    assert.doesNotMatch(doctor, /\u001b\[/);

    await mkdir(join(control, '.loop'), { recursive: true });
    await writeFile(join(control, '.loop', 'run-state.yaml'), 'project_decision: not_started\n');
    await writeFile(join(control, 'project.yaml'), 'project: test\n');
    await writeFile(join(control, 'keep-user-file.txt'), 'keep me\n');
    const dry = assertOk(run(['uninstall', '--host', host, '--control', control]));
    assert.match(dry.stdout, /No files were changed/);
    assert.ok(manifest.managed_assets.some((asset) => dry.stdout.includes(asset.path)));
    assert.ok(await readFile(join(control, 'keep-user-file.txt'), 'utf8'));

    const applied = assertOk(run(['uninstall', '--host', host, '--control', control, '--apply']));
    assert.match(applied.stdout, /Installation manifest updated/);
    assert.match(applied.stdout, /Uninstall complete/);
    const after = await manifestAt(control);
    assert.equal(after.status, 'uninstalled');
    assert.equal(after.scope_status.project, 'uninstalled');
    assert.equal(await readFile(join(control, 'keep-user-file.txt'), 'utf8'), 'keep me\n');
    assert.equal(await readFile(join(control, '.loop', 'run-state.yaml'), 'utf8'), 'project_decision: not_started\n');
    assert.equal(await readFile(join(control, 'project.yaml'), 'utf8'), 'project: test\n');
    const second = assertOk(run(['uninstall', '--host', host, '--control', control, '--apply']));
    assert.match(second.stdout, /Installation manifest updated/);
  }

  for (const [host, control, directory, parent] of [
    ['opencode', join(fixtureRoot, 'directory-survival-opencode'), join(fixtureRoot, 'directory-survival-opencode', '.opencode', 'agents'), '.opencode'],
    ['antigravity', join(fixtureRoot, 'directory-survival-antigravity'), join(fixtureRoot, 'directory-survival-antigravity', '.agents', 'agents'), '.agents']
  ]) {
    assertOk(run(['init', '--host', host, '--control', control]));
    assert.equal((await stat(directory)).isDirectory(), true);
    assertOk(run(['uninstall', '--host', host, '--control', control, '--apply']));
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.equal((await stat(join(control, parent))).isDirectory(), true);
  }

  const configuredControl = join(fixtureRoot, 'configured-opencode-control');
  const configuredTeam = join(fixtureRoot, 'configured-team.json');
  const team = {
    schema_version: 1,
    interaction: { language: 'English', owner_name: 'Owner', communication_style: 'concise' },
    roles: {
      orchestrator: { displayName: 'Orchestrator', persona: 'precise' },
      developer: { displayName: 'Developer', persona: 'precise' },
      reviewer: { displayName: 'Reviewer', persona: 'precise' },
      evaluator: { displayName: 'Evaluator', persona: 'precise', enabled: false }
    }
  };
  await writeFile(configuredTeam, `${JSON.stringify(team, null, 2)}\n`);
  const preexistingAgents = '# User instructions\nKeep this content.\n';
  await mkdir(configuredControl, { recursive: true });
  await writeFile(join(configuredControl, 'AGENTS.md'), preexistingAgents);
  assertOk(run(['init', '--host', 'opencode', '--control', configuredControl, '--team-config', configuredTeam]));
  const teamPath = join(configuredControl, '.triad-plus', 'team.json');
  const teamBeforeUninstall = await readFile(teamPath, 'utf8');
  const configuredManifest = await manifestAt(configuredControl);
  const overlayAsset = configuredManifest.managed_assets.find((asset) => asset.kind === 'managed_block' && asset.path === 'AGENTS.md');
  assert.ok(overlayAsset, 'expected managed AGENTS.md block record');
  const configuredDryRun = assertOk(run(['uninstall', '--host', 'opencode', '--control', configuredControl]));
  assert.match(configuredDryRun.stdout, /WOULD REMOVE block AGENTS\.md/);
  const customAgent = join(configuredControl, '.opencode', 'agents', 'custom-user-agent.md');
  await writeFile(customAgent, 'user-owned agent\n');
  assert.ok(!configuredManifest.managed_assets.some((asset) => asset.path.endsWith('custom-user-agent.md')));
  const configuredUninstall = assertOk(run(['uninstall', '--host', 'opencode', '--control', configuredControl, '--apply']));
  assert.match(configuredUninstall.stdout, /Preserved state/);
  assert.equal(await readFile(teamPath, 'utf8'), teamBeforeUninstall);
  assert.equal(await readFile(customAgent, 'utf8'), 'user-owned agent\n');
  const agentsAfterUninstall = await readFile(join(configuredControl, 'AGENTS.md'), 'utf8');
  assert.match(agentsAfterUninstall, /# User instructions\nKeep this content\./);
  assert.doesNotMatch(agentsAfterUninstall, /triad-plus:managed-instructions:/);

  const createdOverlayControl = join(fixtureRoot, 'created-overlay-control');
  assertOk(run(['init', '--host', 'opencode', '--control', createdOverlayControl, '--team-config', configuredTeam]));
  assert.match(await readFile(join(createdOverlayControl, 'AGENTS.md'), 'utf8'), /triad-plus:managed-instructions:start/);
  assertOk(run(['uninstall', '--host', 'opencode', '--control', createdOverlayControl, '--apply']));
  assert.doesNotMatch(await readFile(join(createdOverlayControl, 'AGENTS.md'), 'utf8'), /triad-plus:managed-instructions:/);

  const modifiedOverlayControl = join(fixtureRoot, 'modified-overlay-control');
  assertOk(run(['init', '--host', 'opencode', '--control', modifiedOverlayControl, '--team-config', configuredTeam]));
  const modifiedAgents = join(modifiedOverlayControl, 'AGENTS.md');
  await writeFile(modifiedAgents, `${(await readFile(modifiedAgents, 'utf8')).replace('Triad+ role-run overlay', 'User-modified overlay')}`);
  const modifiedOverlayUninstall = assertOk(run(['uninstall', '--host', 'opencode', '--control', modifiedOverlayControl, '--apply']));
  assert.match(modifiedOverlayUninstall.stdout, /PRESERVE\s+AGENTS\.md/);
  assert.match(await readFile(modifiedAgents, 'utf8'), /User-modified overlay/);
  assert.equal((await manifestAt(modifiedOverlayControl)).status, 'partial');

  const legacyControl = join(fixtureRoot, 'legacy-upgrade-control');
  assertOk(run(['init', '--host', 'opencode', '--control', legacyControl]));
  await rm(join(legacyControl, '.triad-plus', 'installation.json'));
  const legacyDry = assertOk(run(['upgrade', '--host', 'opencode', '--control', legacyControl]));
  assert.match(legacyDry.stdout, /manifest would be created/);
  assert.equal(await readFile(join(legacyControl, '.opencode', 'agents', 'triad-orchestrator.md'), 'utf8').then((text) => text.length > 0), true);
  const legacyApply = assertOk(run(['upgrade', '--host', 'opencode', '--control', legacyControl, '--apply']));
  assert.match(legacyApply.stdout, /Installation manifest updated/);
  const migrated = await manifestAt(legacyControl);
  assert.equal(migrated.triad_version, packageVersion);

  const modifiedControl = join(fixtureRoot, 'modified-control');
  assertOk(run(['init', '--host', 'opencode', '--control', modifiedControl]));
  const modifiedAsset = join(modifiedControl, '.opencode', 'agents', 'triad-reviewer.md');
  await writeFile(modifiedAsset, `${await readFile(modifiedAsset, 'utf8')}\nuser edit\n`);
  const modifiedUninstall = assertOk(run(['uninstall', '--host', 'opencode', '--control', modifiedControl, '--apply']));
  assert.match(modifiedUninstall.stdout, /PRESERVE\s+\.opencode\/agents\/triad-reviewer\.md/);
  assert.equal(await readFile(modifiedAsset, 'utf8').then((text) => text.includes('user edit')), true);
  const modifiedManifest = await manifestAt(modifiedControl);
  assert.equal(modifiedManifest.scope_status.project, 'partial');
  assert.equal(modifiedManifest.status, 'partial');

  const absentControl = join(fixtureRoot, 'absent-control');
  assertOk(run(['init', '--host', 'antigravity', '--control', absentControl]));
  const absentAsset = join(absentControl, '.agents', 'agents', 'triad-developer', 'agent.md');
  await rm(absentAsset);
  const absentUninstall = assertOk(run(['uninstall', '--host', 'antigravity', '--control', absentControl, '--apply']));
  assert.match(absentUninstall.stdout, /ABSENT/);
  assert.equal((await manifestAt(absentControl)).status, 'uninstalled');

  const globalHome = join(fixtureRoot, 'global-home');
  const globalControl = join(fixtureRoot, 'global-control');
  const globalEnv = { HOME: globalHome };
  assertOk(run(['init', '--host', 'opencode', '--control', globalControl, '--global'], globalEnv));
  const globalManifest = await manifestAt(globalControl);
  const globalEntry = globalManifest.managed_assets.find((asset) => asset.scope === 'global' && asset.path.endsWith('/triad-orchestrator.md'));
  assert.ok(globalEntry, 'expected a global OpenCode role asset');
  assert.equal(globalManifest.scope_status.global, 'installed');
  const projectOnly = assertOk(run(['uninstall', '--host', 'opencode', '--control', globalControl, '--apply'], globalEnv));
  assert.match(projectOnly.stdout, /Project managed assets/);
  assert.equal((await manifestAt(globalControl)).scope_status.project, 'uninstalled');
  assert.equal((await manifestAt(globalControl)).scope_status.global, 'installed');
  assert.equal(await readFile(globalEntry.path, 'utf8').then((text) => text.length > 0), true);

  const sharedGlobalHome = join(fixtureRoot, 'shared-global-home');
  const sharedGlobalEnv = { HOME: sharedGlobalHome };
  const sharedControlA = join(fixtureRoot, 'shared-control-a');
  const sharedControlB = join(fixtureRoot, 'shared-control-b');
  assertOk(run(['init', '--host', 'opencode', '--control', sharedControlA, '--global'], sharedGlobalEnv));
  assertOk(run(['init', '--host', 'opencode', '--control', sharedControlB, '--global'], sharedGlobalEnv));
  const sharedManifestB = await manifestAt(sharedControlB);
  const sharedAssetB = sharedManifestB.managed_assets.find((asset) => asset.scope === 'global' && asset.path.endsWith('/triad-orchestrator.md'));
  assert.ok(sharedAssetB);
  const sharedUninstallA = assertOk(run(['uninstall', '--host', 'opencode', '--control', sharedControlA, '--global', '--apply'], sharedGlobalEnv));
  assert.match(sharedUninstallA.stdout, /global ownership may be shared/);
  assert.equal(await readFile(sharedAssetB.path, 'utf8').then((text) => text.length > 0), true);
  const sharedDoctorB = assertOk(run(['doctor', '--host', 'opencode', '--control', sharedControlB], { ...sharedGlobalEnv, NO_COLOR: '1' })).stdout;
  assert.match(sharedDoctorB, /Installed version\s+1\.10\.0/);

  const globalModifiedControl = join(fixtureRoot, 'global-modified-control');
  assertOk(run(['init', '--host', 'copilot', '--control', globalModifiedControl, '--global'], globalEnv));
  const globalModifiedManifest = await manifestAt(globalModifiedControl);
  const modifiedGlobal = globalModifiedManifest.managed_assets.find((asset) => asset.scope === 'global' && asset.path.endsWith('triad-reviewer.agent.md'));
  assert.ok(modifiedGlobal);
  await writeFile(modifiedGlobal.path, `${await readFile(modifiedGlobal.path, 'utf8')}\nuser edit\n`);
  const globalUninstall = assertOk(run(['uninstall', '--host', 'copilot', '--control', globalModifiedControl, '--global', '--apply'], globalEnv));
  assert.match(globalUninstall.stdout, /PRESERVE/);
  assert.equal(await readFile(modifiedGlobal.path, 'utf8').then((text) => text.includes('user edit')), true);

  const skewControl = join(fixtureRoot, 'skew-control');
  assertOk(run(['init', '--host', 'opencode', '--control', skewControl]));
  const skewManifestPath = join(skewControl, '.triad-plus', 'installation.json');
  const skewManifest = JSON.parse(await readFile(skewManifestPath, 'utf8'));
  skewManifest.triad_version = '99.0.0';
  skewManifest.fingerprint = installationManifestFingerprint(skewManifest);
  await writeFile(skewManifestPath, `${JSON.stringify(skewManifest, null, 2)}\n`);
  const skewDoctor = assertOk(run(['doctor', '--host', 'opencode', '--control', skewControl], { NO_COLOR: '1' })).stdout;
  assert.match(skewDoctor, /CLI older than installed version/);

  const malformedControl = join(fixtureRoot, 'malformed-control');
  await mkdir(join(malformedControl, '.triad-plus'), { recursive: true });
  await writeFile(join(malformedControl, '.triad-plus', 'installation.json'), '{ malformed');
  const malformedDoctor = assertOk(run(['doctor', '--host', 'opencode', '--control', malformedControl], { NO_COLOR: '1' })).stdout;
  assert.match(malformedDoctor, /Manifest\s+invalid/);
  const legacyVersionControl = join(fixtureRoot, 'no-manifest-control');
  await mkdir(legacyVersionControl, { recursive: true });
  const legacyVersion = assertOk(run(['version', '--control', legacyVersionControl])).stdout;
  assert.match(legacyVersion, /unknown \(legacy installation\)/);

  const missingVersionControl = join(fixtureRoot, 'missing-version-control');
  const missingVersion = run(['version', '--control', missingVersionControl]);
  assert.notEqual(missingVersion.status, 0);
  assert.match(missingVersion.stderr, /workspace does not exist/);
  assert.equal(await (async () => { try { await stat(missingVersionControl); return true; } catch { return false; } })(), false);
  const missingUninstallControl = join(fixtureRoot, 'missing-uninstall-control');
  const missingUninstall = run(['uninstall', '--host', 'opencode', '--control', missingUninstallControl]);
  assert.notEqual(missingUninstall.status, 0);
  assert.match(missingUninstall.stderr, /workspace does not exist/);
  assert.equal(await (async () => { try { await stat(missingUninstallControl); return true; } catch { return false; } })(), false);

  process.stdout.write('Triad+ installation manifest, version, and safe uninstall tests passed.\n');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
