import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listAdapters, sharedSkillNames } from '../adapters/registry.mjs';
import { buildMultiAdapterManifest, validateInstallationManifest, writeInstallationManifest } from '../runtime/lib/installation-manifest.mjs';
import { terminalScreen } from './terminal-screen-emulator.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'triad-plus.js');
const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'triad-setup-cli-')));
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

const line = (value = '') => `L${value}`;
const key = (value) => `K${value}`;

function terminalInput(cwd, actions, env) {
  const input = `${actions.join('\n')}\n`;
  if (!pseudoTerminalAvailable) {
    return { status: 77, stdout: '', stderr: 'No supported local pseudo-terminal runner.' };
  }
  const pythonPty = [
    'import fcntl, os, pty, select, signal, struct, sys, termios, time',
    'argv = sys.argv[1:]',
    'pid, fd = pty.fork()',
    'if pid == 0: os.execvpe(argv[0], argv, os.environ)',
    'rows = int(os.environ.get("TRIAD_TEST_PTY_ROWS", "48"))',
    'cols = int(os.environ.get("TRIAD_TEST_PTY_COLS", "220"))',
    'fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))',
    'payload = sys.stdin.buffer.read().splitlines(keepends=True)',
    'output = bytearray()',
    'deadline = time.monotonic() + 20',
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
    'keys = {b"up": b"\\x1b[A", b"down": b"\\x1b[B", b"space": b" ", b"enter": b"\\r", b"escape": b"\\x1b", b"ctrl-c": b"\\x03"}',
    'for token in payload:',
    '  if time.monotonic() >= deadline: break',
    '  drain(0.15)',
    '  token = token.rstrip(b"\\r\\n")',
    '  if token.startswith(b"L"): data = token[1:] + b"\\r"',
    '  elif token.startswith(b"K"): data = keys[token[1:]]',
    '  else: raise ValueError("PTY input actions must start with L or K")',
    '  try: os.write(fd, data)',
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
    cwd, env: { ...safeParentEnvironment(), ...env }, input, encoding: 'utf8', timeout: 25_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

// The initial interactive entry renders the approved color mark before its
// first choice; the menu remains usable and the static header is not replayed.
if (pseudoTerminalAvailable) {
  const retroRoot = path.join(fixture, 'RETRO-HEADER-CONTROL');
  await mkdir(retroRoot);
  const originalNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  const retro = terminalInput(retroRoot, [line('n'), line(''), key('escape')], {
    HOME: path.join(fixture, 'home-retro-header'),
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TRIAD_TEST_PTY_COLS: '80',
    TRIAD_TEST_PTY_ROWS: '24',
  });
  if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
  assert.equal(retro.status, 0, `${retro.stderr}\n${retro.stdout}`);
  await saveTranscript('retro-pixel-header', retro);
  if (process.env.TRIAD_RETRO_PTY_EVIDENCE) {
    const evidencePath = path.resolve(process.env.TRIAD_RETRO_PTY_EVIDENCE);
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, retro.stdout.replaceAll('\u001b', '<ESC>').replaceAll('\r', '<CR>'));
  }
  assert.match(retro.stdout, /\u001b\[38;2;124;140;255m/, 'interactive PTY uses the exact violet');
  assert.match(retro.stdout, /\u001b\[38;2;53;195;177m/, 'interactive PTY uses the exact turquoise');
  assert.match(retro.stdout, /\u001b\[38;2;245;185;94m/, 'interactive PTY uses the exact amber');
  assert.match(retro.stdout, /Choose \[N\]ew workspace/, 'the first menu choice appears immediately');
  assert.match(retro.stdout, /Select product repositories/, 'the next interactive screen remains available');
  assert.equal((retro.stdout.match(/ENGINEERING LOOP/g) ?? []).length, 1, 'the header is printed once across menu redraws');
  assert.doesNotMatch(retro.stdout, /\u001b\[2J/, 'redraws do not clear the display before painting');
  assert.match(retro.stdout, /Cancelled\. No files were changed\./);
  assert.equal(await readFile(path.join(retroRoot, 'project.yaml')).then(() => true, () => false), false);

  // Reproduce a later checklist after text prompts have scrolled a small PTY.
  // The checklist must not jump back to the header's original absolute row and
  // paint over the intervening prompts; Back must still reopen and Escape must
  // restore the terminal without applying the previewed setup.
  const scrollRoot = path.join(fixture, 'SCROLLED-CHECKLIST');
  await mkdir(scrollRoot);
  const scrollRepo = path.join(scrollRoot, 'product');
  await makeRepo(scrollRepo, 'scroll fixture remains untouched\n');
  const scrollBefore = await treeSnapshot(scrollRepo);
  const scrolled = terminalInput(scrollRoot, [
    line('n'), line(''), key('space'), key('enter'),
    line(''), line(''), line(''), line(''), key('escape'), key('escape'),
  ], {
    HOME: path.join(fixture, 'home-scrolled-checklist'),
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TRIAD_TEST_PTY_COLS: '50',
    TRIAD_TEST_PTY_ROWS: '18',
  });
  assert.equal(scrolled.status, 0, `${scrolled.stderr}\n${scrolled.stdout}`);
  await saveTranscript('scrolling-checklist', scrolled);
  assert.match(stripAnsi(scrolled.stdout), /TRIAD\+/);
  assert.match(scrolled.stdout, /Select product repositories/);
  assert.match(scrolled.stdout, /Cancelled\. No files were changed\./);
  assert.equal((scrolled.stdout.match(/ENGINEERING LOOP/g) ?? []).length, 1, 'the brand mark is written once and remains readable in scrollback');
  const lastChecklistFrame = scrolled.stdout.lastIndexOf('Esc cancel');
  assert.notEqual(lastChecklistFrame, -1, 'the reopened repository checklist was actually rendered');
  const scrolledScreen = terminalScreen(scrolled.stdout.slice(0, lastChecklistFrame + 'Esc cancel'.length), { rows: 18, columns: 50 });
  assert.equal(scrolledScreen.filter((line) => line.trim() === 'Select product repositories').length, 1, `the reopened checklist title occupies its own visible row:\n${scrolledScreen.join('\n')}`);
  assert.ok(scrolledScreen.some((line) => line.includes('› [x] ./product')), `the selected repository remains legible:\n${scrolledScreen.join('\n')}`);
  assert.match(scrolled.stdout, /worktree mapping/, 'the preceding text question remains intact in the PTY transcript');
  assert.deepEqual(await treeSnapshot(scrollRepo), scrollBefore, 'Back/Escape leave the repository unchanged');
}

async function saveTranscript(name, result) {
  const directory = process.env.TRIAD_SETUP_TRANSCRIPT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const transcript = result.stdout
    .replaceAll(fixture, '<temporary-fixture>')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '');
  await writeFile(path.join(directory, `${name}.txt`), transcript);
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
    // one direct-child Git repository, and a real two-harness keyboard selection.
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
    git(sampleApp, ['branch', '-m', 'develop']);
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
      line(''), line(''), key('space'), key('enter'),
      line('ketchup2'), line(''), line(''), line(''),
      key('down'), key('space'), key('up'), key('space'), key('enter'),
      key('space'), key('enter'), line('install'),
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
    await saveTranscript('single-tty-two-harness-first-install', setup);
    const realRoot = await realpath(root);
    assert.ok(setup.stdout.includes(`Control Workspace (open this path): ${realRoot}`), setup.stdout);
    assert.match(setup.stdout, /Triad\+ setup completed\./);
    assert.match(setup.stdout, /Select product repositories/);
    assert.match(setup.stdout, /current branch develop/);
    assert.match(setup.stdout, /Only immediate-child Git roots are suggested/);
    assert.match(setup.stdout, /Select coding harnesses/);
    assert.match(setup.stdout, /primary OpenCode \(opencode\)/);
    assert.doesNotMatch(setup.stdout, /repo-1/);
    assert.match(setup.stdout, /Attempt-bound multi-harness dispatch remains unsupported/);
    assert.match(setup.stdout, /Optional; only exact files shown in the final preview can be installed/);
    assert.ok(setup.stdout.includes(`CREATE ${path.join(codexHome, 'skills', 'triad', 'SKILL.md')}`), 'the final preview names the exact absolute Codex-native skill path');
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
    assert.match(projectYaml, /id: "ketchup2"/, 'stable repo ID comes from the selected repository rather than a generic placeholder');
    assert.match(projectYaml, /path: "\.\/sample-app"/, 'the direct child repository mapping is explicit');
    assert.match(projectYaml, /base_branch: "develop"/, 'the observed branch becomes the base suggestion');
    assert.match(projectYaml, /project_branch: "triad\/ketchup2-feature"/);
    assert.match(projectYaml, /worktree: "\.\/worktrees\/ketchup2-feature"/);
    const controlGit = run('git', ['-C', root, 'rev-parse', '--show-toplevel'], root);
    assert.notEqual(controlGit.status, 0, 'Control Workspace stays non-Git');
    const manifestPath = path.join(root, '.triad-plus', 'installation.json');
    const multi = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateInstallationManifest(multi);
    assert.equal(multi.schema_version, 2);
    const adapters = listAdapters();
    const registryIds = adapters.map((adapter) => adapter.id).sort();
    const selectedIds = ['opencode', 'codex'];
    assert.deepEqual(registryIds, ['antigravity', 'claude-code', 'codex', 'copilot', 'hermes', 'opencode']);
    for (const adapter of adapters) assert.ok(setup.stdout.includes(`${adapter.label} (${adapter.id})`), `${adapter.id} is present in the six-adapter keyboard screen`);
    assert.match(setup.stdout, /Initial runtime metadata: opencode writes/);
    const recordedIds = multi.adapters.map((adapter) => adapter.id);
    assert.deepEqual(recordedIds, [...selectedIds].sort(), 'exactly the selected harness memberships are recorded once');
    assert.equal(new Set(multi.adapters.map((adapter) => adapter.id)).size, selectedIds.length, 'adapter membership contains no duplicates');
    assert.equal(await readFile(path.join(root, '.triad-runtime', 'adapter.json'), 'utf8').then((text) => JSON.parse(text).id), 'opencode', 'the first selected adapter retains the singleton runtime metadata');
    for (const adapter of adapters.filter((candidate) => selectedIds.includes(candidate.id))) {
      const record = multi.adapters.find((entry) => entry.id === adapter.id);
      assert.deepEqual(record.scopes, { project: true, global: adapter.id === 'codex' }, `${adapter.id} records only the explicitly selected global entry scope`);
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
    const codexGlobalEntry = path.join(codexHome, 'skills', 'triad', 'SKILL.md');
    const codexPreflight = path.join(codexHome, 'triad-plus', 'host-entry-preflight.mjs');
    const bindingKey = digest(Buffer.from(await realpath(root)));
    const codexBinding = path.join(codexHome, 'triad-plus', 'bindings', `${bindingKey}.json`);
    assert.ok((await readFile(codexGlobalEntry, 'utf8')).includes('host-entry-preflight.mjs'));
    assert.ok(setup.stdout.includes(`CREATE ${codexPreflight}`), 'the exact installed trusted preflight path is included in the preview');
    assert.ok(setup.stdout.includes(`CREATE ${codexBinding}`), 'the exact workspace-specific owner binding path is included in the preview');
    const globalFiles = await filesUnder(codexHome);
    assert.deepEqual(globalFiles, [
      'skills/triad/SKILL.md',
      `triad-plus/bindings/${bindingKey}.json`,
      'triad-plus/host-entry-preflight.mjs',
    ].sort(), 'the approved Codex skill, trusted preflight and exact workspace binding are the only global files installed');
    const codexRecord = multi.adapters.find((record) => record.id === 'codex');
    const codexGlobalAssets = codexRecord.managed_assets.filter((asset) => asset.scope === 'global');
    assert.deepEqual(codexGlobalAssets.map((asset) => asset.path).sort(), [codexBinding, codexPreflight, codexGlobalEntry].sort(), 'manifest records every exact trusted global file');
    const binding = JSON.parse(await readFile(codexBinding, 'utf8'));
    assert.equal(binding.workspace, await realpath(root), 'the binding records the canonical owner-selected workspace');
    assert.deepEqual(binding.expected_project_assets, codexRecord.managed_assets
      .filter((asset) => asset.scope === 'project')
      .map(({ path: assetPath, kind, sha256 }) => ({ path: assetPath, kind, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)));
    for (const directory of [home, xdgHome, hermesHome, isolatedTmp]) {
      assert.deepEqual(await filesUnder(directory), [], `local-only setup wrote no global files under ${directory}`);
    }
    const isolatedHostEnv = { HOME: home, XDG_CONFIG_HOME: xdgHome, CODEX_HOME: codexHome, HERMES_HOME: hermesHome, PATH: hostlessPath };
    const fixtureBeforeDiagnostics = await treeSnapshot(fixture);
    const list = runCli(['adapter', 'list', '--control', root], root, isolatedHostEnv);
    assert.equal(list.status, 0, `${list.stderr}\n${list.stdout}`);
    for (const id of recordedIds) assert.match(list.stdout, new RegExp(`${id}\\s+project=installed global=${id === 'codex' ? 'installed' : 'not_configured'} host=unavailable`), `${id} records the selected global entry separately from host availability`);
    assert.deepEqual(await treeSnapshot(fixture), fixtureBeforeDiagnostics, 'adapter list and isolated global locations are read-only');
    const manifestBytesBeforeDoctor = await readFile(manifestPath);
    const doctor = runCli(['adapter', 'doctor', '--control', root], root, isolatedHostEnv);
    assert.equal(doctor.status, 0, `${doctor.stderr}\n${doctor.stdout}`);
    assert.match(doctor.stdout, /attempt dispatch=unsupported/);
    assert.match(doctor.stdout, /host=unavailable/);
    assert.deepEqual(await readFile(manifestPath), manifestBytesBeforeDoctor, 'adapter doctor is read-only');
    assert.deepEqual(await treeSnapshot(fixture), fixtureBeforeDiagnostics, 'adapter doctor and isolated global locations leave all fixture files unchanged');

    // The managed-block regression must come from a real first-run wizard
    // install, with Codex primary, the optional global entry, and READY inputs.
    const managedRoot = path.join(fixture, 'MANAGED-BLOCK-FIRST-RUN');
    const managedHome = path.join(fixture, 'managed-home');
    const managedCodexHome = path.join(fixture, 'managed-codex-home');
    const managedHostlessPath = path.join(fixture, 'managed-hostless-bin');
    await mkdir(managedRoot, { recursive: true });
    for (const directory of [managedHome, managedCodexHome, managedHostlessPath]) await mkdir(directory, { recursive: true });
    for (const command of ['git', 'python3']) {
      const executable = spawnSync('which', [command], { encoding: 'utf8' });
      assert.equal(executable.status, 0, `the local ${command} fixture executable is available`);
      await symlink(executable.stdout.trim(), path.join(managedHostlessPath, command));
    }
    await writeFile(path.join(managedRoot, 'PRD.md'), '# Managed block first-run fixture\n');
    await mkdir(path.join(managedRoot, '.loop'), { recursive: true });
    await writeFile(path.join(managedRoot, '.loop', 'quality-gates.yaml'), [
      'version: 2',
      'gates:',
      '  - id: required-fixture-check',
      '    command: true',
      '    required: true',
      '    executor: control-plane',
      '    timeout_seconds: 2',
      '',
    ].join('\n'));
    const managedTeamBytes = Buffer.from(`${JSON.stringify(teamConfiguration(), null, 2)}\n`);
    await mkdir(path.join(managedRoot, '.triad-plus'), { recursive: true });
    await writeFile(path.join(managedRoot, '.triad-plus', 'team.json'), managedTeamBytes);
    const managedRepo = path.join(managedRoot, 'product');
    await makeRepo(managedRepo, 'managed block product fixture\n');
    const managedWorktree = path.join(managedRoot, 'worktrees', 'product-feature');
    await mkdir(path.dirname(managedWorktree), { recursive: true });
    git(managedRepo, ['worktree', 'add', '-b', 'triad/product-feature', managedWorktree, 'main']);
    const managedAnswers = [
      line(''), line(''), key('space'), key('enter'), line('product'), line(''), line(''), line(''),
      key('space'), key('enter'), key('space'), key('enter'), line('install'),
    ];
    const managedSetup = terminalInput(managedRoot, managedAnswers, {
      HOME: managedHome,
      CODEX_HOME: managedCodexHome,
      PATH: managedHostlessPath,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    assert.equal(managedSetup.status, 0, `${managedSetup.stderr}\n${managedSetup.stdout}`);
    assert.match(managedSetup.stdout, /primary Codex \(codex\)/);
    assert.match(managedSetup.stdout, /Readiness: READY/);
    assert.ok(managedSetup.stdout.includes(`CREATE ${path.join(managedCodexHome, 'skills', 'triad', 'SKILL.md')}`), 'the wizard approved the optional Codex global skill');
    assert.deepEqual(await readFile(path.join(managedRoot, '.triad-plus', 'team.json')), managedTeamBytes, 'the first-run wizard preserves the configured team');
    const managedManifestPath = path.join(managedRoot, '.triad-plus', 'installation.json');
    const managedManifestBytes = await readFile(managedManifestPath);
    const managedManifest = JSON.parse(managedManifestBytes);
    validateInstallationManifest(managedManifest);
    const managedCodexRecord = managedManifest.adapters.find((record) => record.id === 'codex');
    assert.equal(managedCodexRecord.managed_assets.find((asset) => asset.scope === 'project' && asset.path === 'AGENTS.md')?.kind, 'managed_block');
    const managedAgentsPath = path.join(managedRoot, 'AGENTS.md');
    const startMarker = '<!-- triad-plus:managed-instructions:start -->';
    const endMarker = '<!-- triad-plus:managed-instructions:end -->';
    const managedAgentsBytes = await readFile(managedAgentsPath);
    const managedEntryPath = path.join(managedRoot, '.triad-runtime', 'triad-host-entry.mjs');
    const managedEntryBytes = await readFile(managedEntryPath);
    const managedPreflight = path.join(managedCodexHome, 'triad-plus', 'host-entry-preflight.mjs');
    const managedBindingKey = digest(Buffer.from(await realpath(managedRoot)));
    const managedBindingPath = path.join(managedCodexHome, 'triad-plus', 'bindings', `${managedBindingKey}.json`);
    const managedBindingBytes = await readFile(managedBindingPath);
    const managedRuntimeEnv = {
      HOME: managedHome,
      CODEX_HOME: managedCodexHome,
      PATH: managedHostlessPath,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const runManagedPreflight = () => run(process.execPath, [managedPreflight, '--adapter', 'codex'], managedRoot, managedRuntimeEnv);
    const runManagedEntry = () => run(process.execPath, [managedEntryPath, '--adapter', 'codex'], managedRoot, managedRuntimeEnv);
    const assertManagedReady = (label) => {
      const preflight = runManagedPreflight();
      assert.equal(preflight.status, 0, `${label}: ${preflight.stderr}\n${preflight.stdout}`);
      assert.match(preflight.stdout, /READY: codex Triad\+ workspace validated/);
      const entry = runManagedEntry();
      assert.equal(entry.status, 0, `${label}: ${entry.stderr}\n${entry.stdout}`);
      assert.match(entry.stdout, /READY: codex Triad\+ workspace validated/);
    };
    const assertManagedBlocked = (label) => {
      const preflight = runManagedPreflight();
      assert.equal(preflight.status, 2, `${label}: ${preflight.stderr}\n${preflight.stdout}`);
      assert.match(preflight.stderr, /BLOCKED: Triad not started/);
      const entry = runManagedEntry();
      assert.equal(entry.status, 2, `${label}: ${entry.stderr}\n${entry.stdout}`);
      assert.match(`${entry.stderr}\n${entry.stdout}`, /BLOCKED: Triad not started/);
    };
    assertManagedReady('fresh first-run wizard install validates READY');

    const ownerEditedAgents = Buffer.concat([
      Buffer.from('# Owner-authored header remains outside the managed block.\n\n'),
      managedAgentsBytes,
      Buffer.from('\n## Owner-authored footer remains outside the managed block.\n'),
    ]);
    await writeFile(managedAgentsPath, ownerEditedAgents);
    assertManagedReady('owner edits outside the managed block stay READY');
    const changedInsideBlock = Buffer.from(ownerEditedAgents.toString('utf8').replace('## Triad+ role-run overlay', '## Altered managed overlay'));
    await writeFile(managedAgentsPath, changedInsideBlock);
    assertManagedBlocked('a modified managed block is BLOCKED');

    await writeFile(managedAgentsPath, Buffer.concat([ownerEditedAgents, Buffer.from(`\n${startMarker}\n`)]));
    assertManagedBlocked('duplicate markers are BLOCKED');
    await writeFile(managedAgentsPath, Buffer.from(ownerEditedAgents.toString('utf8').replace(endMarker, '<!-- removed managed end -->')));
    assertManagedBlocked('a missing marker is BLOCKED');
    const malformedMarkers = ownerEditedAgents.toString('utf8')
      .replace(startMarker, '<!-- temporary marker -->')
      .replace(endMarker, startMarker)
      .replace('<!-- temporary marker -->', endMarker);
    await writeFile(managedAgentsPath, malformedMarkers);
    assertManagedBlocked('out-of-order markers are BLOCKED');
    await writeFile(managedAgentsPath, ownerEditedAgents);

    const managedSentinel = path.join(fixture, 'untrusted-managed-validator-ran.txt');
    await writeFile(managedEntryPath, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(managedSentinel)}, 'executed');\n`);
    const alteredMarkerManifest = JSON.parse(managedManifestBytes);
    alteredMarkerManifest.adapters.find((record) => record.id === 'codex')
      .managed_assets.find((asset) => asset.scope === 'project' && asset.path === 'AGENTS.md').start_marker = '<!-- attacker:start -->';
    await writeInstallationManifest(managedRoot, buildMultiAdapterManifest({
      triadVersion: alteredMarkerManifest.triad_version,
      installedAt: alteredMarkerManifest.installed_at,
      updatedAt: new Date().toISOString(),
      adapters: alteredMarkerManifest.adapters,
    }));
    const alteredMarkerPreflight = runManagedPreflight();
    assert.equal(alteredMarkerPreflight.status, 2, `${alteredMarkerPreflight.stderr}\n${alteredMarkerPreflight.stdout}`);
    assert.match(alteredMarkerPreflight.stderr, /canonical AGENTS\.md marker contract/);
    assert.equal(await readFile(managedSentinel).then(() => true, () => false), false, 'a changed manifest marker definition cannot load local validator code');
    await writeFile(managedManifestPath, managedManifestBytes);

    const alteredBinding = JSON.parse(managedBindingBytes);
    alteredBinding.expected_project_assets.find((asset) => asset.path === 'AGENTS.md').start_marker = '<!-- attacker:start -->';
    await writeFile(managedBindingPath, `${JSON.stringify(alteredBinding, null, 2)}\n`);
    const alteredBindingPreflight = runManagedPreflight();
    assert.equal(alteredBindingPreflight.status, 2, `${alteredBindingPreflight.stderr}\n${alteredBindingPreflight.stdout}`);
    assert.match(alteredBindingPreflight.stderr, /canonical AGENTS\.md marker contract/);
    assert.equal(await readFile(managedSentinel).then(() => true, () => false), false, 'a changed owner-binding marker definition cannot load local validator code');
    await writeFile(managedBindingPath, managedBindingBytes);

    const alteredBindingHash = JSON.parse(managedBindingBytes);
    alteredBindingHash.expected_project_assets.find((asset) => asset.path === 'AGENTS.md').sha256 = digest(ownerEditedAgents);
    await writeFile(managedBindingPath, `${JSON.stringify(alteredBindingHash, null, 2)}\n`);
    const alteredBindingHashPreflight = runManagedPreflight();
    assert.equal(alteredBindingHashPreflight.status, 2, `${alteredBindingHashPreflight.stderr}\n${alteredBindingHashPreflight.stdout}`);
    assert.match(alteredBindingHashPreflight.stderr, /project-managed asset list differs from the owner-bound manifest/);
    assert.equal(await readFile(managedSentinel).then(() => true, () => false), false, 'a changed owner-binding hash cannot load local validator code');
    await writeFile(managedBindingPath, managedBindingBytes);

    const alteredHashManifest = JSON.parse(managedManifestBytes);
    const agentsAsset = alteredHashManifest.adapters.find((record) => record.id === 'codex')
      .managed_assets.find((asset) => asset.scope === 'project' && asset.path === 'AGENTS.md');
    agentsAsset.sha256 = digest(ownerEditedAgents);
    await writeInstallationManifest(managedRoot, buildMultiAdapterManifest({
      triadVersion: alteredHashManifest.triad_version,
      installedAt: alteredHashManifest.installed_at,
      updatedAt: new Date().toISOString(),
      adapters: alteredHashManifest.adapters,
    }));
    const alteredHashPreflight = runManagedPreflight();
    assert.equal(alteredHashPreflight.status, 2, `${alteredHashPreflight.stderr}\n${alteredHashPreflight.stdout}`);
    assert.match(alteredHashPreflight.stderr, /project-managed asset list differs from the owner-bound manifest/);
    assert.equal(await readFile(managedSentinel).then(() => true, () => false), false, 'a changed managed-block hash cannot load local validator code');
    await writeFile(managedEntryPath, managedEntryBytes);
    await writeFile(managedManifestPath, managedManifestBytes);
    await writeFile(managedAgentsPath, managedAgentsBytes);
    assertManagedReady('restored wizard-generated install remains READY');

    // Selecting a global entry is still only a plan: cancelling the exact
    // final preview must leave both local and user-level files untouched.
    const cancelRoot = path.join(fixture, 'GLOBAL-CANCEL-CONTROL');
    const cancelRepo = path.join(cancelRoot, 'product');
    const cancelCodexHome = path.join(fixture, 'codex-cancel-home');
    await mkdir(cancelRoot);
    await mkdir(cancelCodexHome);
    await makeRepo(cancelRepo, 'cancel fixture product state\n');
    const globalCancel = terminalInput(cancelRoot, [
      line(''), line(''), key('space'), key('enter'),
      line(''), line(''), line(''), line(''),
      key('space'), key('enter'), key('space'), key('enter'), line('n'), line('cancel'),
    ], { HOME: path.join(fixture, 'home-global-cancel'), CODEX_HOME: cancelCodexHome });
    assert.equal(globalCancel.status, 0, `${globalCancel.stderr}\n${globalCancel.stdout}`);
    assert.match(globalCancel.stdout, /CREATE .*skills[/\\]triad[/\\]SKILL\.md/);
    assert.match(globalCancel.stdout, /Cancelled\. No files were changed\./);
    assert.deepEqual(await filesUnder(cancelCodexHome), [], 'final-preview cancellation creates no global file');
    assert.equal(await readFile(path.join(cancelRoot, '.triad-plus', 'installation.json')).then(() => true, () => false), false);
    assert.equal(await readFile(path.join(cancelRoot, 'project.yaml')).then(() => true, () => false), false);

    // A different pre-existing global command is a preflight conflict and the
    // wizard must preserve it without creating any local workspace assets.
    const collisionBridgeRoot = path.join(fixture, 'GLOBAL-COLLISION-CONTROL');
    const collisionBridgeRepo = path.join(collisionBridgeRoot, 'product');
    const collisionCodexHome = path.join(fixture, 'codex-collision-home');
    const collisionBridgeEntry = path.join(collisionCodexHome, 'skills', 'triad', 'SKILL.md');
    const collisionBridgeBytes = '# Owner managed Codex skill\n';
    await mkdir(collisionBridgeRoot);
    await mkdir(path.dirname(collisionBridgeEntry), { recursive: true });
    await makeRepo(collisionBridgeRepo, 'collision fixture product state\n');
    await writeFile(collisionBridgeEntry, collisionBridgeBytes);
    const globalCollision = terminalInput(collisionBridgeRoot, [
      line(''), line(''), key('space'), key('enter'),
      line(''), line(''), line(''), line(''),
      key('space'), key('enter'), key('space'), key('enter'), line('n'),
    ], { HOME: path.join(fixture, 'home-global-collision'), CODEX_HOME: collisionCodexHome });
    assert.equal(globalCollision.status, 0, `${globalCollision.stderr}\n${globalCollision.stdout}`);
    assert.match(globalCollision.stdout, /Global entry collision; existing bytes differ, no files were changed/);
    assert.equal(await readFile(collisionBridgeEntry, 'utf8'), collisionBridgeBytes, 'pre-existing global owner file remains byte-identical');
    assert.equal(await readFile(path.join(collisionBridgeRoot, '.triad-plus', 'installation.json')).then(() => true, () => false), false);
    assert.equal(await readFile(path.join(collisionBridgeRoot, 'project.yaml')).then(() => true, () => false), false);

    // A legacy same-name prompt is not migrated, replaced, or deleted. The
    // owner gets an explicit collision report before any workspace files are
    // installed and can back up the old prompt or skip the native entry.
    const legacyPromptRoot = path.join(fixture, 'GLOBAL-LEGACY-PROMPT-COLLISION');
    const legacyPromptRepo = path.join(legacyPromptRoot, 'product');
    const legacyCodexHome = path.join(fixture, 'codex-legacy-prompt-home');
    const legacyPromptPath = path.join(legacyCodexHome, 'prompts', 'triad.md');
    const legacyPromptBytes = '# Existing owner-authored Codex prompt; preserve exactly.\n';
    await mkdir(legacyPromptRoot);
    await mkdir(path.dirname(legacyPromptPath), { recursive: true });
    await makeRepo(legacyPromptRepo, 'legacy prompt collision fixture\n');
    await writeFile(legacyPromptPath, legacyPromptBytes);
    const legacyPromptCollision = terminalInput(legacyPromptRoot, [
      line(''), line(''), key('space'), key('enter'),
      line(''), line(''), line(''), line(''),
      key('space'), key('enter'), key('space'), key('enter'), line('n'),
    ], { HOME: path.join(fixture, 'home-legacy-prompt'), CODEX_HOME: legacyCodexHome });
    assert.equal(legacyPromptCollision.status, 0, `${legacyPromptCollision.stderr}\n${legacyPromptCollision.stdout}`);
    await saveTranscript('legacy-codex-prompt-collision', legacyPromptCollision);
    assert.match(legacyPromptCollision.stdout, /Legacy Codex prompt collision/);
    assert.match(legacyPromptCollision.stdout, /preserved byte-for-byte and is not migrated or deleted/);
    assert.match(legacyPromptCollision.stdout, /No files were changed/);
    assert.equal(await readFile(legacyPromptPath, 'utf8'), legacyPromptBytes, 'legacy prompt remains byte-identical');
    assert.equal(await readFile(path.join(legacyCodexHome, 'skills/triad/SKILL.md')).then(() => true, () => false), false, 'native skill is not installed alongside a colliding legacy prompt');
    assert.equal(await readFile(path.join(legacyPromptRoot, '.triad-plus/installation.json')).then(() => true, () => false), false, 'legacy collision writes no installation manifest');

    // A different file appearing after the preview is never overwritten.
    const raceRoot = path.join(fixture, 'GLOBAL-RACE-CONTROL');
    const raceRepo = path.join(raceRoot, 'product');
    const raceCodexHome = path.join(fixture, 'codex-race-home');
    const raceGlobalEntry = path.join(raceCodexHome, 'skills', 'triad', 'SKILL.md');
    await mkdir(raceRoot);
    await mkdir(raceCodexHome);
    await makeRepo(raceRepo, 'race fixture product state\n');
    const globalRace = terminalInput(raceRoot, [
      line(''), line(''), key('space'), key('enter'),
      line(''), line(''), line(''), line(''),
      key('space'), key('enter'), key('space'), key('enter'), line('n'), line('install'),
    ], {
      HOME: path.join(fixture, 'home-global-race'),
      CODEX_HOME: raceCodexHome,
      TRIAD_TEST_INJECT_CONFLICT: raceGlobalEntry,
    });
    assert.equal(globalRace.status, 2, `${globalRace.stderr}\n${globalRace.stdout}`);
    assert.match(`${globalRace.stdout}\n${globalRace.stderr}`, /Global entry (?:changed|appeared) after preview.*refusing to overwrite/);
    assert.equal(await readFile(raceGlobalEntry, 'utf8'), 'introduced after preview\n', 'late owner content remains untouched');
    const raceManifest = JSON.parse(await readFile(path.join(raceRoot, '.triad-plus', 'installation.json'), 'utf8'));
    assert.equal(raceManifest.scopes.global, false, 'an unapproved or conflicting global file is never claimed by the local manifest');

    // Direct global init is blocked so it cannot bypass exact-path consent.
    const secondWorkspace = path.join(fixture, 'SECOND-CONTROL-WORKSPACE');
    await mkdir(secondWorkspace);
    const bypass = runCli(['init', '--host', 'codex', '--control', secondWorkspace, '--global'], secondWorkspace, isolatedHostEnv);
    assert.equal(bypass.status, 2, `${bypass.stderr}\n${bypass.stdout}`);
    assert.match(bypass.stderr, /only through the interactive setup wizard/);
    assert.equal(await readFile(path.join(secondWorkspace, '.triad-plus', 'installation.json')).then(() => true, () => false), false);
    assert.equal(await readFile(codexGlobalEntry, 'utf8'), await readFile(path.join(repositoryRoot, 'adapters/codex/skills/triad/SKILL.md'), 'utf8'), 'blocked direct init leaves the approved global skill unchanged');

    // A Codex user profile is shared: the wizard may reuse only byte-identical
    // global files in a second Control Workspace, then removal of that local
    // adapter must preserve the global file for the first workspace.
    const secondRepo = path.join(secondWorkspace, 'product');
    await makeRepo(secondRepo, 'second workspace fixture stays in temp storage\n');
    const firstBindingBeforeSecondInstall = await readFile(codexBinding);
    const secondInstall = terminalInput(secondWorkspace, [
      line(''), line(''), key('space'), key('enter'),
      line(''), line(''), line(''), line(''),
      key('space'), key('enter'), key('space'), key('enter'), line('n'), line('install'),
    ], isolatedHostEnv);
    assert.equal(secondInstall.status, 0, `${secondInstall.stderr}\n${secondInstall.stdout}`);
    assert.match(secondInstall.stdout, /REUSE identical .*skills[/\\]triad[/\\]SKILL\.md/);
    assert.match(secondInstall.stdout, /Triad\+ setup completed\./);
    const secondBindingKey = digest(Buffer.from(await realpath(secondWorkspace)));
    const secondBinding = path.join(codexHome, 'triad-plus', 'bindings', `${secondBindingKey}.json`);
    assert.notEqual(secondBinding, codexBinding, 'each approved workspace receives its own owner-binding target');
    assert.ok(secondInstall.stdout.includes(`CREATE ${secondBinding}`), 'second workspace consent preview names its own exact binding file');
    assert.deepEqual(await readFile(codexBinding), firstBindingBeforeSecondInstall, 'adding a workspace leaves the first workspace binding byte-identical');
    assert.equal(await readFile(codexGlobalEntry, 'utf8'), await readFile(path.join(repositoryRoot, 'adapters/codex/skills/triad/SKILL.md'), 'utf8'));
    const secondPreflight = run(process.execPath, [path.join(codexHome, 'triad-plus/host-entry-preflight.mjs'), '--adapter', 'codex'], secondWorkspace, isolatedHostEnv);
    assert.equal(secondPreflight.status, 2, 'incomplete second workspace is rejected by its local validator after binding succeeds');
    assert.match(secondPreflight.stderr, /BLOCKED: Triad not started/);
    assert.doesNotMatch(secondPreflight.stderr, /owner-bound Control Workspace/, 'second workspace resolves its separate binding rather than inheriting the first');
    const removeSecond = runCli(['adapter', 'remove', 'codex', '--control', secondWorkspace, '--apply'], secondWorkspace, isolatedHostEnv);
    assert.equal(removeSecond.status, 0, `${removeSecond.stderr}\n${removeSecond.stdout}`);
    assert.match(removeSecond.stdout, /Global entry files are preserved/);
    assert.equal(await readFile(codexGlobalEntry, 'utf8'), await readFile(path.join(repositoryRoot, 'adapters/codex/skills/triad/SKILL.md'), 'utf8'), 'removing one workspace never removes the shared global skill');
    const firstAfterSecondRemoval = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(firstAfterSecondRemoval.adapters.find((record) => record.id === 'codex').scope_status.global, 'installed', 'the other workspace retains its valid global owner record');

    // Screen A/B: multi-select two colliding slugs, visit Back, and verify both
    // repository and harness selections survive the round trip before cancel.
    const multiRoot = path.join(fixture, 'MULTI-REPOSITORIES');
    await mkdir(multiRoot);
    const firstSlugRepo = path.join(multiRoot, 'a-app');
    const secondSlugRepo = path.join(multiRoot, 'a_app');
    await makeRepo(firstSlugRepo, 'first repository remains untouched\n');
    await makeRepo(secondSlugRepo, 'second repository remains untouched\n');
    const firstSlugBefore = await treeSnapshot(firstSlugRepo);
    const secondSlugBefore = await treeSnapshot(secondSlugRepo);
    const multiAnswers = [
      line(''), line(''), key('enter'), // zero selection is diagnosed, not defaulted
      key('down'), key('space'), key('up'), key('space'), key('enter'), // a_app first, then a-app
      line(''), line(''), line(''), line(''), line(''), line(''), line(''), line(''),
      key('down'), key('space'), key('up'), key('space'), key('escape'), // OpenCode primary, Codex second; back
      key('enter'), // both repositories remain checked
      line(''), line(''), line(''), line(''), line(''), line(''), line(''), line(''),
      key('enter'), key('enter'), line('n'), line('cancel'), // both adapters remain checked; skip global files and cancel exact plan
    ];
    const multiSelection = terminalInput(multiRoot, multiAnswers, { HOME: path.join(fixture, 'home-multi') });
    assert.equal(multiSelection.status, 0, `${multiSelection.stderr}\n${multiSelection.stdout}`);
    assert.match(multiSelection.stdout, /Select at least 1 items|Select a row with Space/);
    assert.match(multiSelection.stdout, /primary OpenCode \(opencode\)/);
    assert.match(multiSelection.stdout, /a-app-2: \.\/a_app/);
    assert.match(multiSelection.stdout, /a-app: \.\/a-app/);
    assert.match(multiSelection.stdout, /Cancelled\. No files were changed\./);
    assert.equal(await readFile(path.join(multiRoot, 'project.yaml')).then(() => true, () => false), false);
    assert.equal(await readFile(path.join(multiRoot, '.triad-plus', 'installation.json')).then(() => true, () => false), false);
    assert.deepEqual(await treeSnapshot(firstSlugRepo), firstSlugBefore, 'both source repositories remain byte-identical after Back/Cancel');
    assert.deepEqual(await treeSnapshot(secondSlugRepo), secondSlugBefore, 'both source repositories remain byte-identical after Back/Cancel');

    // Zero suggested children still permits an explicit custom external Git root.
    const customRoot = path.join(fixture, 'CUSTOM-PATH-CONTROL');
    await mkdir(customRoot);
    const externalRepo = path.join(fixture, 'EXPLICIT-EXTERNAL-REPOSITORY');
    await makeRepo(externalRepo, 'external repository stays untouched\n');
    git(externalRepo, ['branch', '-m', 'develop']);
    const externalBefore = await treeSnapshot(externalRepo);
    const customPathRun = terminalInput(customRoot, [
      line(''), line(''), key('enter'), line(externalRepo), key('enter'),
      line(''), line(''), line(''), line(''), key('down'), key('space'), key('enter'), line('n'), line('cancel'),
    ], { HOME: path.join(fixture, 'home-custom-path') });
    assert.equal(customPathRun.status, 0, `${customPathRun.stderr}\n${customPathRun.stdout}`);
    assert.match(customPathRun.stdout, /Add repository by path/);
    assert.ok(customPathRun.stdout.includes(externalRepo), customPathRun.stdout);
    assert.match(customPathRun.stdout, /external-repository/);
    assert.match(customPathRun.stdout, /Cancelled\. No files were changed\./);
    assert.deepEqual(await treeSnapshot(externalRepo), externalBefore, 'custom external repository stays unchanged before exact approval');
    assert.equal(await readFile(path.join(customRoot, 'project.yaml')).then(() => true, () => false), false);

    // Ctrl+C from the raw checklist restores the terminal and exits without mutation.
    const interruptRoot = path.join(fixture, 'INTERRUPT');
    await mkdir(interruptRoot);
    const interruptRepo = path.join(interruptRoot, 'product');
    await makeRepo(interruptRepo, 'interrupt fixture remains untouched\n');
    const interruptBefore = await treeSnapshot(interruptRepo);
    const interrupted = terminalInput(interruptRoot, [line(''), line(''), key('ctrl-c')], { HOME: path.join(fixture, 'home-interrupt') });
    assert.equal(interrupted.status, 130, `${interrupted.stderr}\n${interrupted.stdout}`);
    assert.match(interrupted.stdout, /Cancelled by Ctrl\+C\. No workspace or repository changes were applied\./);
    assert.deepEqual(await treeSnapshot(interruptRepo), interruptBefore, 'Ctrl+C leaves source repository bytes unchanged');
    assert.equal(await readFile(path.join(interruptRoot, 'project.yaml')).then(() => true, () => false), false);
    assert.equal(await readFile(path.join(interruptRoot, '.triad-plus', 'installation.json')).then(() => true, () => false), false);

    // Narrow, monochrome dumb terminals use clipped plain text, including long repository paths.
    const narrowRoot = path.join(fixture, 'NARROW-CONTROL-WORKSPACE');
    await mkdir(narrowRoot);
    const longName = `product-${'long-segment-'.repeat(5)}repo`;
    const longRepo = path.join(narrowRoot, longName);
    await makeRepo(longRepo, 'long path fixture remains untouched\n');
    const narrow = terminalInput(narrowRoot, [line(''), line(''), key('escape')], {
      HOME: path.join(fixture, 'home-narrow'),
      TERM: 'dumb',
      NO_COLOR: '1',
      TRIAD_TEST_PTY_COLS: '36',
      TRIAD_TEST_PTY_ROWS: '12',
    });
    assert.equal(narrow.status, 0, `${narrow.stderr}\n${narrow.stdout}`);
    assert.doesNotMatch(narrow.stdout, /\u001b\[/, 'TERM=dumb and NO_COLOR stay readable without ANSI controls');
    assert.match(narrow.stdout, /TRIAD\+ \/ Engineering Loop/, 'short dumb terminals use a one-line identity fallback');
    assert.match(narrow.stdout, /…/, 'long paths are clipped to the terminal width');
    assert.match(narrow.stdout, /Cancelled\. No files were changed\./);
    assert.equal(await readFile(path.join(narrowRoot, 'project.yaml')).then(() => true, () => false), false);

    // NO_COLOR disables style codes independently of ANSI screen navigation.
    const noColorRoot = path.join(fixture, 'NO-COLOR-CONTROL-WORKSPACE');
    await mkdir(noColorRoot);
    const noColorRepo = path.join(noColorRoot, 'product');
    await makeRepo(noColorRepo, 'no-color fixture remains untouched\n');
    const noColor = terminalInput(noColorRoot, [line(''), line(''), key('down'), key('escape')], {
      HOME: path.join(fixture, 'home-no-color'),
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    });
    assert.equal(noColor.status, 0, `${noColor.stderr}\n${noColor.stdout}`);
    assert.match(noColor.stdout, /\r\u001b\[2K/, 'interactive navigation starts at the live prompt cursor and clears bounded rows');
    assert.match(noColor.stdout, /\u001b\[\d+A\r\u001b\[2K/, 'interactive redraw is anchored relative to its previous frame');
    assert.match(noColor.stdout, /ENGINEERING LOOP/, 'the colorless mark remains readable');
    assert.doesNotMatch(noColor.stdout, /\u001b\[2J/, 'redraw does not clear the display before painting');
    assert.doesNotMatch(noColor.stdout, /\u001b\[[0-9;]*m/, 'NO_COLOR suppresses all ANSI style codes including cleanup reset');
    assert.match(noColor.stdout, /Cancelled\. No files were changed\./);

    // Regression: a wrong repository path is corrected without restarting the wizard;
    // a later preflight failure can retry repository mapping in the same Control Workspace.
    const retryRoot = path.join(fixture, 'PATH-RECOVERY');
    await mkdir(retryRoot);
    await mkdir(path.join(fixture, 'home-path-recovery'));
    const retryRepo = path.join(retryRoot, 'ketchup2');
    await makeRepo(retryRepo, 'do not change product contents\n');
    const retryBefore = await treeSnapshot(retryRepo);
    const retryHead = git(retryRepo, ['rev-parse', 'HEAD']);
    const retryAnswers = [
      line(''), line(''), key('down'), key('enter'), line('./missing'), key('enter'), line('./ketchup2'), key('enter'),
      line(''), line(''), line('bad..branch'), line(''),
      line('y'), key('enter'), line(''), line(''), line('triad/ketchup2-feature'), line(''),
      key('space'), key('enter'), key('enter'), line('n'), line('install'),
    ];
    const retryRun = terminalInput(retryRoot, retryAnswers, {
      HOME: path.join(fixture, 'home-path-recovery'),
      CODEX_HOME: path.join(fixture, 'home-path-recovery', '.codex'),
    });
    assert.equal(retryRun.status, 0, retryRun.stderr + '\n' + retryRun.stdout);
    assert.match(retryRun.stdout, /Path was not added; no workspace changes were made:/);
    assert.match(retryRun.stdout, /Repository preflight failed; nothing was changed:/);
    assert.match(retryRun.stdout, /Correct repository mapping and retry from this workspace\?/);
    assert.match(retryRun.stdout, /Triad\+ setup completed\./);
    assert.match(await readFile(path.join(retryRoot, 'project.yaml'), 'utf8'), /path: "\.\/ketchup2"/);
    assert.equal(git(retryRepo, ['rev-parse', 'HEAD']), retryHead);
    assert.deepEqual(await treeSnapshot(retryRepo), retryBefore, 'product repository stays byte-identical');
    const missingControl = runCli(['init', '--host', 'opencode'], retryRoot);
    assert.equal(missingControl.status, 2);
    assert.match(missingControl.stderr, /Provide --control/);
    assert.match(missingControl.stderr, /npx triad-plus --help/);
    assert.doesNotMatch(missingControl.stderr, /Usage:/, 'parameter errors no longer dump the full help');

    // A04-A05: actual greenfield setup initializes local Git only after exact approval and reports missing readiness inputs.
    const greenRoot = path.join(fixture, 'GREENFIELD');
    await mkdir(greenRoot);
    const greenHome = path.join(fixture, 'home-green');
    await mkdir(greenHome);
    const greenAnswers = [
      line(''), line(''), key('down'), key('enter'), line('1'), line('sample-app'), line(''), line(''), line(''), line(''),
      key('space'), key('enter'), key('enter'), line('n'), line('install'),
    ];
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
    const blocked = terminalInput(appRoot, [line(''), line('')], { HOME: path.join(fixture, 'home-blocked') });
    assert.equal(blocked.status, 0, `${blocked.stderr}\n${blocked.stdout}`);
    await saveTranscript('git-root-boundary-cancel', blocked);
    assert.match(blocked.stdout, /belongs to Git root/);
    assert.match(blocked.stdout, /No sibling path will be generated/);
    assert.match(blocked.stdout, /Cancelled\. No files were changed\./);
    assert.equal(await readFile(path.join(appRoot, 'README.md'), 'utf8'), 'app source\n');
    assert.equal(await readFile(path.join(fixture, 'APP-ROOT-control', '.triad-plus', 'installation.json')).then(() => true, () => false), false);

    // A01: a not-yet-created root is previewed without making the directory; cancellation remains write-free.
    const missingRoot = path.join(await realpath(fixture), 'NEW-ROOT');
    const missingRootRun = terminalInput(fixture, [line(''), line('NEW-ROOT'), key('escape')], { HOME: path.join(fixture, 'home-missing-root') });
    assert.equal(missingRootRun.status, 0, `${missingRootRun.stderr}\n${missingRootRun.stdout}`);
    await saveTranscript('new-root-cancel', missingRootRun);
    assert.ok(missingRootRun.stdout.includes(`Control Workspace: ${missingRoot}`), missingRootRun.stdout);
    assert.match(missingRootRun.stdout, /Cancelled\. No files were changed\./);
    assert.equal(await stat(missingRoot).then(() => true, () => false), false);

    // A09: preflight collisions fail before project config, manifest, or owner assets are written.
    const collisionRoot = path.join(fixture, 'COLLISION');
    await mkdir(path.join(collisionRoot, '.opencode', 'commands'), { recursive: true });
    const ownerCommand = '# Owner command\n';
    await writeFile(path.join(collisionRoot, '.opencode', 'commands', 'triad.md'), ownerCommand);
    const collision = terminalInput(collisionRoot, [
      line(''), line(''), key('down'), key('down'), key('enter'), key('down'), key('space'), key('enter'), key('enter'), line('n'),
    ], { HOME: path.join(fixture, 'home-collision') });
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
    const partialAnswers = [
      line(''), line(''), key('down'), key('down'), key('enter'), key('down'), key('space'), key('up'), key('space'), key('enter'), key('enter'), line('n'), line('install'),
    ];
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
