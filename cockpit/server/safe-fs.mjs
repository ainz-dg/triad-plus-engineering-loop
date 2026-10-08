import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// Read-only, allowlisted access to one control workspace. Every path is
// workspace-relative POSIX text, resolved and realpath-checked before any read,
// so `..`, absolute paths, and symlinks that leave the workspace are refused.

export const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 5000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Paths relative to a project base (the control root or projects/<id>).
const PROJECT_ALLOW = [
  /^\.loop(\/.*)?$/,
  /^artifacts(\/.*)?$/,
  /^features(\/.*)?$/,
  /^card-reports(\/.*)?$/,
  /^handoff\.md$/,
  /^feature-plan\.md$/,
  /^project\.yaml$/,
];

// Paths relative to the control root only.
const CONTROL_ALLOW = [
  /^\.triad-plus\/installation\.json$/,
  /^\.triad-plus\/team\.json$/,
  /^\.triad-runtime\/adapter\.json$/,
];

export class AccessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function deny(message) {
  throw new AccessError("access_denied", message);
}

/** Normalize client-supplied relative text or refuse it; never resolves on disk. */
export function normalizeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) deny("path must be a non-empty bounded string");
  if (value.includes("\0") || value.includes("\\")) deny("path contains forbidden characters");
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) deny("path must be workspace-relative");
  const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) deny("path must name a file");
  if (segments.some((segment) => segment === "..")) deny("path must not contain parent segments");
  // Hidden names are refused except the top-level Triad+ directories.
  if (segments.some((segment, index) => segment.startsWith(".") && !(index === 0 && [".loop", ".triad-plus", ".triad-runtime"].includes(segment)))) {
    deny("hidden path segments are not exposed");
  }
  if (segments.some((segment) => /^\.?env(\.|$)/i.test(segment))) deny("environment files are not exposed");
  return segments.join("/");
}

function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Create a reader bound to one control workspace. `projectBase` values are
 * control-relative directories produced by discovery, never client text.
 */
export async function createWorkspaceReader(controlRoot) {
  let root;
  try { root = await realpath(controlRoot); }
  catch { throw new AccessError("workspace_missing", "control workspace does not exist"); }
  if (!(await lstat(root)).isDirectory()) throw new AccessError("workspace_missing", "control workspace is not a directory");

  function allowed(projectBase, relative) {
    if (projectBase === "" && CONTROL_ALLOW.some((rule) => rule.test(relative))) return true;
    return PROJECT_ALLOW.some((rule) => rule.test(relative));
  }

  /** Resolve an allowlisted path; returns null when it does not exist. */
  async function resolveAllowed(projectBase, value) {
    const relative = normalizeRelative(value);
    if (!allowed(projectBase, relative)) deny("path is outside the Cockpit allowlist");
    const lexical = path.resolve(root, projectBase, relative);
    if (!within(root, lexical)) deny("path escapes the control workspace");
    let real;
    try { real = await realpath(lexical); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    // A symlink anywhere on the path may point elsewhere; only the real target counts.
    if (!within(root, real)) deny("path resolves outside the control workspace");
    const realRelative = path.relative(path.resolve(root, projectBase), real).split(path.sep).join("/");
    if (realRelative.startsWith("..") || !allowed(projectBase, realRelative)) deny("path resolves outside the Cockpit allowlist");
    return { relative, absolute: real };
  }

  /** Read bounded bytes. Result `null` means the file is absent. */
  async function readBytes(projectBase, value, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const resolved = await resolveAllowed(projectBase, value);
    if (!resolved) return null;
    let handle;
    try { handle = await open(resolved.absolute, constants.O_RDONLY | NOFOLLOW); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      if (error.code === "ELOOP") deny("symlinked files are not opened");
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) deny("path is not a regular file");
      const length = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const bytes = buffer.subarray(0, offset);
      return {
        path: resolved.relative,
        size: info.size,
        modified_at: info.mtime.toISOString(),
        truncated: info.size > maxBytes,
        bytes,
      };
    } finally {
      await handle.close();
    }
  }

  async function readText(projectBase, value, options) {
    const result = await readBytes(projectBase, value, options);
    if (!result) return null;
    return { ...result, text: result.bytes.toString("utf8"), sha256: result.truncated ? null : sha256(result.bytes) };
  }

  /** Parse JSON; parse failures are reported, never thrown. */
  async function readJson(projectBase, value, options = { maxBytes: 5 * DEFAULT_MAX_BYTES }) {
    const result = await readText(projectBase, value, options);
    if (!result) return { status: "missing", path: normalizeRelative(value) };
    if (result.truncated) return { status: "invalid", path: result.path, error: "file exceeds the JSON size bound" };
    try {
      return { status: "ok", path: result.path, sha256: result.sha256, modified_at: result.modified_at, value: JSON.parse(result.text) };
    } catch {
      return { status: "invalid", path: result.path, sha256: result.sha256, error: "file is not valid JSON" };
    }
  }

  /** List one allowlisted directory (names only, bounded, sorted). */
  async function list(projectBase, value) {
    let resolved;
    try { resolved = await resolveAllowed(projectBase, value); }
    catch (error) { if (error instanceof AccessError) return []; throw error; }
    if (!resolved) return [];
    let entries;
    try { entries = await readdir(resolved.absolute, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOTDIR" || error.code === "ENOENT") return []; throw error; }
    return entries
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .filter((entry) => !entry.name.startsWith(".") && !/^env(\.|$)/i.test(entry.name))
      .map((entry) => ({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile(), symlink: entry.isSymbolicLink() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Existence check for project discovery; never follows to outside the root. */
  async function isDirectory(projectBase, value) {
    try {
      const resolved = await resolveAllowed(projectBase, value);
      return Boolean(resolved) && (await lstat(resolved.absolute)).isDirectory();
    } catch (error) {
      if (error instanceof AccessError) return false;
      throw error;
    }
  }

  /** Directories under projects/ are discovered here, outside the allowlist rules. */
  async function listProjectDirectories() {
    const base = path.join(root, "projects");
    let real;
    try { real = await realpath(base); } catch { return []; }
    if (!within(root, real)) return [];
    const entries = await readdir(real, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  return { root, readBytes, readText, readJson, list, isDirectory, listProjectDirectories };
}
