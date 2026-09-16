import { createHash } from "node:crypto";
import { realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;

function contextError(message, code = "repository_context_invalid") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Required repository skills are deliberately worktree-relative. Reject
 * absolute paths and parent traversal instead of allowing a caller to combine
 * files from the control workspace or another repository root.
 */
export function repositoryRelativePath(value, label = "repository skill path") {
  if (typeof value !== "string" || !value.trim()) throw contextError(`${label} must be a non-empty repository-relative path`);
  const normalized = value.trim().replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw contextError(`${label} must be repository-relative`);
  }
  const segments = normalized.split("/");
  if (segments.includes("..") || segments.includes("")) {
    throw contextError(`${label} must not contain parent traversal or empty path segments`);
  }
  return normalized;
}

async function gitTopLevel(cwd) {
  const result = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15_000 });
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  if (!value) return null;
  return realpath(value).catch(() => path.resolve(value));
}

async function shellPwd(cwd) {
  const result = await runProcess("pwd", [], { cwd, timeoutMs: 15_000 });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

/**
 * Inspect the repository context bound to an assignment. This is intentionally
 * read-only and host-neutral: it proves the assigned worktree, its Git root,
 * and every required skill's real path/hash. `checkActualCwd` is used by a
 * role activation; verifier/packet creation leave it false because they run
 * from the control workspace and must not mistake that process cwd for the
 * delegated role cwd.
 */
export async function inspectRepositoryContext({
  worktree,
  requiredSkills = [],
  actualCwd = null,
  checkActualCwd = false
} = {}) {
  if (typeof worktree !== "string" || !worktree.trim()) throw contextError("assigned worktree is required");
  if (!Array.isArray(requiredSkills)) throw contextError("required repository skills must be an array");
  const assignedWorktree = await realpath(worktree).catch(() => {
    throw contextError(`assigned worktree is missing: ${worktree}`);
  });
  const assignedGitTopLevel = await gitTopLevel(assignedWorktree);
  const issues = [];
  if (!assignedGitTopLevel) {
    issues.push(issue("assigned_repository_not_git", "assigned worktree has no resolvable Git top-level", {
      assigned_worktree: assignedWorktree
    }));
  } else if (assignedGitTopLevel !== assignedWorktree) {
    issues.push(issue("assigned_worktree_not_repository_root", "assigned worktree is not the repository Git top-level", {
      assigned_worktree: assignedWorktree,
      assigned_git_top_level: assignedGitTopLevel
    }));
  }

  const skills = [];
  const seen = new Set();
  for (const [index, item] of requiredSkills.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(issue("invalid_repository_skill_binding", "repository skill binding must be an object", { index }));
      continue;
    }
    let relative;
    try { relative = repositoryRelativePath(item.path, `repository skill [${index}] path`); }
    catch (error) {
      issues.push(issue("invalid_repository_skill_path", error.message, { index, path: item.path ?? null }));
      continue;
    }
    if (seen.has(relative)) {
      issues.push(issue("duplicate_repository_skill", `repository skill is declared more than once: ${relative}`, { path: relative }));
      continue;
    }
    seen.add(relative);
    if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) {
      issues.push(issue("invalid_repository_skill_hash", `repository skill requires a SHA-256 hash: ${relative}`, { path: relative }));
      continue;
    }
    const lexical = path.resolve(assignedWorktree, relative);
    if (!inside(assignedWorktree, lexical)) {
      issues.push(issue("repository_skill_outside_worktree", `repository skill escapes assigned worktree: ${relative}`, { path: relative }));
      continue;
    }
    let resolved;
    try { resolved = await realpath(lexical); }
    catch {
      issues.push(issue("repository_skill_missing", `repository skill missing: ${relative}`, { path: relative, resolved_path: lexical }));
      continue;
    }
    if (!inside(assignedWorktree, resolved)) {
      issues.push(issue("repository_skill_symlink_escape", `repository skill resolves outside assigned worktree: ${relative}`, { path: relative, resolved_path: resolved }));
      continue;
    }
    try {
      if (!(await stat(resolved)).isFile()) throw new Error("not a regular file");
    } catch {
      issues.push(issue("repository_skill_not_file", `repository skill is not a regular file: ${relative}`, { path: relative, resolved_path: resolved }));
      continue;
    }
    const actual = digest(await readFile(resolved));
    const skillGitTopLevel = await gitTopLevel(path.dirname(resolved));
    const entry = {
      path: relative,
      resolved_path: resolved,
      sha256: actual,
      repository_root: skillGitTopLevel
    };
    skills.push(entry);
    if (actual.toLowerCase() !== item.sha256.toLowerCase()) {
      issues.push(issue("repository_skill_hash_mismatch", `repository skill hash mismatch: ${relative}`, {
        path: relative,
        expected_sha256: item.sha256,
        actual_sha256: actual
      }));
    }
    if (assignedGitTopLevel && skillGitTopLevel !== assignedGitTopLevel) {
      issues.push(issue("repository_skill_root_mismatch", `repository skill belongs to a different Git root: ${relative}`, {
        path: relative,
        skill_repository_root: skillGitTopLevel,
        assigned_git_top_level: assignedGitTopLevel
      }));
    }
  }

  let actual = null;
  if (checkActualCwd) {
    const requested = actualCwd || process.cwd();
    const resolved = await realpath(requested).catch(() => path.resolve(requested));
    const gitRoot = await gitTopLevel(resolved);
    actual = {
      process_cwd: process.cwd(),
      shell_pwd: await shellPwd(process.cwd()),
      resolved_cwd: resolved,
      git_top_level: gitRoot
    };
    if (resolved !== assignedWorktree) {
      issues.push(issue("runtime_cwd_mismatch", "role process cwd does not match assigned worktree", {
        expected_worktree: assignedWorktree,
        actual_cwd: resolved
      }));
    }
    if (assignedGitTopLevel && gitRoot !== assignedGitTopLevel) {
      issues.push(issue("runtime_git_root_mismatch", "role process Git top-level does not match assigned repository", {
        expected_git_top_level: assignedGitTopLevel,
        actual_git_top_level: gitRoot
      }));
    }
  }

  return {
    status: issues.length ? "blocked" : "pass",
    assigned_worktree: assignedWorktree,
    assigned_git_top_level: assignedGitTopLevel,
    actual,
    skills,
    issues
  };
}

export { SHA256 };
