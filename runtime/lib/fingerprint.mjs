import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process.mjs";

const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\..*)?|.*\.pem|.*\.key|credentials(?:\..*)?)$/i;
const IGNORED_PATH = /(^|\/)(?:node_modules|\.git|dist|build|coverage)(\/|$)/;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseLines(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function gitLines(worktree, args) {
  const result = await runProcess("git", args, { cwd: worktree, timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return parseLines(result.stdout);
}

async function gitOutput(worktree, args) {
  const result = await runProcess("git", args, { cwd: worktree, timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout;
}

async function verifiedCommit(root, commit, label) {
  const resolved = (await gitLines(root, ["rev-parse", "--verify", `${commit}^{commit}`]))[0];
  if (!resolved) throw new Error(`${label} does not resolve to a commit`);
  return resolved;
}

function ignored(relativePath) {
  return SENSITIVE_PATH.test(relativePath) || IGNORED_PATH.test(relativePath);
}

function statusFrom(code) {
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D")) return "deleted";
  return "modified";
}

function parseNameStatus(source) {
  const entries = [];
  for (const line of source.split("\n")) {
    if (!line) continue;
    const [code, firstPath, secondPath] = line.split("\t");
    if (!code || !firstPath) continue;
    if (code.startsWith("R")) {
      if (!secondPath) throw new Error("git rename entry is missing destination path");
      entries.push({ status: "renamed", source: firstPath, destination: secondPath });
    } else {
      entries.push({ status: statusFrom(code), path: firstPath });
    }
  }
  return entries;
}

function pathsFor(entry) {
  return entry.status === "renamed" ? [entry.source, entry.destination] : [entry.path];
}

export async function collectCandidateChanges(worktree, { baseCommit = null } = {}) {
  const root = await realpath(worktree);
  const head = (await gitLines(root, ["rev-parse", "HEAD"]))[0] ?? "NO_HEAD";
  const base = baseCommit ?? head;
  await gitLines(root, ["rev-parse", "--verify", `${base}^{commit}`]);
  const tracked = parseNameStatus(await gitOutput(root, ["diff", "--name-status", "--find-renames", base]));
  const known = new Set(tracked.flatMap(pathsFor));
  for (const relativePath of await gitLines(root, ["ls-files", "--others", "--exclude-standard"])) {
    if (!known.has(relativePath)) tracked.push({ status: "untracked", path: relativePath });
  }
  const changes = [];
  const ignored_paths = [];
  for (const entry of tracked) {
    const entryPaths = pathsFor(entry);
    if (entryPaths.some(ignored)) {
      ignored_paths.push(...entryPaths.filter(ignored));
      continue;
    }
    for (const relativePath of entryPaths) {
      const absolutePath = path.resolve(root, relativePath);
      if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe changed path: ${relativePath}`);
    }
    changes.push(entry);
  }
  return { git_head: head, base_commit: base, changes, ignored_paths: [...new Set(ignored_paths)].sort() };
}

/**
 * Collect a complete candidate delta from an immutable Git commit rather than
 * from whatever happens to be in the current worktree. This is used by derived
 * reports so a later Card on the same branch cannot contaminate an earlier one.
 */
export async function collectCandidateChangesAtCommit(worktree, { baseCommit, commit }) {
  const root = await realpath(worktree);
  const base = await verifiedCommit(root, baseCommit, "base commit");
  const head = await verifiedCommit(root, commit, "final commit");
  const ancestry = await runProcess("git", ["merge-base", "--is-ancestor", base, head], { cwd: root, timeoutMs: 15_000 });
  if (ancestry.exitCode !== 0) throw new Error("card baseline is not an ancestor of the final commit");
  const tracked = parseNameStatus(await gitOutput(root, ["diff", "--name-status", "--find-renames", base, head]));
  const changes = [];
  const ignored_paths = [];
  for (const entry of tracked) {
    const entryPaths = pathsFor(entry);
    if (entryPaths.some(ignored)) {
      ignored_paths.push(...entryPaths.filter(ignored));
      continue;
    }
    for (const relativePath of entryPaths) {
      const absolutePath = path.resolve(root, relativePath);
      if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe changed path: ${relativePath}`);
    }
    changes.push(entry);
  }
  return { git_head: head, base_commit: base, changes, ignored_paths: [...new Set(ignored_paths)].sort() };
}

async function commitFileHash(root, commit, relativePath) {
  const result = await runProcess("git", ["show", `${commit}:${relativePath}`], { cwd: root, timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(`git show failed for ${commit}:${relativePath}`);
  return digest(result.stdout);
}

/** Calculate the same candidate fingerprint algorithm at a specific commit. */
export async function calculateCandidateFingerprintAtCommit(worktree, { baseCommit, commit }) {
  const root = await realpath(worktree);
  const candidate = await collectCandidateChangesAtCommit(root, { baseCommit, commit });
  const files = [];
  const changed = new Map();
  for (const entry of candidate.changes) {
    if (entry.status === "renamed") {
      changed.set(entry.source, "DELETED");
      changed.set(entry.destination, null);
    } else {
      changed.set(entry.path, entry.status === "deleted" ? "DELETED" : null);
    }
  }
  for (const [relativePath, knownHash] of [...changed.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const contentHash = knownHash === null ? await commitFileHash(root, candidate.git_head, relativePath) : knownHash;
    files.push({ path: relativePath, sha256: contentHash });
  }
  const canonical = JSON.stringify({ git_head: candidate.git_head, files });
  return { algorithm: "sha256", value: digest(canonical), git_head: candidate.git_head, files };
}

export async function worktreeBranch(worktree) {
  const root = await realpath(worktree);
  return (await gitLines(root, ["branch", "--show-current"]))[0] ?? "DETACHED";
}

export async function calculateCandidateFingerprint(worktree) {
  const root = await realpath(worktree);
  const candidate = await collectCandidateChanges(root);
  const files = [];
  const changed = new Map();
  for (const entry of candidate.changes) {
    if (entry.status === "renamed") {
      changed.set(entry.source, "DELETED");
      changed.set(entry.destination, null);
    } else {
      changed.set(entry.path, entry.status === "deleted" ? "DELETED" : null);
    }
  }
  for (const [relativePath, knownHash] of [...changed.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe changed path: ${relativePath}`);
    let contentHash = knownHash;
    if (contentHash === null) {
      contentHash = "DELETED";
      try {
        const metadata = await stat(absolutePath);
        if (metadata.isFile()) contentHash = digest(await readFile(absolutePath));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    files.push({ path: relativePath, sha256: contentHash });
  }
  const canonical = JSON.stringify({ git_head: candidate.git_head, files });
  return { algorithm: "sha256", value: digest(canonical), git_head: candidate.git_head, files };
}
