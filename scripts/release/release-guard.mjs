import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash as cryptoCreateHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export const PACKAGE_NAME = 'triad-plus';
const RELEASE_ACTOR = 'ainz-dg';
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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

export function versionFromReleaseTag(tag) {
  const match = String(tag || '').match(RELEASE_TAG_PATTERN);
  if (!match) fail('Release tag must be exactly vMAJOR.MINOR.PATCH with no prerelease or build suffix.');
  return match.slice(1).join('.');
}

function assertSha(value, label) {
  if (!SHA_PATTERN.test(value || '')) fail(label + ' must be a full 40-character commit SHA.');
  return value.toLowerCase();
}

function assertPackageIdentity({ packageName, packageVersion, version }) {
  if (packageName !== PACKAGE_NAME) fail('package.json name must be ' + PACKAGE_NAME + '.');
  if (packageVersion !== version) fail('package.json version must exactly match release tag version ' + version + '.');
}

export function validateReleaseContext({
  eventName,
  action,
  ref,
  sha,
  checkedOutSha,
  mainSha,
  tagName,
  tagSha,
  targetCommitish,
  draft,
  prerelease,
  actor,
  packageName,
  packageVersion,
}) {
  if (eventName !== 'release' || action !== 'published') {
    fail('Only a GitHub release event with action=published is accepted.');
  }
  const version = versionFromReleaseTag(tagName);
  if (ref !== 'refs/tags/' + tagName) fail('GITHUB_REF must be the exact published release tag.');
  if (draft !== false || prerelease !== false) fail('Draft and prerelease releases are rejected.');
  if (actor !== RELEASE_ACTOR) fail('Only release publisher ' + RELEASE_ACTOR + ' is authorized.');

  const eventSha = assertSha(sha, 'GITHUB_SHA');
  const checkoutSha = assertSha(checkedOutSha, 'Checked-out commit');
  const currentMainSha = assertSha(mainSha, 'Current main commit');
  const resolvedTagSha = assertSha(tagSha, 'Resolved tag commit');
  if (checkoutSha !== eventSha) fail('Checkout must use the immutable GITHUB_SHA supplied by the release event.');
  if (resolvedTagSha !== eventSha) fail('Published tag no longer resolves to the release event commit.');
  if (currentMainSha !== eventSha) fail('Release commit is not the current approved main HEAD; refusing to publish.');

  let resolvedTarget;
  if (targetCommitish === 'main') resolvedTarget = currentMainSha;
  else if (SHA_PATTERN.test(targetCommitish || '')) resolvedTarget = targetCommitish.toLowerCase();
  else fail('release.target_commitish must be main or a full commit SHA; other branch names are ambiguous.');
  if (resolvedTarget !== currentMainSha) fail('release.target_commitish does not resolve to the current main HEAD.');
  assertPackageIdentity({ packageName, packageVersion, version });
  return { tagName, version, commitSha: eventSha };
}

export function validateDispatchContext({
  eventName,
  ref,
  sha,
  checkedOutSha,
  expectedSha,
  mainSha,
  tagName,
  packageName,
  packageVersion,
}) {
  if (eventName !== 'workflow_dispatch') fail('Only the side-effect-free workflow_dispatch dry-run is accepted.');
  if (ref !== 'refs/heads/main') fail('Dry-run dispatch must use refs/heads/main.');
  const version = versionFromReleaseTag(tagName);
  const runSha = assertSha(sha, 'GITHUB_SHA');
  const checkoutSha = assertSha(checkedOutSha, 'Checked-out commit');
  const expectedMainSha = assertSha(expectedSha, 'Expected main commit');
  const currentMainSha = assertSha(mainSha, 'Current main commit');
  if (runSha !== checkoutSha || runSha !== expectedMainSha || runSha !== currentMainSha) {
    fail('Dry-run requires the exact full SHA of the current main HEAD.');
  }
  assertPackageIdentity({ packageName, packageVersion, version });
  return { tagName, version, commitSha: runSha };
}

function isMissingVersionOutput(output) {
  return /E404|No match found for version/i.test(output);
}

export function classifyNpmVersionProbe(result, version) {
  if (result.status === 0) {
    const value = parseJson(result.stdout, 'npm view');
    const publishedVersion = typeof value === 'string' ? value : value?.version;
    if (publishedVersion !== version) fail('npm returned unexpected version metadata; stopping closed.');
    return { present: true, version: publishedVersion };
  }
  const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
  if (isMissingVersionOutput(output)) return { present: false };
  fail('npm registry preflight failed for a reason other than a missing version; stopping closed.');
}

export function classifyNpmMetadataProbe(result, version) {
  if (result.status !== 0) {
    const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
    if (isMissingVersionOutput(output)) fail('Expected npm version ' + version + ' is not present after publish.');
    fail('Could not read npm registry metadata; stopping closed.');
  }
  return normalizeNpmMetadata(parseJson(result.stdout, 'npm view'), version);
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

export function assertPublishedRegistry(metadata, expectedVersion, expected) {
  if (!expected?.integrity || !expected?.shasum) fail('Expected npm integrity metadata is missing; stopping closed.');
  if (metadata.version !== expectedVersion) fail('Published npm version does not match the release tag.');
  if (metadata.integrity !== expected.integrity || metadata.shasum !== expected.shasum) {
    fail('Published npm integrity or shasum does not match the verified tarball; stop for manual recovery.');
  }
  return true;
}

export function classifyPublishedNpmProbe(result, expectedVersion, expected) {
  if (result.status !== 0) {
    const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
    if (isMissingVersionOutput(output)) return { visible: false };
    fail('npm registry verification failed for a reason other than temporary version absence; stopping closed.');
  }
  const metadata = normalizeNpmMetadata(parseJson(result.stdout, 'npm view'), expectedVersion);
  assertPublishedRegistry(metadata, expectedVersion, expected);
  return { visible: true, metadata };
}

export async function waitForPublishedRegistry({
  probe,
  expectedVersion,
  expected,
  attempts = 8,
  initialDelayMs = 5_000,
  maxDelayMs = 30_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!Number.isInteger(attempts) || attempts < 1) fail('Registry retry attempts must be a positive integer.');
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0 || !Number.isInteger(maxDelayMs) || maxDelayMs < 0) {
    fail('Registry retry delays must be non-negative integers.');
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await probe(attempt);
    const state = classifyPublishedNpmProbe(result, expectedVersion, expected);
    if (state.visible) return { ...state, attempts: attempt };
    if (attempt < attempts) {
      const delay = Math.min(maxDelayMs, initialDelayMs * (2 ** (attempt - 1)));
      await sleep(delay);
    }
  }
  fail('npm version ' + expectedVersion + ' did not become visible after ' + attempts
    + ' bounded checks; follow the documented manual recovery and do not republish.');
}

export function classifyTagProbe(result, tagName) {
  if (result.status === 2 && !String(result.stdout || '').trim()) return { present: false };
  if (result.status !== 0 || !String(result.stdout || '').trim()) fail('Git tag preflight failed; stopping closed.');

  const directRef = 'refs/tags/' + tagName;
  const peeledRef = directRef + '^{}';
  const records = String(result.stdout).trim().split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^([0-9a-f]{40})\s+(.+)$/i);
    if (!match) fail('Git tag preflight returned malformed ref data.');
    return { sha: match[1].toLowerCase(), ref: match[2] };
  });
  const direct = records.filter((record) => record.ref === directRef);
  const peeled = records.filter((record) => record.ref === peeledRef);
  if (records.some((record) => record.ref !== directRef && record.ref !== peeledRef)
    || direct.length !== 1 || peeled.length > 1 || records.length !== direct.length + peeled.length) {
    fail('Git tag preflight returned ambiguous ref data; stopping closed.');
  }
  return { present: true, objectSha: direct[0].sha, commitSha: (peeled[0] || direct[0]).sha };
}

export function assertTagCommit(tagProbe, expectedSha, tagName) {
  if (!tagProbe?.present || tagProbe.commitSha !== assertSha(expectedSha, 'Expected tag commit')) {
    fail('Git tag ' + tagName + ' does not resolve to the expected immutable commit.');
  }
  return true;
}

export function classifyReleaseProbe(result) {
  if (result.status === 0) return { present: true };
  const output = (String(result.stdout || '') + '\n' + String(result.stderr || '')).toLowerCase();
  if (output.includes('release not found') || output.includes('http 404')) return { present: false };
  fail('GitHub Release preflight failed for a reason other than not found.');
}

export function assertNoConflicts({ npm, tag, release, version, tagName }) {
  if (npm.present) fail('npm version ' + version + ' already exists; immutable versions are never overwritten.');
  if (tag.present) fail('Git tag ' + tagName + ' already exists; tags are never moved or replaced.');
  if (release.present) fail('GitHub Release ' + tagName + ' already exists; releases are never overwritten.');
  return true;
}

export function planReleaseAssetUploads(release, { tagName, archiveSha256, sidecarSha256 }) {
  const version = versionFromReleaseTag(tagName);
  if (release.tag_name !== tagName || release.draft !== false || release.prerelease !== false) {
    fail('GitHub Release metadata is not the expected published stable release.');
  }
  if (!Array.isArray(release.assets)) fail('GitHub Release asset metadata is missing or malformed.');
  const expectedAssets = new Map([
    [PACKAGE_NAME + '-' + version + '.tgz', 'sha256:' + archiveSha256],
    [PACKAGE_NAME + '-' + version + '.tgz.sha256', 'sha256:' + sidecarSha256],
  ]);
  const actual = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== 'string' || actual.has(asset.name)) {
      fail('GitHub Release has malformed or duplicate asset names.');
    }
    actual.set(asset.name, asset.digest);
  }
  for (const [name, digest] of actual) {
    if (!expectedAssets.has(name)) fail('GitHub Release contains an unexpected asset: ' + name + '.');
    if (!digest || digest !== expectedAssets.get(name)) {
      fail('Existing GitHub Release asset ' + name + ' conflicts with the verified archive; it will not be overwritten.');
    }
  }
  return { missing: [...expectedAssets.keys()].filter((name) => !actual.has(name)), expectedNames: [...expectedAssets.keys()] };
}

export function assertReleaseMetadata(release, expected) {
  const plan = planReleaseAssetUploads(release, expected);
  if (plan.missing.length > 0) fail('GitHub Release is missing one or more verified release assets.');
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

function packageManifest() {
  return parseJson(readFileSync('package.json', 'utf8'), 'package.json');
}

function workflowEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) fail('GitHub event payload path is required.');
  return parseJson(readFileSync(path, 'utf8'), 'GitHub event payload');
}

function releaseTagFromEnvironment() {
  const tagName = process.env.RELEASE_TAG;
  versionFromReleaseTag(tagName);
  return tagName;
}

function releaseTagProbe(tagName) {
  return classifyTagProbe(command('git', [
    'ls-remote',
    '--exit-code',
    'origin',
    'refs/tags/' + tagName,
    'refs/tags/' + tagName + '^{}',
  ]), tagName);
}

function currentMainSha() {
  const output = commandOrFail('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) fail('Current main preflight returned ambiguous ref data.');
  const match = lines[0].match(/^([0-9a-f]{40})\s+refs\/heads\/main$/i);
  if (!match) fail('Current main preflight returned malformed ref data.');
  return match[1].toLowerCase();
}

function checkedOutSha() {
  return commandOrFail('git', ['rev-parse', 'HEAD']).trim();
}

function currentReleaseApi(tagName) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) fail('GITHUB_REPOSITORY is missing or malformed.');
  const output = commandOrFail('gh', ['api', 'repos/' + repository + '/releases/tags/' + tagName], {
    env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN },
  });
  return parseJson(output, 'GitHub release API');
}

function eventRelease() {
  const event = workflowEvent();
  if (!event.release || typeof event.release !== 'object') fail('GitHub release event metadata is missing.');
  return event;
}

function validateReleaseEvent({ checkRegistryConflict = true } = {}) {
  const event = eventRelease();
  const payloadRelease = event.release;
  const tagName = payloadRelease.tag_name;
  const version = versionFromReleaseTag(tagName);
  if (releaseTagFromEnvironment() !== tagName) fail('RELEASE_TAG differs from the signed release event tag.');
  const packageJson = packageManifest();
  const context = validateReleaseContext({
    eventName: process.env.GITHUB_EVENT_NAME,
    action: event.action,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    checkedOutSha: checkedOutSha(),
    mainSha: currentMainSha(),
    tagName,
    tagSha: releaseTagProbe(tagName).commitSha,
    targetCommitish: payloadRelease.target_commitish,
    draft: payloadRelease.draft,
    prerelease: payloadRelease.prerelease,
    actor: process.env.GITHUB_ACTOR,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
  });
  if (!payloadRelease.id) fail('Release event is missing its immutable release ID.');
  const currentRelease = currentReleaseApi(tagName);
  if (currentRelease.id !== payloadRelease.id
    || currentRelease.tag_name !== tagName
    || currentRelease.target_commitish !== payloadRelease.target_commitish
    || currentRelease.draft !== false
    || currentRelease.prerelease !== false) {
    fail('Current GitHub Release no longer matches the stable published event; stopping closed.');
  }
  if (checkRegistryConflict) {
    const npm = classifyNpmVersionProbe(command('npm', ['view', PACKAGE_NAME + '@' + version, 'version', '--json']), version);
    if (npm.present) fail('npm version ' + version + ' already exists; immutable versions are never overwritten.');
  }
  return context;
}

function validateDispatchDryRun() {
  const tagName = releaseTagFromEnvironment();
  const version = versionFromReleaseTag(tagName);
  const packageJson = packageManifest();
  const context = validateDispatchContext({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    checkedOutSha: checkedOutSha(),
    expectedSha: process.env.EXPECTED_COMMIT,
    mainSha: currentMainSha(),
    tagName,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
  });
  const conflicts = {
    npm: classifyNpmVersionProbe(command('npm', ['view', PACKAGE_NAME + '@' + version, 'version', '--json']), version),
    tag: releaseTagProbe(tagName),
    release: classifyReleaseProbe(command('gh', ['release', 'view', tagName, '--json', 'tagName'], {
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN },
    })),
  };
  assertNoConflicts({ ...conflicts, version, tagName });
  return context;
}

function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n';
  appendFileSync(process.env.GITHUB_OUTPUT, lines);
}

function buildAndInspectPackage() {
  const tagName = releaseTagFromEnvironment();
  const version = versionFromReleaseTag(tagName);
  const packageJson = packageManifest();
  assertPackageIdentity({ packageName: packageJson.name, packageVersion: packageJson.version, version });
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'triad-plus-release-'));
  const packedOutput = commandOrFail('npm', ['pack', '--json', '--pack-destination', root]);
  const metadata = parseJson(packedOutput, 'npm pack');
  const pack = Array.isArray(metadata) ? metadata[0] : null;
  const expectedName = PACKAGE_NAME + '-' + version + '.tgz';
  if (!pack || pack.filename !== expectedName || pack.name !== PACKAGE_NAME || pack.version !== version) {
    fail('npm pack did not produce the exact expected tarball name or package identity.');
  }
  const archive = join(root, expectedName);
  const tarballManifest = parseJson(commandOrFail('tar', ['-xOf', archive, 'package/package.json']), 'tarball package.json');
  assertPackageIdentity({ packageName: tarballManifest.name, packageVersion: tarballManifest.version, version });
  const filePaths = new Set((pack.files || []).map((file) => file.path));
  for (const required of ['package.json', 'bin/triad-plus.js', 'cockpit/dist/index.html']) {
    if (!filePaths.has(required)) fail('Tarball is missing required package file: ' + required);
  }
  if ([...filePaths].some((file) => file === '.npmrc' || file.endsWith('/.npmrc'))) {
    fail('Tarball unexpectedly contains npm configuration.');
  }
  const archiveSha256 = cryptoCreateHash('sha256').update(readFileSync(archive)).digest('hex');
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
  assertPackageIdentity({ packageName: installedManifest.name, packageVersion: installedManifest.version, version });
  const smoke = commandOrFail(process.execPath, [
    join(installRoot, 'node_modules', PACKAGE_NAME, 'bin', 'triad-plus.js'),
    '--version',
  ]);
  if (smoke.trim() !== version) fail('Installed tarball CLI smoke returned an unexpected version.');
  if (!pack.integrity || !/^sha512-/.test(pack.integrity) || !/^[0-9a-f]{40}$/i.test(pack.shasum || '')) {
    fail('npm pack did not return valid integrity and shasum metadata.');
  }
  const sha = process.env.GITHUB_SHA || 'local';
  const artifactName = 'triad-plus-release-' + version + '-' + sha.slice(0, 12);
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

function expectedArtifactMetadata() {
  return {
    archiveSha256: process.env.EXPECTED_ARCHIVE_SHA256,
    sidecarSha256: process.env.EXPECTED_SIDECAR_SHA256,
  };
}

function verifyArtifact() {
  const tagName = releaseTagFromEnvironment();
  const version = versionFromReleaseTag(tagName);
  const directory = process.env.ARTIFACT_DIR;
  if (!directory) fail('Artifact directory is required.');
  const expectedName = PACKAGE_NAME + '-' + version + '.tgz';
  const archive = join(directory, expectedName);
  const sidecar = archive + '.sha256';
  const archiveSha256 = cryptoCreateHash('sha256').update(readFileSync(archive)).digest('hex');
  const sidecarBytes = readFileSync(sidecar);
  const sidecarSha256 = cryptoCreateHash('sha256').update(sidecarBytes).digest('hex');
  const sidecarText = sidecarBytes.toString('utf8');
  const expected = expectedArtifactMetadata();
  if (archiveSha256 !== expected.archiveSha256
    || sidecarSha256 !== expected.sidecarSha256
    || sidecarText !== archiveSha256 + '  ' + expectedName + '\n') {
    fail('Release artifact bytes or checksum sidecar differ from the verified tarball.');
  }
  console.log('Verified release artifact bytes: ' + expectedName + ' sha256=' + archiveSha256 + '.');
}

function verifyRegistry() {
  const tagName = releaseTagFromEnvironment();
  const version = versionFromReleaseTag(tagName);
  const expected = {
    integrity: process.env.EXPECTED_INTEGRITY,
    shasum: process.env.EXPECTED_SHASUM,
  };
  return waitForPublishedRegistry({
    expectedVersion: version,
    expected,
    attempts: 8,
    initialDelayMs: 5_000,
    maxDelayMs: 30_000,
    probe: () => command('npm', [
      'view',
      PACKAGE_NAME + '@' + version,
      'version',
      'dist.integrity',
      'dist.shasum',
      '--json',
    ]),
  }).then(({ attempts, metadata }) => {
    if (attempts > 1) console.log('npm registry propagation completed after ' + attempts + ' bounded checks.');
    console.log('npm registry identity verified: ' + version + ' ' + metadata.integrity + '.');
  });
}

function verifyRelease() {
  const tagName = releaseTagFromEnvironment();
  const release = parseJson(readFileSync(process.env.RELEASE_JSON_PATH, 'utf8'), 'GitHub Release metadata');
  assertReleaseMetadata(release, { tagName, ...expectedArtifactMetadata() });
  console.log('GitHub Release tag and exact asset digests verified.');
}

function verifyTag() {
  const tagName = releaseTagFromEnvironment();
  const probe = releaseTagProbe(tagName);
  assertTagCommit(probe, process.env.GITHUB_SHA, tagName);
  console.log('Git tag ' + tagName + ' resolves to the exact release commit.');
}

function verifyReleaseMatchesEvent(release, event) {
  if (release.id !== event.release.id
    || release.tag_name !== event.release.tag_name
    || release.target_commitish !== event.release.target_commitish
    || release.draft !== false
    || release.prerelease !== false) {
    fail('Current GitHub Release no longer matches the stable published event.');
  }
  assertTagCommit(releaseTagProbe(event.release.tag_name), process.env.GITHUB_SHA, event.release.tag_name);
}

function ensureReleaseAssets() {
  const event = eventRelease();
  const tagName = releaseTagFromEnvironment();
  if (event.action !== 'published' || event.release.tag_name !== tagName) fail('Release asset upload requires the matching published release event.');
  verifyArtifact();
  const artifactDirectory = process.env.ARTIFACT_DIR;
  const expected = { tagName, ...expectedArtifactMetadata() };
  const current = currentReleaseApi(tagName);
  verifyReleaseMatchesEvent(current, event);
  const plan = planReleaseAssetUploads(current, expected);
  if (plan.missing.length > 0) {
    const files = plan.missing.map((name) => join(artifactDirectory, name));
    commandOrFail('gh', ['release', 'upload', tagName, ...files], {
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN },
    });
  }
  const updated = currentReleaseApi(tagName);
  verifyReleaseMatchesEvent(updated, event);
  assertReleaseMetadata(updated, expected);
  console.log('GitHub Release now has exactly the two verified assets; no existing asset was overwritten.');
}

function verifyReleaseDownloads() {
  const tagName = releaseTagFromEnvironment();
  const version = versionFromReleaseTag(tagName);
  const event = eventRelease();
  if (event.action !== 'published' || event.release.tag_name !== tagName) {
    fail('Release asset verification requires the matching published release event.');
  }
  const release = currentReleaseApi(tagName);
  verifyReleaseMatchesEvent(release, event);
  assertReleaseMetadata(release, { tagName, ...expectedArtifactMetadata() });
  const downloadDirectory = process.env.RELEASE_DOWNLOAD_DIR;
  if (!downloadDirectory) fail('Release asset download directory is required.');
  mkdirSync(downloadDirectory, { recursive: true });
  if (readdirSync(downloadDirectory).length !== 0) fail('Release asset download directory must start empty.');
  commandOrFail('gh', ['release', 'download', tagName, '--dir', downloadDirectory], {
    env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN },
  });

  const archiveName = PACKAGE_NAME + '-' + version + '.tgz';
  const sidecarName = archiveName + '.sha256';
  const actualNames = readdirSync(downloadDirectory).sort();
  const expectedNames = [archiveName, sidecarName].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail('Downloaded GitHub Release assets are not exactly the expected archive and SHA-256 sidecar.');
  }
  const archiveBytes = readFileSync(join(downloadDirectory, archiveName));
  const sidecarBytes = readFileSync(join(downloadDirectory, sidecarName));
  const archiveSha256 = cryptoCreateHash('sha256').update(archiveBytes).digest('hex');
  const sidecarSha256 = cryptoCreateHash('sha256').update(sidecarBytes).digest('hex');
  if (archiveSha256 !== process.env.EXPECTED_ARCHIVE_SHA256
    || sidecarSha256 !== process.env.EXPECTED_SIDECAR_SHA256
    || sidecarBytes.toString('utf8') !== archiveSha256 + '  ' + archiveName + '\n') {
    fail('Downloaded GitHub Release asset bytes do not match the original verified archive.');
  }
  console.log('Downloaded GitHub Release assets exactly match the verified archive and sidecar.');
}

function registrySmoke() {
  const tagName = releaseTagFromEnvironment();
  const version = versionFromReleaseTag(tagName);
  const installRoot = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'triad-plus-registry-smoke-'));
  commandOrFail('npm', [
    'install',
    '--registry=https://registry.npmjs.org',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-save',
    '--prefix',
    installRoot,
    PACKAGE_NAME + '@' + version,
  ]);
  const installedManifest = parseJson(
    readFileSync(join(installRoot, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'),
    'registry-installed package.json',
  );
  assertPackageIdentity({ packageName: installedManifest.name, packageVersion: installedManifest.version, version });
  const result = commandOrFail(process.execPath, [
    join(installRoot, 'node_modules', PACKAGE_NAME, 'bin', 'triad-plus.js'),
    '--version',
  ]).trim();
  if (result !== version) fail('Registry-installed package CLI returned a version other than the release tag.');
  console.log('Registry install smoke verified triad-plus@' + version + '.');
}

function runGate() {
  const context = process.env.GITHUB_EVENT_NAME === 'release'
    ? validateReleaseEvent()
    : process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      ? validateDispatchDryRun()
      : fail('Only release published events or the dry-run workflow_dispatch are supported.');
  console.log('Release gate passed for ' + context.tagName + ' at ' + context.commitSha + '.');
}

function runPublishPreflight() {
  if (process.env.GITHUB_EVENT_NAME !== 'release') fail('npm publication is allowed only for a published GitHub Release event.');
  const context = validateReleaseEvent();
  const expected = {
    integrity: process.env.EXPECTED_INTEGRITY,
    shasum: process.env.EXPECTED_SHASUM,
  };
  if (!expected.integrity || !expected.shasum) fail('Verified npm archive metadata is required before publication.');
  console.log('Final npm publish preflight passed for ' + context.tagName + ' at ' + context.commitSha + '.');
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'gate') return runGate();
  if (mode === 'publish-preflight') return runPublishPreflight();
  if (mode === 'package') {
    const outputs = buildAndInspectPackage();
    console.log('Verified tarball: ' + outputs.tarball_name + ' sha256=' + outputs.sha256 + ' integrity=' + outputs.integrity + '.');
    return;
  }
  if (mode === 'verify-registry') return verifyRegistry();
  if (mode === 'verify-release') return verifyRelease();
  if (mode === 'verify-tag') return verifyTag();
  if (mode === 'verify-artifact') return verifyArtifact();
  if (mode === 'upload-release-assets') return ensureReleaseAssets();
  if (mode === 'verify-release-downloads') return verifyReleaseDownloads();
  if (mode === 'registry-smoke') return registrySmoke();
  fail('Unknown release guard mode.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error('Release guard failed closed: ' + error.message);
    process.exitCode = 1;
  });
}
