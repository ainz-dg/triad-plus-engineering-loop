import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/i;
const QUALITY_SCOPES = new Set(["product_quality", "delivery_closure"]);

function qualityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function objectLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Return a JSON-compatible value with object keys sorted recursively. Arrays
 * intentionally retain their declared order: source and criterion order is
 * part of the authored contract, while object formatting is not.
 */
export function canonicalizeQualityValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeQualityValue);
  if (!objectLike(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeQualityValue(value[key])])
  );
}

export function qualityBaselinePayload(manifest) {
  if (!objectLike(manifest)) return manifest;
  const { fingerprint: _fingerprint, ...payload } = manifest;
  return canonicalizeQualityValue(payload);
}

export function qualityBaselineFingerprint(manifest) {
  const canonical = JSON.stringify(qualityBaselinePayload(manifest));
  return createHash("sha256").update(canonical).digest("hex");
}

function projectRelativePath(root, value, label) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw qualityError("quality_baseline_invalid", `${label} must be a non-empty project-relative path`);
  }
  const normalized = value.replaceAll("\\", "/");
  const posix = path.posix.normalize(normalized);
  if (posix === "." || posix === ".." || posix.startsWith("../")) {
    throw qualityError("quality_baseline_invalid", `${label} escapes the project root`);
  }
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw qualityError("quality_baseline_invalid", `${label} escapes the project root`);
  }
  return resolved;
}

function validateSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw qualityError("quality_baseline_invalid", `${label} must be a SHA-256 hex digest`);
  }
}

/**
 * Validate the manifest shape and its self-declared fingerprint without
 * touching source files. This is useful to callers that only need to inspect
 * the immutable contract before resolving it against a project.
 */
export function validateQualityBaselineManifest(manifest) {
  if (!objectLike(manifest)) throw qualityError("quality_baseline_invalid", "quality baseline must be a JSON object");
  if (manifest.schema_version !== 1) throw qualityError("quality_baseline_invalid", "quality baseline schema_version must be 1");
  if (typeof manifest.id !== "string" || !manifest.id.trim()) throw qualityError("quality_baseline_invalid", "quality baseline id must be non-empty");
  if (!Number.isInteger(manifest.revision) || manifest.revision < 1) throw qualityError("quality_baseline_invalid", "quality baseline revision must be a positive integer");
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) throw qualityError("quality_baseline_invalid", "quality baseline must declare at least one source");
  if (!Array.isArray(manifest.criteria)) throw qualityError("quality_baseline_invalid", "quality baseline criteria must be an array");

  const sourceIds = new Set();
  for (const source of manifest.sources) {
    if (!objectLike(source)) throw qualityError("quality_baseline_invalid", "quality baseline sources must contain objects");
    if (typeof source.id !== "string" || !source.id.trim()) throw qualityError("quality_baseline_invalid", "quality baseline source id must be non-empty");
    if (sourceIds.has(source.id)) throw qualityError("quality_baseline_invalid", `duplicate quality baseline source id: ${source.id}`);
    sourceIds.add(source.id);
    if (typeof source.role !== "string" || !source.role.trim()) throw qualityError("quality_baseline_invalid", `quality baseline source role is missing: ${source.id}`);
    if (typeof source.path !== "string" || !source.path.trim() || path.isAbsolute(source.path)) throw qualityError("quality_baseline_invalid", `quality baseline source path must be project-relative: ${source.id}`);
    const normalizedSourcePath = path.posix.normalize(source.path.replaceAll("\\", "/"));
    if (normalizedSourcePath === "." || normalizedSourcePath === ".." || normalizedSourcePath.startsWith("../")) throw qualityError("quality_baseline_invalid", `quality baseline source path escapes the project root: ${source.id}`);
    validateSha(source.sha256, `quality baseline source ${source.id}`);
  }

  const criterionIds = new Set();
  for (const criterion of manifest.criteria) {
    if (!objectLike(criterion)) throw qualityError("quality_baseline_invalid", "quality baseline criteria must contain objects");
    if (typeof criterion.id !== "string" || !criterion.id.trim()) throw qualityError("quality_baseline_invalid", "quality baseline criterion id must be non-empty");
    if (criterionIds.has(criterion.id)) throw qualityError("quality_baseline_invalid", `duplicate quality baseline criterion id: ${criterion.id}`);
    criterionIds.add(criterion.id);
    if (!QUALITY_SCOPES.has(criterion.scope)) throw qualityError("quality_baseline_invalid", `invalid quality baseline criterion scope: ${criterion.id}`);
    if (typeof criterion.requirement !== "string" || !criterion.requirement.trim()) throw qualityError("quality_baseline_invalid", `quality baseline criterion requirement must be non-empty: ${criterion.id}`);
  }

  validateSha(manifest.fingerprint, "quality baseline fingerprint");
  const calculatedFingerprint = qualityBaselineFingerprint(manifest);
  if (manifest.fingerprint.toLowerCase() !== calculatedFingerprint) {
    throw qualityError("quality_baseline_invalid", "quality baseline declared fingerprint does not match its canonical content");
  }
  return { manifest, fingerprint: calculatedFingerprint };
}

async function verifySources(manifest, root) {
  const verifiedSources = [];
  for (const source of manifest.sources) {
    const sourcePath = projectRelativePath(root, source.path, `quality baseline source ${source.id}`);
    let resolvedSource;
    try {
      resolvedSource = await realpath(sourcePath);
    } catch {
      throw qualityError("quality_baseline_invalid", `quality baseline source is missing: ${source.path}`);
    }
    if (!resolvedSource.startsWith(`${root}${path.sep}`)) {
      throw qualityError("quality_baseline_invalid", `quality baseline source escapes the project root: ${source.path}`);
    }
    let content;
    try {
      content = await readFile(resolvedSource);
    } catch {
      throw qualityError("quality_baseline_invalid", `quality baseline source cannot be read: ${source.path}`);
    }
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== source.sha256.toLowerCase()) {
      throw qualityError("quality_baseline_drift", `quality baseline source hash mismatch: ${source.path}`);
    }
    verifiedSources.push({ id: source.id, path: source.path, sha256: actual });
  }
  return verifiedSources;
}

/**
 * Load, validate, fingerprint, and resolve the immutable quality contract
 * against source files under the project root.
 */
export async function loadQualityBaseline(manifestPath, { projectRoot = process.cwd(), expectedFingerprint = null } = {}) {
  const root = await realpath(projectRoot);
  const resolvedManifestPath = projectRelativePath(root, manifestPath, "quality baseline path");
  let source;
  try {
    source = await readFile(resolvedManifestPath, "utf8");
  } catch {
    throw qualityError("quality_baseline_invalid", `quality baseline manifest is missing: ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw qualityError("quality_baseline_invalid", `quality baseline manifest is not valid JSON: ${error.message}`);
  }
  const validated = validateQualityBaselineManifest(manifest);
  if (expectedFingerprint !== null && expectedFingerprint !== undefined) {
    validateSha(expectedFingerprint, "expected quality baseline fingerprint");
    if (expectedFingerprint.toLowerCase() !== validated.fingerprint) {
      throw qualityError("quality_baseline_drift", "quality baseline fingerprint does not match the assignment binding");
    }
  }
  const sources = await verifySources(manifest, root);
  return {
    manifest,
    path: path.relative(root, resolvedManifestPath),
    fingerprint: validated.fingerprint,
    sources,
    criteria: manifest.criteria,
  };
}

/** Resolve the optional assignment binding while preserving legacy mode. */
export async function resolveQualityContract(assignment, projectRoot) {
  const manifestPath = assignment?.quality_baseline_path;
  const expectedFingerprint = assignment?.expected_quality_baseline_fingerprint;
  const pathPresent = typeof manifestPath === "string" && manifestPath.trim();
  const fingerprintPresent = typeof expectedFingerprint === "string" && expectedFingerprint.trim();
  if (!pathPresent && !fingerprintPresent) return null;
  if (!pathPresent || !fingerprintPresent) {
    throw qualityError("quality_baseline_invalid", "quality contract requires quality_baseline_path and expected_quality_baseline_fingerprint together");
  }
  return loadQualityBaseline(manifestPath, { projectRoot, expectedFingerprint });
}

export function qualityCriteriaByScope(manifestOrContract) {
  const manifest = manifestOrContract?.manifest ?? manifestOrContract;
  if (!objectLike(manifest) || !Array.isArray(manifest.criteria)) throw qualityError("quality_baseline_invalid", "quality baseline criteria are unavailable");
  return {
    product_quality: manifest.criteria.filter((criterion) => criterion.scope === "product_quality"),
    delivery_closure: manifest.criteria.filter((criterion) => criterion.scope === "delivery_closure"),
  };
}

export { QUALITY_SCOPES };
