// Verification-only entry point: no publisher, rebuild, install, or remote mutation.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertTagCommit, classifyTagProbe, planReleaseAssetUploads,
  publishedRegistryProbe, versionFromReleaseTag, waitForPublishedRegistry,
} from './release-guard.mjs';

const REPOSITORY = 'ainz-dg/triad-plus-engineering-loop';
const GATE = 'Validate, test, and build the exact release archive';
const PUBLISHER = 'Publish the verified archive to npm with OIDC';
const PUBLISH_STEP = 'Publish the exact verified archive with provenance';
const PREFLIGHT = 'Verify archive identity and repeat the fail-closed preflight';
const SHA = /^[0-9a-f]{40}$/;
const HASH = '[0-9a-f]{64}';
const INTEGRITY = 'sha512-[A-Za-z0-9+/]{86}==';
const fail = (message) => { throw new Error(message); };
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');

export function validateRecoveryInputs({ tag, commit, runId }) {
  const version = versionFromReleaseTag(tag);
  if (!SHA.test(commit || '')) fail('Expected commit must be an exact lowercase full SHA.');
  if (!/^[1-9][0-9]*$/.test(runId || '') || !Number.isSafeInteger(Number(runId))) fail('Original run ID must be a positive safe integer.');
  return { tag, version, commit, runId: Number(runId) };
}

export function validateRecoverySource({ input, run, jobs, release, artifacts }) {
  if (run.id !== input.runId || run.repository?.full_name !== REPOSITORY
    || run.head_repository?.full_name !== REPOSITORY || run.head_sha !== input.commit
    || run.head_branch !== input.tag || run.path !== '.github/workflows/release.yml'
    || run.event !== 'release' || run.status !== 'completed'
    || !['success', 'failure'].includes(run.conclusion) || run.run_attempt !== 1
    || run.actor?.login !== 'ainz-dg' || run.triggering_actor?.login !== 'ainz-dg') {
    fail('Original run identity/status/tag/SHA/owner or first-attempt provenance does not match.');
  }
  if (release.tag_name !== input.tag || release.draft !== false || release.prerelease !== false
    || !Number.isSafeInteger(release.id) || release.author?.login !== 'ainz-dg'
    || !['main', input.commit].includes(release.target_commitish)
    || !Number.isFinite(Date.parse(release.published_at))
    || !Number.isFinite(Date.parse(run.created_at))
    || Date.parse(release.published_at) > Date.parse(run.created_at)) {
    fail('Stable Release identity/owner/publication time does not match the original run.');
  }
  const uniqueJob = (name) => {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].run_id !== input.runId
      || matches[0].head_sha !== input.commit || matches[0].run_attempt !== 1
      || matches[0].status !== 'completed') fail('Missing or ambiguous original job: ' + name);
    return matches[0];
  };
  const gate = uniqueJob(GATE);
  const publisher = uniqueJob(PUBLISHER);
  const succeeded = (job, name) => {
    const steps = (job.steps || []).filter((step) => step.name === name);
    if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') {
      fail('Original successful step is required: ' + name);
    }
    return steps[0];
  };
  if (gate.conclusion !== 'success' || !['success', 'failure'].includes(publisher.conclusion)) fail('Original gate/publisher status is unsafe.');
  succeeded(gate, 'Pack, inspect, and smoke-install one exact archive');
  succeeded(gate, 'Preserve the verified archive for the release event only');
  const preflight = succeeded(publisher, PREFLIGHT);
  const publication = succeeded(publisher, PUBLISH_STEP);
  if (preflight.number >= publication.number) fail('Original preflight must precede publication.');
  const artifactName = 'triad-plus-release-' + input.version + '-' + input.commit.slice(0, 12);
  const candidates = artifacts.filter((artifact) => artifact.name === artifactName);
  if (candidates.length !== 1) fail('Original verified artifact is missing or ambiguous.');
  const artifact = candidates[0];
  if (artifact.expired !== false || !Number.isSafeInteger(artifact.id)
    || !new RegExp('^sha256:' + HASH + '$').test(artifact.digest || '')
    || artifact.workflow_run?.id !== input.runId || artifact.workflow_run?.head_sha !== input.commit
    || artifact.workflow_run?.head_branch !== input.tag
    || artifact.workflow_run?.repository_id !== run.repository.id
    || artifact.workflow_run?.head_repository_id !== run.repository.id) {
    fail('Original artifact provenance/digest is missing, expired, or inconsistent.');
  }
  return { gate, publisher, artifact };
}

function cleanLogs(logs) {
  return logs.replace(/\u001b\[[0-9;]*m/g, '').replace(/^\uFEFF/, '')
    .split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+Z /, '')).join('\n');
}

export function originalChecksums({ input, artifact, gateLogs, publishLogs }) {
  const gate = cleanLogs(gateLogs);
  const publish = cleanLogs(publishLogs);
  const one = (text, expression, label) => {
    const values = [...text.matchAll(expression)].map((match) => match[1]);
    if (!values.length || new Set(values).size !== 1) fail('Original log evidence is missing or conflicting: ' + label);
    return values[0];
  };
  const archiveName = 'triad-plus-' + input.version + '.tgz';
  if (!gate.split('\n').includes('Release gate passed for ' + input.tag + ' at ' + input.commit + '.')) {
    fail('Original approved release gate evidence is missing.');
  }
  const digest = one(gate, new RegExp('^SHA256 digest of uploaded artifact zip is (' + HASH + ')$', 'gm'), 'artifact digest');
  const id = one(gate, /^Artifact .+\.zip successfully finalized\. Artifact ID ([0-9]+)$/gm, 'artifact ID');
  if ('sha256:' + digest !== artifact.digest || id !== String(artifact.id)) fail('Artifact was substituted after the original gate.');
  const field = (name, pattern) => one(publish, new RegExp('^  ' + name + ': (' + pattern + ')$', 'gm'), name);
  const expected = {
    archiveSha256: field('EXPECTED_ARCHIVE_SHA256', HASH),
    sidecarSha256: field('EXPECTED_SIDECAR_SHA256', HASH),
    integrity: field('EXPECTED_INTEGRITY', INTEGRITY),
    shasum: field('EXPECTED_SHASUM', '[0-9a-f]{40}'),
  };
  if (!gate.split('\n').includes('Verified tarball: ' + archiveName + ' sha256=' + expected.archiveSha256 + ' integrity=' + expected.integrity + '.')
    || !publish.split('\n').includes('Verified release artifact bytes: ' + archiveName + ' sha256=' + expected.archiveSha256 + '.')
    || !publish.split('\n').includes('+ triad-plus@' + input.version)) {
    fail('Original exact verified archive/publication log evidence is missing.');
  }
  return expected;
}

export function verifyRecoveryBytes({ archive, sidecar, version, expected }) {
  const archiveSha256 = hash(archive);
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  const shasum = hash(archive, 'sha1');
  if (archiveSha256 !== expected.archiveSha256 || hash(sidecar) !== expected.sidecarSha256
    || integrity !== expected.integrity || shasum !== expected.shasum
    || sidecar.toString('utf8') !== archiveSha256 + '  triad-plus-' + version + '.tgz\n') {
    fail('Original artifact bytes/checksum/integrity/shasum mismatch.');
  }
  return { archiveSha256, sidecarSha256: hash(sidecar), integrity, shasum };
}

function githubReadLabel(path) {
  // Never echo arbitrary arguments, URLs, response bodies, or query values.
  const known = /^(?:actions\/runs\/[1-9]\d*(?:\/attempts\/1\/jobs\?per_page=100|\/artifacts\?per_page=100)?|actions\/jobs\/[1-9]\d*\/logs|actions\/artifacts\/[1-9]\d*\/zip|releases\/tags\/v\d+\.\d+\.\d+|releases\/assets\/[1-9]\d*)$/;
  return 'GET /repos/' + REPOSITORY + '/' + (known.test(path) ? path : '[unrecognized-endpoint]');
}

function githubReadFailure(result, label) {
  // Extract only a numeric status from gh's standard error formats. Discard all text.
  const stderr = String(result.stderr || '');
  const http = stderr.match(/^gh: HTTP ([1-5]\d{2})(?::|$)/m)?.[1]
    || stderr.match(/^gh: [^\r\n]*\(HTTP ([1-5]\d{2})\)\s*$/m)?.[1];
  const exit = Number.isInteger(result.status) ? result.status : 'none';
  const code = result.error?.code;
  const error = ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS'].includes(code)
    ? code : result.error ? 'spawn-error' : result.signal ? 'signal' : 'nonzero-exit';
  return 'Read-only gh ' + label + ' failed (exit=' + exit + ', http_status=' + (http || 'unknown')
    + ', http_class=' + (http ? http[0] + 'xx' : 'unknown') + ', error=' + error
    + '); original evidence unavailable.';
}

function command(bin, args, binary = false, readLabel) {
  const result = spawnSync(bin, args, { encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  if (result.error || result.status !== 0) {
    fail(readLabel ? githubReadFailure(result, readLabel) : 'Read-only ' + bin + ' command failed; original evidence unavailable.');
  }
  return result.stdout;
}
const api = (path, binary = false, acceptBinary = false) => {
  const label = githubReadLabel(path);
  console.log('Recovery evidence: ' + label);
  return command('gh', ['api', '--method', 'GET',
    ...(/^actions\/jobs\/[1-9]\d*\/logs$/.test(path) ? ['--allow-escape-sequences'] : []),
    ...(acceptBinary ? ['-H', 'Accept: application/octet-stream'] : []),
    'repos/' + REPOSITORY + '/' + path], binary, label);
};
const jsonApi = (path) => {
  const response = api(path);
  try { return JSON.parse(response); }
  catch { fail('Read-only gh ' + githubReadLabel(path) + ' returned invalid JSON; original evidence unavailable.'); }
};

function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
}

export async function verifyRecovery() {
  const input = validateRecoveryInputs({ tag: process.env.RELEASE_TAG, commit: process.env.EXPECTED_COMMIT, runId: process.env.ORIGINAL_RUN_ID });
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/main'
    || process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_ACTOR !== 'ainz-dg') {
    fail('Recovery requires owner dispatch on the canonical repository main branch.');
  }
  if (command('git', ['rev-parse', 'HEAD']).trim() !== process.env.GITHUB_SHA) fail('Recovery checkout must match dispatch SHA.');
  // Never check out or execute code from the caller-selected historical release.
  command('git', ['merge-base', '--is-ancestor', input.commit, 'origin/main']);
  const run = jsonApi('actions/runs/' + input.runId);
  const release = jsonApi('releases/tags/' + input.tag);
  const jobsResponse = jsonApi('actions/runs/' + input.runId + '/attempts/1/jobs?per_page=100');
  const artifactsResponse = jsonApi('actions/runs/' + input.runId + '/artifacts?per_page=100');
  if (jobsResponse.total_count !== jobsResponse.jobs?.length || artifactsResponse.total_count !== artifactsResponse.artifacts?.length) {
    fail('Incomplete original job/artifact evidence.');
  }
  const source = validateRecoverySource({ input, run, release, jobs: jobsResponse.jobs, artifacts: artifactsResponse.artifacts });
  const expected = originalChecksums({ input, artifact: source.artifact,
    gateLogs: api('actions/jobs/' + source.gate.id + '/logs'), publishLogs: api('actions/jobs/' + source.publisher.id + '/logs') });
  assertTagCommit(classifyTagProbe({ status: 0, stdout: command('git', ['ls-remote', '--exit-code', 'origin', 'refs/tags/' + input.tag, 'refs/tags/' + input.tag + '^{}']) }, input.tag), input.commit, input.tag);
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'triad-recovery-'));
  const zip = api('actions/artifacts/' + source.artifact.id + '/zip', true);
  if ('sha256:' + hash(zip) !== source.artifact.digest) fail('Downloaded artifact ZIP digest mismatch.');
  const zipPath = join(root, 'original.zip');
  writeFileSync(zipPath, zip, { flag: 'wx' });
  const name = 'triad-plus-' + input.version + '.tgz';
  const entries = command('unzip', ['-Z1', zipPath]).trim().split(/\r?\n/).sort();
  if (JSON.stringify(entries) !== JSON.stringify([name, name + '.sha256'].sort())) fail('Original artifact must contain exactly the archive and sidecar.');
  const archive = command('unzip', ['-p', zipPath, name], true);
  const sidecar = command('unzip', ['-p', zipPath, name + '.sha256'], true);
  const metadata = verifyRecoveryBytes({ archive, sidecar, version: input.version, expected });
  const archivePath = join(root, name);
  writeFileSync(archivePath, archive, { flag: 'wx' });
  const manifest = JSON.parse(command('tar', ['-xOf', archivePath, 'package/package.json']));
  if (manifest.name !== 'triad-plus' || manifest.version !== input.version) fail('Original archive has wrong package identity.');
  const plan = planReleaseAssetUploads(release, { tagName: input.tag, ...metadata });
  summary('Original run ' + input.runId + ' remains ' + run.conclusion + '. Missing GitHub Release assets: ' + (plan.missing.join(', ') || 'none') + '.');
  // Verify every existing asset by bytes as well as by the GitHub API digest.
  for (const asset of release.assets) {
    if (!Number.isSafeInteger(asset.id)) fail('Invalid Release asset identity.');
    const bytes = api('releases/assets/' + asset.id, true, true);
    if (!bytes.equals(asset.name === name ? archive : sidecar)) fail('Downloaded Release asset bytes mismatch.');
  }
  await waitForPublishedRegistry({ expectedVersion: input.version, expected: metadata,
    probe: (_attempt, remainingMs) => publishedRegistryProbe(input.version, remainingMs) });
  const latestRelease = jsonApi('releases/tags/' + input.tag);
  if (latestRelease.id !== release.id || latestRelease.published_at !== release.published_at
    || latestRelease.target_commitish !== release.target_commitish) fail('Release identity changed during verification.');
  const latestPlan = planReleaseAssetUploads(latestRelease, { tagName: input.tag, ...metadata });
  const assetIdentity = (assets) => assets.map(({ id, name, digest, size }) => ({ id, name, digest, size })).sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(assetIdentity(latestRelease.assets)) !== JSON.stringify(assetIdentity(release.assets))) {
    fail('Release assets changed during verification; repeat read-only verification.');
  }
  assertTagCommit(classifyTagProbe({ status: 0, stdout: command('git', ['ls-remote', '--exit-code', 'origin', 'refs/tags/' + input.tag, 'refs/tags/' + input.tag + '^{}']) }, input.tag), input.commit, input.tag);
  summary('Missing GitHub Release assets: ' + (latestPlan.missing.join(', ') || 'none') + '.');
  summary('VERIFIED ' + input.tag + ' at ' + input.commit + ': npm matches the original exact archive. Missing assets require separately authorized manual recovery. Historical run unchanged.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyRecovery().catch((error) => {
    summary((error.code === 'REGISTRY_NOT_VISIBLE' ? '' : 'BLOCKED/MISMATCH: ') + error.message);
    process.exitCode = 1;
  });
}
