import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repositoryRoot = new URL('..', import.meta.url).pathname;
const launcher = join(repositoryRoot, 'adapters/codex/run-role.mjs');

test('Codex launcher binds a configured profile in an isolated home and normalizes Reviewer output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triad-codex-role-launcher-'));
  const codexHome = join(root, 'codex-home');
  const profileRoot = join(codexHome, 'agents');
  await mkdir(profileRoot, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), 'model = "host-model"\nmodel_reasoning_effort = "max"\n');
  await writeFile(join(codexHome, 'auth.json'), '{"test_auth":true}\n');
  const profile = join(profileRoot, 'triad_reviewer.toml');
  const original = 'name = "triad_reviewer"\ndescription = "Reviewer"\ndeveloper_instructions = "Act as the independent Reviewer."\n';
  await writeFile(profile, original);
  const prompt = join(root, 'prompt.txt');
  await writeFile(prompt, 'Return the Reviewer result.');
  const observed = join(root, 'observed.json');
  const fake = join(root, 'fake-codex.mjs');
  const fakeSource = [
    "#!/usr/bin/env node",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const profile = process.argv[process.argv.indexOf('--profile') + 1];",
    "const home = process.env.CODEX_HOME;",
    `writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ profile, home, config: readFileSync(path.join(home, profile + '.config.toml'), 'utf8'), baseConfig: readFileSync(path.join(home, 'config.toml'), 'utf8'), auth: readFileSync(path.join(home, 'auth.json'), 'utf8') }));`,
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-test-thread' }));",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'TRIAD_REVIEW_RESULT: {\\\"decision\\\":\\\"blocked\\\"}' } }));",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'TRIAD_REVIEW_RESULT: {\\\"decision\\\":\\\"approved\\\"}' } }));",
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }));"
  ].join('\n');
  await writeFile(fake, fakeSource);
  await chmod(fake, 0o755);

  const result = spawnSync(process.execPath, [launcher, '--role', 'reviewer', '--cwd', root, '--prompt-file', prompt, '--profile-source', profile, '--codex', fake, '--model', 'test-model'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const observedValue = JSON.parse(await readFile(observed, 'utf8'));
  assert.equal(observedValue.profile, 'triad_reviewer');
  assert.equal(observedValue.config, original);
  assert.equal(observedValue.baseConfig, 'model = "host-model"\nmodel_reasoning_effort = "max"\n');
  assert.equal(observedValue.auth, '{"test_auth":true}\n');
  assert.match(result.stdout, /triad\.codex\.role_dispatch/);
  assert.match(result.stdout, /TRIAD_REVIEW_RESULT/);
  assert.match(result.stdout, /\\"decision\\":\\"approved\\"/);
  assert.equal(await readFile(profile, 'utf8'), original);
});

console.log('Codex role launcher contract: PASS');
