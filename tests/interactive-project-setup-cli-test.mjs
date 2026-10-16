import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateInstallationManifest } from '../runtime/lib/installation-manifest.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'triad-plus.js');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'triad-setup-cli-'));
const pseudoTerminalAvailable = ['darwin', 'linux'].includes(process.platform)
  && spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 90_000,
  });
}

function terminalInput(cwd, answers, env) {
  const input = `${answers.join('\n')}\n`;
  if (!pseudoTerminalAvailable) {
    return { status: 77, stdout: '', stderr: 'No supported local pseudo-terminal runner.' };
  }
  const pythonPty = [
    'import fcntl, os, pty, select, signal, struct, sys, termios, time',
    'argv = sys.argv[1:]',
    'pid, fd = pty.fork()',
    'if pid == 0: os.execvpe(argv[0], argv, os.environ)',
    'fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 220, 0, 0))',
    'payload = sys.stdin.buffer.read().splitlines(keepends=True)',
    'output = bytearray()',
    'deadline = time.monotonic() + 90',
    'def drain(seconds):',
    '  end = time.monotonic() + seconds',
    '  while time.monotonic() < end:',
    '    ready, _, _ = select.select([fd], [], [], min(0.05, max(0, end - time.monotonic())))',
    '    if ready:',
    '      try: output.extend(os.read(fd, 65536))',
    '      except OSError: return',
    'injected = False',
    'inject = os.environ.get("TRIAD_TEST_INJECT_CONFLICT")',
    'status = None',
    'for line in payload:',
    '  if time.monotonic() >= deadline: break',
    '  drain(0.15)',
    '  try: os.write(fd, line)',
    '  except OSError: break',
    '  drain(0.15)',
    '  if inject and not injected and b"Type install to apply this exact plan" in output:',
    '    os.makedirs(os.path.dirname(inject), exist_ok=True)',
    '    with open(inject, "w", encoding="utf8") as conflict: conflict.write("introduced after preview\\n")',
    '    injected = True',
    'while time.monotonic() < deadline:',
    '  drain(0.1)',
    '  done, status = os.waitpid(pid, os.WNOHANG)',
    '  if done: break',
    'if status is None: os.kill(pid, signal.SIGKILL); _, status = os.waitpid(pid, 0)',
    'sys.stdout.buffer.write(output)',
    'sys.exit(os.waitstatus_to_exitcode(status))',
  ].join('\n');
  return spawnSync('python3', ['-c', pythonPty, process.execPath, cli], {
    cwd, env: { ...process.env, ...env }, input, encoding: 'utf8', timeout: 95_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function saveTranscript(name, result) {
  const directory = process.env.TRIAD_SETUP_TRANSCRIPT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${name}.txt`), result.stdout.replaceAll('\r\n', '\n'));
}

function git(cwd, args) {
  const result = run('git', ['-C', cwd, ...args], cwd);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function makeRepo(directory, contents) {
  await mkdir(directory, { recursive: true });
  const init = run('git', ['init', '--initial-branch=main', directory], directory);
  assert.equal(init.status, 0, init.stderr);
  git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  git(directory, ['config', 'user.name', 'Fixture']);
  await writeFile(path.join(directory, 'README.md'), contents);
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-m', 'fixture baseline']);
}

try {
  if (!pseudoTerminalAvailable) {
    process.stdout.write('Interactive setup CLI transcript: SKIPPED (no supported pseudo-terminal runner).\n');
  } else {
    // Actual TTY transcript for A01-A03/A07/A13: root folder, two existing repos, and two adapters.
    const root = path.join(fixture, 'RITES');
    const home = path.join(fixture, 'home-existing');
    const codexHome = path.join(home, '.codex');
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    const prd = '# RITES source PRD\nOwner-authored; must remain unchanged.\n';
    await writeFile(path.join(root, 'PRD.md'), prd);
    const rites = path.join(root, 'rites');
    const other = path.join(root, 'other-repo');
    await makeRepo(rites, 'rites source\n');
    await makeRepo(other, 'other source\n');
    const answers = [
      '', '', '1', '2',
      'rites', '', '', '', '',
      'other', './other-repo', '', '', '',
      'opencode,codex', '', 'install',
    ];
    const setup = terminalInput(root, answers, { HOME: home, CODEX_HOME: codexHome });
    assert.equal(setup.status, 0, `${setup.stderr}\n${setup.stdout}`);
    await saveTranscript('two-repo-two-harness', setup);
    const realRoot = await realpath(root);
    assert.ok(setup.stdout.includes(`Control Workspace (open this path): ${realRoot}`), setup.stdout);
    assert.match(setup.stdout, /Triad\+ setup completed\./);
    assert.match(setup.stdout, /Attempt-bound multi-harness dispatch remains unsupported/);
    assert.match(setup.stdout, /Readiness: NOT READY/);
    assert.match(setup.stdout, /\/triad/);
    assert.equal(await readFile(path.join(root, 'PRD.md'), 'utf8'), prd);
    assert.equal(git(rites, ['remote']), '');
    assert.equal(git(other, ['remote']), '');
    assert.equal(git(rites, ['show', 'HEAD:README.md']), 'rites source');
    assert.equal(git(other, ['show', 'HEAD:README.md']), 'other source');
    assert.equal(await readFile(path.join(root, 'project.yaml'), 'utf8').then((yaml) => (yaml.match(/^  - id:/gm) ?? []).length), 2);
    const manifestPath = path.join(root, '.triad-plus', 'installation.json');
    const multi = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateInstallationManifest(multi);
    assert.equal(multi.schema_version, 2);
    assert.deepEqual(multi.adapters.map((adapter) => adapter.id), ['codex', 'opencode']);
    assert.equal(await stat(path.join(root, '.opencode', 'commands', 'triad.md')).then(() => true), true);
    assert.equal(await stat(path.join(root, '.agents', 'skills', 'triad-loop-bootstrap', 'SKILL.md')).then(() => true), true);
    assert.equal(await readFile(path.join(root, '.triad-runtime', 'adapter.json'), 'utf8').then((text) => JSON.parse(text).id), 'opencode');
    assert.equal(await readFile(path.join(root, '.triad-runtime', 'adapters', 'codex', 'adapter.json'), 'utf8').then((text) => JSON.parse(text).id), 'codex');
    assert.equal(await readFile(path.join(home, '.codex', 'prompts', 'triad.md'), 'utf8').then(() => true, () => false), false, 'global Codex prompt was not installed');

    // A04-A05: actual greenfield setup initializes local Git only after exact approval and reports missing readiness inputs.
    const greenRoot = path.join(fixture, 'GREENFIELD');
    await mkdir(greenRoot);
    const greenHome = path.join(fixture, 'home-green');
    await mkdir(greenHome);
    const greenAnswers = ['', '', '2', '1', 'rites', '', '', '', '', 'opencode', '', 'install'];
    const green = terminalInput(greenRoot, greenAnswers, { HOME: greenHome, CODEX_HOME: path.join(greenHome, '.codex') });
    assert.equal(green.status, 0, `${green.stderr}\n${green.stdout}`);
    await saveTranscript('greenfield-not-ready', green);
    assert.match(green.stdout, /INIT local Git only \(after approval; no remote\/push\)/);
    assert.match(green.stdout, /root PRD\.md/);
    assert.match(green.stdout, /quality-gates\.yaml/);
    const greenRepo = path.join(greenRoot, 'rites');
    assert.equal(git(greenRepo, ['branch', '--show-current']), 'main');
    assert.equal(git(greenRepo, ['remote']), '');
    const head = run('git', ['-C', greenRepo, 'rev-parse', '--verify', 'HEAD'], greenRepo);
    assert.notEqual(head.status, 0, 'the wizard does not manufacture an initial commit');
    assert.match(green.stdout, /Readiness: NOT READY/);

    // A06: a CWD that is itself a product Git root is not initialized as control and no sibling is guessed.
    const appRoot = path.join(fixture, 'APP-ROOT');
    await makeRepo(appRoot, 'app source\n');
    const blocked = terminalInput(appRoot, ['', ''], { HOME: path.join(fixture, 'home-blocked') });
    assert.equal(blocked.status, 0, `${blocked.stderr}\n${blocked.stdout}`);
    await saveTranscript('git-root-boundary-cancel', blocked);
    assert.match(blocked.stdout, /belongs to Git root/);
    assert.match(blocked.stdout, /No sibling path will be generated/);
    assert.match(blocked.stdout, /Cancelled\. No files were changed\./);
    assert.equal(await readFile(path.join(appRoot, 'README.md'), 'utf8'), 'app source\n');
    assert.equal(await readFile(path.join(fixture, 'APP-ROOT-control', '.triad-plus', 'installation.json')).then(() => true, () => false), false);

    // A01: a not-yet-created root is previewed without making the directory; cancellation remains write-free.
    const missingRoot = path.join(await realpath(fixture), 'NEW-ROOT');
    const missingRootRun = terminalInput(fixture, ['', 'NEW-ROOT', '3', 'opencode', '', ''], { HOME: path.join(fixture, 'home-missing-root') });
    assert.equal(missingRootRun.status, 0, `${missingRootRun.stderr}\n${missingRootRun.stdout}`);
    await saveTranscript('new-root-cancel', missingRootRun);
    assert.ok(missingRootRun.stdout.includes(`Control Workspace (open this path): ${missingRoot}`), missingRootRun.stdout);
    assert.match(missingRootRun.stdout, /Cancelled\. No files were changed\./);
    assert.equal(await stat(missingRoot).then(() => true, () => false), false);

    // A09: preflight collisions fail before project config, manifest, or owner assets are written.
    const collisionRoot = path.join(fixture, 'COLLISION');
    await mkdir(path.join(collisionRoot, '.opencode', 'commands'), { recursive: true });
    const ownerCommand = '# Owner command\n';
    await writeFile(path.join(collisionRoot, '.opencode', 'commands', 'triad.md'), ownerCommand);
    const collision = terminalInput(collisionRoot, ['', '', '3', 'opencode', '', ''], { HOME: path.join(fixture, 'home-collision') });
    assert.equal(collision.status, 0, `${collision.stderr}\n${collision.stdout}`);
    await saveTranscript('preflight-collision', collision);
    assert.match(collision.stdout, /Preflight failed; nothing was changed/);
    assert.equal(await readFile(path.join(collisionRoot, '.opencode', 'commands', 'triad.md'), 'utf8'), ownerCommand);
    assert.equal(await readFile(path.join(collisionRoot, 'project.yaml')).then(() => true, () => false), false);
    assert.equal(await readFile(path.join(collisionRoot, '.triad-plus', 'installation.json')).then(() => true, () => false), false);

    // A09: a collision introduced after preview keeps the committed first adapter and never claims completion.
    const partialRoot = path.join(fixture, 'PARTIAL');
    await mkdir(partialRoot);
    const conflict = path.join(partialRoot, '.agents', 'skills', 'triad-loop-bootstrap', 'SKILL.md');
    const partialAnswers = ['', '', '3', 'opencode,codex', '', 'install'];
    const partial = terminalInput(partialRoot, partialAnswers, {
      HOME: path.join(fixture, 'home-partial'),
      TRIAD_TEST_INJECT_CONFLICT: conflict,
    });
    assert.equal(partial.status, 2, `${partial.stderr}\n${partial.stdout}`);
    await saveTranscript('partial-second-adapter-failure', partial);
    assert.match(partial.stdout, /Setup is incomplete; no successful step was removed/);
    assert.match(partial.stdout, /Harnesses fully installed: opencode/);
    assert.match(partial.stdout, /Safe re-entry: run triad-plus from this root, choose Manage existing/);
    assert.doesNotMatch(partial.stdout, /Triad\+ setup completed\./);
    assert.equal(await readFile(conflict, 'utf8'), 'introduced after preview\n');
    const partialManifest = JSON.parse(await readFile(path.join(partialRoot, '.triad-plus', 'installation.json'), 'utf8'));
    assert.equal(partialManifest.adapter, 'opencode');

    process.stdout.write('Interactive setup CLI pseudo-terminal fixtures passed: A01-A09, A13; native discovery gates are reported rather than inferred.\n');
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}
