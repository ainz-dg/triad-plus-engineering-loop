import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertNoSymlinkPath,
  confirmAndApplySetup,
  formatSetupPreview,
  initializeGreenfieldRepositories,
  inspectControlRoot,
  mergeProjectYaml,
  parseAdapterSelection,
  parsePositiveCount,
  projectLaunchHint,
  readProjectYamlPlan,
  setupReadiness,
  validateRepositoryPlan,
  writeProjectYamlPlan,
} from '../runtime/lib/interactive-project-setup.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'triad-project-setup-'));

function command(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function gitRepo(directory, content = 'untouched\n') {
  await mkdir(directory, { recursive: true });
  const init = spawnSync('git', ['init', '--initial-branch=main', directory], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(init.status, 0, init.stderr);
  command(directory, ['config', 'user.email', 'fixture@example.invalid']);
  command(directory, ['config', 'user.name', 'Fixture']);
  await writeFile(path.join(directory, 'README.md'), content);
  command(directory, ['add', 'README.md']);
  command(directory, ['commit', '-m', 'fixture baseline']);
}

function prompt(answers) {
  const questions = [];
  return {
    questions,
    async question(message) { questions.push(message); return answers.shift() ?? ''; },
  };
}

try {
  // A01: a safe current directory is itself the proposed root; no sibling convention exists.
  const container = path.join(root, 'RITES');
  await mkdir(container);
  const classified = await inspectControlRoot(container);
  assert.equal(classified.path, container);
  assert.equal(classified.gitBoundary, null);
  assert.equal(await readdir(root).then((entries) => entries.includes('RITES-control')), false);

  // A02/A03: map two independently committed Git roots and preserve their bytes.
  const one = path.join(container, 'rites');
  const two = path.join(container, 'other-repo');
  await gitRepo(one, 'product one\n');
  await gitRepo(two, 'product two\n');
  const oneBefore = await readFile(path.join(one, 'README.md'), 'utf8');
  const twoBefore = await readFile(path.join(two, 'README.md'), 'utf8');
  const entries = await validateRepositoryPlan(container, [
    { id: 'rites', path: './rites', base_branch: 'main', project_branch: 'triad/rites-feature', worktree: 'worktrees/rites-feature' },
    { id: 'other', path: './other-repo', base_branch: 'main', project_branch: 'triad/other-feature', worktree: 'worktrees/other-feature' },
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(await Promise.all([
    readFile(path.join(one, 'README.md'), 'utf8'),
    readFile(path.join(two, 'README.md'), 'utf8'),
  ]), [oneBefore, twoBefore]);
  assert.equal(command(one, ['remote']), '');
  assert.equal(command(two, ['remote']), '');
  const external = path.join(root, 'external-product');
  await gitRepo(external, 'external product\n');
  const externalMapping = await validateRepositoryPlan(container, [{
    id: 'external', path: external, base_branch: 'main', project_branch: 'triad/external-feature',
    worktree: path.join(root, 'external-worktrees', 'external-feature'),
  }]);
  assert.equal(externalMapping[0].path, external, 'safe explicit external roots remain supported');

  const foreignWorktree = path.join(container, 'worktrees', 'other-feature');
  await mkdir(path.dirname(foreignWorktree), { recursive: true });
  const addForeignWorktree = spawnSync('git', ['-C', two, 'worktree', 'add', '--detach', foreignWorktree, 'HEAD'], { encoding: 'utf8' });
  assert.equal(addForeignWorktree.status, 0, addForeignWorktree.stderr);
  await assert.rejects(() => validateRepositoryPlan(container, [{
    id: 'rites', path: './rites', base_branch: 'main', project_branch: 'triad/rites-feature',
    worktree: foreignWorktree,
  }]), /Mapped worktree belongs to a different Git repository/);

  // Existing JSON/YAML mappings are merged without changing unrelated owner data.
  const yaml = [
    'version: 2',
    'project:',
    '  id: rites',
    '  title: RITES',
    '  owner: Ainz',
    'repositories:',
    '  # owner comment must remain',
    '  - id: rites',
    '    path: ./rites',
    '    base_branch: main',
    '    project_branch: triad/rites-feature',
    '    worktree: worktrees/rites-feature',
    '    instructions: owner-notes.md',
    'owner_note: keep this byte-for-byte',
    '',
  ].join('\n');
  const merged = mergeProjectYaml(yaml, entries, { projectId: 'rites', title: 'RITES' });
  assert.match(merged, /id: "other"/);
  assert.match(merged, /owner_note: keep this byte-for-byte/);
  assert.match(merged, /# owner comment must remain/);
  assert.match(merged, /instructions: owner-notes\.md/);
  const jsonSource = JSON.stringify({ project: { id: 'old', owner: 'Ainz' }, repositories: [] }, null, 2);
  const jsonMerged = JSON.parse(mergeProjectYaml(jsonSource, [entries[0]]));
  assert.equal(jsonMerged.project.owner, 'Ainz');
  assert.equal(jsonMerged.repositories[0].id, 'rites');
  assert.equal(mergeProjectYaml(jsonSource, [], { projectId: 'old' }), jsonSource);

  // A project config plan is read-only until the caller applies it after confirmation.
  const configPlan = await readProjectYamlPlan(container, entries, { projectId: 'rites', title: 'RITES' });
  assert.equal(configPlan.changed, true);
  assert.equal(await readFile(configPlan.path).then(() => true, () => false), false);
  const cancelled = prompt(['install ']);
  let applies = 0;
  const output = [];
  const didApply = await confirmAndApplySetup({
    prompt: cancelled,
    preview: 'exact fixture preview\n',
    apply: async () => { applies += 1; },
    write: (value) => output.push(value),
  });
  assert.equal(didApply, false, 'confirmation is exact; whitespace cancels');
  assert.equal(applies, 0);
  assert.match(output.join(''), /No files were changed/);
  await writeProjectYamlPlan(configPlan);
  assert.match(await readFile(configPlan.path, 'utf8'), /owner: "Owner"|owner: Ainz/);
  assert.match(await readFile(configPlan.path, 'utf8'), /id: "other"/);
  const idempotentPlan = await readProjectYamlPlan(container, entries, { projectId: 'rites', title: 'RITES' });
  assert.equal(idempotentPlan.changed, false, 'reapplying an identical mapping does not rewrite project.yaml');

  // A new project.yaml is published without replacing a file that appears at the publication boundary.
  const publishSuccessRoot = path.join(root, 'publish-success');
  await mkdir(publishSuccessRoot);
  const publishSuccessPlan = await readProjectYamlPlan(publishSuccessRoot, entries, { projectId: 'rites', title: 'RITES' });
  await writeProjectYamlPlan(publishSuccessPlan);
  assert.equal(await readFile(publishSuccessPlan.path, 'utf8'), publishSuccessPlan.after, 'a missing project.yaml is published atomically');

  const publishConflictRoot = path.join(root, 'publish-conflict');
  await mkdir(publishConflictRoot);
  const publishConflictPlan = await readProjectYamlPlan(publishConflictRoot, entries, { projectId: 'rites', title: 'RITES' });
  const ownerBytes = Buffer.from('# created by the owner after preview\nowner_note: preserve these bytes\n');
  await assert.rejects(() => writeProjectYamlPlan(publishConflictPlan, {
    beforePublishIfAbsent: async (target) => writeFile(target, ownerBytes, { flag: 'wx' }),
  }), /project\.yaml appeared after preview; refusing to overwrite/);
  assert.deepEqual(await readFile(publishConflictPlan.path), ownerBytes, 'a publication-boundary conflict preserves owner bytes exactly');

  // A05: readiness is honest when PRD/gates/baseline/worktree are absent.
  const emptyRoot = path.join(root, 'greenfield-control');
  await mkdir(emptyRoot);
  const greenfield = await validateRepositoryPlan(emptyRoot, [
    { id: 'new-app', path: './new-app', base_branch: 'main', project_branch: 'triad/new-app-feature', worktree: 'worktrees/new-app-feature' },
  ], { mode: 'greenfield' });
  const controlRootGit = spawnSync('git', ['-C', emptyRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  assert.notEqual(controlRootGit.status, 0, 'control root is not initialized as a product repository');
  assert.equal(await readFile(path.join(emptyRoot, 'project.yaml')).then(() => true, () => false), false);
  const readinessBefore = await setupReadiness(emptyRoot, greenfield);
  assert.equal(readinessBefore.ready, false);
  assert.match(readinessBefore.missing.join('; '), /PRD\.md/);
  assert.match(readinessBefore.missing.join('; '), /quality-gates/);
  assert.match(readinessBefore.missing.join('; '), /baseline commit/);
  assert.match(readinessBefore.missing.join('; '), /worktree/);

  // A04: actual git init happens only after the exact approval word.
  await confirmAndApplySetup({
    prompt: prompt(['install']),
    preview: 'greenfield; no remote; no push\n',
    apply: async () => { await initializeGreenfieldRepositories(greenfield); applies += 1; },
    write: () => {},
  });
  assert.equal(applies, 1);
  const newRepo = path.join(emptyRoot, 'new-app');
  assert.equal(await realpath(command(newRepo, ['rev-parse', '--show-toplevel'])), await realpath(newRepo));
  assert.equal(command(newRepo, ['branch', '--show-current']), 'main');
  assert.equal(command(newRepo, ['remote']), '');
  const greenfieldHead = spawnSync('git', ['-C', newRepo, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  assert.notEqual(greenfieldHead.status, 0, 'no baseline commit is manufactured');
  const readinessAfter = await setupReadiness(emptyRoot, greenfield);
  assert.equal(readinessAfter.ready, false);

  // A06: the application Git root is flagged rather than silently used/moved.
  const rootBoundary = await inspectControlRoot(one);
  assert.ok(rootBoundary.gitBoundary);
  assert.equal(rootBoundary.isGitRoot, true);
  await assert.rejects(() => validateRepositoryPlan(one, [], { mode: 'defer' }), /inside Git root/);

  // A07: multi-select accepts IDs and numbers, preserves selection order, rejects duplicates/invalids.
  const adapters = [{ id: 'opencode' }, { id: 'codex' }, { id: 'copilot' }];
  assert.deepEqual(parseAdapterSelection('opencode, 3', adapters).map(({ id }) => id), ['opencode', 'copilot']);
  assert.equal(parseAdapterSelection('1 1', adapters), null);
  assert.equal(parseAdapterSelection('unknown', adapters), null);
  assert.equal(parsePositiveCount('2', 20), 2);
  assert.equal(parsePositiveCount('0', 20), null);

  // A09/A10: cancellation/preflight/path attacks leave owner files untouched.
  const stableSnapshot = await readFile(configPlan.path, 'utf8');
  await assert.rejects(() => validateRepositoryPlan(container, [
    { id: 'escape', path: '../outside', base_branch: 'main', project_branch: 'triad/escape-feature', worktree: 'worktrees/escape' },
  ]), /traversal/);
  await assert.rejects(() => validateRepositoryPlan(container, [
    { id: 'rites', path: './rites', base_branch: 'main', project_branch: 'triad/rites-feature', worktree: 'worktrees/rites-feature' },
    { id: 'rites', path: './other-repo', base_branch: 'main', project_branch: 'triad/other-feature', worktree: 'worktrees/other-feature' },
  ]), /duplicated/);
  await assert.rejects(() => validateRepositoryPlan(container, [
    { id: 'dup-a', path: './rites', base_branch: 'main', project_branch: 'triad/dup-a', worktree: 'worktrees/shared' },
    { id: 'dup-b', path: './other-repo', base_branch: 'main', project_branch: 'triad/dup-b', worktree: 'worktrees/shared' },
  ]), /overlap/);
  const symlinkPath = path.join(root, 'repo-link');
  await symlink(one, symlinkPath, 'dir');
  await assert.rejects(() => assertNoSymlinkPath(symlinkPath), /symlink/);
  await assert.rejects(() => validateRepositoryPlan(container, [
    { id: 'linked', path: symlinkPath, base_branch: 'main', project_branch: 'triad/linked-feature', worktree: 'worktrees/linked-feature' },
  ]), /symlink/);
  assert.equal(await readFile(configPlan.path, 'utf8'), stableSnapshot);
  assert.match(projectLaunchHint({ id: 'codex' }, container).join('\n'), /was not installed/);
  const teamPreview = formatSetupPreview({
    root: emptyRoot,
    repositories: greenfield,
    adapters: [{ id: 'opencode', label: 'OpenCode' }],
    adapterPlans: new Map([['opencode', { created: ['.opencode/commands/triad.md'] }]]),
    projectYamlPlan: { changed: true, before: null },
    readiness: readinessBefore,
    currentVersion: '1.18.0',
    teamMode: 'create requested team config',
    roleOverlayPlan: { action: 'append', target: path.join(emptyRoot, 'AGENTS.md') },
    roleBindingActions: [{ adapterId: 'opencode', target: path.join(emptyRoot, '.opencode', 'agents', 'triad-orchestrator.md') }],
  });
  assert.match(teamPreview, /NOT READY/);
  assert.match(teamPreview, /\.triad-plus\/team\.json: CREATE/);
  assert.match(teamPreview, /AGENTS\.md role instructions: APPEND/);
  assert.match(teamPreview, /opencode: CONFIGURE/);
  assert.match(teamPreview, /Initial runtime metadata: opencode writes \.triad-runtime\/adapter\.json/);

  process.stdout.write('Triad+ interactive project setup safety fixtures passed (A01-A06, A09-A10; lifecycle/A11 and verifier/A14 covered by existing suites).\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
