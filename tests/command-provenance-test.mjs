import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describeCommandProvenance } from '../runtime/lib/process.mjs';
import { executeGates, parseQualityGates } from '../runtime/lib/gates.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'triad-command-provenance-'));
try {
  const bin = path.join(root, 'bin');
  const alternateBin = path.join(root, 'alternate-bin');
  const worktree = path.join(root, 'worktree');
  await Promise.all([writeFile(path.join(root, 'placeholder'), ''), writeFile(path.join(root, 'side-effect'), '')]);
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(bin), mkdir(alternateBin), mkdir(worktree)]));
  const fake = path.join(bin, 'fake-tool');
  const alternate = path.join(alternateBin, 'fake-tool');
  await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake-tool 1.0.0; else exit 0; fi\n');
  await writeFile(alternate, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake-tool 2.0.0; else exit 0; fi\n');
  await chmod(fake, 0o755);
  await chmod(alternate, 0o755);
  const fakeResolved = await realpath(fake);
  const alternateResolved = await realpath(alternate);
  const fakeHash = createHash('sha256').update(await readFile(fake)).digest('hex');

  const direct = await describeCommandProvenance('fake-tool', [], { cwd: worktree, shell: true, env: { PATH: bin } });
  assert.equal(direct.provenance_status, 'unbound');
  assert.equal(direct.resolved_executable, fakeResolved);
  assert.equal(direct.sha256, fakeHash);
  assert.equal(direct.version, 'fake-tool 1.0.0');
  assert.deepEqual(Object.keys(direct).sort(), ['declared', 'provenance_status', 'resolved_executable', 'sha256', 'version']);
  assert.equal(Object.hasOwn(direct, 'env'), false, 'provenance must not expose the process environment');

  const composite = await describeCommandProvenance('npm test | tee output.log', [], { cwd: worktree, shell: true });
  assert.equal(composite.provenance_status, 'unresolved_shell_command');
  assert.equal(composite.resolved_executable, null);

  const bound = await describeCommandProvenance(fake, [], {
    cwd: worktree,
    shell: true,
    toolchain: { executable: fakeResolved, sha256: fakeHash, version: 'fake-tool 1.0.0' }
  });
  assert.equal(bound.provenance_status, 'bound');
  await assert.rejects(
    () => describeCommandProvenance('fake-tool', [], {
      cwd: worktree,
      shell: true,
      env: { PATH: alternateBin },
      toolchain: { executable: fakeResolved, sha256: fakeHash }
    }),
    (error) => error?.code === 'gate_toolchain_mismatch'
  );

  const sideEffect = path.join(worktree, 'must-not-exist');
  const mismatchGates = [
    { id: 'side-effect', command: `node -e "require('node:fs').writeFileSync(${JSON.stringify(sideEffect)}, 'bad')"`, required: true, executor: 'control-plane' },
    { id: 'bound', command: fake, required: true, executor: 'control-plane', toolchain: { executable: alternateResolved, sha256: '0'.repeat(64) } }
  ];
  await assert.rejects(() => executeGates(mismatchGates, worktree, path.join(root, 'logs')), (error) => error?.code === 'gate_toolchain_mismatch');
  await assert.rejects(() => readFile(sideEffect), { code: 'ENOENT' }, 'mismatch must be detected before any gate side effect');

  const legacyLogs = path.join(root, 'logs');
  await mkdir(legacyLogs);
  const legacy = await executeGates([{ id: 'legacy', command: fake, required: true, executor: 'control-plane' }], worktree, legacyLogs);
  assert.equal(legacy[0].status, 'pass');
  assert.equal(legacy[0].provenance.provenance_status, 'unbound');
  assert.equal(legacy[0].provenance.sha256, fakeHash);

  const parsed = parseQualityGates(`version: 2\ngates:\n  - id: bound\n    command: ${fake}\n    required: true\n    executor: control-plane\n    toolchain:\n      executable: ${fake}\n      sha256: ${fakeHash}\n      version: fake-tool 1.0.0\n`);
  assert.deepEqual(parsed[0].toolchain, { executable: fake, sha256: fakeHash, version: 'fake-tool 1.0.0' });

  const adapter = path.join(root, 'adapter.json');
  await writeFile(adapter, JSON.stringify({ schema_version: 1, id: 'fixture', binary: 'fake-tool', binary_candidates: [fake], verification: { default_mode: 'explicit_dispatch' } }));
  const capability = spawnSync(process.execPath, [path.join(repositoryRoot, 'runtime', 'triad-runtime-capabilities.mjs'), '--adapter', adapter, '--host-bin', fake, '--version-output', 'fake-tool 1.0.0'], { encoding: 'utf8' });
  assert.equal(capability.status, 0, capability.stderr);
  const snapshot = JSON.parse(capability.stdout);
  assert.equal(snapshot.host_runtime.resolved_path, fakeResolved);
  assert.equal(snapshot.host_runtime.sha256, fakeHash);
  assert.equal(Object.hasOwn(snapshot, 'environment'), false, 'capability snapshot must not expose the environment');
  console.log('Command and gate provenance contract: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
