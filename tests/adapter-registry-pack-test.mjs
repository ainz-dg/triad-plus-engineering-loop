import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listAdapters, sharedSkillNames } from '../adapters/registry.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function filesUnder(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(path.relative(directory, target).split(path.sep).join('/'));
    }
  }
  await walk(directory);
  return files;
}

const requiredSources = new Map();
for (const adapter of listAdapters()) {
  for (const asset of [...adapter.projectAssets, ...adapter.globalAssets]) {
    const sources = asset.source === 'shared-skills'
      ? sharedSkillNames.map((name) => path.join('skills', name))
      : [asset.source];
    for (const relativeSource of sources) {
      const sourcePath = path.join(repositoryRoot, relativeSource);
      const info = await lstat(sourcePath);
      const files = asset.source !== 'shared-skills' && (asset.file || !info.isDirectory())
        ? [relativeSource]
        : (await filesUnder(sourcePath)).map((relative) => path.join(relativeSource, relative).split(path.sep).join('/'));
      for (const file of files) {
        const bytes = await readFile(path.join(repositoryRoot, file));
        assert.ok(bytes.length > 0, `Registry asset source is readable and non-empty: ${file}`);
        requiredSources.set(file, digest(bytes));
      }
    }
  }
}

const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--silent'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  timeout: 60_000,
  env: { ...process.env, npm_config_update_notifier: 'false' },
});
assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
const packageRecords = JSON.parse(packed.stdout);
const packageRecord = packageRecords['triad-plus'];
assert.ok(packageRecord && Array.isArray(packageRecord.files), 'npm pack dry-run produces a triad-plus package record');
const packedFiles = new Set(packageRecord.files.map((entry) => entry.path));
for (const source of requiredSources.keys()) {
  assert.ok(packedFiles.has(source), `Registry asset source is included in the npm package: ${source}`);
  assert.equal(digest(await readFile(path.join(repositoryRoot, source))), requiredSources.get(source), `Registry asset source did not change during packaging: ${source}`);
}

process.stdout.write(`Registry asset sources are readable and included in npm pack (${requiredSources.size} files across ${listAdapters().length} adapters).\n`);
