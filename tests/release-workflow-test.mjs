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

import { validateRecoveryInputs, validateRecoverySource, originalChecksums, verifyRecoveryBytes } from '../scripts/release/recovery-verify.mjs';

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

function createReleaseCliFixture(root) {
  const bin = join(root, 'bin');
  const eventPath = join(root, 'event.json');
  const releaseStatePath = join(root, 'release.json');
  const npmResponsesPath = join(root, 'npm-responses.json');
  const npmStatePath = join(root, 'npm-state.txt');
  const commandLogPath = join(root, 'commands.jsonl');
  const artifactDirectory = join(root, 'artifacts');
  const tagName = 'v1.22.2';
  const archiveName = 'triad-plus-1.22.2.tgz';
  const archiveBytes = Buffer.from('isolated release archive fixture\n');
  const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
  const sidecarBytes = Buffer.from(archiveSha256 + '  ' + archiveName + '\n');
  const sidecarSha256 = createHash('sha256').update(sidecarBytes).digest('hex');
  const event = {
    action: 'published',
    release: { id: 42, tag_name: tagName, target_commitish: 'main', draft: false, prerelease: false },
  };
  const release = { ...event.release, assets: [] };

  mkdirSync(bin, { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'triad-plus', version: '1.22.2' }));
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(releaseStatePath, JSON.stringify(release));
  writeFileSync(join(artifactDirectory, archiveName), archiveBytes);
  writeFileSync(join(artifactDirectory, archiveName + '.sha256'), sidecarBytes);
  writeFileSync(npmResponsesPath, JSON.stringify([{ status: 1, stderr: 'npm error code E404' }]));
  writeFileSync(npmStatePath, '0');
  writeFileSync(commandLogPath, '');

  writeExecutable(join(bin, 'git'), `
    const { appendFileSync } = require('node:fs');
    const args = process.argv.slice(2);
    appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ bin: 'git', args }) + '\\n');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') process.stdout.write('${sha}\\n');
    else if (args[0] === 'ls-remote' && args.at(-1) === 'refs/heads/main') process.stdout.write('${sha}\\trefs/heads/main\\n');
    else if (args[0] === 'ls-remote' && args.some((arg) => arg.startsWith('refs/tags/'))) process.stdout.write('${sha}\\trefs/tags/v1.22.2\\n');
    else process.exit(2);
  `);
  writeExecutable(join(bin, 'gh'), `
    const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
    const { basename } = require('node:path');
    const { createHash } = require('node:crypto');
    const args = process.argv.slice(2);
    const record = { bin: 'gh', args, clobber: args.includes('--clobber') };
    if (args[0] === 'release' && args[1] === 'upload') {
      record.files = args.slice(3).map((path) => ({
        path,
        basename: basename(path),
        bytes: readFileSync(path).toString('base64'),
      }));
    }
    appendFileSync(process.env.COMMAND_LOG, JSON.stringify(record) + '\\n');
    if (args[0] === 'api') process.stdout.write(readFileSync(process.env.RELEASE_STATE, 'utf8'));
    else if (args[0] === 'release' && args[1] === 'upload') {
      const release = JSON.parse(readFileSync(process.env.RELEASE_STATE, 'utf8'));
      for (const path of args.slice(3)) {
        const bytes = readFileSync(path);
        release.assets.push({ name: basename(path), digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });
      }
      writeFileSync(process.env.RELEASE_STATE, JSON.stringify(release));
    } else process.exit(2);
  `);
  writeExecutable(join(bin, 'npm'), `
    const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
    const args = process.argv.slice(2);
    const responses = JSON.parse(readFileSync(process.env.NPM_RESPONSES, 'utf8'));
    const index = Number(readFileSync(process.env.NPM_STATE, 'utf8')) || 0;
    const response = responses[Math.min(index, responses.length - 1)];
    writeFileSync(process.env.NPM_STATE, String(index + 1));
    appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ bin: 'npm', args, index }) + '\\n');
    if (response.stdout) process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(response.stderr);
    process.exit(response.status);
  `);

  const env = {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    COMMAND_LOG: commandLogPath,
    RELEASE_STATE: releaseStatePath,
    NPM_RESPONSES: npmResponsesPath,
    NPM_STATE: npmStatePath,
    GITHUB_EVENT_NAME: 'release',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REF: 'refs/tags/' + tagName,
    GITHUB_SHA: sha,
    GITHUB_ACTOR: 'ainz-dg',
    GITHUB_REPOSITORY: 'ainz-dg/triad-plus-engineering-loop',
    RELEASE_TAG: tagName,
    EXPECTED_INTEGRITY: 'sha512-fixture-integrity',
    EXPECTED_SHASUM: 'a'.repeat(40),
    EXPECTED_ARCHIVE_SHA256: archiveSha256,
    EXPECTED_SIDECAR_SHA256: sidecarSha256,
    ARTIFACT_DIR: artifactDirectory,
  };

  return {
    root,
    env,
    eventPath,
    releaseStatePath,
    npmResponsesPath,
    npmStatePath,
    commandLogPath,
    artifactDirectory,
    archiveName,
    archiveBytes,
    sidecarBytes,
    archiveSha256,
    sidecarSha256,
    run(mode, overrides = {}, nodeArgs = []) {
      return spawnSync(process.execPath, [...nodeArgs, guardPath, mode], {
        cwd: root,
        encoding: 'utf8',
        env: { ...env, ...overrides },
      });
    },
    commands() {
      return readFileSync(commandLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    },
    setNpmResponses(responses) {
      writeFileSync(npmResponsesPath, JSON.stringify(responses));
      writeFileSync(npmStatePath, '0');
    },
    setRelease(releaseJson) {
      writeFileSync(releaseStatePath, JSON.stringify(releaseJson));
    },
  };
}

function writeImmediateTimerHook(root) {
  const path = join(root, 'immediate-timers.mjs');
  writeFileSync(path, `import { performance } from 'node:perf_hooks';
let clock = 0;
Object.defineProperty(performance, 'now', { value: () => clock });
globalThis.setTimeout = (callback, delay) => { clock += delay; queueMicrotask(callback); return 0; };
`);
  return path;
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
  let clock = 0;
  let calls = 0;
  const visible = await waitForPublishedRegistry({
    expectedVersion: '1.22.2', expected, budgetMs: 600_000, now: () => clock,
    probe: async () => {
      calls += 1;
      return calls < 3
        ? { status: 1, stderr: 'npm error code E404' }
        : { status: 0, stdout: JSON.stringify({ version: '1.22.2', dist: expected }) };
    },
    sleep: async (delay) => { sleeps.push(delay); clock += delay; },
  });
  assert.equal(visible.attempts, 3);
  assert.deepEqual(sleeps, [15_000, 15_000]);

  let missingCalls = 0;
  await assert.rejects(waitForPublishedRegistry({
    expectedVersion: '1.22.2', expected, budgetMs: 45_000, now: () => clock,
    probe: async () => { missingCalls += 1; return { status: 1, stderr: 'E404' }; },
    sleep: async (delay) => { clock += delay; },
  }), /manual recovery and do not republish/);
  assert.equal(missingCalls, 3);

  let mismatchCalls = 0;
  await assert.rejects(waitForPublishedRegistry({
    expectedVersion: '1.22.2', expected,
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
  const npmJob = workflow.slice(workflow.indexOf('  publish-npm:'), workflow.indexOf('  verify-npm:'));
  assert.doesNotMatch(npmJob, /verify-registry/);
  for (const job of ['publish-release-assets', 'verify-published']) {
    assert.match(workflow.slice(workflow.indexOf('  ' + job + ':')).split('    steps:')[0], /- verify-npm/);
  }
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

test('publish-preflight subprocess accepts only the exact stable published release and absent npm version', () => {
  const root = mkdtempSync(join(tmpdir(), 'triad-publish-preflight-cli-'));
  const fixture = createReleaseCliFixture(root);
  try {
    const accepted = fixture.run('publish-preflight');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Final npm publish preflight passed for v1\.22\.2/);
    const commands = fixture.commands();
    assert.ok(commands.some(({ bin, args }) => bin === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD'));
    assert.ok(commands.some(({ bin, args }) => bin === 'git' && args[0] === 'ls-remote' && args.at(-1) === 'refs/heads/main'));
    assert.ok(commands.some(({ bin, args }) => bin === 'gh' && args[0] === 'api'));
    assert.ok(commands.some(({ bin, args }) => bin === 'npm' && args.join(' ') === 'view triad-plus@1.22.2 version --json --prefer-online --registry=https://registry.npmjs.org'));

    fixture.setNpmResponses([{ status: 0, stdout: '"1.22.2"' }]);
    const duplicate = fixture.run('publish-preflight');
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already exists; immutable versions are never overwritten/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish-preflight subprocess rejects event, published tag, and immutable SHA mismatches', () => {
  const cases = [
    { label: 'event', overrides: { GITHUB_EVENT_NAME: 'push' }, expected: /published GitHub Release event/ },
    { label: 'tag', overrides: { GITHUB_REF: 'refs/tags/v1.22.1' }, expected: /exact published release tag/ },
    { label: 'SHA', overrides: { GITHUB_SHA: otherSha }, expected: /immutable GITHUB_SHA supplied by the release event/ },
  ];
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), 'triad-publish-preflight-' + scenario.label + '-'));
    const fixture = createReleaseCliFixture(root);
    try {
      const rejected = fixture.run('publish-preflight', scenario.overrides);
      assert.equal(rejected.status, 1, scenario.label + ' mismatch unexpectedly passed');
      assert.match(rejected.stderr, scenario.expected);
      assert.equal(fixture.commands().filter(({ bin }) => bin === 'npm').length, 0,
        scenario.label + ' mismatch reached the npm preflight');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('verify-registry subprocess retries transient E404 and accepts npm dotted dist fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'triad-verify-registry-cli-'));
  const fixture = createReleaseCliFixture(root);
  const expectedIntegrity = 'sha512-fixture-integrity';
  const expectedShasum = 'c'.repeat(40);
  fixture.setNpmResponses([
    { status: 1, stderr: 'npm error code E404' },
    {
      status: 0,
      stdout: JSON.stringify({ version: '1.22.2', 'dist.integrity': expectedIntegrity, 'dist.shasum': expectedShasum }),
    },
  ]);
  try {
    const result = fixture.run('verify-registry', {
      EXPECTED_INTEGRITY: expectedIntegrity,
      EXPECTED_SHASUM: expectedShasum,
    }, ['--import', writeImmediateTimerHook(root)]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /propagation completed after 2 bounded checks/);
    assert.match(result.stdout, /npm registry identity verified: 1\.22\.2/);
    const npmCalls = fixture.commands().filter(({ bin }) => bin === 'npm');
    assert.equal(npmCalls.length, 2);
    assert.ok(npmCalls.every(({ args }) => args.join(' ') === 'view triad-plus@1.22.2 version dist.integrity dist.shasum --json --prefer-online --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=30000'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify-registry subprocess fails closed on integrity mismatch, permanent error, and exhausted E404 retries', () => {
  const cases = [
    {
      name: 'integrity-mismatch',
      responses: [{ status: 0, stdout: JSON.stringify({
        version: '1.22.2', 'dist.integrity': 'sha512-wrong', 'dist.shasum': 'c'.repeat(40),
      }) }],
      expected: /does not match the verified tarball/,
      calls: 1,
    },
    {
      name: 'shasum-mismatch',
      responses: [{ status: 0, stdout: JSON.stringify({
        version: '1.22.2', 'dist.integrity': 'sha512-fixture-integrity', 'dist.shasum': 'd'.repeat(40),
      }) }],
      expected: /does not match the verified tarball/,
      calls: 1,
    },
    {
      name: 'permanent-error',
      responses: [{ status: 1, stderr: 'npm error code ECONNRESET' }],
      expected: /other than temporary version absence/,
      calls: 1,
    },
    {
      name: 'bounded-timeout',
      responses: [{ status: 1, stderr: 'npm error code E404' }],
      expected: /did not become visible within 30000ms after 2 bounded checks/,
      calls: 2,
    },
  ];
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), 'triad-verify-registry-' + scenario.name + '-'));
    const fixture = createReleaseCliFixture(root);
    fixture.setNpmResponses(scenario.responses);
    try {
      const result = fixture.run('verify-registry', {
        EXPECTED_INTEGRITY: 'sha512-fixture-integrity',
        EXPECTED_SHASUM: 'c'.repeat(40),
        REGISTRY_BUDGET_MS: '30000',
      }, ['--import', writeImmediateTimerHook(root)]);
      assert.equal(result.status, 1, scenario.name + ' unexpectedly passed');
      assert.match(result.stderr, scenario.expected);
      assert.equal(fixture.commands().filter(({ bin }) => bin === 'npm').length, scenario.calls);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('upload-release-assets subprocess uploads exactly two missing verified assets without clobbering', () => {
  const root = mkdtempSync(join(tmpdir(), 'triad-upload-assets-cli-'));
  const fixture = createReleaseCliFixture(root);
  try {
    const result = fixture.run('upload-release-assets');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /now has exactly the two verified assets/);
    const commands = fixture.commands();
    const uploads = commands.filter(({ bin, args }) => bin === 'gh' && args[0] === 'release' && args[1] === 'upload');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].clobber, false);
    assert.deepEqual(uploads[0].files.map(({ path }) => path), [
      join(fixture.artifactDirectory, fixture.archiveName),
      join(fixture.artifactDirectory, fixture.archiveName + '.sha256'),
    ]);
    assert.deepEqual(uploads[0].files.map(({ bytes }) => Buffer.from(bytes, 'base64')),
      [fixture.archiveBytes, fixture.sidecarBytes]);
    assert.deepEqual(JSON.parse(readFileSync(fixture.releaseStatePath, 'utf8')).assets.map(({ name }) => name), [
      fixture.archiveName,
      fixture.archiveName + '.sha256',
    ]);
    assert.ok(commands.filter(({ bin }) => bin === 'gh').every(({ clobber }) => clobber === false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upload-release-assets subprocess skips matching assets and rejects conflicts before any mutation', () => {
  const cases = [
    {
      name: 'matching',
      assets: (fixture) => [
        { name: fixture.archiveName, digest: 'sha256:' + fixture.archiveSha256 },
        { name: fixture.archiveName + '.sha256', digest: 'sha256:' + fixture.sidecarSha256 },
      ],
      succeeds: true,
    },
    {
      name: 'digest-conflict',
      assets: (fixture) => [{ name: fixture.archiveName, digest: 'sha256:' + 'd'.repeat(64) }],
      expected: /will not be overwritten/,
    },
    {
      name: 'unexpected-asset',
      assets: (fixture) => [{ name: 'unexpected.zip', digest: 'sha256:' + 'e'.repeat(64) }],
      expected: /unexpected asset/,
    },
  ];
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), 'triad-upload-assets-' + scenario.name + '-'));
    const fixture = createReleaseCliFixture(root);
    fixture.setRelease({ ...JSON.parse(readFileSync(fixture.releaseStatePath, 'utf8')), assets: scenario.assets(fixture) });
    const initialRelease = readFileSync(fixture.releaseStatePath, 'utf8');
    try {
      const result = fixture.run('upload-release-assets');
      if (scenario.succeeds) {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /no existing asset was overwritten/);
      } else {
        assert.equal(result.status, 1, scenario.name + ' unexpectedly passed');
        assert.match(result.stderr, scenario.expected);
        assert.equal(readFileSync(fixture.releaseStatePath, 'utf8'), initialRelease,
          scenario.name + ' mutated release metadata before rejecting the conflict');
      }
      const commands = fixture.commands();
      assert.equal(commands.filter(({ bin, args }) => bin === 'gh' && args[0] === 'release' && args[1] === 'upload').length, 0);
      assert.ok(commands.filter(({ bin }) => bin === 'gh').every(({ clobber }) => clobber === false));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('owner guide documents OIDC setup, event semantics, partial-publication recovery, and no release creation', () => {
  for (const text of [
    'ainz-dg', 'triad-plus-engineering-loop', 'release.yml', 'Trusted Publisher',
    'GITHUB_SHA', 'refs/tags/', 'published', 'prerelease', 'never republish',
    'static-token fallback', 'release-recovery.yml',
  ]) assert.ok(ownerGuide.includes(text), 'missing owner guidance: ' + text);
  assert.match(ownerGuide, /GitHub Release is already public before npm publication/);
});

test('registry uses the full ten minute budget with slow propagation and no real waiting', async () => {
  const expected = { integrity: 'sha512-good', shasum: 'a'.repeat(40) };
  let clock = 0;
  let probes = 0;
  const diagnostics = [];
  const state = await waitForPublishedRegistry({
    expectedVersion: '1.22.2', expected, now: () => clock,
    sleep: async (delay) => { clock += delay; }, report: (line) => diagnostics.push(line),
    probe: async (_attempt, remaining) => {
      assert.equal(remaining, 600_000 - clock);
      probes += 1;
      return probes < 40 ? { status: 1, stderr: 'No match found for version 1.22.2' }
        : { status: 0, stdout: JSON.stringify({ version: '1.22.2', dist: expected }) };
    },
  });
  assert.equal(state.attempts, 40);
  assert.equal(clock, 585_000);
  assert.match(diagnostics.at(-1), /VERIFIED.*attempt=40 elapsed=585000ms/);

  clock = 0;
  probes = 0;
  await assert.rejects(waitForPublishedRegistry({
    expectedVersion: '1.22.2', expected, now: () => clock,
    sleep: async (delay) => { clock += delay; }, report: () => {},
    probe: async () => { probes += 1; clock += 1_000; return { status: 1, stderr: 'E404' }; },
  }), (error) => error.code === 'REGISTRY_NOT_VISIBLE');
  assert.equal(clock, 600_000);
  assert.equal(probes, 38); // Probe latency also consumes the budget.
});

test('registry immediately rejects wrong identity, malformed metadata, mixed errors, and invalid policies', async () => {
  const expected = { integrity: 'sha512-good', shasum: 'a'.repeat(40) };
  for (const result of [
    { status: 0, stdout: JSON.stringify({ version: '1.22.1', dist: expected }) },
    { status: 0, stdout: 'not-json' },
    { status: 0, stdout: JSON.stringify({ version: '1.22.2' }) },
    { status: 0, stdout: JSON.stringify({ version: '1.22.2', dist: { ...expected, integrity: 'sha512-wrong' } }) },
    { status: 0, stdout: JSON.stringify({ version: '1.22.2', dist: { ...expected, shasum: 'b'.repeat(40) } }) },
    { status: 1, stderr: 'E401 E404' },
    { status: 1, stderr: 'ETIMEDOUT' },
    { status: 1, stderr: 'E500' },
  ]) {
    let probes = 0;
    await assert.rejects(waitForPublishedRegistry({ expectedVersion: '1.22.2', expected,
      probe: () => { probes += 1; return result; },
      sleep: () => assert.fail('Permanent failure must never sleep'), report: () => {},
    }));
    assert.equal(probes, 1);
  }
  for (const policy of [{ budgetMs: 0 }, { budgetMs: 600_001 }, { delayMs: 0 }, { delayMs: 700_000 }]) {
    await assert.rejects(waitForPublishedRegistry({ ...policy, expectedVersion: '1.22.2', expected,
      probe: () => assert.fail('Invalid policy must not probe'),
    }));
  }
});

const recoveryWorkflow = readFileSync(new URL('../.github/workflows/release-recovery.yml', import.meta.url), 'utf8');
const recoveryPath = fileURLToPath(new URL('../scripts/release/recovery-verify.mjs', import.meta.url));

function recoveryEvidence() {
  const input = validateRecoveryInputs({ tag: 'v1.22.3', commit: sha, runId: '12345' });
  const run = { id: input.runId, repository: { id: 99, full_name: 'ainz-dg/triad-plus-engineering-loop' },
    head_repository: { full_name: 'ainz-dg/triad-plus-engineering-loop' }, head_sha: sha, head_branch: input.tag,
    path: '.github/workflows/release.yml', event: 'release', status: 'completed', conclusion: 'failure', run_attempt: 1,
    actor: { login: 'ainz-dg' }, triggering_actor: { login: 'ainz-dg' }, created_at: '2026-11-07T15:53:20Z' };
  const release = { id: 42, tag_name: input.tag, draft: false, prerelease: false, target_commitish: 'main',
    author: { login: 'ainz-dg' }, published_at: '2026-11-07T15:53:16Z', assets: [] };
  const step = (name, number) => ({ name, number, status: 'completed', conclusion: 'success' });
  const jobs = [
    { id: 1, name: 'Validate, test, and build the exact release archive', conclusion: 'success', steps: [
      step('Pack, inspect, and smoke-install one exact archive', 13), step('Preserve the verified archive for the release event only', 14),
    ] },
    { id: 2, name: 'Publish the verified archive to npm with OIDC', conclusion: 'failure', steps: [
      step('Verify archive identity and repeat the fail-closed preflight', 6), step('Publish the exact verified archive with provenance', 7),
    ] },
  ].map((job) => ({ ...job, head_sha: sha, run_attempt: 1, run_id: input.runId, status: 'completed' }));
  const artifact = { id: 987, name: 'triad-plus-release-1.22.3-' + sha.slice(0, 12), expired: false,
    digest: 'sha256:' + 'c'.repeat(64), workflow_run: {
      id: input.runId, repository_id: 99, head_repository_id: 99, head_sha: sha, head_branch: input.tag,
    } };
  return { input, run, jobs, release, artifacts: [artifact] };
}

test('recovery rejects caller injection and every unsafe original run/Release/artifact identity', () => {
  for (const overrides of [ { tag: 'v1.22.3;echo bad' }, { commit: 'main' }, { commit: sha.toUpperCase() },
    { runId: '-1' }, { runId: '01' }, { runId: '1/../2' }, { runId: '9007199254740992' },
  ]) assert.throws(() => validateRecoveryInputs({ tag: 'v1.22.3', commit: sha, runId: '12345', ...overrides }));
  assert.equal(validateRecoverySource(recoveryEvidence()).artifact.id, 987);
  for (const mutate of [
    (e) => { e.run.id += 1; }, (e) => { e.run.head_sha = otherSha; }, (e) => { e.run.head_branch = 'v1.22.2'; },
    (e) => { e.run.repository.full_name = 'fork/repo'; }, (e) => { e.run.head_repository.full_name = 'fork/repo'; },
    (e) => { e.run.path = '.github/workflows/release-recovery.yml'; }, (e) => { e.run.event = 'workflow_dispatch'; },
    (e) => { e.run.run_attempt = 2; }, (e) => { e.run.status = 'in_progress'; }, (e) => { e.run.conclusion = 'cancelled'; },
    (e) => { e.run.actor.login = 'other'; }, (e) => { e.run.triggering_actor.login = 'other'; },
    (e) => { e.jobs[0].conclusion = 'failure'; }, (e) => { e.jobs[1].steps[1].conclusion = 'failure'; },
    (e) => { e.jobs[1].steps[0].conclusion = 'skipped'; }, (e) => { e.jobs[1].steps[0].number = 9; },
    (e) => { e.jobs.push(e.jobs[0]); }, (e) => { e.jobs[0].head_sha = otherSha; },
    (e) => { e.release.tag_name = 'v1.22.2'; }, (e) => { e.release.prerelease = true; },
    (e) => { e.release.author.login = 'other'; }, (e) => { e.release.target_commitish = otherSha; },
    (e) => { e.release.published_at = '2026-11-08T00:00:00Z'; }, (e) => { e.release.published_at = 'invalid'; },
    (e) => { e.artifacts = []; }, (e) => { e.artifacts.push(e.artifacts[0]); },
    (e) => { e.artifacts[0].expired = true; }, (e) => { delete e.artifacts[0].digest; },
    (e) => { e.artifacts[0].workflow_run.id += 1; }, (e) => { e.artifacts[0].workflow_run.head_sha = otherSha; },
    (e) => { e.artifacts[0].workflow_run.repository_id = 1; },
  ]) {
    const evidence = recoveryEvidence();
    mutate(evidence);
    assert.throws(() => validateRecoverySource(evidence), String(mutate));
  }
});

function recoveryLogs(evidence, archive, zip) {
  const { input, artifacts: [artifact] } = evidence;
  artifact.digest = 'sha256:' + createHash('sha256').update(zip).digest('hex');
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const sidecar = Buffer.from(archiveSha256 + '  triad-plus-1.22.3.tgz\n');
  const expected = { archiveSha256, sidecarSha256: createHash('sha256').update(sidecar).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), shasum: createHash('sha1').update(archive).digest('hex') };
  const gateLogs = [
    'Release gate passed for ' + input.tag + ' at ' + input.commit + '.',
    'Verified tarball: triad-plus-1.22.3.tgz sha256=' + archiveSha256 + ' integrity=' + expected.integrity + '.',
    'SHA256 digest of uploaded artifact zip is ' + artifact.digest.slice(7),
    'Artifact ' + artifact.name + '.zip successfully finalized. Artifact ID ' + artifact.id,
  ].join('\n');
  const publishLogs = [
    '  EXPECTED_ARCHIVE_SHA256: ' + archiveSha256, '  EXPECTED_SIDECAR_SHA256: ' + expected.sidecarSha256,
    '  EXPECTED_INTEGRITY: ' + expected.integrity, '  EXPECTED_SHASUM: ' + expected.shasum,
    'Verified release artifact bytes: triad-plus-1.22.3.tgz sha256=' + archiveSha256 + '.', '+ triad-plus@1.22.3',
  ].join('\n');
  return { gateLogs, publishLogs, expected, sidecar };
}

test('original log anchors and all four byte hashes reject substitution and missing evidence', () => {
  const evidence = recoveryEvidence();
  const archive = Buffer.from('original-archive');
  const logs = recoveryLogs(evidence, archive, Buffer.from('original-zip'));
  const params = { input: evidence.input, artifact: evidence.artifacts[0], ...logs };
  assert.deepEqual(originalChecksums(params), logs.expected);
  assert.deepEqual(verifyRecoveryBytes({ archive, sidecar: logs.sidecar, version: '1.22.3', expected: logs.expected }), logs.expected);
  for (const override of [
    { gateLogs: '' }, { publishLogs: '' }, { artifact: { ...params.artifact, id: 988 } },
    { artifact: { ...params.artifact, digest: 'sha256:' + 'd'.repeat(64) } },
    { publishLogs: logs.publishLogs + '\n  EXPECTED_SHASUM: ' + 'd'.repeat(40) },
    { gateLogs: logs.gateLogs.replace(sha, otherSha) },
    { publishLogs: logs.publishLogs.replace('+ triad-plus@1.22.3', '+ triad-plus@1.22.2') },
  ]) assert.throws(() => originalChecksums({ ...params, ...override }));
  for (const override of [
    { archive: Buffer.from('modified') }, { sidecar: Buffer.from('modified') }, { version: '1.22.2' },
    ...Object.keys(logs.expected).map((key) => ({ expected: { ...logs.expected, [key]: 'wrong' } })),
  ]) assert.throws(() => verifyRecoveryBytes({ archive, sidecar: logs.sidecar, version: '1.22.3', expected: logs.expected, ...override }));
});

test('recovery workflow has only read permissions and one fixed verification entry with no input interpolation in shell', () => {
  assert.match(recoveryWorkflow, /workflow_dispatch:/);
  // Invalid dispatch contexts must reach the JS guard and fail, never skip the job.
  assert.doesNotMatch(recoveryWorkflow, /^\s+if:/m);
  assert.doesNotMatch(recoveryWorkflow, /^\s*(release|push|pull_request|workflow_run|schedule):/m);
  assert.match(recoveryWorkflow, /permissions:\n  contents: read\n  actions: read/);
  assert.doesNotMatch(recoveryWorkflow, /:\s*write|id-token:|secrets\.|npm publish|gh release|git tag|upload-artifact|workflow_call/);
  assert.match(recoveryWorkflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(recoveryWorkflow, /persist-credentials: false/);
  assert.deepEqual(recoveryWorkflow.match(/^\s+run: .+$/gm)?.map((line) => line.trim()), ['run: node scripts/release/recovery-verify.mjs']);
  assert.equal((recoveryWorkflow.match(/^\s+uses:/gm) || []).length, 2);
});

function createRecoveryCliFixture(root) {
  const evidence = recoveryEvidence();
  const bin = join(root, 'bin');
  const contents = join(root, 'contents');
  const packed = join(root, 'packed');
  mkdirSync(bin);
  mkdirSync(join(contents, 'package'), { recursive: true });
  mkdirSync(packed);
  writeFileSync(join(contents, 'package/package.json'), JSON.stringify({ name: 'triad-plus', version: '1.22.3' }));
  const name = 'triad-plus-1.22.3.tgz';
  assert.equal(spawnSync('tar', ['-czf', join(packed, name), '-C', contents, 'package']).status, 0);
  const archive = readFileSync(join(packed, name));
  const provisional = recoveryLogs(evidence, archive, Buffer.from('provisional'));
  writeFileSync(join(packed, name + '.sha256'), provisional.sidecar);
  const zipPath = join(root, 'original.zip');
  assert.equal(spawnSync('zip', ['-q', zipPath, name, name + '.sha256'], { cwd: packed }).status, 0);
  const logs = recoveryLogs(evidence, archive, readFileSync(zipPath));
  const statePath = join(root, 'state.json');
  const logPath = join(root, 'commands.jsonl');
  const state = { ...evidence, ...logs, zipPath, name, packed };
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  save();
  writeFileSync(logPath, '');
  writeExecutable(join(bin, 'git'), `
    const { appendFileSync } = require('node:fs');
    const args = process.argv.slice(2);
    appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ bin: 'git', args }) + '\\n');
    if (args[0] === 'rev-parse') process.stdout.write('${sha}\\n');
    else if (args[0] === 'ls-remote') process.stdout.write((process.env.WRONG_TAG_SHA || '${sha}') + '\\trefs/tags/v1.22.3\\n');
    else if (args.join(' ') !== 'merge-base --is-ancestor ${sha} origin/main') process.exit(2);
  `);
  writeExecutable(join(bin, 'gh'), `
    const { appendFileSync, readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const args = process.argv.slice(2);
    const s = JSON.parse(readFileSync(process.env.RECOVERY_STATE, 'utf8'));
    appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ bin: 'gh', args }) + '\\n');
    if (args[0] !== 'api' || args[1] !== '--method' || args[2] !== 'GET') process.exit(90);
    const path = args.at(-1);
    if (s.ghFailure && path.endsWith(s.ghFailure.path)) {
      if (s.ghFailure.stdout) process.stdout.write(s.ghFailure.stdout);
      if (s.ghFailure.stderr) process.stderr.write(s.ghFailure.stderr);
      process.exit(s.ghFailure.status);
    }
    let value;
    if (path.endsWith('/actions/runs/12345')) value = s.run;
    else if (path.endsWith('/releases/tags/v1.22.3')) value = s.release;
    else if (path.includes('/attempts/1/jobs?')) value = { total_count: s.jobs.length, jobs: s.jobs };
    else if (path.includes('/12345/artifacts?')) value = { total_count: s.artifacts.length, artifacts: s.artifacts };
    else if (path.endsWith('/jobs/1/logs')) value = s.gateLogs;
    else if (path.endsWith('/jobs/2/logs')) value = s.publishLogs;
    else if (path.endsWith('/artifacts/987/zip')) { process.stdout.write(readFileSync(s.zipPath)); process.exit(0); }
    else if (path.endsWith('/releases/assets/11')) { process.stdout.write(readFileSync(join(s.packed, s.name))); process.exit(0); }
    else if (path.endsWith('/releases/assets/12')) { process.stdout.write(readFileSync(join(s.packed, s.name + '.sha256'))); process.exit(0); }
    else process.exit(91);
    process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
  `);
  writeExecutable(join(bin, 'npm'), `
    const { appendFileSync, readFileSync } = require('node:fs');
    const args = process.argv.slice(2);
    const s = JSON.parse(readFileSync(process.env.RECOVERY_STATE, 'utf8'));
    appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ bin: 'npm', args }) + '\\n');
    if (args[0] !== 'view') process.exit(92);
    if (s.npmError) { process.stderr.write(s.npmError); process.exit(1); }
    process.stdout.write(JSON.stringify(s.npmMetadata || { version: '1.22.3', dist: s.expected }));
  `);
  return { state, save, run(overrides = {}) {
    return spawnSync(process.execPath, ['--import', writeImmediateTimerHook(root), recoveryPath], { cwd: root, encoding: 'utf8', env: {
      ...process.env, PATH: bin + ':' + process.env.PATH, COMMAND_LOG: logPath, RECOVERY_STATE: statePath,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
      GITHUB_ACTOR: 'ainz-dg', GITHUB_REPOSITORY: 'ainz-dg/triad-plus-engineering-loop',
      RELEASE_TAG: 'v1.22.3', EXPECTED_COMMIT: sha, ORIGINAL_RUN_ID: '12345', ...overrides,
    } });
  }, commands: () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

test('recovery CLI may run twice, verifies existing asset bytes, and cannot invoke any publisher', () => {
  const root = mkdtempSync(join(tmpdir(), 'triad-recovery-cli-'));
  try {
    const fixture = createRecoveryCliFixture(root);
    const first = fixture.run();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /VERIFIED v1.22.3/);
    assert.match(first.stdout, /Original run 12345 remains failure/);
    assert.match(first.stdout, /Missing GitHub Release assets: triad-plus-1.22.3.tgz/);
    fixture.state.release.assets = [
      { id: 11, name: fixture.state.name, digest: 'sha256:' + fixture.state.expected.archiveSha256 },
      { id: 12, name: fixture.state.name + '.sha256', digest: 'sha256:' + fixture.state.expected.sidecarSha256 },
    ];
    fixture.save();
    const second = fixture.run();
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /Missing GitHub Release assets: none/);
    assert.equal(fixture.commands().filter(({ bin }) => bin === 'npm').length, 2);
    for (const { bin, args } of fixture.commands()) {
      if (bin === 'npm') { assert.equal(args[0], 'view'); assert.ok(args.includes('--prefer-online')); }
      if (bin === 'gh') assert.deepEqual(args.slice(0, 3), ['api', '--method', 'GET']);
      if (bin === 'git') assert.ok(['rev-parse', 'merge-base', 'ls-remote'].includes(args[0]));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovery CLI blocks unavailable or modified evidence and all npm mismatches without fallback', () => {
  const scenarios = [
    { mutate: (s) => { s.run.id += 1; } },
    { env: { WRONG_TAG_SHA: otherSha } },
    { env: { EXPECTED_COMMIT: otherSha } },
    { mutate: (s) => { s.artifacts = []; } },
    { mutate: (s) => { s.publishLogs = ''; } },
    { mutate: (s) => { writeFileSync(s.zipPath, 'modified artifact'); } },
    { mutate: (s) => { s.release.assets = [{ id: 11, name: s.name, digest: 'sha256:' + 'f'.repeat(64) }]; } },
    { mutate: (s) => { s.npmMetadata = { version: '1.22.2', dist: s.expected }; }, npm: true },
    { mutate: (s) => { s.npmMetadata = { version: '1.22.3', dist: { ...s.expected, integrity: 'wrong' } }; }, npm: true },
    { mutate: (s) => { s.npmMetadata = { version: '1.22.3', dist: { ...s.expected, shasum: 'wrong' } }; }, npm: true },
    { mutate: (s) => { s.npmError = 'E401'; }, npm: true },
    { mutate: (s) => { s.npmError = 'E404'; }, waiting: true },
    { mutate: (s) => {
      s.release.assets = [{ id: 11, name: s.name, digest: 'sha256:' + s.expected.archiveSha256 }];
      writeFileSync(join(s.packed, s.name), 'modified Release asset bytes');
    } },
  ];
  for (const scenario of scenarios) {
    const root = mkdtempSync(join(tmpdir(), 'triad-recovery-reject-'));
    try {
      const fixture = createRecoveryCliFixture(root);
      scenario.mutate?.(fixture.state);
      fixture.save();
      const rejected = fixture.run(scenario.env);
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.match(rejected.stdout, scenario.waiting ? /WAITING\/NOT YET VISIBLE/ : /BLOCKED\/MISMATCH/);
      assert.equal(fixture.commands().filter(({ bin }) => bin === 'npm').length, scenario.waiting ? 40 : scenario.npm ? 1 : 0);
      assert.ok(fixture.commands().every(({ bin, args }) => bin !== 'npm' || args[0] === 'view'));
      assert.ok(fixture.commands().every(({ bin, args }) => bin !== 'gh' || args[2] === 'GET'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('invalid recovery dispatch contexts fail explicitly before any external command', () => {
  const root = mkdtempSync(join(tmpdir(), 'triad-recovery-context-'));
  try {
    const fixture = createRecoveryCliFixture(root);
    for (const env of [
      { GITHUB_EVENT_NAME: 'push' },
      { GITHUB_REF: 'refs/heads/feature' },
      { GITHUB_REPOSITORY: 'fork/triad-plus-engineering-loop' },
      { GITHUB_ACTOR: 'other-owner' },
    ]) {
      const rejected = fixture.run(env);
      assert.equal(rejected.status, 1, JSON.stringify(env) + ': ' + rejected.stdout + rejected.stderr);
      assert.match(rejected.stdout, /BLOCKED\/MISMATCH: Recovery requires owner dispatch on the canonical repository main branch/);
      assert.deepEqual(fixture.commands(), [], 'Invalid context must fail before GitHub, git, or npm access');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('recovery diagnoses the first failed GET and never prints raw response diagnostics', () => {
  const paths = [
    'actions/runs/12345',
    'releases/tags/v1.22.3',
    'actions/runs/12345/attempts/1/jobs?per_page=100',
    'actions/runs/12345/artifacts?per_page=100',
    'actions/jobs/1/logs',
    'actions/jobs/2/logs',
    'actions/artifacts/987/zip',
    'releases/assets/11',
    'releases/assets/12',
  ];
  for (const [index, path] of paths.entries()) {
    const root = mkdtempSync(join(tmpdir(), 'triad-recovery-get-failure-'));
    try {
      const fixture = createRecoveryCliFixture(root);
      fixture.state.release.assets = [
        { id: 11, name: fixture.state.name, digest: 'sha256:' + fixture.state.expected.archiveSha256 },
        { id: 12, name: fixture.state.name + '.sha256', digest: 'sha256:' + fixture.state.expected.sidecarSha256 },
      ];
      fixture.state.ghFailure = { path, status: 1,
        stdout: '{"private":"response-body-sentinel"}',
        stderr: 'Authorization: Bearer token-sentinel\nhttps://secret.invalid/file?signature=signed-url-sentinel\n'
          + 'gh: Resource not accessible by integration (HTTP 403)\n',
      };
      fixture.save();
      const rejected = fixture.run();
      const output = rejected.stdout + rejected.stderr;
      assert.equal(rejected.status, 1);
      assert.ok(output.includes('BLOCKED/MISMATCH: Read-only gh GET /repos/ainz-dg/triad-plus-engineering-loop/' + path + ' failed'));
      assert.match(output, /exit=1, http_status=403, http_class=4xx, error=nonzero-exit/);
      assert.doesNotMatch(output, /token-sentinel|signed-url-sentinel|response-body-sentinel|Authorization|secret\.invalid/);
      assert.doesNotMatch(output, /VERIFIED/);
      const calls = fixture.commands().filter(({ bin }) => bin === 'gh');
      assert.equal(calls.length, index + 1, 'Failure must stop at the first failing GET');
      assert.equal(calls.at(-1).args.at(-1), 'repos/ainz-dg/triad-plus-engineering-loop/' + path);
      assert.ok(calls.every(({ args }) => args[2] === 'GET'));
      assert.equal(fixture.commands().filter(({ bin }) => bin === 'npm').length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('recovery diagnostics distinguish gh HTTP classes, unknown errors, and malformed JSON without exposing bodies', () => {
  const root = mkdtempSync(join(tmpdir(), 'triad-recovery-get-status-'));
  try {
    const fixture = createRecoveryCliFixture(root);
    for (const [status, stderr, expected] of [
      [1, 'gh: HTTP 404: hidden-response-sentinel (https://secret.invalid)\n', /http_status=404, http_class=4xx/],
      [1, 'gh: hidden-response-sentinel (HTTP 429)\n', /http_status=429, http_class=4xx/],
      [1, 'gh: hidden-response-sentinel (HTTP 503)\n', /http_status=503, http_class=5xx/],
      [4, 'no HTTP status hidden-response-sentinel', /exit=4, http_status=unknown, http_class=unknown/],
      [0, '', /returned invalid JSON/],
    ]) {
      fixture.state.ghFailure = { path: 'actions/runs/12345', status, stderr,
        stdout: 'malformed-json-with-hidden-response-sentinel',
      };
      fixture.save();
      const rejected = fixture.run();
      const output = rejected.stdout + rejected.stderr;
      assert.equal(rejected.status, 1);
      assert.match(output, /BLOCKED\/MISMATCH: Read-only gh GET \/repos\/ainz-dg\/triad-plus-engineering-loop\/actions\/runs\/12345/);
      assert.match(output, expected);
      assert.doesNotMatch(output, /hidden-response-sentinel|secret\.invalid/);
      assert.doesNotMatch(output, /VERIFIED/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
