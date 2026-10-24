import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  classifyReleaseProbe,
  classifyTagProbe,
  validateDispatchContext,
} from '../scripts/release/release-guard.mjs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const ownerGuide = readFileSync(new URL('../docs/maintainers/releasing.md', import.meta.url), 'utf8');
const releaseGuardPath = fileURLToPath(new URL('../scripts/release/release-guard.mjs', import.meta.url));
const sha = 'a'.repeat(40);

function validDispatch(overrides = {}) {
  return {
    eventName: 'workflow_dispatch',
    ref: 'refs/heads/main',
    sha,
    expectedSha: sha,
    mainSha: sha,
    version: '1.22.1',
    packageVersion: '1.22.1',
    mode: 'dry-run',
    actor: 'ainz-dg',
    trustedPublisherConfirmed: false,
    nodeVersion: 'v24.1.0',
    npmVersion: '11.5.1',
    ...overrides,
  };
}

test('dispatch accepts only the exact approved main commit and prepared package version', () => {
  assert.equal(validateDispatchContext(validDispatch()), true);
  for (const overrides of [
    { ref: 'refs/heads/feature/release' },
    { expectedSha: 'b'.repeat(40) },
    { mainSha: 'c'.repeat(40) },
    { version: '1.22.2' },
    { packageVersion: '1.22.0' },
    { eventName: 'push' },
    { nodeVersion: 'v22.14.0' },
    { npmVersion: '11.5.0' },
  ]) {
    assert.throws(() => validateDispatchContext(validDispatch(overrides)));
  }
});

test('publish mode requires a positive Trusted Publisher confirmation while dry-run does not', () => {
  assert.equal(validateDispatchContext(validDispatch({ mode: 'publish', trustedPublisherConfirmed: true })), true);
  assert.throws(() => validateDispatchContext(validDispatch({ mode: 'publish', trustedPublisherConfirmed: false })), /Trusted Publisher/);
  assert.throws(() => validateDispatchContext(validDispatch({ mode: 'publish', trustedPublisherConfirmed: true, actor: 'contributor' })), /Only the repository owner/);
});

test('npm duplicate probe treats only a real 404 as absence and fails closed on network errors', () => {
  assert.deepEqual(classifyNpmVersionProbe({ status: 0, stdout: '"1.22.1"', stderr: '' }, '1.22.1'), { present: true, version: '1.22.1' });
  assert.deepEqual(classifyNpmVersionProbe({ status: 1, stdout: '', stderr: 'npm error code E404' }, '1.22.1'), { present: false });
  assert.throws(() => classifyNpmVersionProbe({ status: 1, stdout: '', stderr: 'ECONNRESET' }, '1.22.1'));
});

test('Git tag and GitHub Release duplicate probes distinguish absence from probe failure', () => {
  assert.deepEqual(classifyTagProbe({ status: 2, stdout: '', stderr: '' }), { present: false });
  assert.equal(classifyTagProbe({ status: 0, stdout: sha + '\trefs/tags/v1.22.1\n', stderr: '' }).present, true);
  assert.throws(() => classifyTagProbe({ status: 128, stdout: '', stderr: 'network failure' }));
  assert.deepEqual(classifyReleaseProbe({ status: 1, stdout: '', stderr: 'release not found' }), { present: false });
  assert.equal(classifyReleaseProbe({ status: 0, stdout: '{"tagName":"v1.22.1"}', stderr: '' }).present, true);
  assert.throws(() => classifyReleaseProbe({ status: 1, stdout: '', stderr: 'API rate limit' }));
});

test('preflight rejects any existing immutable npm version, tag, or Release', () => {
  assert.equal(assertNoConflicts({
    npm: { present: false },
    tag: { present: false },
    release: { present: false },
  }), true);
  for (const key of ['npm', 'tag', 'release']) {
    assert.throws(() => assertNoConflicts({
      npm: { present: false },
      tag: { present: false },
      release: { present: false },
      [key]: { present: true },
    }));
  }
});

test('post-publish registry metadata must match the one verified tarball', () => {
  const expected = { integrity: 'sha512-verified', shasum: 'a'.repeat(40) };
  // Captured read-only with `npx npm@11.5.1 view triad-plus@1.22.0 version dist.integrity dist.shasum --json`.
  const capturedNpm1151Output = {
    version: '1.22.0',
    'dist.integrity': 'sha512-lQXa0QmAcgV9mx5iIzzUNJEM9FDdkxsp5IEA1EOQZKo1XzCF79BtC6PAesl0RIbJhoN/39LbrL4NcBf9pkOKKg==',
    'dist.shasum': 'a197a0092ab6468be04159b32c018cabeed93cd1',
  };
  assert.deepEqual(classifyNpmMetadataProbe({
    status: 0,
    stdout: JSON.stringify(capturedNpm1151Output),
    stderr: '',
  }, '1.22.0'), {
    version: '1.22.0',
    integrity: capturedNpm1151Output['dist.integrity'],
    shasum: capturedNpm1151Output['dist.shasum'],
  });
  assert.deepEqual(classifyNpmMetadataProbe({
    status: 0,
    stdout: JSON.stringify([{ version: '1.22.0', dist: { integrity: 'sha512-nested', shasum: 'b'.repeat(40) } }]),
    stderr: '',
  }, '1.22.0'), { version: '1.22.0', integrity: 'sha512-nested', shasum: 'b'.repeat(40) });
  assert.deepEqual(classifyNpmMetadataProbe({
    status: 0,
    stdout: JSON.stringify({ ...capturedNpm1151Output, dist: { integrity: capturedNpm1151Output['dist.integrity'], shasum: capturedNpm1151Output['dist.shasum'] } }),
    stderr: '',
  }, '1.22.0'), {
    version: '1.22.0',
    integrity: capturedNpm1151Output['dist.integrity'],
    shasum: capturedNpm1151Output['dist.shasum'],
  });
  assert.throws(() => classifyNpmMetadataProbe({
    status: 0,
    stdout: JSON.stringify({ ...capturedNpm1151Output, dist: { integrity: 'sha512-conflict', shasum: 'c'.repeat(40) } }),
    stderr: '',
  }, '1.22.0'), /conflicting/);
  assert.throws(() => classifyNpmMetadataProbe({
    status: 0,
    stdout: JSON.stringify([{ version: '1.22.0' }, { version: '1.22.0' }]),
    stderr: '',
  }, '1.22.0'), /exactly one/);
  assert.throws(() => classifyNpmMetadataProbe({
    status: 0,
    stdout: JSON.stringify({ version: '1.22.0', 'dist.integrity': 'sha512-missing-shasum' }),
    stderr: '',
  }, '1.22.0'), /valid dist.shasum/);
  assert.deepEqual(classifyNpmMetadataProbe({
    status: 0,
    stdout: JSON.stringify({ version: '1.22.1', dist: expected }),
    stderr: '',
  }, '1.22.1'), { version: '1.22.1', ...expected });
  assert.equal(assertPublishedRegistry({ version: '1.22.1', ...expected }, expected), true);
  assert.throws(() => assertPublishedRegistry({ version: '1.22.1', ...expected, shasum: 'b'.repeat(40) }, expected));
  assert.throws(() => classifyNpmMetadataProbe({ status: 1, stdout: '', stderr: 'npm error code E404' }, '1.22.1'));
});

test('verify-registry command accepts dotted npm fields and fails closed on mismatches or malformed metadata', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'triad-release-verify-registry-'));
  const registryPath = join(tempDirectory, 'registry.json');
  const integrity = 'sha512-local-fixture';
  const shasum = 'a'.repeat(40);
  const runVerifyRegistry = (expectedIntegrity = integrity, expectedShasum = shasum) => spawnSync(
    process.execPath,
    [releaseGuardPath, 'verify-registry'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        REGISTRY_JSON_PATH: registryPath,
        EXPECTED_INTEGRITY: expectedIntegrity,
        EXPECTED_SHASUM: expectedShasum,
      },
    },
  );

  try {
    writeFileSync(registryPath, JSON.stringify({
      version: '1.22.1',
      'dist.integrity': integrity,
      'dist.shasum': shasum,
    }));
    const valid = runVerifyRegistry();
    assert.equal(valid.status, 0, valid.stderr);
    assert.ok(valid.stdout.includes('npm registry identity verified: 1.22.1 ' + integrity + '.'));

    const mismatched = runVerifyRegistry('sha512-wrong');
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /does not match the verified tarball/);

    writeFileSync(registryPath, JSON.stringify({ version: '1.22.1', 'dist.integrity': integrity }));
    const malformed = runVerifyRegistry();
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /missing a valid dist\.shasum/);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('post-publish release verification requires exactly two assets with matching API digests', () => {
  const release = {
    tag_name: 'v1.22.1',
    draft: false,
    prerelease: false,
    assets: [
      { name: 'triad-plus-1.22.1.tgz', digest: 'sha256:' + 'a'.repeat(64) },
      { name: 'triad-plus-1.22.1.tgz.sha256', digest: 'sha256:' + 'b'.repeat(64) },
    ],
  };
  const expected = { archiveSha256: 'a'.repeat(64), sidecarSha256: 'b'.repeat(64) };
  assert.equal(assertReleaseMetadata(release, expected), true);
  assert.throws(() => assertReleaseMetadata({ ...release, assets: [...release.assets, { name: 'extra.zip' }] }, expected));
  assert.throws(() => assertReleaseMetadata({ ...release, assets: release.assets.map((asset) => ({ ...asset, digest: 'sha256:bad' })) }, expected));
});

test('workflow is manual-only, dry-run by default, and grants write/OIDC only to isolated jobs', () => {
  const setupNodeMajors = [...workflow.matchAll(/uses:\s*actions\/setup-node@([^\s]+)/g)].map((match) => match[1]);
  assert.equal(setupNodeMajors.length, 4);
  assert.deepEqual(setupNodeMajors, ['v7', 'v7', 'v7', 'v7']);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.NPM_TOKEN/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|schedule):/m);
  assert.match(workflow, /default: dry-run/);
  assert.equal((workflow.match(/id-token:\s*write/g) || []).length, 1);
  assert.equal((workflow.match(/contents:\s*write/g) || []).length, 1);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM_TOKEN/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /node-version: '24'/);
  assert.ok(workflow.includes('DISPATCH_ACTOR: $' + '{{ github.actor }}'));
  assert.match(workflow, /npm install --global npm@11\.5\.1/);
});

test('workflow gates prevent publish on failed checks and dry-run avoids remote write steps', () => {
  const publishJob = workflow.slice(workflow.indexOf('  publish-npm:'));
  const releaseJob = workflow.slice(workflow.indexOf('  create-github-release:'));
  const gateJob = workflow.slice(workflow.indexOf('  gate:'), workflow.indexOf('  publish-npm:'));
  assert.match(publishJob, /needs: gate/);
  assert.match(publishJob, /if: \$\{\{ inputs\.mode == 'publish' \}\}/);
  assert.match(publishJob, /id-token: write/);
  assert.match(publishJob, /npm publish .*--provenance --access public/);
  assert.match(releaseJob, /needs:[\s\S]*publish-npm/);
  assert.match(releaseJob, /contents: write/);
  assert.match(gateJob, /if: \$\{\{ inputs\.mode == 'publish' \}\}[\s\S]*actions\/upload-artifact/);
  assert.doesNotMatch(gateJob, /npm publish|gh release create|git tag/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});

test('owner guide documents exact npm identity, direct publish, expiry, and partial-publish recovery', () => {
  for (const text of [
    'ainz-dg',
    'triad-plus-engineering-loop',
    'release.yml',
    'direct npm publish',
    'two days',
    'do **not** rerun the publish path',
    'static-token fallback',
  ]) assert.ok(ownerGuide.includes(text), 'missing owner guidance: ' + text);
});
