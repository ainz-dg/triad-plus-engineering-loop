import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectReadiness, approveReadiness, runReadinessCommand, validateReadinessAssignment, readinessErrorMessage, READINESS_RECEIPT } from '../runtime/lib/readiness.mjs';
import { resolveAssignmentContext } from '../runtime/lib/assignment-packet.mjs';

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'triad-readiness-')));
const cli = fileURLToPath(new URL('../bin/triad-plus.js', import.meta.url));
const marker = path.join(root, 'NO-EXECUTION');
const run = (command, args, cwd) => spawnSync(command, args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', timeout: 30_000 });
function git(cwd, args) { const result = run('git', ['-C', cwd, ...args], cwd); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
async function makeWorkspace(host, suffix = host, repositories = 1) {
  const control = path.join(root, suffix);
  await mkdir(control);
  const mappings = [];
  for (let i = 0; i < repositories; i += 1) {
    const repo = path.join(control, 'repo-' + i), worktree = path.join(control, 'worktree-' + i);
    await mkdir(repo);
    git(repo, ['init', '--initial-branch=main']);
    git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test.mjs', lint: 'eslint .' } }));
    await writeFile(path.join(repo, 'test.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'not allowed before consent');\n`);
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'fixture']);
    git(repo, ['worktree', 'add', '-b', 'triad/feature-' + i, worktree, 'main']);
    mappings.push({ id: 'repo-' + i, path: repo, worktree, base_branch: 'main', project_branch: 'triad/feature-' + i });
  }
  await writeFile(path.join(control, 'project.yaml'), JSON.stringify({ repositories: mappings }));
  await writeFile(path.join(control, 'PRD.md'), '# Owner-controlled fixture\n');
  const installed = run(process.execPath, [cli, 'init', '--host', host, '--control', control], control);
  assert.equal(installed.status, 0, installed.stderr);
  return { adapter: host, cwd: control, control, mappings };
}
async function confirm(workspace, { catalog } = {}) {
  let report = await inspectReadiness(workspace);
  for (let i = 0; i < 12 && !report.ready; i += 1) {
    const action = report.actions[0];
    assert.notEqual(action.kind, 'manual', JSON.stringify(report));
    const options = { ...workspace, approve: action.id };
    if (action.kind === 'confirm-gates') {
      if (catalog) { options.catalog = catalog; report = await inspectReadiness(options); }
      else options.select = 'test';
    }
    report = await approveReadiness({ ...options, expectedState: report.state_sha256 });
  }
  assert.equal(report.ready, true, JSON.stringify(report));
  return report;
}
async function absent(file) { assert.equal(await stat(file).then(() => true, () => false), false); }

try {
  for (const host of ['opencode', 'claude-code', 'codex', 'copilot', 'antigravity', 'hermes']) {
    const workspace = await makeWorkspace(host);
    const before = await inspectReadiness(workspace);
    if (host === 'opencode') {
      const direct = run(process.execPath, [path.join(workspace.control, '.triad-runtime/triad-host-entry.mjs'), '--adapter', host, '--json'], workspace.control);
      assert.equal(direct.status, 2);
      assert.equal(JSON.parse(direct.stdout).ready, false, 'the default native entry cannot bypass consent via legacy structural READY');
    }
    assert.equal(before.ready, false);
    assert.equal(before.actions[0].id, 'models');
    await absent(path.join(workspace.control, READINESS_RECEIPT));
    const blocked = run(process.execPath, [cli, 'preflight', '--host', host, '--control', workspace.control, '--non-interactive', '--json'], workspace.control);
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).ready, false);
    await assert.rejects(() => approveReadiness({ ...workspace, approve: 'models' }), /expected state/);
    const ready = await confirm(workspace);
    assert.equal(ready.catalogs.length, 1);
    assert.equal(ready.effective_model_identity, 'not-observable');
    assert.match(ready.model_binding, /owner-confirmed-host-default/);
    const receiptBytes = await readFile(path.join(workspace.control, READINESS_RECEIPT));
    let questions = 0;
    const resumed = await runReadinessCommand(workspace, { output: { write() {} }, question: async () => { questions += 1; return ''; } });
    assert.equal(resumed.ready, true); assert.equal(questions, 0, 'unchanged inputs need no repeated ceremony');
    assert.deepEqual(await readFile(path.join(workspace.control, READINESS_RECEIPT)), receiptBytes);
    const catalog = ready.catalogs[0];
    const assignment = { worktree: workspace.mappings[0].worktree, repository_id: 'repo-0', expected_branch: 'triad/feature-0', gates_path: catalog.gates_path, expected_gates_sha256: catalog.expected_gates_sha256 };
    await validateReadinessAssignment({ projectRoot: workspace.control, assignment, worktree: assignment.worktree, repository: 'repo-0' });
    await resolveAssignmentContext(assignment, { projectRoot: workspace.control });
    await assert.rejects(() => resolveAssignmentContext({ ...assignment, gates_path: '.loop/quality-gates.yaml' }, { projectRoot: workspace.control }), /exact per-repository/);
    const succeeded = run(process.execPath, [cli, 'preflight', '--host', host, '--control', workspace.control, '--non-interactive'], workspace.control);
    assert.equal(succeeded.status, 0, succeeded.stderr);
    await absent(marker);
  }

  const spaced = await makeWorkspace('opencode', 'workspace with spaces');
  const spacedEntry = run(process.execPath, [path.join(spaced.control, '.triad-runtime/triad-host-entry.mjs'), '--adapter', 'opencode', '--json'], spaced.control);
  assert.equal(spacedEntry.status, 2);
  assert.equal(JSON.parse(spacedEntry.stdout).ready, false, 'encoded paths cannot silently skip the native entry');
  await confirm(spaced);
  const multiple = await makeWorkspace('opencode', 'multi', 2);
  const ready = await confirm(multiple);
  assert.equal(ready.catalogs.length, 2);
  assert.notEqual(ready.catalogs[0].gates_path, ready.catalogs[1].gates_path);
  const repo = multiple.mappings[0];
  const assignment = { worktree: repo.worktree, repository_id: repo.id, expected_branch: repo.project_branch,
    gates_path: ready.catalogs[0].gates_path, expected_gates_sha256: ready.catalogs[0].expected_gates_sha256 };
  const packagePath = path.join(repo.worktree, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  await writeFile(packagePath, JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.equal((await inspectReadiness(multiple)).ready, false);
  await assert.rejects(() => validateReadinessAssignment({ projectRoot: multiple.control, assignment, worktree: repo.worktree, repository: repo.id }), /source, worktree or branch changed/);
  await assert.rejects(() => approveReadiness({ ...multiple, approve: 'gates:repo-0', select: 'test', expectedState: ready.state_sha256 }), /changed/);
  await writeFile(packagePath, original);
  git(repo.worktree, ['switch', '-c', 'wrong-branch']);
  assert.equal((await inspectReadiness(multiple)).ready, false);
  await assert.rejects(() => validateReadinessAssignment({ projectRoot: multiple.control, assignment, worktree: repo.worktree, repository: repo.id }), /mapping/);
  git(repo.worktree, ['switch', repo.project_branch]);
  const catalogPath = path.join(multiple.control, ready.catalogs[0].gates_path);
  const catalogBytes = await readFile(catalogPath, 'utf8');
  await writeFile(catalogPath, catalogBytes + ' ');
  await assert.rejects(() => validateReadinessAssignment({ projectRoot: multiple.control, assignment, worktree: repo.worktree, repository: repo.id }), /catalog bytes changed/);
  await writeFile(catalogPath, catalogBytes);

  const correction = await makeWorkspace('opencode', 'model-correction');
  const roles = Object.fromEntries(['orchestrator', 'developer', 'reviewer', 'evaluator'].map((id) => [id, { displayName: id, persona: 'keep', model: 'gpt 6 luna medium', reasoning_effort: null, enabled: id !== 'evaluator' }]));
  const teamPath = path.join(correction.control, '.triad-plus/team.json');
  await writeFile(teamPath, JSON.stringify({ schema_version: 1, interaction: {}, roles }));
  let report = await inspectReadiness(correction);
  assert.ok(report.model_requests.some((entry) => entry.model === 'invalid-request'));
  assert.doesNotMatch(JSON.stringify(report), /gpt 6 luna medium/);
  report = await approveReadiness({ ...correction, setModel: 'developer=fixture/exact-id', expectedState: report.state_sha256 });
  const team = JSON.parse(await readFile(teamPath));
  assert.equal(team.roles.developer.model, 'fixture/exact-id'); assert.equal(team.roles.reviewer.persona, 'keep');
  await confirm(correction);
  const changedIntent = JSON.parse(await readFile(teamPath)); changedIntent.roles.developer.reasoning_effort = 'other';
  await writeFile(teamPath, JSON.stringify(changedIntent));
  assert.equal((await inspectReadiness(correction)).actions[0].id, 'models');

  const declined = await makeWorkspace('opencode', 'declined');
  report = await inspectReadiness(declined);
  report = await approveReadiness({ ...declined, approve: 'models', expectedState: report.state_sha256 });
  report = await approveReadiness({ ...declined, approve: 'gates:repo-0', select: 'reject', expectedState: report.state_sha256 });
  assert.equal(report.actions[0].kind, 'manual');
  let prompted = false;
  await runReadinessCommand(declined, { output: { write() {} }, question: async () => { prompted = true; return ''; } });
  assert.equal(prompted, false, 'declined unchanged candidates do not prompt again');
  report = await inspectReadiness({ ...declined, review: 'gates:repo-0' });
  await approveReadiness({ ...declined, review: 'gates:repo-0', approve: 'gates:repo-0', select: 'test', expectedState: report.state_sha256 });
  await confirm(declined);

  const interrupted = await makeWorkspace('opencode', 'interrupted');
  let count = 0;
  await runReadinessCommand(interrupted, { output: { write() {} }, question: async () => ++count === 1 ? 'defaults' : '' });
  report = await inspectReadiness(interrupted);
  assert.equal(report.actions[0].id, 'gates:repo-0', 'confirmed model choice survives interruption');
  const missingPrd = path.join(interrupted.control, 'PRD.md');
  const prdText = await readFile(missingPrd, 'utf8');
  await rm(missingPrd);
  assert.equal((await inspectReadiness(interrupted)).actions[0].id, 'prd');
  await writeFile(missingPrd, prdText);
  assert.equal((await inspectReadiness({ ...interrupted, expectedVersion: '999.0.0' })).actions[0].severity, 'fatal');
  const receiptPath = path.join(interrupted.control, READINESS_RECEIPT);
  const previousReceipt = await readFile(receiptPath, 'utf8');
  await writeFile(receiptPath, 'null');
  assert.equal((await inspectReadiness(interrupted)).actions[0].id, 'receipt');
  await writeFile(receiptPath, previousReceipt);

  const manual = await makeWorkspace('opencode', 'manual');
  report = await inspectReadiness(manual);
  await approveReadiness({ ...manual, approve: 'models', expectedState: report.state_sha256 });
  const manualPath = path.join(manual.control, 'manual.json');
  const falseSecret = 'DO-NOT-DISCLOSE-FIXTURE-TOKEN';
  assert.doesNotMatch(readinessErrorMessage(Object.assign(new Error('body token=' + falseSecret), { code: 'EACCES' })), new RegExp(falseSecret));
  await writeFile(manualPath, JSON.stringify({ gates: [{ id: 'test', command: 'echo token=' + falseSecret, timeout_seconds: 2 }] }));
  report = await inspectReadiness({ ...manual, catalog: 'manual.json' });
  assert.doesNotMatch(JSON.stringify(report), new RegExp(falseSecret));
  await writeFile(manualPath, JSON.stringify({ gates: [{ id: 'test', command: 'true', timeout_seconds: 2 }] }));
  await assert.rejects(() => approveReadiness({ ...manual, catalog: 'manual.json', approve: 'gates:repo-0', expectedState: report.state_sha256 }), /changed/);
  await confirm(manual, { catalog: 'manual.json' });
  report = await inspectReadiness({ ...manual, review: 'gates:repo-0' });
  assert.equal(report.actions[0].kind, 'confirm-gates', 'explicit re-review can edit an existing approval');
  const manualReceipt = await readFile(path.join(manual.control, READINESS_RECEIPT));
  await rm(path.join(manual.control, READINESS_RECEIPT));
  await assert.rejects(() => validateReadinessAssignment({ projectRoot: manual.control, assignment: {}, worktree: manual.mappings[0].worktree, repository: 'repo-0' }), /approval is missing/);
  const installedHelper = path.join(manual.control, '.triad-runtime/lib/readiness.mjs');
  const helperBytes = await readFile(installedHelper);
  await rm(installedHelper);
  await assert.rejects(() => validateReadinessAssignment({ projectRoot: manual.control, assignment: {}, worktree: manual.mappings[0].worktree, repository: 'repo-0' }), /approval is missing/);
  await writeFile(installedHelper, helperBytes);
  await writeFile(path.join(manual.control, READINESS_RECEIPT), manualReceipt);

  // Every actual native entry/fallback has the same non-publishing consent protocol.
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const relative of [
    'opencode/.opencode/commands/triad.md', 'opencode/.opencode/agents/triad-orchestrator.md',
    'claude-code/.claude/commands/triad.md', 'copilot/.github/skills/triad/SKILL.md',
    'copilot/.github/agents/triad-orchestrator.agent.md', 'antigravity/.agents/skills/triad/SKILL.md',
    'antigravity/.agents/agents/triad-orchestrator/agent.md', 'codex/skills/triad/SKILL.md', 'hermes/skills/triad/SKILL.md',
  ]) {
    const source = await readFile(path.join(packageRoot, 'adapters', relative), 'utf8');
    assert.match(source, /--json/); assert.match(source, /never auto-approve/i);
    assert.match(source, /--expected-state/); assert.match(source, /gates_path/);
    assert.match(source, /post-LLM/); assert.match(source, /requested.*intent|intent.*native/is);
  }

  // Real terminal CLI: invalid model -> one-field correction -> explicit consent -> READY.
  if (['darwin', 'linux'].includes(process.platform) && run('python3', ['--version'], root).status === 0) {
    const ttyWorkspace = await makeWorkspace('opencode', 'tty');
    const python = `import os,pty,select,signal,sys,time,json
pid,fd=pty.fork()
if pid==0: os.execv(sys.argv[1],sys.argv[1:])
answers=[(b'Type defaults',b'model developer=gpt 6 luna medium'),(b'Type defaults',b'model developer=fixture/exact-id'),(b'Type defaults',b'defaults'),(b'Select candidate IDs',b'test'),(b'Type approve',b'approve'),(b'Type confirm',b'confirm')]
output=bytearray(); position=0; start=0; deadline=time.monotonic()+35; status=None
while time.monotonic()<deadline:
 ready,_,_=select.select([fd],[],[],0.05)
 if ready:
  try: output.extend(os.read(fd,65536))
  except OSError: pass
 if position<len(answers) and answers[position][0] in output[start:]:
  os.write(fd,answers[position][1]+b'\\r'); position+=1; start=len(output)
 done,status=os.waitpid(pid,os.WNOHANG)
 if done: break
if not done: os.kill(pid,signal.SIGKILL); _,status=os.waitpid(pid,0)
sys.stdout.buffer.write(output); sys.exit(os.waitstatus_to_exitcode(status))`;
    const terminal = run('python3', ['-c', python, process.execPath, cli, 'preflight', '--host', 'opencode', '--control', ttyWorkspace.control], ttyWorkspace.control);
    assert.equal(terminal.status, 0, terminal.stdout + terminal.stderr);
    assert.match(terminal.stdout, /exact ID without spaces/);
    assert.match(terminal.stdout, /READY: workspace preflight/);
    assert.equal((await inspectReadiness(ttyWorkspace)).ready, true);
    assert.equal(JSON.parse(await readFile(path.join(ttyWorkspace.control, '.triad-plus/team.json'))).roles.developer.model, 'fixture/exact-id');
  }
  await absent(marker);
  process.stdout.write('Readiness: PASS (six-host contracts, per-repo consent, idempotence, stale source/branch/catalog guards, non-interactive failure, model correction, rejection/resume, no execution).\n');
} finally { await rm(root, { recursive: true, force: true }); }
