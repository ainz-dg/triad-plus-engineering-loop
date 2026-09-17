import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const INSTALLATION_MANIFEST_SCHEMA_VERSION = 1;
export const INSTALLATION_MANIFEST_PATH = '.triad-plus/installation.json';

const SHA256 = /^[a-f0-9]{64}$/i;
const SCOPES = new Set(['project', 'global']);
const SCOPE_STATES = new Set(['installed', 'partial', 'uninstalled', 'not_configured']);
const TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'triad_version',
  'adapter',
  'installed_at',
  'updated_at',
  'uninstalled_at',
  'scopes',
  'scope_status',
  'managed_assets',
  'status',
  'fingerprint'
]);
const ASSET_KEYS = new Set(['scope', 'path', 'kind', 'sha256', 'start_marker', 'end_marker']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'installation_manifest_invalid';
  return error;
}

function objectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Return a stable JSON-compatible value with object keys ordered recursively.
 * Array order is intentionally preserved because the manifest is an ordered
 * record of the managed install plan.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!objectLike(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function installationManifestPayload(manifest) {
  const { fingerprint: _fingerprint, ...payload } = manifest;
  return payload;
}

export function installationManifestFingerprint(manifest) {
  return digest(canonicalJson(installationManifestPayload(manifest)));
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value.trim()) throw invalid('installation manifest asset path must be non-empty');
  if (value.includes('\0') || path.isAbsolute(value)) throw invalid(`installation manifest project path must be relative: ${value}`);
  const normalized = value.split(path.sep).join('/');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw invalid(`installation manifest path contains traversal or empty segments: ${value}`);
  }
  if (path.posix.normalize(normalized) !== normalized) throw invalid(`installation manifest path is not normalized: ${value}`);
  return normalized;
}

function normalizeAbsolute(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value)) {
    throw invalid(`installation manifest global path must be absolute: ${value}`);
  }
  const normalized = path.resolve(value);
  if (normalized !== value) throw invalid(`installation manifest global path is not normalized: ${value}`);
  return normalized;
}

function validateTimestamp(value, label) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw invalid(`installation manifest ${label} must be an ISO timestamp`);
  }
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid(`${label} has unknown property: ${key}`);
}

/** Validate a manifest, including its self-declared fingerprint. */
export function validateInstallationManifest(manifest) {
  if (!objectLike(manifest)) throw invalid('installation manifest must be a JSON object');
  rejectUnknown(manifest, TOP_LEVEL_KEYS, 'installation manifest');
  if (manifest.schema_version !== INSTALLATION_MANIFEST_SCHEMA_VERSION) {
    throw invalid(`installation manifest schema_version must be ${INSTALLATION_MANIFEST_SCHEMA_VERSION}`);
  }
  if (typeof manifest.triad_version !== 'string' || !manifest.triad_version.trim()) throw invalid('installation manifest triad_version must be non-empty');
  if (typeof manifest.adapter !== 'string' || !manifest.adapter.trim()) throw invalid('installation manifest adapter must be non-empty');
  validateTimestamp(manifest.installed_at, 'installed_at');
  validateTimestamp(manifest.updated_at, 'updated_at');
  if (manifest.uninstalled_at !== undefined) validateTimestamp(manifest.uninstalled_at, 'uninstalled_at');

  if (!objectLike(manifest.scopes)) throw invalid('installation manifest scopes must be an object');
  rejectUnknown(manifest.scopes, SCOPES, 'installation manifest scopes');
  if (typeof manifest.scopes.project !== 'boolean' || typeof manifest.scopes.global !== 'boolean') {
    throw invalid('installation manifest scopes.project and scopes.global must be booleans');
  }

  if (manifest.scope_status !== undefined) {
    if (!objectLike(manifest.scope_status)) throw invalid('installation manifest scope_status must be an object');
    rejectUnknown(manifest.scope_status, SCOPES, 'installation manifest scope_status');
    for (const scope of SCOPES) {
      if (!SCOPE_STATES.has(manifest.scope_status[scope])) throw invalid(`installation manifest scope_status.${scope} is invalid`);
    }
  }

  if (!Array.isArray(manifest.managed_assets)) throw invalid('installation manifest managed_assets must be an array');
  const seen = new Set();
  for (const asset of manifest.managed_assets) {
    if (!objectLike(asset)) throw invalid('installation manifest managed asset must be an object');
    rejectUnknown(asset, ASSET_KEYS, 'installation manifest managed asset');
    if (!SCOPES.has(asset.scope)) throw invalid(`installation manifest managed asset scope is invalid: ${asset.scope}`);
    const normalized = asset.scope === 'project' ? normalizeRelative(asset.path) : normalizeAbsolute(asset.path);
    if (normalized !== asset.path) throw invalid(`installation manifest managed asset path is not normalized: ${asset.path}`);
    if (asset.kind === 'file') {
      if (asset.start_marker !== undefined || asset.end_marker !== undefined) {
        throw invalid(`installation manifest file asset cannot contain managed block markers: ${asset.path}`);
      }
    } else if (asset.kind === 'managed_block') {
      if (asset.scope !== 'project') throw invalid(`installation manifest managed block must be project-scoped: ${asset.path}`);
      if (typeof asset.start_marker !== 'string' || !asset.start_marker || typeof asset.end_marker !== 'string' || !asset.end_marker || asset.start_marker === asset.end_marker) {
        throw invalid(`installation manifest managed block markers are invalid: ${asset.path}`);
      }
    } else {
      throw invalid(`installation manifest managed asset kind is unsupported: ${asset.kind}`);
    }
    if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) throw invalid(`installation manifest managed asset sha256 is invalid: ${asset.path}`);
    const key = `${asset.scope}:${asset.path}`;
    if (seen.has(key)) throw invalid(`installation manifest managed asset is duplicated: ${key}`);
    seen.add(key);
  }

  if (manifest.status !== undefined && !SCOPE_STATES.has(manifest.status)) throw invalid(`installation manifest status is invalid: ${manifest.status}`);
  if (typeof manifest.fingerprint !== 'string' || !SHA256.test(manifest.fingerprint)) throw invalid('installation manifest fingerprint is invalid');
  const calculated = installationManifestFingerprint(manifest);
  if (manifest.fingerprint.toLowerCase() !== calculated) throw invalid('installation manifest fingerprint does not match its contents');
  return manifest;
}

export function installationManifestPath(controlRoot) {
  return path.join(controlRoot, INSTALLATION_MANIFEST_PATH);
}

export async function loadInstallationManifest(controlRoot) {
  const manifestPath = installationManifestPath(controlRoot);
  try {
    await access(manifestPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw invalid(`installation manifest is not valid JSON: ${error.message}`);
  }
  validateInstallationManifest(manifest);
  return { path: manifestPath, manifest };
}

export async function writeInstallationManifest(controlRoot, manifest) {
  validateInstallationManifest(manifest);
  const target = installationManifestPath(controlRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return target;
}

function within(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

async function walkFiles(target, files) {
  let info;
  try { info = await lstat(target); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (info.isDirectory()) {
    for (const name of (await readdir(target)).sort()) await walkFiles(path.join(target, name), files);
    return;
  }
  if (!info.isFile()) throw invalid(`managed installation asset is not a regular file: ${target}`);
  files.push(target);
}

export async function sha256File(filePath) {
  return digest(await readFile(filePath));
}

export function sha256Text(value) {
  return digest(value);
}

/** Collect the exact regular files materialized below one or more asset roots. */
export async function collectManagedAssetRecords(roots, { scope, baseRoot = null } = {}) {
  if (!SCOPES.has(scope)) throw new Error(`unknown installation asset scope: ${scope}`);
  const files = [];
  for (const root of [...new Set(roots.map((item) => path.resolve(item)))]) await walkFiles(root, files);
  const unique = [...new Set(files.map((item) => path.resolve(item)))].sort();
  return Promise.all(unique.map(async (filePath) => {
    const assetPath = scope === 'project'
      ? path.relative(path.resolve(baseRoot), filePath).split(path.sep).join('/')
      : filePath;
    if (scope === 'project' && (!assetPath || assetPath.startsWith('..') || !within(baseRoot, filePath))) {
      throw invalid(`managed project asset escaped control root: ${filePath}`);
    }
    return { scope, path: assetPath, kind: 'file', sha256: await sha256File(filePath) };
  }));
}

export function buildInstallationManifest({
  triadVersion,
  adapter,
  installedAt = new Date().toISOString(),
  updatedAt = installedAt,
  uninstalledAt,
  scopes = { project: true, global: false },
  scopeStatus = { project: 'installed', global: scopes.global ? 'installed' : 'not_configured' },
  managedAssets = [],
  status = 'installed'
}) {
  const manifest = {
    schema_version: INSTALLATION_MANIFEST_SCHEMA_VERSION,
    triad_version: triadVersion,
    adapter,
    installed_at: installedAt,
    updated_at: updatedAt,
    scopes: { project: Boolean(scopes.project), global: Boolean(scopes.global) },
    scope_status: { project: scopeStatus.project, global: scopeStatus.global },
    managed_assets: [...managedAssets].sort((left, right) => `${left.scope}:${left.path}`.localeCompare(`${right.scope}:${right.path}`)),
    status
  };
  if (uninstalledAt) manifest.uninstalled_at = uninstalledAt;
  manifest.fingerprint = installationManifestFingerprint(manifest);
  validateInstallationManifest(manifest);
  return manifest;
}

export function manifestScopeStatus(manifest, scope) {
  if (manifest.scope_status?.[scope]) return manifest.scope_status[scope];
  return manifest.scopes?.[scope] ? 'installed' : 'not_configured';
}

export function manifestIsUninstalled(manifest) {
  return manifest.status === 'uninstalled' || (
    ['project', 'global'].every((scope) => ['not_configured', 'uninstalled'].includes(manifestScopeStatus(manifest, scope)))
  );
}
