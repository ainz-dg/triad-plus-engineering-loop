import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repositoryRoot = new URL('..', import.meta.url).pathname;
const launcher = join(repositoryRoot, 'adapters/opencode/run-role.mjs');

test('OpenCode standalone launcher materializes a native primary role and restores the managed profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triad-opencode-role-launcher-'));
  const profileRoot = join(root, '.opencode', 'agents');
  await mkdir(profileRoot, { recursive: true });
  const profile = join(profileRoot, 'triad-developer.md');
  const original = await readFile(join(repositoryRoot, 'adapters/opencode/.opencode/agents/triad-developer.md'), 'utf8');
  await writeFile(profile, original);
  const prompt = join(root, 'prompt.txt');
  await writeFile(prompt, 'return the role marker');
  const observed = join(root, 'observed-mode.txt');
  const fake = join(root, 'fake-opencode.mjs');
  await writeFile(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[process.argv.indexOf('--dir') + 1];
const role = process.argv[process.argv.indexOf('--agent') + 1];
writeFileSync(${JSON.stringify(observed)}, readFileSync(path.join(dir, '.opencode', 'agents', role + '.md'), 'utf8').match(/^mode: .*$/m)[0]);
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: 'ROLE_LAUNCH_OK' } }));
`);
  await chmod(fake, 0o755);

  const result = spawnSync(process.execPath, [launcher, '--role', 'developer', '--control', root, '--cwd', root, '--prompt-file', prompt, '--opencode', fake], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ROLE_LAUNCH_OK/);
  assert.equal(await readFile(observed, 'utf8'), 'mode: primary');
  assert.equal(await readFile(profile, 'utf8'), original);
});

console.log('OpenCode role launcher contract: PASS');
