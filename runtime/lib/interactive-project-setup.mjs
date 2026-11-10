import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { formatModelValue, paint } from './terminal.mjs';
import { roleDefinitions } from '../../adapters/registry.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

function fail(message) {
  throw new Error(message);
}

function within(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15_000 });
}

function gitRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) return null;
  return path.resolve(result.stdout.trim());
}

function noTraversal(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(`${label} must be a non-empty path`);
  const normalized = value.trim().replaceAll('\\', '/');
  const absolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
  if (path.win32.isAbsolute(normalized) && !path.posix.isAbsolute(normalized)) fail(`${label} uses a path format from a different platform`);
  const parts = normalized.split('/');
  const checked = absolute && path.posix.isAbsolute(normalized) ? parts.slice(1) : parts;
  if (checked.some((part) => part === '..' || part === '')) fail(`${label} must not contain traversal or empty path segments`);
  if (/[\r\n]/.test(normalized)) fail(`${label} must not contain line breaks`);
  return normalized;
}

/** Reject symlinks in every existing path component, including the selected root. */
export async function assertNoSymlinkPath(target, { allowMissing = true } = {}) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        const canonical = await realpath(current);
        const systemTempAlias = (current === '/var' && canonical === '/private/var')
          || (current === '/tmp' && canonical === '/private/tmp');
        if (!systemTempAlias) fail(`Path contains a symlink; refusing to follow it: ${current}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return absolute;
      throw error;
    }
  }
  return absolute;
}

export async function inspectControlRoot(root) {
  const absolute = await assertNoSymlinkPath(root);
  let info = null;
  try { info = await lstat(absolute); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && !info.isDirectory()) fail(`Control Workspace path is not a directory: ${absolute}`);
  let nearest = info ? absolute : path.dirname(absolute);
  while (!(await pathExists(nearest))) {
    const parent = path.dirname(nearest);
    if (parent === nearest) break;
    nearest = parent;
  }
  const boundary = gitRoot(nearest);
  const physicalRoot = info ? await realpath(absolute) : absolute;
  return {
    path: absolute,
    exists: Boolean(info),
    gitBoundary: boundary,
    isGitRoot: Boolean(boundary && path.resolve(boundary) === physicalRoot),
  };
}

async function pathExists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function normalizeDeclaredPath(root, value, label) {
  const normalized = noTraversal(value, label);
  const absolute = path.resolve(root, normalized);
  if (!path.isAbsolute(normalized) && !within(root, absolute)) fail(`${label} escapes the Control Workspace`);
  if (absolute === root) fail(`${label} cannot be the Control Workspace root`);
  return { declared: path.isAbsolute(normalized) ? absolute : `./${path.relative(root, absolute).split(path.sep).join('/')}`, absolute };
}

function assertBranchName(value, label) {
  if (typeof value !== 'string' || !BRANCH.test(value) || value.startsWith('-') || value.includes('..') || value.includes('//') || value.endsWith('/')) {
    fail(`${label} is not a safe Git branch name: ${value}`);
  }
  const result = spawnSync('git', ['check-ref-format', '--branch', value], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) fail(`${label} is not a valid Git branch name: ${value}`);
}

/** Validate explicitly selected repositories without searching the filesystem. */
export async function validateRepositoryPlan(controlRoot, repositories, { mode = 'existing' } = {}) {
  const root = path.resolve(controlRoot);
  const rootState = await inspectControlRoot(root);
  if (rootState.gitBoundary) fail(`Control Workspace is inside Git root ${rootState.gitBoundary}; select a separate container. No repository migration is allowed here.`);
  if (!Array.isArray(repositories)) fail('Repository selection must be a list.');
  if (!['existing', 'greenfield', 'defer'].includes(mode)) fail(`Unsupported repository mode: ${mode}`);
  if (mode === 'defer') {
    if (repositories.length) fail('Deferred repository setup cannot include repository entries.');
    return [];
  }
  if (!repositories.length) fail('Select at least one repository or explicitly defer repository setup.');

  const ids = new Set();
  const paths = [];
  const worktrees = [];
  const result = [];
  for (const [index, entry] of repositories.entries()) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!ID.test(id)) fail(`Repository ${index + 1} needs a stable ID using lowercase letters, numbers, and hyphens.`);
    if (ids.has(id)) fail(`Repository ID is duplicated: ${id}`);
    ids.add(id);
    const repository = normalizeDeclaredPath(root, entry.path, `${id} repository path`);
    const worktree = normalizeDeclaredPath(root, entry.worktree, `${id} worktree path`);
    assertBranchName(entry.base_branch, `${id} base branch`);
    assertBranchName(entry.project_branch, `${id} project branch`);
    if (entry.base_branch === entry.project_branch) fail(`${id} project branch must differ from its base branch.`);
    if (paths.some((other) => within(other, repository.absolute) || within(repository.absolute, other))) {
      fail(`Repository paths overlap; repositories must be independent Git roots: ${repository.declared}`);
    }
    if (within(repository.absolute, worktree.absolute) || within(worktree.absolute, repository.absolute)) {
      fail(`Repository and its worktree mapping must be separate paths: ${repository.declared} / ${worktree.declared}`);
    }
    if (worktrees.some((other) => within(other, worktree.absolute) || within(worktree.absolute, other))) {
      fail(`Worktree paths overlap: ${worktree.declared}`);
    }
    if (paths.some((other) => within(other, worktree.absolute) || within(worktree.absolute, other))) {
      fail(`Worktree path overlaps another product repository: ${worktree.declared}`);
    }
    if (result.some((other) => within(other.absoluteWorktree, repository.absolute) || within(repository.absolute, other.absoluteWorktree))) {
      fail(`Repository path overlaps another mapped worktree: ${repository.declared}`);
    }

    await assertNoSymlinkPath(repository.absolute);
    await assertNoSymlinkPath(worktree.absolute);
    let repositoryInfo = null;
    try { repositoryInfo = await lstat(repository.absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (mode === 'existing') {
      if (!repositoryInfo?.isDirectory()) fail(`Existing repository directory does not exist: ${repository.absolute}`);
      const top = gitRoot(repository.absolute);
      const physical = await realpath(repository.absolute);
      if (!top || path.resolve(top) !== physical) fail(`Selected path is not an independent Git root: ${repository.absolute}`);
    } else {
      if (repositoryInfo && !repositoryInfo.isDirectory()) fail(`Greenfield repository path is not a directory: ${repository.absolute}`);
      if (repositoryInfo && (await readdir(repository.absolute)).length > 0) fail(`Greenfield repository directory must be empty: ${repository.absolute}`);
      let nearest = path.dirname(repository.absolute);
      while (!(await pathExists(nearest))) {
        const parent = path.dirname(nearest);
        if (parent === nearest) break;
        nearest = parent;
      }
      if (gitRoot(nearest)) fail(`Greenfield path is already inside a Git worktree: ${repository.absolute}`);
    }

    let worktreeInfo = null;
    try { worktreeInfo = await lstat(worktree.absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (worktreeInfo) {
      if (!worktreeInfo.isDirectory()) fail(`Mapped worktree path is not a directory: ${worktree.absolute}`);
      const worktreeRoot = gitRoot(worktree.absolute);
      const physicalWorktree = await realpath(worktree.absolute);
      if (!worktreeRoot || path.resolve(worktreeRoot) !== physicalWorktree) fail(`Existing mapped worktree is not a Git worktree root: ${worktree.absolute}`);
      const repositoryCommon = git(repository.absolute, ['rev-parse', '--git-common-dir']);
      const worktreeCommon = git(worktree.absolute, ['rev-parse', '--git-common-dir']);
      const commonPath = async (cwd, value) => realpath(path.resolve(cwd, value.trim()));
      if (repositoryCommon.status !== 0 || worktreeCommon.status !== 0
        || await commonPath(repository.absolute, repositoryCommon.stdout) !== await commonPath(worktree.absolute, worktreeCommon.stdout)) {
        fail(`Mapped worktree belongs to a different Git repository: ${worktree.absolute}`);
      }
    }
    paths.push(repository.absolute);
    worktrees.push(worktree.absolute);
    result.push({
      id,
      path: repository.declared,
      base_branch: entry.base_branch,
      project_branch: entry.project_branch,
      worktree: worktree.declared,
      status: mode === 'greenfield' ? 'proposed-new' : 'existing',
      absolutePath: repository.absolute,
      absoluteWorktree: worktree.absolute,
    });
  }
  return result;
}

function yamlScalar(value) { return JSON.stringify(String(value)); }

function mappingBlock(repositories, indentation = 0) {
  const pad = ' '.repeat(indentation);
  const entryPad = `${pad}  `;
  const propertyPad = `${entryPad}  `;
  if (!repositories.length) return `${pad}repositories: []`;
  return [
    `${pad}repositories:`,
    ...repositories.flatMap((repository) => [
      `${entryPad}- id: ${yamlScalar(repository.id)}`,
      `${propertyPad}path: ${yamlScalar(repository.path)}`,
      `${propertyPad}base_branch: ${yamlScalar(repository.base_branch)}`,
      `${propertyPad}project_branch: ${yamlScalar(repository.project_branch)}`,
      `${propertyPad}worktree: ${yamlScalar(repository.worktree)}`,
    ]),
  ].join('\n');
}

function parseYamlSection(lines, start, end, sectionIndent) {
  const entries = [];
  let current = null;
  let itemIndent = null;
  for (let index = start + 1; index < end; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indentation = raw.search(/\S/);
    const item = raw.match(/^(\s*)-\s*([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (item && indentation > sectionIndent) {
      if (current) entries.push(current);
      itemIndent = item[1].length;
      current = { [item[2]]: decodeYamlScalar(item[3]) };
      continue;
    }
    const property = raw.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!property || !current || Number(property[1].length) <= itemIndent) fail('Existing project.yaml repository list uses an unsupported shape; it was left unchanged.');
    current[property[2]] = decodeYamlScalar(property[3]);
  }
  if (current) entries.push(current);
  return entries;
}

function equivalentMappingPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = (value) => path.posix.isAbsolute(value)
    ? path.posix.normalize(value.replaceAll('\\', '/'))
    : path.posix.normalize(value.replaceAll('\\', '/').replace(/^\.\//, ''));
  return normalize(left) === normalize(right);
}

function yamlRepositoryAdditions(existing, incoming) {
  const ids = new Map();
  for (const entry of existing) {
    if (!entry.id) fail('Existing project.yaml repository entry has no ID; the file was left unchanged.');
    if (ids.has(entry.id)) fail(`Existing project.yaml has duplicate repository ID ${entry.id}; the file was left unchanged.`);
    ids.set(entry.id, entry);
  }
  const additions = [];
  for (const candidate of incoming) {
    const sameId = ids.get(candidate.id);
    if (sameId) {
      const exact = equivalentMappingPath(sameId.path, candidate.path)
        && sameId.base_branch === candidate.base_branch
        && sameId.project_branch === candidate.project_branch
        && equivalentMappingPath(sameId.worktree, candidate.worktree);
      if (!exact) fail(`project.yaml already maps repository ID ${candidate.id} differently or incompletely; the existing mapping was preserved.`);
      continue;
    }
    const duplicatePath = existing.find((entry) => equivalentMappingPath(entry.path, candidate.path)
      || equivalentMappingPath(entry.worktree, candidate.worktree));
    if (duplicatePath) fail(`project.yaml already maps repository/worktree path for ${duplicatePath.id}; duplicate mapping refused.`);
    additions.push(candidate);
    ids.set(candidate.id, candidate);
  }
  return additions;
}

function decodeYamlScalar(value) {
  const clean = value.replace(/\s+#.*$/, '').trim();
  if (clean.startsWith('"')) {
    try { return JSON.parse(clean); } catch { fail('Existing project.yaml contains an invalid quoted repository value.'); }
  }
  if (clean.startsWith("'")) return clean.slice(1, clean.endsWith("'") ? -1 : undefined).replaceAll("''", "'");
  return clean;
}

/** Merge only the existing project.yaml repository contract, preserving unrelated YAML text. */
export function mergeProjectYaml(source, repositories, { projectId = 'project', title = 'Project' } = {}) {
  if (source === null || source === undefined) {
    const normalizedId = String(projectId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'project';
    const header = [
      'version: 2',
      '',
      'project:',
      `  id: ${yamlScalar(normalizedId)}`,
      `  title: ${yamlScalar(title)}`,
      '  owner: "Owner"',
      '  prd_source: "PRD.md"',
      '  prd: artifacts/prd.md',
      '',
    ].join('\n');
    return `${header}${mappingBlock(repositories)}\n`;
  }

  let json;
  try { json = JSON.parse(source); }
  catch { json = null; }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const destination = Array.isArray(json.repositories)
      ? json
      : json.project && typeof json.project === 'object' && Array.isArray(json.project.repositories)
        ? json.project
        : json;
    const current = Array.isArray(destination.repositories) ? destination.repositories : [];
    const merged = mergeRepositoryEntries(current, repositories);
    if (merged.length === current.length) return source;
    destination.repositories = merged;
    return `${JSON.stringify(json, null, 2)}\n`;
  }

  const lines = source.split(/\r?\n/);
  const rootStart = lines.findIndex((line) => /^repositories:\s*(?:(?:\[\])\s*)?(?:#.*)?$/.test(line));
  const projectStart = rootStart < 0
    ? lines.findIndex((line, index) => /^project:\s*(?:#.*)?$/.test(line)
      && lines.slice(index + 1).some((child) => /^  repositories:\s*(?:#.*)?$/.test(child)))
    : -1;
  const nestedStart = projectStart < 0 ? -1 : lines.findIndex((line, index) => index > projectStart && /^  repositories:\s*(?:(?:\[\])\s*)?(?:#.*)?$/.test(line));
  const start = rootStart >= 0 ? rootStart : nestedStart;
  const indentation = rootStart >= 0 ? 0 : 2;
  if (start < 0) {
    const normalized = source.replace(/\s*$/, '');
    return `${normalized}${normalized ? '\n\n' : ''}${mappingBlock(repositories)}\n`;
  }
  const end = lines.findIndex((line, index) => index > start && line.trim() && !/^\s*#/.test(line) && line.search(/\S/) <= indentation);
  const sectionEnd = end < 0 ? lines.length : end;
  const header = lines[start].trim();
  const inline = header.slice(header.indexOf(':') + 1).replace(/\s+#.*$/, '').trim();
  if (inline && inline !== '[]') fail('Existing project.yaml repositories must use the documented list form; the file was left unchanged.');
  const existing = inline === '[]' ? [] : parseYamlSection(lines, start, sectionEnd, indentation);
  const additions = yamlRepositoryAdditions(existing, repositories);
  if (!additions.length) return source;
  const block = mappingBlock(additions, indentation).split('\n');
  if (inline === '[]') lines.splice(start, 1, `${' '.repeat(indentation)}repositories:`, ...block.slice(1));
  else lines.splice(sectionEnd, 0, ...block.slice(1));
  return `${lines.join('\n').replace(/\s*$/, '')}\n`;
}

function mergeRepositoryEntries(existing, incoming) {
  const merged = existing.map((entry) => ({ ...entry }));
  for (const candidate of incoming) {
    const sameId = merged.find((entry) => entry.id === candidate.id);
    if (sameId) {
      for (const key of ['path', 'base_branch', 'project_branch', 'worktree']) {
        const pathsMatch = ['path', 'worktree'].includes(key)
          && sameId[key] !== undefined
          && equivalentMappingPath(String(sameId[key]), String(candidate[key]));
        if (sameId[key] !== undefined && sameId[key] !== candidate[key] && !pathsMatch) {
          fail(`project.yaml already maps repository ID ${candidate.id} differently; the existing mapping was preserved.`);
        }
      }
      Object.assign(sameId, Object.fromEntries(['path', 'base_branch', 'project_branch', 'worktree']
        .filter((key) => sameId[key] === undefined)
        .map((key) => [key, candidate[key]])));
      continue;
    }
    const samePath = merged.find((entry) => equivalentMappingPath(entry.path, candidate.path) || equivalentMappingPath(entry.worktree, candidate.worktree));
    if (samePath) fail(`project.yaml already maps repository/worktree path for ${samePath.id}; duplicate mapping refused.`);
    merged.push({
      id: candidate.id,
      path: candidate.path,
      base_branch: candidate.base_branch,
      project_branch: candidate.project_branch,
      worktree: candidate.worktree,
    });
  }
  const ids = new Set();
  for (const entry of merged) {
    if (!entry.id) fail('Existing project.yaml repository entry has no ID; the file was left unchanged.');
    if (ids.has(entry.id)) fail(`Existing project.yaml has duplicate repository ID ${entry.id}; the file was left unchanged.`);
    ids.add(entry.id);
  }
  return merged;
}

export async function readProjectYamlPlan(controlRoot, repositories, { projectId, title } = {}) {
  const target = path.join(controlRoot, 'project.yaml');
  let before = null;
  let mode = 0o644;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) fail('project.yaml is not a regular file; it was left unchanged.');
    mode = info.mode & 0o777;
    before = await readFile(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const after = mergeProjectYaml(before, repositories, { projectId, title });
  return { path: target, before, after, mode, changed: before !== after };
}

export async function writeProjectYamlPlan(plan, { beforePublishIfAbsent } = {}) {
  let current = null;
  try { current = await readFile(plan.path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== plan.before) fail(`project.yaml changed after preview; refusing to overwrite: ${plan.path}`);
  const { open, link, rename, unlink } = await import('node:fs/promises');
  const temporary = `${plan.path}.triad-setup-${process.pid}-${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', plan.mode ?? 0o644);
    await handle.writeFile(plan.after, 'utf8');
    await handle.close();
    handle = null;
    if (plan.before === null) {
      await beforePublishIfAbsent?.(plan.path);
      try { await link(temporary, plan.path); }
      catch (error) { if (error.code === 'EEXIST') fail(`project.yaml appeared after preview; refusing to overwrite: ${plan.path}`); throw error; }
    } else {
      await rename(temporary, plan.path);
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function initializeGreenfieldRepositories(repositories) {
  const created = [];
  try {
    for (const repository of repositories.filter((entry) => entry.status === 'proposed-new')) {
      await assertNoSymlinkPath(repository.absolutePath);
      let info = null;
      try { info = await lstat(repository.absolutePath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info && (!info.isDirectory() || (await readdir(repository.absolutePath)).length > 0)) {
        fail(`Greenfield path changed after preview and is no longer empty: ${repository.absolutePath}`);
      }
      const result = spawnSync('git', ['init', `--initial-branch=${repository.base_branch}`, repository.absolutePath], { encoding: 'utf8', timeout: 30_000 });
      if (result.status !== 0) fail(`Could not initialize local Git repository ${repository.absolutePath}: ${result.stderr.trim() || result.error?.message || 'git init failed'}`);
      const top = gitRoot(repository.absolutePath);
      const physical = await realpath(repository.absolutePath);
      if (top !== physical) fail(`Git initialized at an unexpected root: ${top ?? repository.absolutePath}`);
      created.push(repository.absolutePath);
      const remotes = git(repository.absolutePath, ['remote']);
      if (remotes.status !== 0 || remotes.stdout.trim()) fail(`Unexpected remote detected after local initialization; inspect ${repository.absolutePath}.`);
    }
  } catch (error) {
    error.createdRepositories = created;
    throw error;
  }
  return created;
}

export async function immediateGitChildren(root) {
  const result = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(root, entry.name);
    if (gitRoot(child) === child) result.push(`./${entry.name}`);
  }
  return result.sort();
}

/** Validate one explicitly supplied existing Git root without scanning beyond it. */
export async function inspectExistingRepositoryRoot(controlRoot, candidatePath) {
  const root = path.resolve(controlRoot);
  const repository = normalizeDeclaredPath(root, candidatePath, 'repository path');
  await assertNoSymlinkPath(repository.absolute, { allowMissing: false });
  let info;
  try { info = await lstat(repository.absolute); }
  catch (error) { if (error.code === 'ENOENT') fail(`Existing repository directory does not exist: ${repository.absolute}`); throw error; }
  if (!info.isDirectory()) fail(`Existing repository path is not a directory: ${repository.absolute}`);
  const top = gitRoot(repository.absolute);
  const physical = await realpath(repository.absolute);
  if (!top || path.resolve(top) !== physical) fail(`Selected path is not an independent Git root: ${repository.absolute}`);
  const branchResult = git(repository.absolute, ['branch', '--show-current']);
  const currentBranch = branchResult.status === 0 ? branchResult.stdout.trim() : '';
  return {
    path: repository.declared,
    absolutePath: repository.absolute,
    currentBranch: currentBranch || null,
  };
}

export async function setupReadiness(controlRoot, repositories) {
  const prd = path.join(controlRoot, 'PRD.md');
  const gates = path.join(controlRoot, '.loop', 'quality-gates.yaml');
  const missing = [];
  try { if (!(await stat(prd)).isFile()) missing.push('root PRD.md'); }
  catch { missing.push('root PRD.md'); }
  try { if (!(await stat(gates)).isFile()) missing.push('.loop/quality-gates.yaml'); }
  catch { missing.push('.loop/quality-gates.yaml'); }
  for (const repository of repositories) {
    const head = git(repository.absolutePath, ['rev-parse', '--verify', 'HEAD']);
    if (head.status !== 0) missing.push(`${repository.id} initial Git baseline commit`);
    try { await stat(repository.absoluteWorktree); }
    catch { missing.push(`${repository.id} mapped worktree (not created by setup)`); }
  }
  return { ready: missing.length === 0 && repositories.length > 0, missing };
}

export function projectLaunchHint(adapter, controlRoot, { globalEntryInstalled = false } = {}) {
  const rootLine = `Control Workspace: ${controlRoot}`;
  const common = [
    rootLine,
    'Installation succeeded; adapter assets are installed, but project readiness was not checked.',
    'Before a first loop: add root PRD.md and .loop/quality-gates.yaml; make an initial commit in each mapped repository, then create its mapped worktree.',
    `Optional from this Control Workspace: npx triad-plus doctor --host ${adapter.id} --control . (host/install only; not readiness).`,
  ];
  let entry;
  if (adapter.id === 'opencode') entry = 'After readiness — OpenCode: open this Control Workspace and run `/triad ./PRD.md`.';
  else if (adapter.id === 'claude-code') entry = 'After readiness — Claude Code: open this Control Workspace and run `/triad ./PRD.md`.';
  else if (adapter.id === 'copilot') entry = 'After readiness — GitHub Copilot: select the project-local triad-orchestrator agent in VS Code.';
  else if (adapter.id === 'antigravity') entry = 'After readiness — Antigravity: local assets are installed; native discovery still needs a host smoke test.';
  else if (adapter.id === 'codex') entry = globalEntryInstalled
    ? 'After readiness — Codex: reopen it from this Control Workspace; the optional user-level $triad entry preflights the consent-bound workspace and runtime hashes.'
    : 'After readiness — Codex: reopen it from this Control Workspace; project-local skill assets are installed, while optional user-level $triad was not selected.';
  else if (adapter.id === 'hermes') entry = globalEntryInstalled
    ? 'After readiness — Hermes: restart it from this Control Workspace; the optional user-level /triad entry preflights the consent-bound workspace and runtime hashes.'
    : 'After readiness — Hermes: reopen it from this Control Workspace; project-local runtime is installed, while optional user-level /triad was not selected.';
  else entry = `After readiness — native entry: ${adapter.entry ?? 'not declared'}.`;
  return [...common, entry, 'Quickstart: https://github.com/ainz-dg/triad-plus-engineering-loop/blob/main/docs/getting-started.md'];
}

export function formatSetupPreview({ root, repositories, adapters, adapterPlans, projectYamlPlan, currentVersion, teamMode = 'leave unconfigured', team = null, roleOverlayPlan = null, roleBindingActions = [], globalEntryPlans = new Map(), stream = process.stdout }) {
  const label = (value) => paint(value, 'section', { stream });
  const directories = new Set();
  for (const adapter of adapters) {
    for (const target of adapterPlans.get(adapter.id)?.created ?? []) {
      let parent = path.dirname(target);
      while (parent !== '.') {
        directories.add(parent);
        parent = path.dirname(parent);
      }
    }
  }
  directories.add('.triad-plus');
  const lines = [
    paint('What this setup will change', 'title', { stream }),
    `${label('Setup folder (Control Workspace)')}: ${root}`,
    `${label('Triad+ version')}: ${currentVersion}`,
    `${label('project.yaml')}: ${projectYamlPlan.changed ? `${projectYamlPlan.before === null ? 'CREATE' : 'UPDATE repositories mapping only'}` : 'unchanged'}`,
    `${label('Team configuration')}: ${teamMode}`,
    ...(teamMode === 'leave unconfigured' ? [] : [
      `  .triad-plus/team.json: ${teamMode === 'reuse existing without rewriting' ? 'REUSE unchanged' : 'CREATE'}`,
      ...(roleOverlayPlan ? [`  AGENTS.md role instructions: ${roleOverlayPlan.action.toUpperCase()} ${roleOverlayPlan.target}`] : []),
      '  Model/effort: host defaults; team.json stores unverified requested intent.',
      ...roleDefinitions.map(({ id }) => `    ${id} — requested model: ${formatModelValue(team?.roles?.[id]?.model)}; effort: ${formatModelValue(team?.roles?.[id]?.reasoning_effort)}`),
      ...(roleBindingActions.length ? [
        '  Host role assets (project-local; model/effort overrides omitted):',
        ...roleBindingActions.map(({ adapterId, target }) => `    ${adapterId}: CONFIGURE ${target}`),
      ] : []),
    ]),
    globalEntryPlans.size
      ? `${label('Coding-tool files')}: local setup files plus the exact user-level shortcuts and workspace links listed below. No credentials, account settings, or unrelated profile files will be changed.`
      : `${label('Coding-tool files')}: local to this setup folder; no user-level files, credentials, or account settings will be changed.`,
    label('Folders created under the setup folder after approval:'),
    `  ${root} (create only if absent)`,
    ...[...directories].sort().map((directory) => `  ${path.join(root, directory)}`),
    label('Repository actions:'),
    ...(repositories.length ? repositories.map((repository) => `  ${repository.status === 'proposed-new' ? 'INIT local Git only (after approval; no remote/push)' : 'KEEP existing Git repository unchanged'} ${repository.id}: ${repository.path}; base=${repository.base_branch}; project=${repository.project_branch}; worktree=${repository.worktree}`) : ['  Deferred; no repository will be initialized or mapped by this plan.']),
    label('Adapter assets:'),
    ...adapters.flatMap((adapter) => {
      const plan = adapterPlans.get(adapter.id);
      return [
        `  ${label(`${adapter.label} (${adapter.id})`)}: ${plan?.created?.length ?? 0} new local file(s), ${plan?.reused?.length ?? 0} exact-byte reuse(s)`,
        ...(plan?.created ?? []).map((target) => `    CREATE ${target}`),
        ...(plan?.reused ?? []).map((target) => `    REUSE ${target}`),
      ];
    }),
    label('Optional user-level shortcuts (Codex/Hermes; separate approval required):'),
    ...(globalEntryPlans.size
      ? [...globalEntryPlans.values()].flatMap((plan) => [
        `  ${plan.adapterId}:`,
        ...plan.created.map((target) => `    CREATE ${target}`),
        ...plan.reused.map((target) => `    REUSE identical ${target}`),
      ])
      : ['  Not selected; no user-level files will be written.']),
    `${label('Primary tool')}: ${adapters[0]?.label ?? 'none'}; adding another tool does not switch tools automatically during a run.`,
  ];
  return `${lines.join('\n')}\n`;
}

export function formatInteractiveSetupSummary({ root, repositories, adapters, projectYamlPlan, currentVersion, teamMode = 'leave unconfigured', team = null, globalEntryPlans = new Map(), heading = 'Setup summary', showDetailsHint = true, stream = process.stdout }) {
  const label = (value) => paint(value, 'section', { stream });
  const repositoryLines = repositories.length
    ? repositories.map((repository) => `  ${repository.id}: ${repository.path} → base ${repository.base_branch}; project ${repository.project_branch}; worktree ${repository.worktree}`)
    : ['  deferred; no repository will be initialized or mapped by this plan'];
  const globalAdapters = [...globalEntryPlans.keys()];
  const evaluator = teamMode === 'leave unconfigured'
    ? 'not configured'
    : team?.roles?.evaluator?.enabled === true ? 'enabled' : 'disabled';
  const lines = [
    paint(heading, 'title', { stream }),
    `${label('Control Workspace')}: ${root}`,
    `${label('Triad+ version')}: ${currentVersion}`,
    label('Repositories:'),
    ...repositoryLines,
    `${label('Coding tools')}: ${adapters.map((adapter) => `${adapter.label} (${adapter.id})`).join(', ')}`,
    `${label('Changes planned')}: local tool entries; project settings ${projectYamlPlan.changed ? projectYamlPlan.before === null ? 'will be created' : 'will be updated' : 'stay unchanged'}.`,
    `${label('Team setup')}: ${teamMode === 'leave unconfigured' ? 'not configured (optional)' : teamMode}; Evaluator+: ${evaluator}`,
    ...(team ? ['Model/effort: host defaults; team.json stores unverified requested intent.'] : []),
    `${label('Project settings')}: ${projectYamlPlan.changed ? projectYamlPlan.before === null ? 'new' : 'repository mapping update' : 'unchanged'}`,
    `${label('Files')}: setup-folder only${globalAdapters.length ? ` plus optional user-level shortcut files for ${globalAdapters.join(', ')}` : '; no user-level files'}`,
    paint('No files are written until you type "install".', 'warning', { stream }),
    ...(showDetailsHint ? [paint('Type "details" to inspect the exact file plan before approval.', 'hint', { stream })] : []),
  ];
  return `${lines.join('\n')}\n`;
}

export async function confirmAndApplySetup({ prompt, preview, summary = preview, apply, requireDetails = false, write = (value) => process.stdout.write(value) }) {
  write(`\n${summary}`);
  let reviewedDetails = false;
  while (true) {
    const question = requireDetails && !reviewedDetails
      ? 'Type details to review exact user-level paths before install (install is not accepted yet): '
      : 'Type install to apply this exact plan, details to inspect it, or anything else to cancel: ';
    const answer = await prompt.question(question);
    if (answer === 'details') {
      write(`\n${preview}`);
      reviewedDetails = true;
      continue;
    }
    if (answer === 'install' && (!requireDetails || reviewedDetails)) {
      await apply();
      return true;
    }
    if (answer === 'install') {
      write('Review the exact user-level paths with "details" before approving this plan.\n');
      continue;
    }
    write('Cancelled. No files were changed.\n');
    return false;
  }
}

export function parseAdapterSelection(answer, adapters) {
  const tokens = answer.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return null;
  const selected = [];
  const seen = new Set();
  for (const token of tokens) {
    const adapter = /^\d+$/.test(token)
      ? adapters[Number(token) - 1]
      : adapters.find((candidate) => candidate.id.toLowerCase() === token.toLowerCase());
    if (!adapter) return null;
    if (seen.has(adapter.id)) return null;
    seen.add(adapter.id);
    selected.push(adapter);
  }
  return selected;
}

export function parsePositiveCount(answer, maximum = 100) {
  const value = Number(answer);
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : null;
}
