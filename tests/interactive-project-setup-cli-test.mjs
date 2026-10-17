import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listAdapters, sharedSkillNames } from '../adapters/registry.mjs';
import { validateInstallationManifest } from '../runtime/lib/installation-manifest.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'triad-plus.js');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'triad-setup-cli-'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const pseudoTerminalAvailable = ['darwin', 'linux'].includes(process.platform)
  && spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, {
    cwd,
    env: { ...safeParentEnvironment(), ...env },
    encoding: 'utf8',
    timeout: 90_000,
  });
}

function safeParentEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i.test(name)));
}

function runCli(args, cwd, env = {}) {
  return run(process.execPath, [cli, ...args], cwd, env);
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
    cwd, env: { ...safeParentEnvironment(), ...env }, input, encoding: 'utf8', timeout: 95_000,
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

async function filesUnder(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(path.relative(directory, target).split(path.sep).join('/'));
    }
  }
  try { await walk(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files.sort();
}

async function treeSnapshot(directory) {
  return Promise.all((await filesUnder(directory)).map(async (relative) => ({
    path: relative,
    sha256: digest(await readFile(path.join(directory, relative))),
  })));
}

async function registryProjectAssetPaths(adapter) {
  const paths = new Set();
  for (const asset of adapter.projectAssets) {
    if (asset.source === 'shared-skills') {
      for (const name of sharedSkillNames) {
        for (const relative of await filesUnder(path.join(repositoryRoot, 'skills', name))) {
          paths.add(path.join(asset.destination, name, relative).split(path.sep).join('/'));
        }
      }
      continue;
    }
    const source = path.join(repositoryRoot, asset.source);
    const info = await lstat(source);
    const destination = asset.source === `adapters/${adapter.id}/runtime.json` && adapter.id !== 'opencode'
      ? `.triad-runtime/adapters/${adapter.id}/adapter.json`
      : asset.destination;
    if (asset.file || !info.isDirectory()) paths.add(destination.split(path.sep).join('/'));
    else for (const relative of await filesUnder(source)) paths.add(path.join(destination, relative).split(path.sep).join('/'));
  }
  return paths;
}

function teamConfiguration() {
  const roles = {};
  for (const id of ['orchestrator', 'developer', 'reviewer', 'evaluator']) {
    roles[id] = { displayName: id, persona: `${id} persona`, model: null, reasoning_effort: null, enabled: id !== 'evaluator' };
  }
  return { schema_version: 1, interaction: { language: 'English', owner_name: 'Test Owner', communication_style: 'concise' }, roles };
}

try {
  if (!pseudoTerminalAvailable) {
    process.stdout.write('Interactive setup CLI transcript: SKIPPED (no supported pseudo-terminal runner).\n');
  } else {
    // Single integrated first-install smoke: one non-Git Control Workspace,
    // one direct-child Git repository, and all six adapters selected at once.
    const root = path.join(fixture, 'sample-workspace');
    const home = path.join(fixture, 'home-existing');
    const xdgHome = path.join(fixture, 'xdg-config');
    const codexHome = path.join(fixture, 'codex-home');
    const hermesHome = path.join(fixture, 'hermes-home');
    const hostlessPath = path.join(fixture, 'hostless-bin');
    const isolatedTmp = path.join(fixture, 'tmp');
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    for (const directory of [xdgHome, codexHome, hermesHome, hostlessPath, isolatedTmp]) await mkdir(directory, { recursive: true });
    for (const command of ['git', 'python3']) {
      const executable = spawnSync('which', [command], { encoding: 'utf8' });
      assert.equal(executable.status, 0, `the local ${command} fixture executable is available`);
      await symlink(executable.stdout.trim(), path.join(hostlessPath, command));
    }
    const prd = '# Sample Workspace source PRD\nOwner-authored; must remain unchanged.\n';
    await writeFile(path.join(root, 'PRD.md'), prd);
    const sampleApp = path.join(root, 'sample-app');
    await makeRepo(sampleApp, 'sample app source\n');
    const loopRoot = path.join(root, '.loop');
    await mkdir(path.join(loopRoot, 'evidence'), { recursive: true });
    await writeFile(path.join(loopRoot, 'run-state.yaml'), 'version: 1\nproject_decision: owner-state\n');
    await writeFile(path.join(loopRoot, 'evidence', 'attempt.json'), '{"status":"owner-evidence"}\n');
    const teamBytes = Buffer.from(`${JSON.stringify(teamConfiguration(), null, 2)}\n`);
    await mkdir(path.join(root, '.triad-plus'), { recursive: true });
    await writeFile(path.join(root, '.triad-plus', 'team.json'), teamBytes);
    const loopBefore = await treeSnapshot(loopRoot);
    const repoBefore = await treeSnapshot(sampleApp);
    const repoHeadBefore = git(sampleApp, ['rev-parse', 'HEAD']);
    const repoStatusBefore = git(sampleApp, ['status', '--porcelain']);
    const answers = [
      '', '', '1', '1',
      'sample-app', '', '', '', '',
      'opencode,codex,claude-code,copilot,antigravity,hermes', 'install',
    ];
    const setup = terminalInput(root, answers, {
      HOME: home,
      XDG_CONFIG_HOME: xdgHome,
      CODEX_HOME: codexHome,
      HERMES_HOME: hermesHome,
      PATH: hostlessPath,
      TMPDIR: isolatedTmp,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    assert.equal(setup.status, 0, `${setup.stderr}\n${setup.stdout}`);
    await saveTranscript('single-tty-six-adapter-first-install', setup);
    const realRoot = await realpath(root);
    assert.ok(setup.stdout.includes(`Control Workspace (open this path): ${realRoot}`), setup.stdout);
    assert.match(setup.stdout, /Triad\+ setup completed\./);
    assert.match(setup.stdout, /Attempt-bound multi-harness dispatch remains unsupported/);
    assert.match(setup.stdout, /Readiness: NOT READY/);
    assert.match(setup.stdout, /\/triad/);
    assert.equal(await readFile(path.join(root, 'PRD.md'), 'utf8'), prd);
    assert.equal(git(sampleApp, ['remote']), '');
    assert.equal(git(sampleApp, ['show', 'HEAD:README.md']), 'sample app source');
    assert.equal(git(sampleApp, ['rev-parse', 'HEAD']), repoHeadBefore, 'the fixture commit is preserved');
    assert.equal(git(sampleApp, ['status', '--porcelain']), repoStatusBefore, 'product repository contents remain unchanged');
    assert.deepEqual(await treeSnapshot(sampleApp), repoBefore, 'all committed repository files remain byte-identical');
    assert.deepEqual(await treeSnapshot(loopRoot), loopBefore, '.loop owner state and evidence remain byte-identical');
    assert.deepEqual(await readFile(path.join(root, '.triad-plus', 'team.json')), teamBytes, 'existing team owner data is reused unchanged');
    const projectYaml = await readFile(path.join(root, 'project.yaml'), 'utf8');
    assert.equal((projectYaml.match(/^  - id:/gm) ?? []).length, 1, 'exactly one repository is mapped');
    assert.match(projectYaml, /path: "\.\/sample-app"/, 'the direct child repository mapping is explicit');
    const controlGit = run('git', ['-C', root, 'rev-parse', '--show-toplevel'], root);
    assert.notEqual(controlGit.status, 0, 'Control Workspace stays non-Git');
    const manifestPath = path.join(root, '.triad-plus', 'installation.json');
    const multi = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateInstallationManifest(multi);
    assert.equal(multi.schema_version, 2);
    const adapters = listAdapters();
    const expectedIds = adapters.map((adapter) => adapter.id).sort();
    assert.deepEqual(expectedIds, ['antigravity', 'claude-code', 'codex', 'copilot', 'hermes', 'opencode']);
    assert.deepEqual(multi.adapters.map((adapter) => adapter.id), expectedIds, 'all six selected adapters are recorded once');
    assert.equal(new Set(multi.adapters.map((adapter) => adapter.id)).size, expectedIds.length, 'adapter membership contains no duplicates');
    assert.equal(await readFile(path.join(root, '.triad-runtime', 'adapter.json'), 'utf8').then((text) => JSON.parse(text).id), 'opencode', 'the first selected adapter retains the singleton runtime metadata');
    for (const adapter of adapters) {
      const record = multi.adapters.find((entry) => entry.id === adapter.id);
      assert.deepEqual(record.scopes, { project: true, global: false }, `${adapter.id} is installed project-only`);
      const owned = new Map(record.managed_assets.filter((asset) => asset.scope === 'project').map((asset) => [asset.path, asset]));
      for (const target of await registryProjectAssetPaths(adapter)) {
        const asset = owned.get(target);
        assert.ok(asset, `${adapter.id} registry project asset is in schema-v2 manifest: ${target}`);
        const bytes = await readFile(path.join(root, target));
        assert.ok(bytes.length > 0, `${adapter.id} project asset is readable: ${target}`);
        assert.equal(digest(bytes), asset.sha256, `${adapter.id} manifest hash matches its materialized asset: ${target}`);
      }
      for (const projectPath of adapter.projectPaths(root)) {
        const relative = path.relative(root, projectPath).split(path.sep).join('/');
        assert.ok(relative && !relative.startsWith('../'), `${adapter.id} project path stays within the Control Workspace: ${relative}`);
        const metadata = await lstat(projectPath).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        assert.ok(metadata?.isDirectory() || metadata?.isFile(), `${adapter.id} registry projectPath exists: ${relative}`);
      }
      const runtimePath = adapter.id === 'opencode'
        ? '.triad-runtime/adapter.json'
        : `.triad-runtime/adapters/${adapter.id}/adapter.json`;
      assert.equal(JSON.parse(await readFile(path.join(root, runtimePath), 'utf8')).id, adapter.id, `${adapter.id} has distinct runtime metadata`);
    }
    assert.ok(multi.shared_assets.length > 0, 'shared assets have an ownership index');
    for (const shared of multi.shared_assets) {
      const owners = multi.adapters.filter((entry) => entry.managed_assets.some((asset) => asset.scope === shared.scope && asset.path === shared.path && asset.sha256 === shared.sha256)).map((entry) => entry.id).sort();
      assert.deepEqual(shared.owners, owners, `shared-asset owners are exact: ${shared.path}`);
      assert.equal(digest(await readFile(path.join(root, shared.path))), shared.sha256, `shared bytes match manifest: ${shared.path}`);
    }
    for (const directory of [home, xdgHome, codexHome, hermesHome, isolatedTmp]) {
      assert.deepEqual(await filesUnder(directory), [], `local-only setup wrote no global files under ${directory}`);
    }
    const isolatedHostEnv = { HOME: home, XDG_CONFIG_HOME: xdgHome, CODEX_HOME: codexHome, HERMES_HOME: hermesHome, PATH: hostlessPath };
    const fixtureBeforeDiagnostics = await treeSnapshot(fixture);
    const list = runCli(['adapter', 'list', '--control', root], root, isolatedHostEnv);
    assert.equal(list.status, 0, `${list.stderr}\n${list.stdout}`);
    for (const id of expectedIds) assert.match(list.stdout, new RegExp(`${id}\\s+project=installed global=not_configured host=unavailable`), `${id} keeps installed assets distinct from its absent host binary`);
    assert.deepEqual(await treeSnapshot(fixture), fixtureBeforeDiagnostics, 'adapter list and isolated global locations are read-only');
    const manifestBytesBeforeDoctor = await readFile(manifestPath);
    const doctor = runCli(['adapter', 'doctor', '--control', root], root, isolatedHostEnv);
    assert.equal(doctor.status, 0, `${doctor.stderr}\n${doctor.stdout}`);
    assert.match(doctor.stdout, /attempt dispatch=unsupported/);
    assert.match(doctor.stdout, /host=unavailable/);
    assert.deepEqual(await readFile(manifestPath), manifestBytesBeforeDoctor, 'adapter doctor is read-only');
    assert.deepEqual(await treeSnapshot(fixture), fixtureBeforeDiagnostics, 'adapter doctor and isolated global locations leave all fixture files unchanged');

    // A04-A05: actual greenfield setup initializes local Git only after exact approval and reports missing readiness inputs.
    const greenRoot = path.join(fixture, 'GREENFIELD');
    await mkdir(greenRoot);
    const greenHome = path.join(fixture, 'home-green');
    await mkdir(greenHome);
    const greenAnswers = ['', '', '2', '1', 'sample-app', '', '', '', '', 'opencode', '', 'install'];
    const green = terminalInput(greenRoot, greenAnswers, { HOME: greenHome, CODEX_HOME: path.join(greenHome, '.codex') });
    assert.equal(green.status, 0, `${green.stderr}\n${green.stdout}`);
    await saveTranscript('greenfield-not-ready', green);
    assert.match(green.stdout, /INIT local Git only \(after approval; no remote\/push\)/);
    assert.match(green.stdout, /root PRD\.md/);
    assert.match(green.stdout, /quality-gates\.yaml/);
    const greenRepo = path.join(greenRoot, 'sample-app');
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
