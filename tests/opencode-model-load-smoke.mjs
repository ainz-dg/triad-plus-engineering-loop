// Explicit local smoke only: no provider requests, credentials, or LLM activation.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const binary = process.env.TRIAD_OPENCODE_SMOKE_BIN;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set TRIAD_OPENCODE_SMOKE_BIN to an absolute, available OpenCode executable.');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'triad-model-load-')));
const cli = fileURLToPath(new URL('../bin/triad-plus.js', import.meta.url));
const env = {
  PATH: process.env.PATH,
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_STATE_HOME: path.join(root, 'state'),
  OPENCODE_CONFIG_DIR: path.join(root, 'config', 'opencode'),
  OPENCODE_DISABLE_FREE_MODELS: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  TERM: 'dumb',
};
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, `fixture command failed (exit ${result.status}); captured output was not emitted`);
  return result.stdout;
}
try {
  const roles = Object.fromEntries(['orchestrator', 'developer', 'reviewer', 'evaluator'].map((id) => [id, {
    displayName: id, model: 'gpt 6 luna medium', reasoning_effort: 'unknown effort', enabled: id !== 'evaluator',
  }]));
  const intent = `${JSON.stringify({ schema_version: 1, interaction: {}, roles }, null, 2)}\n`;
  const teamSource = path.join(root, 'intent.json');
  await writeFile(teamSource, intent);
  const control = path.join(root, 'control');
  run(process.execPath, [cli, 'init', '--host', 'opencode', '--control', control, '--team-config', teamSource]);
  const agent = path.join(control, '.opencode', 'agents', 'triad-orchestrator.md');
  await writeFile(agent, (await readFile(agent, 'utf8')).replace('---\n', '---\nmodel: "gpt 6 luna medium"\n'));
  const load = () => {
    // Native debug output can exceed the pipe flushed by this CLI's process exit.
    const outputPath = path.join(root, 'native-debug.json');
    const output = openSync(outputPath, 'w', 0o600);
    let result;
    try {
      result = spawnSync(binary, ['--pure', 'debug', 'agent', 'triad-orchestrator'], { cwd: control, env, stdio: ['ignore', output, 'pipe'], timeout: 15_000 });
    } finally { closeSync(output); }
    assert.equal(result.status, 0, 'native debug loader failed; captured output was not emitted');
    try { return JSON.parse(readFileSync(outputPath, 'utf8')); }
    catch { throw new Error('Native debug output was not complete JSON; captured output was not emitted.'); }
  };
  assert.deepEqual(load().model, { providerID: 'gpt 6 luna medium', modelID: '' }, 'native loader preserves the broken override');
  run(process.execPath, [cli, 'upgrade', '--host', 'opencode', '--control', control, '--apply']);
  assert.equal(load().model, undefined, 'native loader now inherits the host default');
  assert.equal(await readFile(path.join(control, '.triad-plus', 'team.json'), 'utf8'), intent);
  process.stdout.write('PASS: real OpenCode loader: legacy malformed override → managed upgrade → host default; intent unchanged. No LLM/loop execution tested.\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
