import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/i;
const MANIFEST_SCHEMA_VERSION = 1;
const CURRENT_STATUS = "current";

function invalid(message, details = {}) {
  const error = new Error(message);
  error.code = "evidence_manifest_invalid";
  Object.assign(error, details);
  return error;
}

function objectLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${label} must be a non-empty string`);
  return value.trim();
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${label} contains unknown property: ${key}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathInside(root, candidate, label) {
  if (typeof candidate !== "string" || !candidate.trim()) throw invalid(`${label} must be a non-empty relative path`);
  if (path.isAbsolute(candidate)) throw invalid(`${label} must be relative to the evidence root`);
  if (candidate.split(/[\\/]/).includes("..")) throw invalid(`${label} must not contain parent traversal`);
  const resolved = path.resolve(root, candidate);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw invalid(`${label} escapes the authorized evidence root`);
  }
  return resolved;
}

function validateArtifactShape(artifact, index, manifest) {
  if (!objectLike(artifact)) throw invalid(`artifact ${index} must be an object`);
  const prefix = `artifact ${index}`;
  rejectUnknown(artifact, new Set([
    "path", "media_type", "sha256", "size_bytes", "producer_gate_id",
    "run_id", "assignment_id", "candidate_fingerprint", "status",
  ]), prefix);
  const result = {
    path: nonEmpty(artifact.path, `${prefix}.path`),
    media_type: nonEmpty(artifact.media_type, `${prefix}.media_type`),
    sha256: nonEmpty(artifact.sha256, `${prefix}.sha256`).toLowerCase(),
    size_bytes: artifact.size_bytes,
    producer_gate_id: nonEmpty(artifact.producer_gate_id, `${prefix}.producer_gate_id`),
    run_id: nonEmpty(artifact.run_id, `${prefix}.run_id`),
    assignment_id: nonEmpty(artifact.assignment_id, `${prefix}.assignment_id`),
    candidate_fingerprint: nonEmpty(artifact.candidate_fingerprint, `${prefix}.candidate_fingerprint`).toLowerCase(),
    status: nonEmpty(artifact.status, `${prefix}.status`),
  };
  if (!SHA256.test(result.sha256)) throw invalid(`${prefix}.sha256 must be a SHA-256 digest`);
  if (!Number.isSafeInteger(result.size_bytes) || result.size_bytes < 0) throw invalid(`${prefix}.size_bytes must be a non-negative safe integer`);
  if (!SHA256.test(result.candidate_fingerprint)) throw invalid(`${prefix}.candidate_fingerprint must be a SHA-256 digest`);
  if (result.run_id !== manifest.run_id) throw invalid(`${prefix}.run_id does not match the manifest run`);
  if (result.assignment_id !== manifest.assignment_id) throw invalid(`${prefix}.assignment_id does not match the manifest assignment`);
  if (result.candidate_fingerprint !== manifest.candidate_fingerprint) throw invalid(`${prefix}.candidate_fingerprint does not match the manifest candidate`);
  if (result.status !== CURRENT_STATUS) throw invalid(`${prefix}.status must be current`);
  return result;
}

function validateManifestShape(manifest) {
  if (!objectLike(manifest)) throw invalid("evidence manifest must be an object");
  rejectUnknown(manifest, new Set([
    "schema_version", "run_id", "assignment_id", "feature_id", "attempt",
    "candidate_fingerprint", "status", "artifacts",
  ]), "evidence manifest");
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) throw invalid("evidence manifest schema_version must be 1");
  const required = {
    run_id: nonEmpty(manifest.run_id, "run_id"),
    assignment_id: nonEmpty(manifest.assignment_id, "assignment_id"),
    feature_id: nonEmpty(manifest.feature_id, "feature_id"),
    candidate_fingerprint: nonEmpty(manifest.candidate_fingerprint, "candidate_fingerprint"),
    status: nonEmpty(manifest.status, "status"),
  };
  if (!SHA256.test(required.candidate_fingerprint)) throw invalid("candidate_fingerprint must be a SHA-256 digest");
  if (required.status !== CURRENT_STATUS) throw invalid("evidence manifest status must be current");
  if (!Number.isInteger(manifest.attempt) || manifest.attempt < 1) throw invalid("attempt must be a positive integer");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw invalid("evidence manifest must contain at least one artifact");
  const artifacts = manifest.artifacts.map((artifact, index) => validateArtifactShape(artifact, index, { ...required, attempt: manifest.attempt }));
  const paths = new Set();
  for (const artifact of artifacts) {
    if (paths.has(artifact.path)) throw invalid(`duplicate artifact path: ${artifact.path}`);
    paths.add(artifact.path);
  }
  return { ...required, attempt: manifest.attempt, artifacts };
}

async function resolveExistingPath(root, candidate, label) {
  const resolved = pathInside(root, candidate, label);
  try { await access(resolved); } catch { throw invalid(`${label} is missing: ${candidate}`); }
  try {
    const linkStats = await lstat(resolved);
    if (linkStats.isSymbolicLink()) throw invalid(`${label} must not be a symbolic link: ${candidate}`);
  } catch (error) {
    if (error?.code === "evidence_manifest_invalid") throw error;
    throw invalid(`${label} cannot be inspected: ${error.message}`);
  }
  let real;
  try { real = await realpath(resolved); } catch { throw invalid(`${label} cannot be resolved: ${candidate}`); }
  const realRoot = await realpath(root);
  if (real === realRoot || !real.startsWith(`${realRoot}${path.sep}`)) {
    throw invalid(`${label} escapes the authorized evidence root`);
  }
  return { resolved, real, realRoot };
}

/**
 * Load and fail closed on a repository-produced generic evidence manifest.
 * The manifest itself is control-workspace state; artifact paths are always
 * relative to its containing directory and are bound to one run/assignment
 * and the candidate fingerprint observed before gate execution.
 */
export async function loadEvidenceManifest({
  projectRoot,
  manifestPath,
  expectedRunId,
  expectedAssignmentId,
  expectedFeatureId,
  expectedAttempt,
  expectedCandidateFingerprint,
  producerGateIds = [],
}) {
  const root = await realpath(projectRoot);
  if (expectedCandidateFingerprint === undefined || expectedCandidateFingerprint === null) {
    throw invalid("expected candidate fingerprint is required");
  }
  const manifestLocation = await resolveExistingPath(root, manifestPath, "evidence manifest");
  let source;
  try { source = await readFile(manifestLocation.real, "utf8"); }
  catch (error) { throw invalid(`evidence manifest cannot be read: ${error.message}`); }
  let parsed;
  try { parsed = JSON.parse(source); }
  catch (error) { throw invalid(`evidence manifest is not valid JSON: ${error.message}`); }
  const manifest = validateManifestShape(parsed);
  const expected = [
    ["run_id", expectedRunId],
    ["assignment_id", expectedAssignmentId],
    ["feature_id", expectedFeatureId],
    ["attempt", expectedAttempt],
    ["candidate_fingerprint", expectedCandidateFingerprint],
  ];
  for (const [key, value] of expected) {
    if (value !== undefined && value !== null && manifest[key] !== value) throw invalid(`evidence manifest ${key} does not match the active binding`);
  }
  const producerSet = new Set(producerGateIds);
  if (producerSet.size === 0) throw invalid("evidence manifest requires at least one passing producer gate");
  const evidenceRoot = path.dirname(manifestLocation.real);
  const normalizedArtifacts = [];
  for (const artifact of manifest.artifacts) {
    if (producerSet.size > 0 && !producerSet.has(artifact.producer_gate_id)) {
      throw invalid(`artifact producer gate is not part of the executed gate set: ${artifact.producer_gate_id}`);
    }
    const location = await resolveExistingPath(evidenceRoot, artifact.path, `artifact ${artifact.path}`);
    const info = await stat(location.real);
    if (!info.isFile()) throw invalid(`artifact is not a regular file: ${artifact.path}`);
    const bytes = await readFile(location.real);
    const actualHash = sha256(bytes);
    if (actualHash !== artifact.sha256) throw invalid(`artifact SHA-256 mismatch: ${artifact.path}`);
    if (bytes.length !== artifact.size_bytes) throw invalid(`artifact size mismatch: ${artifact.path}`);
    normalizedArtifacts.push({
      ...artifact,
      path: path.relative(root, location.real).split(path.sep).join("/"),
      root: path.relative(root, evidenceRoot).split(path.sep).join("/") || ".",
    });
  }
  return {
    path: path.relative(root, manifestLocation.real).split(path.sep).join("/"),
    sha256: sha256(source),
    root: path.relative(root, evidenceRoot).split(path.sep).join("/") || ".",
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: manifest.run_id,
    assignment_id: manifest.assignment_id,
    feature_id: manifest.feature_id,
    attempt: manifest.attempt,
    candidate_fingerprint: manifest.candidate_fingerprint,
    status: manifest.status,
    artifacts: normalizedArtifacts,
  };
}

export { MANIFEST_SCHEMA_VERSION };
