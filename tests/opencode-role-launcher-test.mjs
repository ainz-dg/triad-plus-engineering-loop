import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repositoryRoot = new URL('..', import.meta.url).pathname;
const launcher = join(repositoryRoot, 'adapters/opencode/run-role.mjs');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'triad-opencode-role-launcher-'));
  const control = join(root, 'control');
  const product = join(root, 'product');
  const profileRoot = join(control, '.opencode', 'agents');
  await mkdir(profileRoot, { recursive: true });
  await mkdir(product, { recursive: true });
  const profile = join(profileRoot, 'triad-developer.md');
  const original = await readFile(join(repositoryRoot, 'adapters/opencode/.opencode/agents/triad-developer.md'), 'utf8');
  await writeFile(profile, original);
  const prompt = join(control, 'prompt.txt');
  await writeFile(prompt, 'return the role marker');
  const observed = join(root, 'observed.json');
  const fake = join(root, 'fake-opencode.mjs');
  await writeFile(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[process.argv.indexOf('--dir') + 1];
const role = process.argv[process.argv.indexOf('--agent') + 1];
const configRoot = process.env.OPENCODE_CONFIG_DIR;
const separator = process.argv.indexOf('--');
const prompt = separator >= 0 ? process.argv.at(-1) : '';
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  dir,
  cwd: process.cwd(),
  configRoot,
  profile: readFileSync(path.join(configRoot, 'agents', role + '.md'), 'utf8').match(/^mode: .*$/m)[0],
  prompt,
}, null, 2));
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: 'ROLE_LAUNCH_OK' } }));
if (process.env.FAKE_OPENCODE_FAIL === '1') process.exit(17);
`);
  await chmod(fake, 0o755);
  return { control, product, profile, original, prompt, observed, fake };
}

test('OpenCode standalone launcher uses product cwd/dir, control config, and restores the managed profile', async () => {
  const { control, product, profile, original, prompt, observed, fake } = await fixture();
  const result = spawnSync(process.execPath, [launcher, '--role', 'developer', '--control', control, '--cwd', product, '--prompt-file', prompt, '--opencode', fake], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_CONFIG_DIR: join(control, 'wrong-user-config') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ROLE_LAUNCH_OK/);
  const dispatch = JSON.parse(await readFile(observed, 'utf8'));
  assert.equal(await realpath(dispatch.dir), await realpath(product));
  assert.equal(await realpath(dispatch.cwd), await realpath(product));
  assert.equal(await realpath(dispatch.configRoot), await realpath(join(control, '.opencode')));
  assert.equal(dispatch.profile, 'mode: primary');
  assert.match(dispatch.prompt, new RegExp(control.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')));
  assert.match(dispatch.prompt, /return the role marker/);
  assert.equal(await readFile(profile, 'utf8'), original);
  await assert.rejects(access(join(product, '.opencode')));
  await assert.rejects(access(join(product, '.triad-plus')));
});

test('OpenCode standalone launcher restores the managed profile after role and prompt failures', async () => {
  const roleFailure = await fixture();
  const failed = spawnSync(process.execPath, [launcher, '--role', 'developer', '--control', roleFailure.control, '--cwd', roleFailure.product, '--prompt-file', roleFailure.prompt, '--opencode', roleFailure.fake], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_OPENCODE_FAIL: '1' },
  });
  assert.equal(failed.status, 17, failed.stderr);
  assert.equal(await readFile(roleFailure.profile, 'utf8'), roleFailure.original);

  const promptFailure = await fixture();
  const missingPrompt = join(promptFailure.control, 'missing-prompt.txt');
  const missing = spawnSync(process.execPath, [launcher, '--role', 'developer', '--control', promptFailure.control, '--cwd', promptFailure.product, '--prompt-file', missingPrompt, '--opencode', promptFailure.fake], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /ENOENT|cannot read/);
  assert.equal(await readFile(promptFailure.profile, 'utf8'), promptFailure.original);
});

console.log('OpenCode role launcher contract: PASS');
