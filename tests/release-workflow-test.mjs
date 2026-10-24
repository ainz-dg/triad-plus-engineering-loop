import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoConflicts,
  assertPublishedRegistry,
  assertReleaseMetadata,
  classifyNpmMetadataProbe,
  classifyNpmVersionProbe,
  classifyPublishedNpmProbe,
  classifyReleaseProbe,
  classifyTagProbe,
  planReleaseAssetUploads,
  validateDispatchContext,
  validateReleaseContext,
  versionFromReleaseTag,
  waitForPublishedRegistry,
} from '../scripts/release/release-guard.mjs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const ownerGuide = readFileSync(new URL('../docs/maintainers/releasing.md', import.meta.url), 'utf8');
const guardPath = fileURLToPath(new URL('../scripts/release/release-guard.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);

function validRelease(overrides = {}) {
  return {
    eventName: 'release',
    action: 'published',
    ref: 'refs/tags/v1.22.2',
    sha,
    checkedOutSha: sha,
    mainSha: sha,
    tagName: 'v1.22.2',
    tagSha: sha,
    targetCommitish: 'main',
    draft: false,
    prerelease: false,
    actor: 'ainz-dg',
    packageName: 'triad-plus',
    packageVersion: '1.22.2',
    ...overrides,
  };
}

function validDispatch(overrides = {}) {
  return {
    eventName: 'workflow_dispatch',
    ref: 'refs/heads/main',
    sha,
    checkedOutSha: sha,
    expectedSha: sha,
    mainSha: sha,
    tagName: 'v1.22.2',
    packageName: 'triad-plus',
    packageVersion: '1.22.2',
    ...overrides,
  };
}

function writeExecutable(path, source) {
  writeFileSync(path, '#!/usr/bin/env node\n' + source);
  chmodSync(path, 0o755);
}

test('release tag parser accepts only stable canonical vMAJOR.MINOR.PATCH tags', () => {
  assert.equal(versionFromReleaseTag('v1.22.2'), '1.22.2');
  for (const invalid of ['1.22.2', 'v01.22.2', 'v1.022.2', 'v1.22.02', 'v1.22', 'v1.22.2-rc.1', 'v1.22.2+build']) {
    assert.throws(() => versionFromReleaseTag(invalid), /exactly vMAJOR/);
  }
});

test('published release gate binds event, stable metadata, actor, tag, current main, and package identity', () => {
  assert.deepEqual(validateReleaseContext(validRelease()), { tagName: 'v1.22.2', version: '1.22.2', commitSha: sha });
  assert.deepEqual(validateReleaseContext(validRelease({ targetCommitish: sha.toUpperCase() })), {
    tagName: 'v1.22.2', version: '1.22.2', commitSha: sha,
  });
  const invalid = [
    { eventName: 'push' }, { action: 'created' }, { ref: 'refs/heads/main' },
    { draft: true }, { prerelease: true }, { actor: 'contributor' },
    { tagName: 'v1.22.2-rc.1' }, { checkedOutSha: otherSha }, { mainSha: otherSha },
    { tagSha: otherSha }, { targetCommitish: 'release/1.22' }, { targetCommitish: otherSha },
    { packageName: 'other-package' }, { packageVersion: '1.22.1' },
  ];
  for (const overrides of invalid) assert.throws(() => validateReleaseContext(validRelease(overrides)), JSON.stringify(overrides));
});

test('dispatch validator is read-only in scope and requires the exact current main SHA', () => {
  assert.equal(validateDispatchContext(validDispatch()).commitSha, sha);
  for (const overrides of [
    { eventName: 'push' }, { ref: 'refs/heads/feature' }, { expectedSha: otherSha },
    { mainSha: otherSha }, { packageVersion: '1.22.1' }, { tagName: 'v1.22.2-rc.1' },
  ]) assert.throws(() => validateDispatchContext(validDispatch(overrides)));
});

test('npm duplicate preflight treats only E404 as absence and fails closed on other errors', () => {
  assert.deepEqual(classifyNpmVersionProbe({ status: 0, stdout: '"1.22.2"' }, '1.22.2'), { present: true, version: '1.22.2' });
  assert.deepEqual(classifyNpmVersionProbe({ status: 1, stderr: 'npm error code E404' }, '1.22.2'), { present: false });
  assert.throws(() => classifyNpmVersionProbe({ status: 1, stderr: 'ECONNRESET' }, '1.22.2'), /other than a missing version/);
  assert.throws(() => classifyNpmVersionProbe({ status: 0, stdout: '"1.22.1"' }, '1.22.2'), /unexpected version/);
});

test('npm registry metadata accepts npm dotted or nested fields only when unambiguous', () => {
  const dotted = { version: '1.22.2', 'dist.integrity': 'sha512-good', 'dist.shasum': 'a'.repeat(40) };
  assert.deepEqual(classifyNpmMetadataProbe({ status: 0, stdout: JSON.stringify(dotted) }, '1.22.2'), {
    version: '1.22.2', integrity: 'sha512-good', shasum: 'a'.repeat(40),
  });
  assert.deepEqual(classifyNpmMetadataProbe({ status: 0, stdout: JSON.stringify([{
    version: '1.22.2', dist: { integrity: 'sha512-nested', shasum: 'b'.repeat(40) },
  }]) }, '1.22.2'), { version: '1.22.2', integrity: 'sha512-nested', shasum: 'b'.repeat(40) });
  assert.throws(() => classifyNpmMetadataProbe({ status: 0, stdout: JSON.stringify({ ...dotted, dist: { integrity: 'sha512-other' } }) }, '1.22.2'), /conflicting/);
  assert.throws(() => classifyNpmMetadataProbe({ status: 0, stdout: JSON.stringify([{ ...dotted }, { ...dotted }]) }, '1.22.2'), /exactly one/);
  assert.throws(() => classifyNpmMetadataProbe({ status: 1, stderr: 'npm error code E404' }, '1.22.2'), /not present after publish/);
});

test('bounded npm propagation retries only temporary E404, accepts eventual visibility, and never retries mismatch', async () => {
  const expected = { integrity: 'sha512-good', shasum: 'a'.repeat(40) };
  const sleeps = [];
  let calls = 0;
  const visible = await waitForPublishedRegistry({
    expectedVersion: '1.22.2', expected, attempts: 4,
    probe: async () => {
      calls += 1;
      return calls < 3
        ? { status: 1, stderr: 'npm error code E404' }
        : { status: 0, stdout: JSON.stringify({ version: '1.22.2', dist: expected }) };
    },
    sleep: async (delay) => sleeps.push(delay),
  });
  assert.equal(visible.attempts, 3);
  assert.deepEqual(sleeps, [5_000, 10_000]);

  let missingCalls = 0;
  await assert.rejects(waitForPublishedRegistry({
    expectedVersion: '1.22.2', expected, attempts: 3,
    probe: async () => { missingCalls += 1; return { status: 1, stderr: 'E404' }; },
    sleep: async () => {},
  }), /manual recovery and do not republish/);
  assert.equal(missingCalls, 3);

  let mismatchCalls = 0;
  await assert.rejects(waitForPublishedRegistry({
    expectedVersion: '1.22.2', expected, attempts: 8,
    probe: async () => {
      mismatchCalls += 1;
      return { status: 0, stdout: JSON.stringify({ version: '1.22.2', dist: { ...expected, shasum: 'c'.repeat(40) } }) };
    },
    sleep: async () => {},
  }), /does not match the verified tarball/);
  assert.equal(mismatchCalls, 1);
});

test('post-publish npm metadata must match the verified archive exactly', () => {
  const expected = { integrity: 'sha512-good', shasum: 'a'.repeat(40) };
  assert.equal(assertPublishedRegistry({ version: '1.22.2', ...expected }, '1.22.2', expected), true);
  assert.throws(() => assertPublishedRegistry({ version: '1.22.2', ...expected, shasum: 'b'.repeat(40) }, '1.22.2', expected), /does not match/);
  assert.deepEqual(classifyPublishedNpmProbe({ status: 1, stderr: 'E404' }, '1.22.2', expected), { visible: false });
  assert.throws(() => classifyPublishedNpmProbe({ status: 1, stderr: 'ECONNRESET' }, '1.22.2', expected), /other than temporary/);
});

test('git tag probe distinguishes absent tags and annotated tag commit from ambiguous or failed probes', () => {
  assert.deepEqual(classifyTagProbe({ status: 2, stdout: '' }, 'v1.22.2'), { present: false });
  assert.deepEqual(classifyTagProbe({ status: 0, stdout: sha + '\trefs/tags/v1.22.2\n' }, 'v1.22.2'), {
    present: true, objectSha: sha, commitSha: sha,
  });
  assert.deepEqual(classifyTagProbe({ status: 0, stdout: otherSha + '\trefs/tags/v1.22.2\n' + sha + '\trefs/tags/v1.22.2^{}\n' }, 'v1.22.2'), {
    present: true, objectSha: otherSha, commitSha: sha,
  });
  assert.throws(() => classifyTagProbe({ status: 0, stdout: sha + '\trefs/tags/v1.22.2\n' + otherSha + '\trefs/tags/v1.22.2\n' }, 'v1.22.2'), /ambiguous/);
  assert.throws(() => classifyTagProbe({ status: 128, stderr: 'network failure' }, 'v1.22.2'));
});

test('GitHub Release conflict probe treats only not-found as absence', () => {
  assert.deepEqual(classifyReleaseProbe({ status: 0, stdout: '{}' }), { present: true });
  assert.deepEqual(classifyReleaseProbe({ status: 1, stderr: 'release not found (HTTP 404)' }), { present: false });
  assert.throws(() => classifyReleaseProbe({ status: 1, stderr: 'API rate limit exceeded' }), /other than not found/);
});

test('preflight rejects existing immutable npm version, tag, or Release', () => {
  assert.equal(assertNoConflicts({ npm: { present: false }, tag: { present: false }, release: { present: false }, version: '1.22.2', tagName: 'v1.22.2' }), true);
  for (const key of ['npm', 'tag', 'release']) {
    assert.throws(() => assertNoConflicts({
      npm: { present: false }, tag: { present: false }, release: { present: false },
      version: '1.22.2', tagName: 'v1.22.2', [key]: { present: true },
    }));
  }
});

test('release asset upload plan is idempotent and rejects conflicts, unexpected assets, and digestless assets', () => {
  const expected = { tagName: 'v1.22.2', archiveSha256: 'a'.repeat(64), sidecarSha256: 'b'.repeat(64) };
  const release = { tag_name: 'v1.22.2', draft: false, prerelease: false, assets: [] };
  assert.deepEqual(planReleaseAssetUploads(release, expected).missing, ['triad-plus-1.22.2.tgz', 'triad-plus-1.22.2.tgz.sha256']);
  const complete = { ...release, assets: [
    { name: 'triad-plus-1.22.2.tgz', digest: 'sha256:' + expected.archiveSha256 },
    { name: 'triad-plus-1.22.2.tgz.sha256', digest: 'sha256:' + expected.sidecarSha256 },
  ] };
  assert.deepEqual(planReleaseAssetUploads(complete, expected).missing, []);
  assert.equal(assertReleaseMetadata(complete, expected), true);
  for (const assets of [
    [...complete.assets, { name: 'unexpected.zip', digest: 'sha256:' + 'c'.repeat(64) }],
    complete.assets.map((asset) => ({ ...asset, digest: 'sha256:wrong' })),
    complete.assets.map(({ name }) => ({ name })),
  ]) assert.throws(() => planReleaseAssetUploads({ ...release, assets }, expected));
  assert.throws(() => planReleaseAssetUploads({ ...release, draft: true }, expected));
});

test('release workflow is published-event driven, fail-closed, and has isolated write permissions', () => {
  assert.match(workflow, /release:\s*\n\s+types:\s*\[published\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule):/m);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.equal((workflow.match(/id-token:\s*write/g) || []).length, 1);
  assert.equal((workflow.match(/contents:\s*write/g) || []).length, 1);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM_TOKEN/);
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /npm install --global npm@11\.5\.1/);
  assert.match(workflow, /npm publish .*--provenance --access public/);
  assert.match(workflow, /verify-release-downloads/);
  assert.match(workflow, /registry-smoke/);
  assert.doesNotMatch(workflow, /gh release create|git tag\s|--clobber/);
  const npmJob = workflow.slice(workflow.indexOf('  publish-npm:'), workflow.indexOf('  publish-release-assets:'));
  assert.match(npmJob, /id-token:\s*write/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  publish-release-assets:')), /id-token:\s*write/);
});

test('CLI gate accepts one fully mocked stable release and rejects other event types before network access', () => {
  const root = mkdtempSync(join(tmpdir(), 'triad-release-cli-gate-'));
  const bin = join(root, 'bin');
  const eventPath = join(root, 'event.json');
  mkdirSync(bin);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'triad-plus', version: '1.22.2' }));
  writeFileSync(eventPath, JSON.stringify({ action: 'published', release: {
    id: 42, tag_name: 'v1.22.2', target_commitish: 'main', draft: false, prerelease: false,
  } }));
  const releaseJson = JSON.stringify({
    id: 42, tag_name: 'v1.22.2', target_commitish: 'main', draft: false, prerelease: false,
  });
  writeExecutable(join(bin, 'git'), `
    const args = process.argv.slice(2);
    if (args[0] === 'rev-parse') process.stdout.write('${sha}\\n');
    else if (args[0] === 'ls-remote' && args.includes('refs/heads/main')) process.stdout.write('${sha}\\trefs/heads/main\\n');
    else if (args[0] === 'ls-remote' && args.some((arg) => arg.startsWith('refs/tags/'))) process.stdout.write('${sha}\\trefs/tags/v1.22.2\\n');
    else process.exit(2);
  `);
  writeExecutable(join(bin, 'gh'), `process.stdout.write(${JSON.stringify(releaseJson)});`);
  writeExecutable(join(bin, 'npm'), `process.stderr.write('npm error code E404'); process.exit(1);`);
  const run = (eventName) => spawnSync(process.execPath, [guardPath, 'gate'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REF: 'refs/tags/v1.22.2',
      GITHUB_SHA: sha,
      GITHUB_ACTOR: 'ainz-dg',
      GITHUB_REPOSITORY: 'ainz-dg/triad-plus-engineering-loop',
      RELEASE_TAG: 'v1.22.2',
    },
  });
  try {
    const success = run('release');
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /Release gate passed for v1\.22\.2/);
    const unsupported = run('push');
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /Only release published events or the dry-run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release download verifier checks exact downloaded archive and sidecar bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'triad-release-assets-cli-'));
  const bin = join(root, 'bin');
  const sourceDirectory = join(root, 'source-assets');
  const downloadedDirectory = join(root, 'downloaded-assets');
  const eventPath = join(root, 'event.json');
  mkdirSync(bin);
  mkdirSync(sourceDirectory);
  const archiveName = 'triad-plus-1.22.2.tgz';
  const archiveBytes = Buffer.from('verified archive fixture\n');
  const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
  const sidecarBytes = Buffer.from(archiveSha256 + '  ' + archiveName + '\n');
  const sidecarSha256 = createHash('sha256').update(sidecarBytes).digest('hex');
  writeFileSync(join(sourceDirectory, archiveName), archiveBytes);
  writeFileSync(join(sourceDirectory, archiveName + '.sha256'), sidecarBytes);
  const releaseJson = JSON.stringify({
    id: 42, tag_name: 'v1.22.2', target_commitish: 'main', draft: false, prerelease: false,
    assets: [
      { name: archiveName, digest: 'sha256:' + archiveSha256 },
      { name: archiveName + '.sha256', digest: 'sha256:' + sidecarSha256 },
    ],
  });
  writeFileSync(eventPath, JSON.stringify({ action: 'published', release: {
    id: 42, tag_name: 'v1.22.2', target_commitish: 'main', draft: false, prerelease: false,
  } }));
  writeExecutable(join(bin, 'git'), `process.stdout.write('${sha}\\trefs/tags/v1.22.2\\n');`);
  writeExecutable(join(bin, 'gh'), `
    const { copyFileSync, mkdirSync } = require('node:fs');
    const { join } = require('node:path');
    const args = process.argv.slice(2);
    if (args[0] === 'api') process.stdout.write(${JSON.stringify(releaseJson)});
    else if (args[0] === 'release' && args[1] === 'download') {
      const target = args[args.indexOf('--dir') + 1];
      mkdirSync(target, { recursive: true });
      for (const name of ${JSON.stringify([archiveName, archiveName + '.sha256'])}) copyFileSync(join(process.env.SOURCE_ASSET_DIR, name), join(target, name));
    } else process.exit(2);
  `);
  const run = () => spawnSync(process.execPath, [guardPath, 'verify-release-downloads'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      GITHUB_EVENT_NAME: 'release',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: 'ainz-dg/triad-plus-engineering-loop',
      RELEASE_TAG: 'v1.22.2',
      RELEASE_DOWNLOAD_DIR: downloadedDirectory,
      SOURCE_ASSET_DIR: sourceDirectory,
      EXPECTED_ARCHIVE_SHA256: archiveSha256,
      EXPECTED_SIDECAR_SHA256: sidecarSha256,
    },
  });
  try {
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Downloaded GitHub Release assets exactly match/);
    rmSync(downloadedDirectory, { recursive: true, force: true });
    writeFileSync(join(sourceDirectory, archiveName), 'tampered archive');
    const tampered = run();
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /asset bytes do not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner guide documents OIDC setup, event semantics, partial-publication recovery, and no release creation', () => {
  for (const text of [
    'ainz-dg', 'triad-plus-engineering-loop', 'release.yml', 'Trusted Publisher',
    'GITHUB_SHA', 'refs/tags/', 'published', 'prerelease', 'never republish',
    'static-token fallback', 'recover manually',
  ]) assert.ok(ownerGuide.includes(text), 'missing owner guidance: ' + text);
  assert.match(ownerGuide, /GitHub Release is already public before npm publication/);
});
