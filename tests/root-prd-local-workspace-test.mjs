import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'triad-plus-root-prd-'));
const controlRoot = path.join(fixtureRoot, 'my-project');
const isolatedHome = path.join(fixtureRoot, 'home');

function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
}

async function makeRepository(repositoryPath, worktreePath, branch) {
  await mkdir(repositoryPath, { recursive: true });
  for (const args of [
    ['-c', 'init.defaultBranch=main', 'init', repositoryPath],
    ['config', 'user.email', 'triad-fixture@example.invalid'],
    ['config', 'user.name', 'Triad Fixture'],
  ]) {
    const result = run('git', args, repositoryPath);
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(path.join(repositoryPath, 'README.md'), `# ${branch}\n`);
  for (const args of [['add', 'README.md'], ['commit', '-m', 'fixture baseline']]) {
    const result = run('git', args, repositoryPath);
    assert.equal(result.status, 0, result.stderr);
  }
  const result = run('git', ['worktree', 'add', '-b', branch, worktreePath], repositoryPath);
  assert.equal(result.status, 0, result.stderr);
}

try {
  await mkdir(controlRoot, { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
  const prd = '# Goal\nA disposable local-only control-workspace fixture.\n';
  await writeFile(path.join(controlRoot, 'PRD.md'), prd);
  const projectConfig = {
    project: { id: 'root-prd-fixture', title: 'Root PRD fixture' },
    repositories: [
      { id: 'frontend', path: '../repositories/frontend', worktree: '../worktrees/frontend-feature' },
      { id: 'backend', path: '../repositories/backend', worktree: '../worktrees/backend-feature' },
    ],
  };
  await writeFile(path.join(controlRoot, 'project.yaml'), `${JSON.stringify(projectConfig, null, 2)}\n`);
  await makeRepository(
    path.join(fixtureRoot, 'repositories', 'frontend'),
    path.join(fixtureRoot, 'worktrees', 'frontend-feature'),
    'triad/frontend-feature',
  );
  await makeRepository(
    path.join(fixtureRoot, 'repositories', 'backend'),
    path.join(fixtureRoot, 'worktrees', 'backend-feature'),
    'triad/backend-feature',
  );

  const init = run(process.execPath, [
    path.join(repositoryRoot, 'bin', 'triad-plus.js'), 'init', '--host', 'opencode', '--control', '.',
  ], controlRoot, { HOME: isolatedHome, XDG_CONFIG_HOME: path.join(isolatedHome, 'xdg') });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /installed for OpenCode/);

  const doctor = run(process.execPath, [
    path.join(repositoryRoot, 'bin', 'triad-plus.js'), 'doctor', '--host', 'opencode', '--control', '.',
  ], controlRoot, { HOME: isolatedHome, XDG_CONFIG_HOME: path.join(isolatedHome, 'xdg') });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /OpenCode\s+OK/);
  assert.equal(await readFile(path.join(controlRoot, 'PRD.md'), 'utf8'), prd);
  assert.deepEqual(JSON.parse(await readFile(path.join(controlRoot, 'project.yaml'), 'utf8')), projectConfig);
  await stat(path.join(controlRoot, '.opencode', 'commands', 'triad.md'));
  await stat(path.join(controlRoot, '.opencode', 'skills', 'triad-loop-bootstrap', 'SKILL.md'));
  await stat(path.join(fixtureRoot, 'worktrees', 'frontend-feature', '.git'));
  await stat(path.join(fixtureRoot, 'worktrees', 'backend-feature', '.git'));
  await assert.rejects(() => stat(path.join(isolatedHome, '.config', 'opencode')) , { code: 'ENOENT' });

  const unrelated = path.join(fixtureRoot, 'unrelated-workspace');
  await mkdir(unrelated);
  await assert.rejects(() => stat(path.join(unrelated, '.opencode')) , { code: 'ENOENT' });

  const bootstrap = await readFile(path.join(repositoryRoot, 'skills', 'triad-loop-bootstrap', 'SKILL.md'), 'utf8');
  assert.match(bootstrap, /relative PRD argument from that Control Workspace root/);
  assert.match(bootstrap, /a\s+readable `PRD\.md` exists at that root/);
  assert.match(bootstrap, /Product repository\s+and worktree paths still require explicit mappings/);
  const command = await readFile(path.join(controlRoot, '.opencode', 'commands', 'triad.md'), 'utf8');
  assert.match(command, /Resolve a relative PRD path from the opened Control Workspace root/);
  assert.match(command, /a readable `PRD\.md` is present at that root/);
  assert.match(await readFile(path.join(repositoryRoot, 'README.md'), 'utf8'), /Project-local OpenCode with a root PRD/);

  console.log('Triad+ root PRD local Control Workspace fixture: PASS (installer/docs/static discovery boundary; agent bootstrap not invoked)');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
