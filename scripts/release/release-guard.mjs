import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash as cryptoCreateHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export const RELEASE_VERSION = '1.22.1';
export const PACKAGE_NAME = 'triad-plus';
export const RELEASE_TAG = 'v' + RELEASE_VERSION;

function fail(message) {
  throw new Error(message);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    return fail(label + ' did not return valid JSON.');
  }
}

function parseVersion(value) {
  const match = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function validateDispatchContext({
  eventName,
  ref,
  sha,
  expectedSha,
  mainSha,
  version,
  packageVersion,
  mode,
  actor,
  trustedPublisherConfirmed,
  nodeVersion,
  npmVersion,
}) {
  if (eventName !== 'workflow_dispatch') fail('Only a manual workflow_dispatch is accepted.');
  if (ref !== 'refs/heads/main') fail('Release dispatch must use refs/heads/main.');
  if (!/^[0-9a-f]{40}$/i.test(expectedSha || '')) fail('Expected main commit must be a full 40-character SHA.');
  if (!/^[0-9a-f]{40}$/i.test(sha || '') || sha !== expectedSha) fail('Expected main commit must exactly match this run SHA.');
  if (mainSha !== sha) fail('origin/main moved or does not match this run SHA; dispatch again against the exact current main commit.');
  if (version !== RELEASE_VERSION || packageVersion !== RELEASE_VERSION || version !== packageVersion) {
    fail('This workflow only accepts package version ' + RELEASE_VERSION + '.');
  }
  if (!['dry-run', 'publish'].includes(mode)) fail('Mode must be dry-run or publish.');
  if (mode === 'publish' && actor !== 'ainz-dg') fail('Only the repository owner account ainz-dg may dispatch publish mode.');
  if (mode === 'publish' && trustedPublisherConfirmed !== true) {
    fail('Publish mode requires explicit confirmation that npm Trusted Publisher is configured.');
  }
  if (!String(nodeVersion || '').startsWith('v24.')) fail('Release jobs require Node 24.');
  if (compareVersions(npmVersion, '11.5.1') === null || compareVersions(npmVersion, '11.5.1') < 0) {
    fail('Trusted Publishing requires npm 11.5.1 or newer.');
  }
  return true;
}

export function classifyNpmVersionProbe(result, version) {
  if (result.status === 0) {
    const value = parseJson(result.stdout, 'npm view');
    const publishedVersion = typeof value === 'string' ? value : value?.version;
    if (publishedVersion !== version) fail('npm returned unexpected version metadata; stopping closed.');
    return { present: true, version: publishedVersion };
  }
  const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
  if (/E404|No match found for version/i.test(output)) return { present: false };
  fail('npm registry preflight failed for a reason other than a missing version; stopping closed.');
}

export function classifyNpmMetadataProbe(result, version) {
  if (result.status !== 0) {
    const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
    if (/E404|No match found for version/i.test(output)) fail('Expected npm version ' + version + ' is not present after publish.');
    fail('Could not read npm registry metadata; stopping closed.');
  }
  const value = parseJson(result.stdout, 'npm view');
  return normalizeNpmMetadata(value, version);
}

export function normalizeNpmMetadata(value, expectedVersion) {
  let metadata = value;
  if (Array.isArray(metadata)) {
    if (metadata.length !== 1) fail('npm registry metadata must contain exactly one version record.');
    [metadata] = metadata;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail('npm registry metadata must be one JSON object.');
  }
  if (metadata.version !== expectedVersion) {
    fail('npm registry returned an unexpected version; expected ' + expectedVersion + '.');
  }
  if (metadata.dist !== undefined && (!metadata.dist || typeof metadata.dist !== 'object' || Array.isArray(metadata.dist))) {
    fail('npm registry dist metadata must be a JSON object when present.');
  }
  const field = (dottedKey, nestedKey, label) => {
    const candidates = [metadata[dottedKey], metadata.dist?.[nestedKey]].filter((candidate) => candidate !== undefined);
    if (candidates.length === 0 || candidates.some((candidate) => typeof candidate !== 'string' || candidate.trim() === '')) {
      fail('npm registry metadata is missing a valid ' + label + '.');
    }
    if (candidates.length === 2 && candidates[0] !== candidates[1]) {
      fail('npm registry metadata has conflicting ' + label + ' values.');
    }
    return candidates[0];
  };
  return {
    version: metadata.version,
    integrity: field('dist.integrity', 'integrity', 'dist.integrity'),
    shasum: field('dist.shasum', 'shasum', 'dist.shasum'),
  };
}

export function classifyTagProbe(result) {
  if (result.status === 0 && String(result.stdout || '').trim()) {
    return { present: true, refs: String(result.stdout).trim().split('\n') };
  }
  if (result.status === 2 && !String(result.stdout || '').trim()) return { present: false };
  fail('Git tag preflight failed; stopping closed.');
}

export function classifyReleaseProbe(result) {
  if (result.status === 0) return { present: true };
  const output = (String(result.stdout || '') + '\n' + String(result.stderr || '')).toLowerCase();
  if (output.includes('release not found') || output.includes('http 404')) return { present: false };
  fail('GitHub Release preflight failed for a reason other than not found; stopping closed.');
}

export function assertNoConflicts({ npm, tag, release }) {
  if (npm.present) fail('npm version ' + RELEASE_VERSION + ' already exists; immutable versions are never overwritten.');
  if (tag.present) fail('Git tag ' + RELEASE_TAG + ' already exists; tags are never moved or replaced.');
  if (release.present) fail('GitHub Release ' + RELEASE_TAG + ' already exists; releases are never overwritten.');
  return true;
}

export function assertPublishedRegistry(metadata, expected) {
  if (!expected?.integrity || !expected?.shasum) fail('Expected npm integrity metadata is missing; stopping closed.');
  if (metadata.version !== RELEASE_VERSION) fail('Published npm version does not match the approved release version.');
  if (metadata.integrity !== expected.integrity || metadata.shasum !== expected.shasum) {
    fail('Published npm integrity or shasum does not match the verified tarball; stop for manual recovery.');
  }
  return true;
}

export function assertReleaseMetadata(release, expected) {
  if (!expected?.archiveSha256 || !expected?.sidecarSha256) fail('Expected GitHub asset digests are missing; stopping closed.');
  if (release.tag_name !== RELEASE_TAG || release.draft === true || release.prerelease === true) {
    fail('GitHub Release metadata is not the expected published release.');
  }
  const names = (release.assets || []).map((asset) => asset.name).sort();
  const expectedNames = [PACKAGE_NAME + '-' + RELEASE_VERSION + '.tgz', PACKAGE_NAME + '-' + RELEASE_VERSION + '.tgz.sha256'].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) fail('GitHub Release must contain exactly the two approved assets.');
  const digests = new Map((release.assets || []).map((asset) => [asset.name, asset.digest]));
  if (digests.get(expectedNames[0]) !== 'sha256:' + expected.archiveSha256
    || digests.get(expectedNames[1]) !== 'sha256:' + expected.sidecarSha256) {
    fail('GitHub Release asset digests do not match the verified archive and checksum sidecar.');
  }
  return true;
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', ...options });
  if (result.error) fail('Could not run ' + bin + ': ' + result.error.message);
  return result;
}

function commandOrFail(bin, args, options = {}) {
  const result = command(bin, args, options);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-2000);
    fail(bin + ' failed with exit ' + result.status + (detail ? ': ' + detail : '.'));
  }
  return result.stdout;
}

function runDispatchValidation() {
  const packageVersion = parseJson(readFileSync('package.json', 'utf8'), 'package.json').version;
  const mainOutput = commandOrFail('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
  const mainSha = mainOutput.trim().split(/\s+/)[0];
  const npmVersion = commandOrFail('npm', ['--version']).trim();
  validateDispatchContext({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    expectedSha: process.env.EXPECTED_COMMIT,
    mainSha,
    version: process.env.RELEASE_VERSION,
    packageVersion,
    mode: process.env.RELEASE_MODE,
    actor: process.env.DISPATCH_ACTOR,
    trustedPublisherConfirmed: String(process.env.TRUSTED_PUBLISHER_CONFIRMED).toLowerCase() === 'true',
    nodeVersion: process.version,
    npmVersion,
  });
  return { packageVersion, npmVersion };
}

function probeNpmVersion() {
  return classifyNpmVersionProbe(command('npm', ['view', PACKAGE_NAME + '@' + RELEASE_VERSION, 'version', '--json']), RELEASE_VERSION);
}

function probeNpmMetadata() {
  return classifyNpmMetadataProbe(command('npm', [
    'view',
    PACKAGE_NAME + '@' + RELEASE_VERSION,
    'version',
    'dist.integrity',
    'dist.shasum',
    '--json',
  ]), RELEASE_VERSION);
}

function probeTag() {
  return classifyTagProbe(command('git', [
    'ls-remote',
    '--exit-code',
    'origin',
    'refs/tags/' + RELEASE_TAG,
    'refs/tags/' + RELEASE_TAG + '^{}',
  ]));
}

function probeRelease() {
  return classifyReleaseProbe(command('gh', ['release', 'view', RELEASE_TAG, '--json', 'tagName'], {
    env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN },
  }));
}

function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n';
  appendFileSync(process.env.GITHUB_OUTPUT, lines);
}

function buildAndInspectPackage() {
  const packageJson = parseJson(readFileSync('package.json', 'utf8'), 'package.json');
  if (packageJson.name !== PACKAGE_NAME || packageJson.version !== RELEASE_VERSION) {
    fail('Cannot pack an unexpected package name or version.');
  }
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'triad-plus-release-'));
  const packedOutput = commandOrFail('npm', ['pack', '--json', '--pack-destination', root]);
  const metadata = parseJson(packedOutput, 'npm pack');
  const pack = Array.isArray(metadata) ? metadata[0] : null;
  const expectedName = PACKAGE_NAME + '-' + RELEASE_VERSION + '.tgz';
  if (!pack || pack.filename !== expectedName || pack.name !== PACKAGE_NAME || pack.version !== RELEASE_VERSION) {
    fail('npm pack did not produce the exact expected tarball name and package identity.');
  }
  const archive = join(root, expectedName);
  const tarballManifest = parseJson(commandOrFail('tar', ['-xOf', archive, 'package/package.json']), 'tarball package.json');
  if (tarballManifest.name !== PACKAGE_NAME || tarballManifest.version !== RELEASE_VERSION) {
    fail('Tarball manifest does not match the approved package identity.');
  }
  const filePaths = new Set((pack.files || []).map((file) => file.path));
  for (const required of ['package.json', 'bin/triad-plus.js', 'cockpit/dist/index.html']) {
    if (!filePaths.has(required)) fail('Tarball is missing required package file: ' + required);
  }
  if ([...filePaths].some((file) => file === '.npmrc' || file.endsWith('/.npmrc'))) {
    fail('Tarball unexpectedly contains npm configuration.');
  }
  const archiveBytes = readFileSync(archive);
  const archiveSha256 = cryptoCreateHash('sha256').update(archiveBytes).digest('hex');
  const sidecar = archive + '.sha256';
  const sidecarText = archiveSha256 + '  ' + expectedName + '\n';
  writeFileSync(sidecar, sidecarText, { flag: 'wx' });
  const sidecarSha256 = cryptoCreateHash('sha256').update(readFileSync(sidecar)).digest('hex');
  const installRoot = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'triad-plus-install-smoke-'));
  commandOrFail('npm', [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-save',
    '--prefix',
    installRoot,
    archive,
  ]);
  const installedManifest = parseJson(readFileSync(join(installRoot, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'), 'installed package.json');
  if (installedManifest.name !== PACKAGE_NAME || installedManifest.version !== RELEASE_VERSION) {
    fail('Isolated tarball install has the wrong package identity.');
  }
  const smoke = commandOrFail(process.execPath, [
    join(installRoot, 'node_modules', PACKAGE_NAME, 'bin', 'triad-plus.js'),
    '--version',
  ]);
  if (smoke.trim() !== RELEASE_VERSION) fail('Installed tarball CLI smoke returned an unexpected version.');
  if (!pack.integrity || !/^sha512-/.test(pack.integrity) || !/^[0-9a-f]{40}$/i.test(pack.shasum || '')) {
    fail('npm pack did not return valid integrity and shasum metadata.');
  }
  const sha = process.env.GITHUB_SHA || 'local';
  const artifactName = 'triad-plus-v' + RELEASE_VERSION + '-' + sha.slice(0, 12);
  const outputs = {
    artifact_name: artifactName,
    tarball_name: expectedName,
    tarball_path: archive,
    sidecar_path: sidecar,
    sha256: archiveSha256,
    sidecar_sha256: sidecarSha256,
    integrity: pack.integrity,
    shasum: pack.shasum,
  };
  writeOutputs(outputs);
  return outputs;
}

function runGate(mode) {
  const context = runDispatchValidation();
  if (mode === 'publish-preflight' && process.env.RELEASE_MODE !== 'publish') {
    fail('npm publish preflight only runs in explicit publish mode.');
  }
  const conflicts = { npm: probeNpmVersion(), tag: probeTag(), release: probeRelease() };
  if (mode !== 'release-preflight') {
    assertNoConflicts(conflicts);
  } else {
    const registry = probeNpmMetadata();
    assertPublishedRegistry(registry, {
      integrity: process.env.EXPECTED_INTEGRITY,
      shasum: process.env.EXPECTED_SHASUM,
    });
    if (conflicts.tag.present) fail('Git tag already exists before the release job; stop for recovery.');
    if (conflicts.release.present) fail('GitHub Release already exists before the release job; stop for recovery.');
  }
  console.log('Release preflight passed: version ' + RELEASE_VERSION + ', npm ' + context.npmVersion + ', mode ' + process.env.RELEASE_MODE + '.');
}

function verifyRegistry() {
  const registry = normalizeNpmMetadata(
    parseJson(readFileSync(process.env.REGISTRY_JSON_PATH, 'utf8'), 'npm registry metadata'),
    RELEASE_VERSION,
  );
  assertPublishedRegistry(registry, {
    integrity: process.env.EXPECTED_INTEGRITY,
    shasum: process.env.EXPECTED_SHASUM,
  });
  console.log('npm registry identity verified: ' + RELEASE_VERSION + ' ' + registry.integrity + '.');
}

function verifyRelease() {
  const release = parseJson(readFileSync(process.env.RELEASE_JSON_PATH, 'utf8'), 'GitHub Release metadata');
  assertReleaseMetadata(release, {
    archiveSha256: process.env.EXPECTED_ARCHIVE_SHA256,
    sidecarSha256: process.env.EXPECTED_SIDECAR_SHA256,
  });
  console.log('GitHub Release tag and exact asset digests verified.');
}

function verifyArtifact() {
  const directory = process.env.ARTIFACT_DIR;
  const expectedName = PACKAGE_NAME + '-' + RELEASE_VERSION + '.tgz';
  if (!directory) fail('Artifact directory is required.');
  const archive = join(directory, expectedName);
  const sidecar = archive + '.sha256';
  const archiveSha256 = cryptoCreateHash('sha256').update(readFileSync(archive)).digest('hex');
  const sidecarBytes = readFileSync(sidecar);
  const sidecarSha256 = cryptoCreateHash('sha256').update(sidecarBytes).digest('hex');
  const sidecarText = sidecarBytes.toString('utf8');
  if (archiveSha256 !== process.env.EXPECTED_ARCHIVE_SHA256
    || sidecarSha256 !== process.env.EXPECTED_SIDECAR_SHA256
    || sidecarText !== archiveSha256 + '  ' + expectedName + '\n') {
    fail('Release artifact bytes or checksum sidecar differ from the verified tarball.');
  }
  console.log('Verified release artifact bytes: ' + expectedName + ' sha256=' + archiveSha256 + '.');
}

function main() {
  const mode = process.argv[2];
  if (mode === 'gate' || mode === 'publish-preflight' || mode === 'release-preflight') return runGate(mode);
  if (mode === 'package') {
    const outputs = buildAndInspectPackage();
    console.log('Verified tarball: ' + outputs.tarball_name + ' sha256=' + outputs.sha256 + ' integrity=' + outputs.integrity + '.');
    return;
  }
  if (mode === 'verify-registry') return verifyRegistry();
  if (mode === 'verify-release') return verifyRelease();
  if (mode === 'verify-artifact') return verifyArtifact();
  fail('Unknown release guard mode.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error('Release guard failed closed: ' + error.message);
    process.exitCode = 1;
  }
}
