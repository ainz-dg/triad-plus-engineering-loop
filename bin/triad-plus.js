#!/usr/bin/env node

import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile, lstat, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve, relative, sep } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { getAdapter, listAdapters, roleDefinitions, sharedSkillNames } from '../adapters/registry.mjs';
import { selectChecklist } from '../runtime/lib/interactive-tui.mjs';
import { writeImportedCard } from '../integrations/bmad/story-importer.mjs';
import {
  hostModelField,
  materializedHostRoleConfiguration,
  supportsNativeReasoning,
  validateTeamConfiguration
} from '../runtime/lib/model-config.mjs';
import {
  formatDoctorLine,
  formatDoctorSection,
  formatSetupSummary
} from '../runtime/lib/terminal.mjs';
import {
  buildInstallationManifest,
  buildMultiAdapterManifest,
  collectManagedAssetRecords,
  installationManifestFingerprint,
  installationManifestPath,
  loadInstallationManifest,
  manifestIsUninstalled,
  manifestScopeStatus,
  MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION,
  sha256Text,
  sha256File,
  writeInstallationManifest
} from '../runtime/lib/installation-manifest.mjs';
import { interactiveAdapterManagement } from '../runtime/lib/interactive-adapter-menu.mjs';
import {
  assertNoSymlinkPath,
  confirmAndApplySetup,
  formatSetupPreview,
  immediateGitChildren,
  inspectExistingRepositoryRoot,
  initializeGreenfieldRepositories,
  inspectControlRoot,
  parsePositiveCount,
  projectLaunchHint,
  readProjectYamlPlan,
  setupReadiness,
  validateRepositoryPlan,
  writeProjectYamlPlan,
} from '../runtime/lib/interactive-project-setup.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Triad+ installer

Usage:
  npx triad-plus
  npx triad-plus --version
  npx triad-plus init --host <adapter-id> --control <path> [--global] [--team-config <path>] [--allow-product-repo]
  npx triad-plus doctor --host <adapter-id> --control <path> [--global] [--hook-config <path>]
  npx triad-plus version --control <path>
  npx triad-plus upgrade --host <adapter-id> --control <path> [--global] [--apply]
  npx triad-plus uninstall --host <adapter-id> --control <path> [--global] [--apply]
  npx triad-plus adapter list --control <path>
  npx triad-plus adapter doctor [<adapter-id>] --control <path>
  npx triad-plus adapter add <adapter-id> --control <path> [--apply]
  npx triad-plus adapter upgrade <adapter-id> --control <path> [--apply]
  npx triad-plus adapter remove <adapter-id> --control <path> [--apply]
  npx triad-plus import-bmad-story --source <story.md> --output <card.md> [--target-repository <id>] [--provenance <record.json>] [--required-gate <id>] [--depends-on <card-id>]
  npx triad-plus cockpit [--control <path>] [--port <n>] [--no-open]

Adapters: ${listAdapters().map((adapter) => adapter.id).join(', ')}

The control path is a project-control workspace, not a product repository.
Installation refuses conflicting asset overwrites; identical global assets may be reused. Upgrade is a dry run unless --apply is supplied.
cockpit serves a read-only web view of the control workspace on 127.0.0.1 only; it never starts agents. Without --control it validates the current directory. A local interactive launch may open the one-time URL in your browser; --no-open disables this.
Multi-adapter installation records membership and exact local asset ownership. Attempt-bound host dispatch is not available in this version.
`);
  process.exit(exitCode);
}

function parseArgs(args) {
  const [command, ...arguments_] = args;
  const rest = [...arguments_];
  const options = { command, global: false, allowProductRepo: false, apply: false, noOpen: false, requiredGates: [], dependsOn: [] };
  if (command === 'adapter') {
    options.adapterCommand = rest.shift();
    if (!['add', 'list', 'doctor', 'upgrade', 'remove'].includes(options.adapterCommand)) throw new Error('Use adapter add, list, doctor, upgrade, or remove.');
    if (!rest[0]?.startsWith('-') && rest.length > 0) options.host = rest.shift();
  }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--global') options.global = true;
    else if (argument === '--allow-product-repo') options.allowProductRepo = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--no-open' && command === 'cockpit') options.noOpen = true;
    else if (argument === '--required-gate' || argument === '--depends-on') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      const target = argument === '--required-gate' ? options.requiredGates : options.dependsOn;
      target.push(value);
      index += 1;
    }
    else if (['--host', '--control', '--team-config', '--hook-config', '--source', '--output', '--target-repository', '--provenance'].includes(argument)
      || (argument === '--port' && command === 'cockpit')) {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else if (argument === '--help' || argument === '-h') usage(0);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function requireDirectory(target) {
  if (!(await exists(target))) return mkdir(target, { recursive: true });
  if (!(await stat(target)).isDirectory()) throw new Error(`Control path is not a directory: ${target}`);
}

async function requireExistingDirectory(target) {
  let info;
  try { info = await stat(target); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Control workspace does not exist: ${target}`);
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`Control path is not a directory: ${target}`);
}

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function context(controlRoot) {
  return { controlRoot, codexHome: codexHome() };
}

function resolveDestination(destination, root, installContext) {
  const value = typeof destination === 'function' ? destination(installContext) : join(root, destination);
  return resolve(value);
}

function sourcePath(source) {
  return join(packageRoot, source);
}

function planForAssets(assets, root, installContext) {
  const paths = [];
  for (const asset of assets) {
    const destination = resolveDestination(asset.destination, root, installContext);
    if (asset.source === 'shared-skills') {
      paths.push(...sharedSkillNames.map((name) => join(destination, name)));
    } else {
      paths.push(destination);
    }
  }
  return paths;
}

async function copyAsset(asset, root, installContext) {
  const destination = resolveDestination(asset.destination, root, installContext);
  if (asset.source === 'shared-skills') {
    await mkdir(destination, { recursive: true });
    for (const name of sharedSkillNames) await cp(join(packageRoot, 'skills', name), join(destination, name), { recursive: true });
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(sourcePath(asset.source), destination, { recursive: !asset.file });
}

async function installAssets(assets, root, installContext) {
  for (const asset of assets) await copyAsset(asset, root, installContext);
}

function assetDestinations(assets, root, installContext) {
  return assets.map((asset) => resolveDestination(asset.destination, root, installContext));
}

async function sourceFiles(source) {
  const info = await lstat(source);
  if (info.isFile()) return [source];
  if (!info.isDirectory()) throw new Error(`Managed asset source is not a regular file or directory: ${source}`);
  const files = [];
  for (const name of (await readdir(source)).sort()) files.push(...await sourceFiles(join(source, name)));
  return files;
}

/** Expand registry assets to exact source/destination file pairs, never to a host directory. */
async function materializedAssetPairs(assets, root, installContext) {
  const pairs = [];
  for (const asset of assets) {
    const destination = resolveDestination(asset.destination, root, installContext);
    if (asset.source === 'shared-skills') {
      for (const name of sharedSkillNames) {
        const source = join(packageRoot, 'skills', name);
        const sourceRoot = resolve(source);
        for (const file of await sourceFiles(sourceRoot)) {
          pairs.push({ source: file, target: join(destination, name, relative(sourceRoot, file)) });
        }
      }
      continue;
    }
    const source = sourcePath(asset.source);
    const sourceInfo = await lstat(source);
    if (asset.file || sourceInfo.isFile()) {
      pairs.push({ source, target: destination });
      continue;
    }
    const sourceRoot = resolve(source);
    for (const file of await sourceFiles(sourceRoot)) pairs.push({ source: file, target: join(destination, relative(sourceRoot, file)) });
  }
  return pairs.map((pair) => ({ source: resolve(pair.source), target: resolve(pair.target) }));
}

/** Expand registry assets to the exact files copied, never to a host directory. */
async function materializedAssetPaths(assets, root, installContext) {
  return (await materializedAssetPairs(assets, root, installContext)).map((pair) => pair.target);
}

function generatedRoleAssetPaths(adapter, installContext, scope, team) {
  if (!team || scope !== 'global' || adapter.modelBinding !== 'global-profiles' || typeof adapter.roleModelPaths !== 'function') return [];
  return adapter.roleModelPaths(installContext);
}

async function collectInstallationAssets(adapter, controlRoot, installContext, scope, team) {
  const assets = scope === 'global' ? adapter.globalAssets : adapter.projectAssets;
  const paths = [
    ...await materializedAssetPaths(assets, controlRoot, installContext),
    ...generatedRoleAssetPaths(adapter, installContext, scope, team)
  ];
  return collectManagedAssetRecords(paths, {
    scope,
    baseRoot: scope === 'project' ? controlRoot : null
  });
}

function overallInstallationStatus(scopeStatus) {
  const values = Object.values(scopeStatus);
  if (values.every((value) => ['not_configured', 'uninstalled'].includes(value))) return 'uninstalled';
  if (values.some((value) => ['partial', 'uninstalled'].includes(value))) return 'partial';
  return 'installed';
}

async function installationManifestFor({ adapter, controlRoot, installContext, team, global = false, previous = null, installedAt = null }) {
  const projectAssets = await collectInstallationAssets(adapter, controlRoot, installContext, 'project', team);
  const previousManifest = previous?.manifest ?? previous;
  const overlayAssets = await managedOverlayRecord(controlRoot, previousManifest, team);
  const globalConfigured = Boolean(global || previousManifest?.scopes?.global);
  const globalAssets = global
    ? await collectInstallationAssets(adapter, controlRoot, installContext, 'global', team)
    : (previousManifest?.managed_assets ?? []).filter((asset) => asset.scope === 'global');
  const scopeStatus = {
    project: 'installed',
    global: globalConfigured
      ? (global ? 'installed' : manifestScopeStatus(previousManifest, 'global'))
      : 'not_configured'
  };
  return buildInstallationManifest({
    triadVersion: packageVersion,
    adapter: adapter.id,
    installedAt: installedAt ?? previousManifest?.installed_at ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scopes: { project: true, global: globalConfigured },
    scopeStatus,
    managedAssets: [...projectAssets, ...overlayAssets, ...globalAssets],
    status: overallInstallationStatus(scopeStatus)
  });
}

async function replaceManagedPath(source, destination, backup, apply) {
  const present = await exists(destination);
  process.stdout.write(`  ${apply ? 'Update' : 'Would update'} ${destination}${present ? ' (backup)' : ''}\n`);
  if (!apply) return;
  if (present) {
    await mkdir(dirname(backup), { recursive: true });
    await cp(destination, backup, { recursive: true });
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function refreshAssets(assets, root, installContext, backupRoot, apply) {
  for (const asset of assets) {
    const destination = resolveDestination(asset.destination, root, installContext);
    if (asset.source === 'shared-skills') {
      for (const name of sharedSkillNames) await replaceManagedPath(join(packageRoot, 'skills', name), join(destination, name), join(backupRoot, name), apply);
    } else {
      await replaceManagedPath(sourcePath(asset.source), destination, join(backupRoot, asset.source.replaceAll('/', '__')), apply);
    }
  }
}

function teamConfigPath(controlRoot) {
  return join(controlRoot, '.triad-plus', 'team.json');
}

const overlayStart = '<!-- triad-plus:managed-instructions:start -->';
const overlayEnd = '<!-- triad-plus:managed-instructions:end -->';
function instructionOverlay(team) {
  const displayName = typeof team?.roles?.orchestrator?.displayName === 'string' && team.roles.orchestrator.displayName.trim()
    ? team.roles.orchestrator.displayName.trim()
    : 'Triad Orchestrator';
  return `${overlayStart}
## Triad+ role-run overlay

When a Triad+ entry point is invoked in this control workspace, read
\`.triad-plus/team.json\` before the first owner-facing reply. The active
Orchestrator is \`${displayName}\` for this run. Its first owner-facing message
is a presentation, not a bootstrap report: begin with a first-person sentence
that explicitly names \`${displayName}\` and says it is the Triad+ Orchestrator,
then state whether the run is new or resumed and the received input. Do this
before reporting bootstrap, inspecting artifacts, delegating, or asking a
question. This is a role-run presentation rule; it does not change technical
authority, repository policy, safety instructions, or the host's identity
outside Triad+.
${overlayEnd}`;
}

function managedBlockIn(source, startMarker = overlayStart, endMarker = overlayEnd) {
  const startCount = source.split(startMarker).length - 1;
  const endCount = source.split(endMarker).length - 1;
  if (startCount === 0 && endCount === 0) return null;
  if (startCount !== 1 || endCount !== 1) throw new Error('Managed instruction block is ambiguous: duplicate or incomplete markers.');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error('Managed instruction block has invalid marker order.');
  const blockEnd = end + endMarker.length;
  return { start, end, blockEnd, content: source.slice(start, blockEnd) };
}

async function overlayPlan(controlRoot, team) {
  const target = join(controlRoot, 'AGENTS.md');
  await assertNoSymlinkPath(target);
  const overlay = instructionOverlay(team);
  let info = null;
  try { info = await lstat(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!info) return { target, action: 'create', before: null, content: `# Project instructions\n\n${overlay}\n` };
  if (!info.isFile()) throw new Error(`Cannot safely add Triad+ instructions to a non-regular file: ${target}`);
  const source = await readFile(target, 'utf8');
  const managed = managedBlockIn(source);
  if (!managed) return { target, action: 'append', before: source, content: `${source}${source.endsWith('\n') ? '\n' : '\n\n'}${overlay}\n` };
  return { target, action: 'update', before: source, content: `${source.slice(0, managed.start)}${overlay}${source.slice(managed.blockEnd)}` };
}

async function applyOverlay(controlRoot, apply, team) {
  const plan = await overlayPlan(controlRoot, team);
  process.stdout.write(`  Instructions ${apply ? plan.action : `would ${plan.action}`} ${plan.target}\n`);
  if (apply) await writeFile(plan.target, plan.content, 'utf8');
}

async function managedOverlayRecord(controlRoot, previousManifest, team) {
  const previousBlocks = (previousManifest?.managed_assets ?? []).filter((asset) => asset.kind === 'managed_block' && asset.scope === 'project');
  if (!team) return previousBlocks;
  const target = join(controlRoot, 'AGENTS.md');
  const source = await readFile(target, 'utf8');
  const managed = managedBlockIn(source);
  if (!managed) throw new Error(`Managed instruction block is missing after materialization: ${target}`);
  return [{
    scope: 'project',
    path: 'AGENTS.md',
    kind: 'managed_block',
    start_marker: overlayStart,
    end_marker: overlayEnd,
    sha256: sha256Text(managed.content)
  }];
}

async function loadTeamConfig(options) {
  if (options.team) return validateTeamConfiguration(options.team);
  if (!options.teamConfig) return null;
  let team;
  try { team = JSON.parse(await readFile(resolve(options.teamConfig), 'utf8')); }
  catch (error) { throw new Error(`Cannot read --team-config: ${error.message}`); }
  try { return validateTeamConfiguration(team); }
  catch (error) { throw new Error(`--team-config is invalid: ${error.message}`); }
}

async function writeTeamConfig(controlRoot, team) {
  const target = teamConfigPath(controlRoot);
  await assertNoSymlinkPath(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(team, null, 2)}\n`, 'utf8');
}

async function applyMarkdownModel(target, configuration, fields = ['model'], cleanupFields = []) {
  const managedFields = [...new Set([...fields, ...cleanupFields])];
  if (managedFields.length === 0) return;
  const source = await readFile(target, 'utf8');
  if (!source.startsWith('---\n')) throw new Error(`Agent definition has no YAML frontmatter: ${target}`);
  const closing = source.indexOf('\n---\n', 4);
  if (closing === -1) throw new Error(`Agent definition has invalid YAML frontmatter: ${target}`);
  let frontmatter = source.slice(4, closing);
  for (const field of managedFields) frontmatter = frontmatter.replace(new RegExp(`^${field}:\\s*.*\\n?`, 'm'), '');
  const values = fields
    .map((field) => ({ field, value: configuration?.[field] }))
    .filter(({ value }) => value !== null && value !== undefined && value !== '');
  const additions = values.map(({ field, value }) => `${field}: ${JSON.stringify(value)}`).join('\n');
  const normalizedFrontmatter = frontmatter.replace(/\s*$/, '');
  const next = `---\n${normalizedFrontmatter}${additions ? `\n${additions}` : ''}${source.slice(closing)}`;
  if (next !== source) await writeFile(target, next, 'utf8');
}

async function writeRoleProfiles(paths, team) {
  await mkdir(dirname(paths[0]), { recursive: true });
  for (const [index, role] of roleDefinitions.entries()) {
    const configuration = team.roles[role.id];
    const instructions = [
      `Act as ${configuration.displayName}, the ${role.label} role in Triad+.`,
      `Persona: ${configuration.persona || 'professional and role-focused'}.`,
      'Read .triad-plus/team.json in the active project-control workspace before working.',
      `At the beginning of each activation, identify yourself as ${configuration.displayName}, the Triad+ ${role.label}, in your first role report.`,
      'Technical role IDs define authority; display names never change it.'
    ].join('\n');
    const profile = [
      `name = ${JSON.stringify(`triad_${role.id}`)}`,
      `description = ${JSON.stringify(`Triad+ ${role.label}: ${configuration.displayName}.`)}`,
      ...(configuration.model ? [`model = ${JSON.stringify(configuration.model)}`] : []),
      ...(configuration.reasoning_effort ? [`model_reasoning_effort = ${JSON.stringify(configuration.reasoning_effort)}`] : []),
      `developer_instructions = ${JSON.stringify(instructions)}`,
      ''
    ].join('\n');
    await writeFile(paths[index], profile, 'utf8');
  }
}

async function applyTeamBinding(adapter, controlRoot, team, installContext, scope = 'project') {
  if (!team || adapter.modelBinding === 'team-record') return;
  if (adapter.modelBinding === 'project-frontmatter') {
    const pathFactory = scope === 'global' ? adapter.globalRoleModelPaths : adapter.roleModelPaths;
    if (typeof pathFactory !== 'function') return;
    const paths = scope === 'global'
      ? pathFactory(installContext)
      : pathFactory(controlRoot, installContext);
    const roles = (adapter.modelRoles ?? roleDefinitions.map((role) => role.id))
      .map((roleId) => roleDefinitions.find((role) => role.id === roleId));
    for (const [index, role] of roles.entries()) {
      const fields = adapter.modelFields ?? ['model'];
      await applyMarkdownModel(
        paths[index],
        materializedHostRoleConfiguration(adapter, role.id, team.roles[role.id]),
        fields,
        adapter.modelCleanupFields ?? []
      );
    }
    return;
  }
  if (adapter.modelBinding === 'global-profiles') {
    if (scope !== 'global') return;
    await writeRoleProfiles(adapter.roleModelPaths(installContext), team);
    return;
  }
  throw new Error(`Unknown model binding: ${adapter.modelBinding}`);
}

function productRepositoryAt(controlRoot) {
  const git = spawnSync('git', ['-C', controlRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (git.status !== 0 || resolve(git.stdout.trim()) !== controlRoot) return false;
  return ['package.json', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'go.mod', 'Gemfile']
    .some((marker) => spawnSync('test', ['-e', join(controlRoot, marker)]).status === 0);
}

async function collisions(paths) {
  const result = [];
  for (const target of paths) if (await exists(target)) result.push(target);
  return result;
}

async function allExist(paths) {
  for (const target of paths) if (!(await exists(target))) return false;
  return true;
}

function sharedSkillRoots(adapter, root, installContext, scope) {
  const assets = scope === 'global' ? adapter.globalAssets : adapter.projectAssets;
  return assets
    .filter((asset) => asset.source === 'shared-skills')
    .map((asset) => resolveDestination(asset.destination, root, installContext));
}

async function anyExist(paths) {
  for (const target of paths) if (await exists(target)) return true;
  return false;
}

async function globalPathReusable(target, pairs) {
  let info;
  try { info = await lstat(target); } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  if (info.isDirectory()) {
    const descendants = pairs.filter((pair) => pathWithin(target, pair.target));
    if (descendants.length === 0) return false;
    for (const pair of descendants) {
      let pairInfo;
      try { pairInfo = await lstat(pair.target); } catch (error) {
        if (error.code === 'ENOENT') continue;
        return false;
      }
      if (!pairInfo.isFile() || await sha256File(pair.target) !== await sha256File(pair.source)) return false;
    }
    return true;
  }
  const pair = pairs.find((candidate) => candidate.target === resolve(target));
  return Boolean(pair && info.isFile() && await sha256File(target) === await sha256File(pair.source));
}

function versionTuple(value) {
  const match = String(value ?? '').match(/^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function pathWithin(root, target) {
  const base = resolve(root);
  const candidate = resolve(target);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

async function managedAssetPaths(adapter, controlRoot, installContext, scope) {
  const assets = scope === 'global' ? adapter.globalAssets : adapter.projectAssets;
  const paths = await materializedAssetPaths(assets, controlRoot, installContext);
  if (scope === 'global' && adapter.modelBinding === 'global-profiles' && typeof adapter.roleModelPaths === 'function') {
    paths.push(...adapter.roleModelPaths(installContext));
  }
  return new Set(paths.map((target) => resolve(target)));
}

function manifestAssetPath(controlRoot, asset) {
  return asset.scope === 'project' ? resolve(controlRoot, asset.path) : resolve(asset.path);
}

function displayManagedAssetPath(asset) {
  if (asset.scope !== 'global') return asset.path;
  const home = resolve(homedir());
  const target = resolve(asset.path);
  return pathWithin(home, target) ? `~${relative(home, target) ? `/${relative(home, target)}` : ''}` : target;
}

function assetAllowedByRegistry(managedPaths, controlRoot, asset) {
  const target = manifestAssetPath(controlRoot, asset);
  if (asset.kind === 'managed_block') return asset.scope === 'project' && target === resolve(controlRoot, 'AGENTS.md');
  return managedPaths.has(target);
}

async function installationAssetIssues(controlRoot, adapter, installContext, manifest) {
  const issues = [];
  for (const asset of manifest.managed_assets) {
    const target = manifestAssetPath(controlRoot, asset);
    const expectedState = manifestScopeStatus(manifest, asset.scope);
    let info;
    try { info = await lstat(target); } catch (error) {
      if (error.code === 'ENOENT') {
        if (expectedState !== 'uninstalled') issues.push({ asset, status: 'missing' });
        continue;
      }
      issues.push({ asset, status: `unreadable:${error.code ?? 'error'}` });
      continue;
    }
    if (asset.kind === 'managed_block') {
      if (!info.isFile()) {
        issues.push({ asset, status: 'modified' });
        continue;
      }
      let source;
      try { source = await readFile(target, 'utf8'); } catch { issues.push({ asset, status: 'unreadable' }); continue; }
      let managed;
      try { managed = managedBlockIn(source, asset.start_marker, asset.end_marker); } catch { managed = null; }
      if (managed && sha256Text(managed.content) !== asset.sha256) issues.push({ asset, status: 'modified' });
      else if (managed && expectedState === 'uninstalled') issues.push({ asset, status: 'present_after_uninstall' });
      else if (!managed && expectedState !== 'uninstalled') issues.push({ asset, status: 'modified' });
      continue;
    }
    if (!info.isFile()) {
      issues.push({ asset, status: 'modified' });
      continue;
    }
    let observed;
    try { observed = await sha256File(target); } catch { issues.push({ asset, status: 'unreadable' }); continue; }
    if (observed !== asset.sha256) issues.push({ asset, status: 'modified' });
    else if (expectedState === 'uninstalled') issues.push({ asset, status: 'present_after_uninstall' });
  }
  return issues;
}

async function inspectInstallation(controlRoot, adapter, installContext) {
  let loaded;
  try { loaded = await loadInstallationManifest(controlRoot); }
  catch (error) {
    return { state: 'invalid', message: error.message, manifest: null, issues: [] };
  }
  if (!loaded) return { state: 'legacy', manifest: null, issues: [] };
  const manifest = loaded.manifest;
  const record = manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION
    ? manifest.adapters.find((entry) => entry.id === adapter.id)
    : manifest.adapter === adapter.id ? manifest : null;
  if (!record) {
    if (manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION) return { state: 'not_installed', manifest: null, issues: [], multiAdapter: true };
    return {
      state: 'invalid',
      message: `manifest adapter ${manifest.adapter} does not match selected ${adapter.id}`,
      manifest,
      issues: []
    };
  }
  const adapterManifest = manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION
    ? { ...record, adapter: record.id, triad_version: manifest.triad_version, status: 'installed' }
    : manifest;
  const issues = await installationAssetIssues(controlRoot, adapter, installContext, adapterManifest);
  const versionRelation = compareVersions(packageVersion, manifest.triad_version);
  const uninstalled = ['project', 'global'].every((scope) => ['not_configured', 'uninstalled'].includes(manifestScopeStatus(adapterManifest, scope)));
  return { state: uninstalled ? 'uninstalled' : 'valid', manifest: adapterManifest, issues, versionRelation, multiAdapter: manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION };
}

/** Return one status per shared skill so a partial install cannot look healthy. */
async function sharedSkillStatuses(adapter, root, installContext, scope) {
  const roots = sharedSkillRoots(adapter, root, installContext, scope);
  if (roots.length === 0) return [];
  const configuredRoots = [];
  for (const skillRoot of roots) if (await exists(skillRoot)) configuredRoots.push(skillRoot);
  const statuses = [];
  for (const name of sharedSkillNames) {
    const paths = roots.map((skillRoot) => join(skillRoot, name));
    if (configuredRoots.length === 0) {
      statuses.push({ name, status: 'not configured', paths });
      continue;
    }
    let present = 0;
    for (const target of paths) if (await exists(target)) present += 1;
    statuses.push({ name, status: present === paths.length ? 'OK' : 'MISSING', paths });
  }
  return statuses;
}

function roleModelEntries(adapter, controlRoot, installContext, scope) {
  let paths;
  if (scope === 'global') {
    if (adapter.modelBinding === 'global-profiles') paths = adapter.roleModelPaths?.(installContext) ?? [];
    else paths = adapter.globalRoleModelPaths?.(installContext) ?? [];
  } else {
    if (adapter.modelBinding !== 'project-frontmatter') return [];
    paths = adapter.roleModelPaths?.(controlRoot, installContext) ?? [];
  }
  const roleIds = adapter.modelRoles ?? roleDefinitions.map((role) => role.id);
  return roleIds.map((roleId, index) => ({
    role: roleDefinitions.find((definition) => definition.id === roleId),
    path: paths[index]
  })).filter((entry) => entry.role && entry.path);
}

function parseFrontmatterFields(source, fields) {
  const result = {};
  if (!source.startsWith('---\n')) return result;
  const closing = source.indexOf('\n---\n', 4);
  if (closing < 0) return result;
  const frontmatter = source.slice(4, closing);
  for (const field of fields) {
    const match = frontmatter.match(new RegExp(`^${field}:\\s*(.*?)\\s*$`, 'm'));
    if (!match) {
      result[field] = null;
      continue;
    }
    try { result[field] = JSON.parse(match[1]); }
    catch { result[field] = match[1].replace(/^['"]|['"]$/g, ''); }
  }
  return result;
}

async function modelBindingEvidence(adapter, controlRoot, installContext, team, scope) {
  const entries = roleModelEntries(adapter, controlRoot, installContext, scope);
  if (!entries.length) return [];
  const evidence = [];
  for (const { role, path: target } of entries) {
    const configuration = team?.roles?.[role.id];
    if (!configuration) {
      evidence.push({ role, status: 'not configured', target });
      continue;
    }
    const expected = materializedHostRoleConfiguration(adapter, role.id, configuration);
    const fields = [...new Set([...(adapter.modelFields ?? Object.keys(expected)), ...(adapter.modelCleanupFields ?? [])])];
    if (Object.keys(expected).length === 0) {
      evidence.push({ role, status: 'UNSUPPORTED', target, expected, observed: null });
      continue;
    }
    if (!(await exists(target))) {
      evidence.push({ role, status: 'UNKNOWN / NOT OBSERVABLE', target, expected, observed: null });
      continue;
    }
    const observed = parseFrontmatterFields(await readFile(target, 'utf8'), fields);
    const matches = fields.every((field) => (expected[field] ?? null) === (observed[field] ?? null));
    const allDefault = Object.values(expected).every((value) => value === null || value === undefined || value === '');
    evidence.push({ role, status: matches && allDefault ? 'HOST DEFAULT' : matches ? 'VERIFIED' : 'MATERIALIZED MISMATCH', target, expected, observed });
  }
  return evidence;
}

function commandVersion(binary) {
  const candidates = Array.isArray(binary) ? binary : [binary];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return String(result.stdout).trim().split('\n')[0];
  }
  return null;
}

function capabilitySnapshot(controlRoot, manifestPath) {
  if (!manifestPath) return null;
  const detector = join(packageRoot, 'runtime', 'triad-runtime-capabilities.mjs');
  const result = spawnSync(process.execPath, [detector, '--adapter', manifestPath], {
    cwd: controlRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

async function collectTeamConfiguration(prompt, adapter) {
  const language = (await prompt.question('Conversation language [English]: ')).trim() || 'English';
  const ownerName = (await prompt.question('How should Triad+ address the project owner [Owner]: ')).trim() || 'Owner';
  const communicationStyle = (await prompt.question('Preferred communication style [professional and concise]: ')).trim() || 'professional and concise';
  const evaluatorEnabled = ['y', 'yes'].includes((await prompt.question('Configure optional post-run Evaluator+? [y/N]: ')).trim().toLowerCase());
  const roles = {};
  for (const role of roleDefinitions) {
    const enabled = role.core || evaluatorEnabled;
    const displayName = (await prompt.question(`${role.label} display name [${role.label}]: `)).trim() || role.label;
    const persona = (await prompt.question(`${role.label} persona [professional and role-focused]: `)).trim() || 'professional and role-focused';
    const model = (await prompt.question(`${role.label} model ID [host default]: `)).trim();
    const reasoningEffort = supportsNativeReasoning(adapter, role.id)
      ? (await prompt.question(`${role.label} reasoning effort [${adapter.modelBinding === 'global-profiles' && model ? role.defaultEffort : 'host default'}]: `)).trim()
        || (adapter.modelBinding === 'global-profiles' && model ? role.defaultEffort : null)
      : null;
    roles[role.id] = { displayName, persona, model: model || null, reasoning_effort: reasoningEffort, enabled };
  }
  return { schema_version: 1, interaction: { language, owner_name: ownerName, communication_style: communicationStyle }, roles };
}

async function init(options) {
  const adapter = getAdapter(options.host);
  if (!adapter) throw new Error(`Choose --host ${listAdapters().map((item) => item.id).join(', ')}.`);
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  const team = options.useExistingTeam ? await currentTeam(controlRoot) : await loadTeamConfig(options);
  const writesTeam = Boolean(team && !options.useExistingTeam);
  if (options.planOnly) await assertNoSymlinkPath(controlRoot);
  else {
    await requireDirectory(controlRoot);
    await assertNoSymlinkPath(controlRoot, { allowMissing: false });
  }
  if (!options.allowProductRepo && productRepositoryAt(controlRoot)) {
    throw new Error('Control path appears to be a product repository. Use a separate project-control workspace, or pass --allow-product-repo after reviewing the risk.');
  }
  let previousManifest = null;
  if (await exists(installationManifestPath(controlRoot))) previousManifest = await loadInstallationManifest(controlRoot);
  if (previousManifest?.manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION) {
    throw new Error('This workspace has a multi-adapter installation record. Use `adapter add` instead of `init`.');
  }
  const installContext = context(controlRoot);
  const projectPlanned = [
    ...adapter.projectPaths(controlRoot, installContext),
    ...(writesTeam ? [teamConfigPath(controlRoot)] : [])
  ];
  const existingProject = await collisions(projectPlanned);
  if (existingProject.length > 0) throw new Error(`Installation aborted; existing paths would be overwritten:\n${existingProject.map((target) => `  ${target}`).join('\n')}`);
  if (options.global) {
    const globalPlanned = [
      ...adapter.globalPaths(installContext),
      ...(team && adapter.modelBinding === 'global-profiles' ? adapter.roleModelPaths(installContext) : []),
      ...(team && adapter.modelBinding === 'project-frontmatter' && adapter.globalRoleModelPaths
        ? adapter.globalRoleModelPaths(installContext)
        : [])
    ];
    const globalPairs = await materializedAssetPairs(adapter.globalAssets, controlRoot, installContext);
    const teamModelPaths = team
      ? new Set([
        ...(adapter.modelBinding === 'global-profiles' && typeof adapter.roleModelPaths === 'function' ? adapter.roleModelPaths(installContext) : []),
        ...(adapter.modelBinding === 'project-frontmatter' && typeof adapter.globalRoleModelPaths === 'function' ? adapter.globalRoleModelPaths(installContext) : [])
      ].map((target) => resolve(target)))
      : new Set();
    const existingGlobal = [];
    for (const target of globalPlanned) {
      if (!(await exists(target))) continue;
      if (teamModelPaths.has(resolve(target)) || !(await globalPathReusable(target, globalPairs))) existingGlobal.push(target);
    }
    if (existingGlobal.length > 0) throw new Error(`Installation aborted; existing global paths would be overwritten:\n${existingGlobal.map((target) => `  ${target}`).join('\n')}`);
  }
  if (options.planOnly) {
    const pairs = await materializedAssetPairs(adapter.projectAssets, controlRoot, installContext);
    const managedAssets = await plannedAdapterRecords(pairs, controlRoot);
    return {
      adapterId: adapter.id,
      managedAssets,
      created: managedAssets.map((asset) => asset.path),
      global: Boolean(options.global),
      teamMode: options.useExistingTeam ? 'reuse existing' : team ? 'create requested config' : 'unconfigured',
    };
  }
  await installAssets(adapter.projectAssets, controlRoot, installContext);
  if (writesTeam) await writeTeamConfig(controlRoot, team);
  if (team) await applyOverlay(controlRoot, true, team);
  if (options.global) await installAssets(adapter.globalAssets, controlRoot, installContext);
  if (team) await applyTeamBinding(adapter, controlRoot, team, installContext, 'project');
  if (team && options.global) await applyTeamBinding(adapter, controlRoot, team, installContext, 'global');
  const manifest = await installationManifestFor({
    adapter,
    controlRoot,
    installContext,
    team,
    global: options.global,
    previous: previousManifest
  });
  await writeInstallationManifest(controlRoot, manifest);
  process.stdout.write(`Triad+ adapter assets installed for ${adapter.label} in ${controlRoot}\n`);
  process.stdout.write('This init command does not configure repository mappings, PRD, quality gates, or worktrees. Verify project readiness separately before invoking /triad.\n');
  if (adapter.globalEntry) {
    process.stdout.write(`Install user-level assets with --global to expose ${adapter.entry}.\n`);
  }
  process.stdout.write(`Open the control workspace and use ${adapter.entry} <PRD path>. Configured Evaluator+ runs automatically post-approval.\n`);
}

async function currentTeam(controlRoot) {
  const target = teamConfigPath(controlRoot);
  if (!(await exists(target))) return null;
  try {
    await assertNoSymlinkPath(target, { allowMissing: false });
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('team configuration is not a regular file');
    return validateTeamConfiguration(JSON.parse(await readFile(target, 'utf8')));
  }
  catch { throw new Error(`Cannot safely read an invalid team config: ${target}`); }
}

const deliveryStateDefault = `
delivery:
  status: not_delivered
  handoff: null
  branches: []
  evaluator_report: null
  delivered_at: null
  owner_message: null
`;

async function upgradeRunStateDelivery(controlRoot, backupRoot, apply) {
  const target = join(controlRoot, '.loop', 'run-state.yaml');
  if (!(await exists(target))) {
    process.stdout.write('  Delivery state skipped: no initialized .loop/run-state.yaml\n');
    return;
  }
  const source = await readFile(target, 'utf8');
  if (/^delivery:\s*$/m.test(source)) {
    process.stdout.write(`  Delivery state already present ${target}\n`);
    return;
  }
  process.stdout.write(`  ${apply ? 'Initialize' : 'Would initialize'} delivery state ${target} (backup)\n`);
  if (!apply) return;
  const backup = join(backupRoot, 'project', 'run-state.yaml');
  await mkdir(dirname(backup), { recursive: true });
  await cp(target, backup);
  await writeFile(target, `${source.replace(/\s*$/, '')}\n${deliveryStateDefault}`, 'utf8');
}

async function upgrade(options) {
  const adapter = getAdapter(options.host);
  if (!adapter) throw new Error(`Choose --host ${listAdapters().map((item) => item.id).join(', ')}.`);
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  await requireExistingDirectory(controlRoot);
  let previousManifest = null;
  if (await exists(installationManifestPath(controlRoot))) previousManifest = await loadInstallationManifest(controlRoot);
  if (previousManifest?.manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION) {
    throw new Error('This workspace has a multi-adapter installation record. Use `adapter upgrade <adapter-id>`.');
  }
  if (previousManifest && previousManifest.manifest.adapter !== adapter.id) {
    throw new Error(`Installation manifest belongs to ${previousManifest.manifest.adapter}, not ${adapter.id}.`);
  }
  const team = await currentTeam(controlRoot);
  const installContext = context(controlRoot);
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupRoot = join(controlRoot, '.triad-plus', 'backups', stamp);
  process.stdout.write(`Triad+ upgrade ${options.apply ? 'applying' : 'plan'} for ${adapter.label}\n`);
  await refreshAssets(adapter.projectAssets, controlRoot, installContext, join(backupRoot, 'project'), options.apply);
  if (team && options.apply && adapter.modelBinding === 'project-frontmatter') {
    await applyTeamBinding(adapter, controlRoot, team, installContext, 'project');
  }
  await upgradeRunStateDelivery(controlRoot, backupRoot, options.apply);
  if (team) await applyOverlay(controlRoot, options.apply, team);
  else process.stdout.write('  Instructions skipped: .triad-plus/team.json is not configured\n');
  if (options.global) {
    await refreshAssets(adapter.globalAssets, controlRoot, installContext, join(backupRoot, 'global'), options.apply);
    if (team && options.apply) await applyTeamBinding(adapter, controlRoot, team, installContext, 'global');
  }
  if (options.apply) {
    const manifest = await installationManifestFor({
      adapter,
      controlRoot,
      installContext,
      team,
      global: options.global,
      previous: previousManifest
    });
    await writeInstallationManifest(controlRoot, manifest);
    process.stdout.write(`  Installation manifest updated ${installationManifestPath(controlRoot)}\n`);
  } else {
    process.stdout.write(`  Installation manifest would be ${previousManifest ? 'updated' : 'created'} ${installationManifestPath(controlRoot)}\n`);
  }
  if (!options.apply) process.stdout.write('Dry run only. Re-run with --apply to update managed assets.\n');
}

async function importBmadStory(options) {
  if (!options.source) throw new Error('Provide --source <bmad-story.md>.');
  if (!options.output) throw new Error('Provide --output <triad-card.md>.');
  const result = await writeImportedCard({
    sourcePath: options.source,
    outputPath: options.output,
    targetRepository: options.targetRepository,
    provenancePath: options.provenance,
    requiredGates: options.requiredGates,
    dependsOn: options.dependsOn
  });
  process.stdout.write(`Imported BMAD Story ${result.story.id} as Triad Card ${result.outputPath}\n`);
  process.stdout.write(`Provenance ${result.provenancePath}\n`);
}

function installationScopeText(manifest, scope) {
  const status = manifestScopeStatus(manifest, scope);
  if (status === 'installed') return 'yes';
  if (status === 'not_configured') return 'no';
  return status;
}

function adapterRecords(manifest) {
  if (!manifest) return [];
  if (manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION) return manifest.adapters;
  return [{
    id: manifest.adapter,
    installed_at: manifest.installed_at,
    updated_at: manifest.updated_at,
    scopes: manifest.scopes,
    scope_status: {
      project: manifestScopeStatus(manifest, 'project'),
      global: manifestScopeStatus(manifest, 'global'),
    },
    managed_assets: manifest.managed_assets,
  }];
}

function assetIdentity(asset) {
  return `${asset.scope}:${asset.path}`;
}

function recordedRuntimeMetadataPath(record) {
  return record?.managed_assets?.find((asset) => asset.scope === 'project' && asset.path.endsWith('/adapter.json') && asset.path.startsWith('.triad-runtime/'))?.path
    ?? null;
}

async function adapterAssetPairs(adapter, controlRoot, installContext, records, record = null) {
  const pairs = await materializedAssetPairs(adapter.projectAssets, controlRoot, installContext);
  const runtimeSource = resolve(sourcePath(`adapters/${adapter.id}/runtime.json`));
  const recordedPath = recordedRuntimeMetadataPath(record);
  const runtimePath = recordedPath
    ?? (records.length === 0 ? '.triad-runtime/adapter.json' : `.triad-runtime/adapters/${adapter.id}/adapter.json`);
  return pairs.map((pair) => pair.source === runtimeSource && pair.target === resolve(controlRoot, '.triad-runtime/adapter.json')
    ? { ...pair, target: resolve(controlRoot, runtimePath) }
    : pair);
}

async function safeProjectAssetInfo(controlRoot, target) {
  if (!pathWithin(controlRoot, target) || resolve(target) === resolve(controlRoot)) throw new Error(`Managed project asset escaped the Control Workspace: ${target}`);
  const rootInfo = await lstat(resolve(controlRoot));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Control Workspace path is unsafe: ${controlRoot}`);
  const relativePath = relative(resolve(controlRoot), resolve(target)).split(sep).join('/');
  let current = resolve(controlRoot);
  const segments = relativePath.split('/');
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Managed project asset path is unsafe: ${relative(controlRoot, current)}`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Managed project asset is not a regular file: ${relative(controlRoot, target)}`);
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureSafeProjectParents(controlRoot, target) {
  if (!pathWithin(controlRoot, target)) throw new Error(`Managed project asset escaped the Control Workspace: ${target}`);
  const root = resolve(controlRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Control Workspace path is unsafe: ${controlRoot}`);
  const parentRelative = relative(root, dirname(resolve(target)));
  if (parentRelative.startsWith('..')) throw new Error(`Managed project asset escaped the Control Workspace: ${target}`);
  let current = root;
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Managed project asset parent is unsafe: ${relative(root, current)}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await mkdir(current); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Managed project asset parent is unsafe: ${relative(root, current)}`);
    }
  }
}

async function plannedAdapterRecords(pairs, controlRoot) {
  const seen = new Set();
  const records = [];
  for (const pair of pairs) {
    if (!pathWithin(controlRoot, pair.target)) throw new Error(`Adapter asset escapes the Control Workspace: ${pair.target}`);
    const targetPath = relative(resolve(controlRoot), resolve(pair.target)).split(sep).join('/');
    if (!targetPath || targetPath.startsWith('../')) throw new Error(`Adapter asset escapes the Control Workspace: ${pair.target}`);
    if (seen.has(targetPath)) throw new Error(`Adapter plan contains duplicate target ownership: ${targetPath}`);
    seen.add(targetPath);
    const sourceInfo = await lstat(pair.source);
    if (!sourceInfo.isFile()) throw new Error(`Adapter asset source is not a regular file: ${pair.source}`);
    records.push({ scope: 'project', path: targetPath, kind: 'file', sha256: await sha256File(pair.source) });
  }
  return records;
}

async function observedAdapterRecords(planned, pairs, controlRoot) {
  const byPath = new Map(pairs.map((pair) => [relative(resolve(controlRoot), resolve(pair.target)).split(sep).join('/'), pair.target]));
  const records = [];
  for (const asset of planned) {
    const target = byPath.get(asset.path);
    if (!target || !(await safeProjectAssetInfo(controlRoot, target))) throw new Error(`Adapter asset is missing after materialization: ${asset.path}`);
    records.push({ ...asset, sha256: await sha256File(target) });
  }
  return records;
}

async function preflightAdapterAdd(controlRoot, pairs, planned, records, { projectedAssets = new Set() } = {}) {
  const owners = new Map();
  for (const record of records) {
    for (const asset of record.managed_assets) {
      const list = owners.get(assetIdentity(asset)) ?? [];
      list.push({ adapter: record.id, asset });
      owners.set(assetIdentity(asset), list);
    }
  }
  let create = 0;
  let reuse = 0;
  const actions = [];
  const controlExists = await exists(controlRoot);
  for (const [index, asset] of planned.entries()) {
    const target = pairs[index].target;
    const info = controlExists ? await safeProjectAssetInfo(controlRoot, target) : null;
    const existingOwners = owners.get(assetIdentity(asset)) ?? [];
    if (!info) {
      if (existingOwners.some((owner) => owner.asset.sha256 !== asset.sha256)) throw new Error(`Shared managed asset requires upgrade before add: ${asset.path}`);
      if (projectedAssets.has(assetIdentity(asset))) {
        reuse += 1;
        actions.push({ kind: 'reuse-shared', asset, owners: existingOwners.map((owner) => owner.adapter) });
        continue;
      }
      create += 1;
      actions.push({ kind: 'create', asset, owners: [] });
      continue;
    }
    const observed = await sha256File(target);
    if (existingOwners.some((owner) => owner.asset.sha256 !== observed)) throw new Error(`Managed asset was modified; refusing to overwrite: ${asset.path}`);
    if (observed !== asset.sha256) throw new Error(`Adapter asset collision; existing bytes differ: ${asset.path}`);
    reuse += 1;
    actions.push({ kind: existingOwners.length ? 'reuse-shared' : 'reuse-identical', asset, owners: existingOwners.map((owner) => owner.adapter) });
  }
  return { create, reuse, actions };
}

async function copyMissingAdapterPairs(controlRoot, pairs, planned, created = []) {
  for (const [index, pair] of pairs.entries()) {
    const info = await safeProjectAssetInfo(controlRoot, pair.target);
    if (info) continue;
    await ensureSafeProjectParents(controlRoot, pair.target);
    if (await safeProjectAssetInfo(controlRoot, pair.target)) throw new Error(`Adapter asset appeared during install; refusing to overwrite: ${planned[index].path}`);
    await copyFile(pair.source, pair.target, fsConstants.COPYFILE_EXCL);
    created.push({ target: pair.target, expected: planned[index].sha256 });
  }
  return created;
}

async function rollbackCreatedAssets(created, finalRecords, controlRoot) {
  const expected = new Map(finalRecords.map((asset) => [asset.path, asset.sha256]));
  const failures = [];
  for (const entry of [...created].reverse()) {
    try {
      const info = await safeProjectAssetInfo(controlRoot, entry.target);
      if (!info) continue;
      const assetPath = relative(resolve(controlRoot), resolve(entry.target)).split(sep).join('/');
      const currentHash = await sha256File(entry.target);
      if (currentHash !== (expected.get(assetPath) ?? entry.expected)) {
        failures.push(assetPath);
        continue;
      }
      await rm(entry.target);
    } catch {
      failures.push(relative(resolve(controlRoot), resolve(entry.target)).split(sep).join('/'));
    }
  }
  return failures;
}

async function loadMultiMutationState(controlRoot) {
  const loaded = await loadInstallationManifest(controlRoot);
  return { loaded, records: adapterRecords(loaded?.manifest ?? null) };
}

async function adapterList(options) {
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  await requireExistingDirectory(controlRoot);
  const { loaded, records } = await loadMultiMutationState(controlRoot);
  process.stdout.write(`Control Workspace ${controlRoot}\n`);
  if (!loaded) {
    process.stdout.write('Installed adapters: none (legacy/uninitialized workspace)\n');
    process.stdout.write(`Available adapters: ${listAdapters().map((adapter) => adapter.id).join(', ')}\n`);
    return;
  }
  process.stdout.write(`Installation schema ${loaded.manifest.schema_version}\n`);
  for (const record of records) {
    const adapter = getAdapter(record.id);
    const binary = adapter ? commandVersion(adapter.binaryCandidates ?? adapter.binary) : null;
    const project = manifestScopeStatus(record, 'project');
    const global = manifestScopeStatus(record, 'global');
    process.stdout.write(`  ${record.id}  project=${project} global=${global} host=${binary?.version ? 'available' : 'unavailable'}`);
    if (!adapter) process.stdout.write(' registry=unsupported');
    if (record.managed_assets.some((asset) => asset.path.startsWith('.triad-runtime/adapters/'))) process.stdout.write(' metadata=per-adapter');
    process.stdout.write('\n');
  }
  process.stdout.write('Attempt-bound host dispatch: unsupported; installed adapters are not selected automatically.\n');
}

async function adapterDoctor(options) {
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  await requireExistingDirectory(controlRoot);
  const { loaded, records } = await loadMultiMutationState(controlRoot);
  const requested = options.host ? records.filter((record) => record.id === options.host) : records;
  if (options.host && requested.length === 0) {
    process.stdout.write(`Adapter ${options.host}: not installed\n`);
    return;
  }
  if (!loaded) {
    process.stdout.write('No installation manifest; doctor is read-only and does not migrate legacy state.\n');
    return;
  }
  process.stdout.write(`Installation schema ${loaded.manifest.schema_version}; ${records.length} adapter(s) recorded.\n`);
  for (const record of requested) {
    const adapter = getAdapter(record.id);
    if (!adapter) {
      process.stdout.write(`  ${record.id}: unsupported registry entry; assets preserved.\n`);
      continue;
    }
    const binary = commandVersion(adapter.binaryCandidates ?? adapter.binary);
    const issues = [];
    for (const asset of record.managed_assets.filter((entry) => entry.scope === 'project')) {
      const target = manifestAssetPath(controlRoot, asset);
      let info;
      try { info = await safeProjectAssetInfo(controlRoot, target); }
      catch { issues.push(`${asset.path}: unsafe`); continue; }
      if (!info) issues.push(`${asset.path}: missing`);
      else if (await sha256File(target) !== asset.sha256) issues.push(`${asset.path}: modified`);
    }
    const runtimePath = recordedRuntimeMetadataPath(record);
    const entrySupport = ['codex', 'hermes'].includes(record.id) ? 'limited/unproven' : 'installed project assets (static only)';
    process.stdout.write(`  ${record.id}: manifest=${issues.length ? 'incomplete' : 'OK'} host=${binary?.version ? `available (${binary.version})` : 'unavailable'} project-entry=${entrySupport}\n`);
    process.stdout.write(`    runtime metadata=${runtimePath ?? 'missing'}; attempt dispatch=unsupported\n`);
    for (const issue of issues) process.stdout.write(`    ISSUE ${issue}\n`);
  }
  process.stdout.write('Doctor is read-only; no manifest migration or global host assets are written.\n');
}

async function adapterAdd(options) {
  const adapter = getAdapter(options.host);
  if (!adapter) throw new Error(`Choose adapter add <${listAdapters().map((entry) => entry.id).join('|')}>.`);
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  if (options.global) throw new Error('Multi-adapter add is project-local only; it never creates global Triad assets.');
  const controlRoot = resolve(options.control);
  if (options.planOnly) await assertNoSymlinkPath(controlRoot);
  else await requireExistingDirectory(controlRoot);
  const { loaded, records: installedRecords } = await loadMultiMutationState(controlRoot);
  const records = options.planOnly ? [...installedRecords, ...(options.setupRecords ?? [])] : installedRecords;
  const existing = records.find((record) => record.id === adapter.id);
  const installContext = context(controlRoot);
  if (existing) {
    const pairs = await adapterAssetPairs(adapter, controlRoot, installContext, records, existing);
    const observed = await plannedAdapterRecords(pairs, controlRoot);
    const expected = new Map(existing.managed_assets.filter((asset) => asset.scope === 'project').map((asset) => [asset.path, asset.sha256]));
    for (const asset of observed) {
      const info = await safeProjectAssetInfo(controlRoot, resolve(controlRoot, asset.path));
      if (!info || await sha256File(resolve(controlRoot, asset.path)) !== expected.get(asset.path)) throw new Error(`Adapter ${adapter.id} is already recorded but unhealthy; use adapter doctor/upgrade. No files were changed.`);
    }
    process.stdout.write(`Adapter ${adapter.id} is already installed and healthy; no changes.\n`);
    return;
  }
  const pairs = await adapterAssetPairs(adapter, controlRoot, installContext, records);
  const planned = await plannedAdapterRecords(pairs, controlRoot);
  const projectedAssets = new Set((options.setupRecords ?? []).flatMap((record) => record.managed_assets ?? []).map(assetIdentity));
  const counts = await preflightAdapterAdd(controlRoot, pairs, planned, records, { projectedAssets });
  if (options.planOnly) {
    return {
      adapterId: adapter.id,
      managedAssets: planned,
      created: counts.actions.filter((action) => action.kind === 'create').map((action) => action.asset.path),
      reused: counts.actions.filter((action) => action.kind !== 'create').map((action) => action.asset.path),
    };
  }
  const migration = loaded?.manifest.schema_version === 1;
  process.stdout.write(`Adapter add ${options.apply ? 'applying' : 'plan'} — ${adapter.label}\n`);
  if (migration) process.stdout.write('  Explicit v1 → v2 migration will preserve the existing adapter record.\n');
  process.stdout.write(`  Project assets: ${counts.create} create, ${counts.reuse} exact-byte reuse; global assets: none.\n`);
  for (const action of counts.actions) {
    const owners = action.owners.length ? ` (shared with ${action.owners.join(', ')})` : '';
    process.stdout.write(`  ${action.kind === 'create' ? 'CREATE' : action.kind === 'reuse-shared' ? 'REUSE shared' : 'REUSE identical'} ${action.asset.path}${owners}\n`);
  }
  process.stdout.write('  Attempt-bound host dispatch remains unsupported; no default host will be changed.\n');
  if (!options.apply) {
    process.stdout.write('Dry run only. Re-run with --apply to add the adapter.\n');
    return;
  }
  const created = [];
  let finalAssets = [];
  try {
    await copyMissingAdapterPairs(controlRoot, pairs, planned, created);
    const team = await currentTeam(controlRoot);
    if (team && adapter.modelBinding === 'project-frontmatter') await applyTeamBinding(adapter, controlRoot, team, installContext, 'project');
    finalAssets = await observedAdapterRecords(planned, pairs, controlRoot);
    const now = new Date().toISOString();
    const entry = {
      id: adapter.id,
      installed_at: now,
      updated_at: now,
      scopes: { project: true, global: false },
      scope_status: { project: 'installed', global: 'not_configured' },
      managed_assets: finalAssets,
    };
    const manifest = buildMultiAdapterManifest({
      triadVersion: packageVersion,
      installedAt: loaded?.manifest.installed_at ?? now,
      updatedAt: now,
      adapters: [...records, entry],
    });
    await writeInstallationManifest(controlRoot, manifest);
    process.stdout.write(`Adapter ${adapter.id} added; installation manifest migrated/written as schema v2.\n`);
  } catch (error) {
    const rollbackFailures = await rollbackCreatedAssets(created, finalAssets.length ? finalAssets : planned, controlRoot);
    if (rollbackFailures.length) process.stderr.write(`Recovery required; newly created assets preserved at: ${rollbackFailures.join(', ')}\n`);
    else process.stderr.write('Newly created adapter assets were rolled back; previous workspace state was preserved.\n');
    throw error;
  }
}

async function adapterRemove(options) {
  if (!options.host) throw new Error('Provide adapter remove <adapter-id>.');
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  if (options.global) throw new Error('Global adapter removal is intentionally unsupported; no global assets will be changed.');
  const controlRoot = resolve(options.control);
  await requireExistingDirectory(controlRoot);
  const { loaded, records } = await loadMultiMutationState(controlRoot);
  if (!loaded || !records.some((record) => record.id === options.host)) {
    process.stdout.write(`Adapter ${options.host} is not installed; no changes.\n`);
    return;
  }
  const selected = records.find((record) => record.id === options.host);
  if (selected.scopes.global) throw new Error(`Adapter ${options.host} also owns global assets. Global migration/removal is not part of this project-local operation; no files were changed.`);
  const remaining = records.filter((record) => record.id !== options.host);
  const owners = new Map();
  for (const record of records) for (const asset of record.managed_assets) {
    const list = owners.get(assetIdentity(asset)) ?? [];
    list.push({ record, asset });
    owners.set(assetIdentity(asset), list);
  }
  const removals = [];
  const preservedShared = [];
  const conflicts = [];
  for (const asset of selected.managed_assets.filter((entry) => entry.scope === 'project')) {
    const target = manifestAssetPath(controlRoot, asset);
    const info = await safeProjectAssetInfo(controlRoot, target);
    const assetOwners = owners.get(assetIdentity(asset)) ?? [];
    if (assetOwners.some((owner) => owner.asset.sha256 !== asset.sha256)) {
      conflicts.push(`${asset.path}: conflicting manifest owner`);
      continue;
    }
    if (!info) continue;
    const observed = await sha256File(target);
    if (observed !== asset.sha256) {
      conflicts.push(`${asset.path}: modified; preserved`);
      continue;
    }
    if (assetOwners.length > 1) preservedShared.push(asset.path);
    else removals.push({ asset, target });
  }
  if (conflicts.length) {
    process.stderr.write(`Removal refused; no files were changed. ${conflicts.join('; ')}\n`);
    throw new Error('Resolve the preserved/modified asset before removing this adapter.');
  }
  process.stdout.write(`Adapter remove ${options.apply ? 'applying' : 'plan'} — ${options.host}\n`);
  process.stdout.write(`  ${removals.length} exclusive unchanged file(s) ${options.apply ? 'will be removed' : 'would be removed'}; ${preservedShared.length} shared file(s) retained.\n`);
  for (const entry of removals) process.stdout.write(`  REMOVE ${entry.asset.path}\n`);
  for (const assetPath of preservedShared) process.stdout.write(`  PRESERVE shared ${assetPath}\n`);
  if (!options.apply) {
    process.stdout.write('Dry run only. Re-run with --apply to remove only hash-matching adapter-owned files.\n');
    return;
  }
  const backupRoot = await mkdtemp(join(tmpdir(), 'triad-adapter-remove-'));
  const backedUp = [];
  try {
    for (const [index, entry] of removals.entries()) {
      const backup = join(backupRoot, String(index));
      await cp(entry.target, backup);
      backedUp.push({ target: entry.target, backup, sha256: entry.asset.sha256 });
      await rm(entry.target);
    }
    const now = new Date().toISOString();
    const manifest = buildMultiAdapterManifest({
      triadVersion: loaded.manifest.triad_version,
      installedAt: loaded.manifest.installed_at,
      updatedAt: now,
      adapters: remaining.map((record) => record.id === options.host ? record : record),
    });
    await writeInstallationManifest(controlRoot, manifest);
    process.stdout.write(`Adapter ${options.host} removed. Project/user state and all shared assets were preserved.\n`);
  } catch (error) {
    const recovery = [];
    for (const entry of backedUp.reverse()) {
      try {
        if (!(await safeProjectAssetInfo(controlRoot, entry.target))) {
          await mkdir(dirname(entry.target), { recursive: true });
          await cp(entry.backup, entry.target);
        } else if (await sha256File(entry.target) !== entry.sha256) recovery.push(relative(controlRoot, entry.target));
      } catch { recovery.push(relative(controlRoot, entry.target)); }
    }
    if (recovery.length) process.stderr.write(`Recovery required; assets could not be restored safely: ${recovery.join(', ')}\n`);
    throw error;
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
}

async function adapterUpgrade(options) {
  const adapter = getAdapter(options.host);
  if (!adapter) throw new Error(`Choose adapter upgrade <${listAdapters().map((entry) => entry.id).join('|')}>.`);
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  if (options.global) throw new Error('Multi-adapter upgrade is project-local only; no global assets are changed.');
  const controlRoot = resolve(options.control);
  await requireExistingDirectory(controlRoot);
  const { loaded, records } = await loadMultiMutationState(controlRoot);
  if (!loaded || loaded.manifest.schema_version !== MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION) throw new Error('Upgrade requires an explicit v2 adapter add; use `adapter add` first.');
  const selected = records.find((record) => record.id === adapter.id);
  if (!selected) throw new Error(`Adapter ${adapter.id} is not installed.`);
  if (selected.scopes.global) throw new Error(`Adapter ${adapter.id} also owns global assets; project-local upgrade will not modify them.`);
  const installContext = context(controlRoot);
  const pairs = await adapterAssetPairs(adapter, controlRoot, installContext, records, selected);
  const planned = await plannedAdapterRecords(pairs, controlRoot);
  const previous = new Map(selected.managed_assets.filter((asset) => asset.scope === 'project').map((asset) => [asset.path, asset]));
  const sharedOwners = new Map();
  for (const record of records) for (const asset of record.managed_assets) {
    const list = sharedOwners.get(assetIdentity(asset)) ?? [];
    list.push({ adapter: record.id, asset });
    sharedOwners.set(assetIdentity(asset), list);
  }
  const actions = [];
  for (const [index, asset] of planned.entries()) {
    const target = pairs[index].target;
    const info = await safeProjectAssetInfo(controlRoot, target);
    const existing = previous.get(asset.path);
    if (!info) {
      if (!existing) throw new Error(`Unowned adapter asset is missing; refusing to claim it during upgrade: ${asset.path}`);
      actions.push({ kind: 'create', asset, target });
      continue;
    }
    const actual = await sha256File(target);
    if (!existing) {
      if (actual !== asset.sha256) throw new Error(`Unowned adapter asset collision: ${asset.path}`);
      actions.push({ kind: 'reuse', asset, target });
    } else if (actual !== existing.sha256) {
      throw new Error(`Modified managed asset preserved; refusing upgrade: ${asset.path}`);
    } else if (actual !== asset.sha256) {
      if ((sharedOwners.get(assetIdentity(asset)) ?? []).some((owner) => owner.adapter !== adapter.id)) {
        throw new Error(`Shared asset requires a coordinated upgrade; no files were changed: ${asset.path}`);
      }
      actions.push({ kind: 'replace', asset, target, previous: existing });
    } else actions.push({ kind: 'reuse', asset, target });
  }
  const createCount = actions.filter((action) => action.kind === 'create').length;
  const replaceCount = actions.filter((action) => action.kind === 'replace').length;
  process.stdout.write(`Adapter upgrade ${options.apply ? 'applying' : 'plan'} — ${adapter.id}: ${createCount} missing, ${replaceCount} changed, ${actions.length - createCount - replaceCount} unchanged.\n`);
  for (const action of actions) {
    const owners = sharedOwners.get(assetIdentity(action.asset)) ?? [];
    const sharedWith = owners.map((owner) => owner.adapter).filter((id) => id !== adapter.id);
    const label = action.kind === 'create' ? 'CREATE' : action.kind === 'replace' ? 'REPLACE (backup first)' : sharedWith.length ? 'PRESERVE/REUSE shared' : 'PRESERVE/REUSE unchanged';
    process.stdout.write(`  ${label} ${action.asset.path}${sharedWith.length ? ` (also owned by ${sharedWith.join(', ')})` : ''}\n`);
  }
  if (!options.apply) {
    process.stdout.write('Dry run only. Re-run with --apply to back up and refresh hash-matching managed assets.\n');
    return;
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupRoot = join(controlRoot, '.triad-plus', 'backups', stamp, 'adapter', adapter.id);
  const created = [];
  const replaced = [];
  let finalAssets = [];
  try {
    for (const action of actions) {
      if (action.kind === 'reuse') continue;
      if (action.kind === 'replace') {
        const backup = join(backupRoot, action.asset.path);
        await ensureSafeProjectParents(controlRoot, backup);
        if (await safeProjectAssetInfo(controlRoot, backup)) throw new Error(`Upgrade backup already exists; refusing to overwrite: ${relative(controlRoot, backup)}`);
        const currentInfo = await safeProjectAssetInfo(controlRoot, action.target);
        if (!currentInfo || await sha256File(action.target) !== action.previous.sha256) throw new Error(`Managed asset changed during upgrade; refusing to overwrite: ${action.asset.path}`);
        await copyFile(action.target, backup, fsConstants.COPYFILE_EXCL);
        replaced.push({ ...action, backup });
      } else {
        const currentInfo = await safeProjectAssetInfo(controlRoot, action.target);
        if (currentInfo) throw new Error(`Adapter asset appeared during upgrade; refusing to overwrite: ${action.asset.path}`);
        created.push(action);
      }
      await ensureSafeProjectParents(controlRoot, action.target);
      await copyFile(pairs[planned.findIndex((asset) => asset.path === action.asset.path)].source, action.target, action.kind === 'create' ? fsConstants.COPYFILE_EXCL : 0);
    }
    const team = await currentTeam(controlRoot);
    if (team && adapter.modelBinding === 'project-frontmatter') await applyTeamBinding(adapter, controlRoot, team, installContext, 'project');
    finalAssets = await observedAdapterRecords(planned, pairs, controlRoot);
    const now = new Date().toISOString();
    const updated = {
      ...selected,
      updated_at: now,
      managed_assets: finalAssets,
    };
    await writeInstallationManifest(controlRoot, buildMultiAdapterManifest({
      triadVersion: packageVersion,
      installedAt: loaded.manifest.installed_at,
      updatedAt: now,
      adapters: records.map((record) => record.id === adapter.id ? updated : record),
    }));
    process.stdout.write(`Adapter ${adapter.id} upgraded; replaced files were backed up under ${relative(controlRoot, backupRoot)}.\n`);
  } catch (error) {
    const rollbackFailures = await rollbackCreatedAssets(created, finalAssets.length ? finalAssets : planned, controlRoot);
    const recovery = [];
    for (const entry of replaced.reverse()) {
      try {
        const info = await safeProjectAssetInfo(controlRoot, entry.target);
        if (!info) {
          await ensureSafeProjectParents(controlRoot, entry.target);
          await copyFile(entry.backup, entry.target, fsConstants.COPYFILE_EXCL);
        } else {
          const currentHash = await sha256File(entry.target);
          if (currentHash === entry.previous.sha256) continue;
          if (currentHash !== entry.asset.sha256) {
            recovery.push(relative(controlRoot, entry.target));
            continue;
          }
          await copyFile(entry.backup, entry.target);
        }
      }
      catch { recovery.push(relative(controlRoot, entry.target)); }
    }
    if (rollbackFailures.length || recovery.length) process.stderr.write(`Recovery required; inspect: ${[...rollbackFailures, ...recovery].join(', ')}\n`);
    throw error;
  }
}

async function adapterCommand(options) {
  if (options.adapterCommand === 'list') return adapterList(options);
  if (options.adapterCommand === 'doctor') return adapterDoctor(options);
  if (options.adapterCommand === 'add') return adapterAdd(options);
  if (options.adapterCommand === 'remove') return adapterRemove(options);
  if (options.adapterCommand === 'upgrade') return adapterUpgrade(options);
  throw new Error('Use adapter add, list, doctor, upgrade, or remove.');
}

async function versionCommand(options) {
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  await requireExistingDirectory(controlRoot);
  process.stdout.write(`Triad+ CLI        ${packageVersion}\n`);
  process.stdout.write(`Workspace         ${controlRoot}\n`);
  let loaded;
  try { loaded = await loadInstallationManifest(controlRoot); }
  catch (error) {
    process.stdout.write('Installed Triad   unknown (manifest invalid)\n');
    process.stdout.write(`Manifest          invalid — ${error.message}\n`);
    throw error;
  }
  if (!loaded) {
    process.stdout.write('Installed Triad   unknown (legacy installation)\n');
    process.stdout.write('Manifest          legacy / manifest missing\n');
    process.stdout.write('Adapter           unknown\n');
    process.stdout.write('Project install   unknown\n');
    process.stdout.write('Global install    unknown\n');
    return;
  }
  const manifest = loaded.manifest;
  if (manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION) {
    process.stdout.write(`${formatDoctorLine('Installation schema', '2 (multi-adapter)')}\n`);
    const uninstalled = manifestIsUninstalled(manifest);
    const installedVersion = uninstalled
      ? `unknown (uninstalled; last ${manifest.triad_version})`
      : manifest.triad_version;
    process.stdout.write(`${formatDoctorLine('Installed Triad', installedVersion)}\n`);
    process.stdout.write(`${formatDoctorLine('Adapters', manifest.adapters.map((adapter) => adapter.id).join(', ') || 'none')}\n`);
    process.stdout.write('Attempt-bound host dispatch: unsupported; no adapter is selected by installation order.\n');
    return;
  }
  const adapter = getAdapter(manifest.adapter);
  const uninstalled = manifestIsUninstalled(manifest);
  process.stdout.write(`Installed Triad   ${uninstalled ? 'unknown (uninstalled)' : manifest.triad_version}\n`);
  process.stdout.write(`Manifest          ${uninstalled ? 'OK (uninstalled)' : 'OK'}\n`);
  process.stdout.write(`Adapter           ${adapter?.label ?? manifest.adapter}\n`);
  process.stdout.write(`Project install   ${installationScopeText(manifest, 'project')}\n`);
  process.stdout.write(`Global install    ${installationScopeText(manifest, 'global')}\n`);
}

async function uninstall(options) {
  const adapter = getAdapter(options.host);
  if (!adapter) throw new Error(`Choose --host ${listAdapters().map((item) => item.id).join(', ')}.`);
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  await requireExistingDirectory(controlRoot);
  const loaded = await loadInstallationManifest(controlRoot);
  process.stdout.write(`Triad+ uninstall — ${adapter.label}\n`);
  if (loaded?.manifest.schema_version === MULTI_ADAPTER_MANIFEST_SCHEMA_VERSION) {
    throw new Error('This workspace has a multi-adapter installation record. Use `adapter remove <adapter-id>`.');
  }
  if (!loaded) {
    process.stdout.write('Manifest          legacy / manifest missing\n');
    process.stdout.write('No files were changed. Refusing to delete assets without an installation manifest.\n');
    return;
  }
  const manifest = loaded.manifest;
  if (manifest.adapter !== adapter.id) throw new Error(`Installation manifest belongs to ${manifest.adapter}, not ${adapter.id}.`);
  const installContext = context(controlRoot);
  const selectedScopes = options.global ? ['project', 'global'] : ['project'];
  const scopeStats = Object.fromEntries(selectedScopes.map((scope) => [scope, { modified: 0, removed: 0 }]));
  if (options.global) process.stdout.write('Global assets are preserved because cross-workspace ownership cannot be proven.\n');
  for (const scope of selectedScopes) {
    const registryPaths = await managedAssetPaths(adapter, controlRoot, installContext, scope);
    process.stdout.write(`\n${scope === 'project' ? 'Project' : 'Global'} managed assets\n`);
    const entries = manifest.managed_assets.filter((asset) => asset.scope === scope);
    if (entries.length === 0) process.stdout.write('  (none)\n');
    for (const asset of entries) {
      const target = manifestAssetPath(controlRoot, asset);
      const display = displayManagedAssetPath(asset);
      let info;
      try { info = await lstat(target); } catch (error) {
        if (error.code === 'ENOENT') {
          process.stdout.write(`  ABSENT    ${display}\n`);
          continue;
        }
        process.stdout.write(`  PRESERVE  ${display}\n`);
        process.stdout.write(`            cannot inspect asset: ${error.message}\n`);
        scopeStats[scope].modified += 1;
        continue;
      }
      if (scope === 'global') {
        process.stdout.write(`  PRESERVE  ${display}\n`);
        process.stdout.write('            global ownership may be shared by another control workspace\n');
        scopeStats[scope].modified += 1;
        continue;
      }
      if (!assetAllowedByRegistry(registryPaths, controlRoot, asset)) {
        process.stdout.write(`  PRESERVE  ${display}\n`);
        process.stdout.write('            path is not in the current adapter managed plan\n');
        scopeStats[scope].modified += 1;
        continue;
      }
      if (asset.kind === 'managed_block') {
        if (!info.isFile()) {
          process.stdout.write(`  PRESERVE  ${display}\n`);
          process.stdout.write('            managed block host file is not a regular file\n');
          scopeStats[scope].modified += 1;
          continue;
        }
        let source;
        let managed;
        try {
          source = await readFile(target, 'utf8');
          managed = managedBlockIn(source, asset.start_marker, asset.end_marker);
        } catch {
          managed = null;
        }
        if (!managed || sha256Text(managed.content) !== asset.sha256) {
          process.stdout.write(`  PRESERVE  ${display}\n`);
          process.stdout.write('            managed block is modified, ambiguous, or unverifiable\n');
          scopeStats[scope].modified += 1;
          continue;
        }
        process.stdout.write(`  ${options.apply ? 'REMOVE' : 'WOULD REMOVE'} block ${display}\n`);
        if (options.apply) {
          await writeFile(target, `${source.slice(0, managed.start)}${source.slice(managed.blockEnd)}`, 'utf8');
          scopeStats[scope].removed += 1;
        }
        continue;
      }
      if (!info.isFile()) {
        process.stdout.write(`  PRESERVE  ${display}\n`);
        process.stdout.write('            asset is no longer a regular file\n');
        scopeStats[scope].modified += 1;
        continue;
      }
      const observed = await sha256File(target);
      if (observed !== asset.sha256) {
        process.stdout.write(`  PRESERVE  ${display}\n`);
        process.stdout.write('            content differs from installation manifest\n');
        scopeStats[scope].modified += 1;
        continue;
      }
      process.stdout.write(`  ${options.apply ? 'REMOVE' : 'WOULD REMOVE'}   ${display}\n`);
      if (options.apply) {
        await rm(target, { force: true });
        scopeStats[scope].removed += 1;
      }
    }
  }
  process.stdout.write('\nPreserved state\n');
  for (const preserved of ['.triad-plus/team.json', '.loop/', 'project.yaml', 'features/', 'artifacts/', 'evidence/']) {
    process.stdout.write(`  KEEP      ${preserved}\n`);
  }
  if (!options.apply) {
    process.stdout.write('\nNo files were changed. Re-run with --apply to uninstall managed assets.\n');
    return;
  }
  const scopeStatus = { project: manifestScopeStatus(manifest, 'project'), global: manifestScopeStatus(manifest, 'global') };
  for (const scope of selectedScopes) scopeStatus[scope] = scopeStats[scope].modified > 0 ? 'partial' : 'uninstalled';
  const status = overallInstallationStatus(scopeStatus);
  const updated = buildInstallationManifest({
    triadVersion: manifest.triad_version,
    adapter: manifest.adapter,
    installedAt: manifest.installed_at,
    updatedAt: new Date().toISOString(),
    uninstalledAt: status === 'uninstalled' ? new Date().toISOString() : undefined,
    scopes: manifest.scopes,
    scopeStatus,
    managedAssets: manifest.managed_assets,
    status
  });
  await writeInstallationManifest(controlRoot, updated);
  process.stdout.write(`\nInstallation manifest updated ${installationManifestPath(controlRoot)}\n`);
  const projectPartial = scopeStatus.project === 'partial';
  const globalPreserved = options.global && scopeStatus.global === 'partial';
  if (status === 'uninstalled') {
    process.stdout.write('Complete project uninstall; user state was preserved.\n');
  } else if (projectPartial && globalPreserved) {
    process.stdout.write('Partial uninstall; modified or unverifiable project assets and shared global assets were preserved.\n');
  } else if (projectPartial) {
    process.stdout.write('Partial project uninstall; modified or unverifiable assets were preserved.\n');
  } else if (globalPreserved) {
    process.stdout.write('Project uninstall complete; global assets were intentionally preserved because shared ownership could not be proven.\n');
  } else {
    process.stdout.write('Uninstall completed conservatively; preserved assets remain in place.\n');
  }
}

async function doctor(options) {
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  const requested = options.host ? [getAdapter(options.host)] : listAdapters();
  if (requested.some((adapter) => !adapter)) throw new Error(`Choose --host ${listAdapters().map((item) => item.id).join(', ')}.`);
  if (!options.host) process.stdout.write('No --host specified: inspecting all six adapters. An incomplete adapter does not mean it was selected for installation; use --host <adapter-id> to focus the diagnosis.\n');
  let team = null;
  if (await exists(teamConfigPath(controlRoot))) {
    try { team = validateTeamConfiguration(JSON.parse(await readFile(teamConfigPath(controlRoot), 'utf8'))); }
    catch { team = 'invalid'; }
  }
  for (const adapter of requested) {
    const installContext = context(controlRoot);
    const installation = await inspectInstallation(controlRoot, adapter, installContext);
    if (installation.state === 'not_installed') {
      process.stdout.write(`\n${formatDoctorSection(`Triad+ doctor — ${adapter.label}`)}\n`);
      process.stdout.write(`  ${formatDoctorLine('Installation', 'not installed in this multi-adapter workspace')}\n`);
      process.stdout.write(`  ${formatDoctorLine('Attempt dispatch', 'unsupported; no implicit host selection')}\n`);
      continue;
    }
    const absent = [];
    const recordedMetadata = installation.multiAdapter ? recordedRuntimeMetadataPath(installation.manifest) : null;
    const projectTargets = adapter.projectPaths(controlRoot, installContext).filter((target) => !(installation.multiAdapter && resolve(target) === resolve(controlRoot, '.triad-runtime/adapter.json')));
    if (recordedMetadata) projectTargets.push(resolve(controlRoot, recordedMetadata));
    for (const target of projectTargets) if (!(await exists(target))) absent.push(target);
    const globalDetected = adapter.globalPaths ? await anyExist(adapter.globalPaths(installContext)) : false;
    const inspectGlobal = Boolean(options.global || globalDetected);
    const globalTargets = inspectGlobal && adapter.globalPaths ? adapter.globalPaths(installContext) : [];
    const globalAbsent = [];
    for (const target of globalTargets) if (!(await exists(target))) globalAbsent.push(target);
    const binary = commandVersion(adapter.binaryCandidates ?? adapter.binary);
    const node = commandVersion('node');
    const manifestPath = recordedMetadata ? resolve(controlRoot, recordedMetadata) : join(controlRoot, '.triad-runtime', 'adapter.json');
    let manifest = false;
    try { manifest = (JSON.parse(await readFile(manifestPath, 'utf8'))?.id === adapter.id); } catch {}
    const targets = projectTargets;
    const roleTargets = targets.filter((target) => /[/\\]agents[/\\]triad-/.test(target));
    const triadSkillTargets = targets.filter((target) => /[/\\]skills[/\\]triad$/.test(target));
    const capability = manifest ? capabilitySnapshot(controlRoot, manifestPath) : null;
    process.stdout.write(`\n${formatDoctorSection(`Triad+ doctor — ${adapter.label}`)}\n`);
    process.stdout.write(`${formatDoctorLine(adapter.label, absent.length || globalAbsent.length || installation.issues.length ? 'incomplete' : 'OK')}\n`);
    process.stdout.write(`${formatDoctorSection('Triad+ installation')}\n`);
    process.stdout.write(`  ${formatDoctorLine('CLI version', packageVersion)}\n`);
    if (installation.state === 'legacy') {
      process.stdout.write(`  ${formatDoctorLine('Installed version', 'unknown (legacy installation)')}\n`);
      process.stdout.write(`  ${formatDoctorLine('Manifest', 'legacy / manifest missing')}\n`);
      process.stdout.write(`  ${formatDoctorLine('Adapter', adapter.label)}\n`);
      process.stdout.write(`  ${formatDoctorLine('Project scope', 'unknown (legacy)')}\n`);
      process.stdout.write(`  ${formatDoctorLine('Global scope', 'unknown (legacy)')}\n`);
    } else if (installation.state === 'invalid') {
      process.stdout.write(`  ${formatDoctorLine('Installed version', 'unknown (manifest invalid)')}\n`);
      process.stdout.write(`  ${formatDoctorLine('Manifest', 'invalid')} — ${installation.message}\n`);
      process.stdout.write(`  ${formatDoctorLine('Adapter', adapter.label)}\n`);
      process.stdout.write(`  ${formatDoctorLine('Project scope', 'unknown')}\n`);
      process.stdout.write(`  ${formatDoctorLine('Global scope', 'unknown')}\n`);
    } else {
      const versionStatus = installation.state === 'uninstalled'
        ? `unknown (uninstalled; last ${installation.manifest.triad_version})`
        : installation.manifest.triad_version;
      const versionWarning = installation.versionRelation === 1
        ? ' — CLI newer / upgrade available'
        : installation.versionRelation === -1
        ? ' — CLI older than installed version'
        : '';
      const issueStatus = installation.issues.some((issue) => issue.status === 'modified' || issue.status === 'present_after_uninstall')
        ? 'managed asset modified'
        : installation.issues.some((issue) => issue.status === 'missing')
        ? 'managed asset missing'
        : installation.state === 'uninstalled' ? 'OK (uninstalled)' : 'OK';
      process.stdout.write(`  ${formatDoctorLine('Installed version', versionStatus)}${versionWarning}\n`);
      process.stdout.write(`  ${formatDoctorLine('Manifest', issueStatus)}\n`);
      process.stdout.write(`  ${formatDoctorLine('Adapter', adapter.label)}\n`);
      process.stdout.write(`  ${formatDoctorLine('Project scope', installationScopeText(installation.manifest, 'project'))}\n`);
      process.stdout.write(`  ${formatDoctorLine('Global scope', installationScopeText(installation.manifest, 'global'))}\n`);
    }
    process.stdout.write(`${formatDoctorSection('Runtime and installation')}\n`);
    process.stdout.write(`  ${formatDoctorLine('Host runtime', binary ? `OK (${binary})` : 'not installed or version unavailable')}\n`);
    process.stdout.write(`  ${formatDoctorLine('Verifier', node && await exists(join(controlRoot, '.triad-runtime', 'triad-verify.mjs')) ? 'OK' : 'incomplete')}\n`);
    process.stdout.write(`  ${formatDoctorLine('Adapter', manifest ? 'OK' : 'missing or different adapter')}\n`);
    if (installation.multiAdapter) process.stdout.write(`  ${formatDoctorLine('Attempt dispatch', 'unsupported; no implicit host selection')}\n`);
    if (roleTargets.length) process.stdout.write(`  ${formatDoctorLine('Role agents', await allExist(roleTargets) ? 'OK' : 'missing')}\n`);
    if (triadSkillTargets.length) process.stdout.write(`  ${formatDoctorLine('Triad skill', await allExist(triadSkillTargets) ? 'OK' : 'missing')}\n`);
    const projectSharedSkills = await sharedSkillStatuses(adapter, controlRoot, installContext, 'project');
    if (projectSharedSkills.length) {
      process.stdout.write(`${formatDoctorSection('Shared skills')}\n`);
      for (const skill of projectSharedSkills) process.stdout.write(`  ${formatDoctorLine(skill.name, skill.status)}\n`);
    }
    if (inspectGlobal) {
      const globalSharedSkills = await sharedSkillStatuses(adapter, controlRoot, installContext, 'global');
      if (globalSharedSkills.length) {
        process.stdout.write(`${formatDoctorSection('Global shared skills')}\n`);
        for (const skill of globalSharedSkills) process.stdout.write(`  ${formatDoctorLine(skill.name, skill.status)}\n`);
      }
    }
    process.stdout.write(`${formatDoctorSection('Verification and capabilities')}\n`);
    process.stdout.write(`  ${formatDoctorLine('Verification', capability?.verification?.selected_mode ?? 'unavailable')}${capability?.verification?.reason ? ` (${capability.verification.reason})` : ''}\n`);
    process.stdout.write(`${formatDoctorSection('Configuration')}\n`);
    process.stdout.write(`  ${formatDoctorLine('Team config', team === 'invalid' ? 'invalid' : team ? 'OK' : 'not configured')}\n`);
    process.stdout.write(`  ${formatDoctorLine('Evaluator+', team?.roles?.evaluator?.enabled === true ? 'configured' : 'not configured')}\n`);
    const modelFields = adapter.modelBinding === 'global-profiles'
      ? 'model, reasoning_effort'
      : Array.isArray(adapter.modelFields) && adapter.modelFields.length ? adapter.modelFields.join(', ') : 'team.json record / host-managed';
    process.stdout.write(`  ${formatDoctorLine('Model binding', `${adapter.modelBinding ?? 'unavailable'} (${modelFields})`)}\n`);
    const modelScopes = [];
    const validTeam = team !== 'invalid' ? team : null;
    if (adapter.modelBinding === 'project-frontmatter') {
      modelScopes.push(['project', await modelBindingEvidence(adapter, controlRoot, installContext, validTeam, 'project')]);
    }
    if (inspectGlobal && (adapter.modelBinding === 'project-frontmatter' || adapter.modelBinding === 'global-profiles')) {
      modelScopes.push(['global', await modelBindingEvidence(adapter, controlRoot, installContext, validTeam, 'global')]);
    }
    if (modelScopes.some(([, entries]) => entries.length)) {
      process.stdout.write(`${formatDoctorSection('Model configuration evidence')}\n`);
      for (const [scope, entries] of modelScopes) {
        for (const entry of entries) {
          const field = hostModelField(adapter, entry.role.id, 'reasoning_effort');
          const desired = validTeam?.roles?.[entry.role.id];
          const desiredText = desired
            ? `desired model=${desired.model || 'host default'}${field ? ` ${field}=${desired.reasoning_effort || 'host default'}` : ''}`
            : 'desired unavailable';
          const observedText = entry.observed ? ` — materialized ${JSON.stringify(entry.observed)}` : '';
          process.stdout.write(`  ${formatDoctorLine(`${scope} ${entry.role.label}`, entry.status)} ${desiredText}${observedText}\n`);
        }
      }
      if (adapter.modelBinding === 'project-frontmatter') {
        process.stdout.write(`  ${formatDoctorLine('Host default', 'UNKNOWN / NOT OBSERVABLE')}\n`);
        process.stdout.write(`  ${formatDoctorLine('Current session', 'UNKNOWN / NOT OBSERVABLE')}\n`);
      }
    }
    const overlay = await overlayPlan(controlRoot, team).catch(() => null);
    process.stdout.write(`  ${formatDoctorLine('Instructions', overlay ? overlay.action === 'update' ? 'managed' : `needs ${overlay.action}` : 'invalid managed block')}\n`);
    const globalAgents = join(codexHome(), 'AGENTS.md');
    if (await exists(globalAgents)) {
      const globalText = await readFile(globalAgents, 'utf8');
      const fixedIdentity = /(?:identity|name)[\s\S]{0,100}(?:always|only|must)/i.test(globalText);
      process.stdout.write(`  ${formatDoctorLine('Identity policy', fixedIdentity ? 'host rule detected; review for Triad role conflicts' : 'no fixed host rule detected')}\n`);
    }
    if (options.hookConfig && adapter.lifecycle) {
      process.stdout.write(`  ${formatDoctorLine('Hook config', 'declared; run runtime capability detection for detailed status')}\n`);
    }
  }
}

async function cockpit(options) {
  // Loaded on demand so installer commands never import the Cockpit server.
  const { launchCockpit } = await import('../cockpit/server/launch.mjs');
  await launchCockpit({ control: options.control, port: options.port, noOpen: options.noOpen });
}

function interactivePrompt() {
  let readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    question(message) { return readline.question(message); },
    async checklist(options) {
      readline.close();
      try {
        return await selectChecklist({ ...options, input: process.stdin, output: process.stdout });
      } finally {
        readline = createInterface({ input: process.stdin, output: process.stdout });
      }
    },
    close() { readline.close(); },
  };
}

function slugFromRepositoryPath(repositoryPath) {
  const raw = basename(repositoryPath).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : 'repository';
}

function uniqueRepositoryIds(repositories) {
  const used = new Set();
  return repositories.map((repository) => {
    const base = slugFromRepositoryPath(repository.path);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      const ending = `-${suffix}`;
      id = `${base.slice(0, 64 - ending.length).replace(/-+$/g, '')}${ending}`;
      suffix += 1;
    }
    used.add(id);
    return id;
  });
}

async function chooseNewControlRoot(prompt, currentDirectory) {
  process.stdout.write('Triad+ / 1 of 5 — Control Workspace\n');
  const current = await inspectControlRoot(currentDirectory);
  if (current.gitBoundary) {
    process.stdout.write(`Current directory belongs to Git root ${current.gitBoundary}. It cannot be selected as a clean Control Workspace; choose a separate root explicitly. No sibling path will be generated.\n`);
  }
  while (true) {
    const answer = (await prompt.question(current.gitBoundary
      ? 'Separate Control Workspace absolute path (blank cancels): '
      : `Control Workspace root to open in the IDE [${currentDirectory}] (absolute or relative; blank uses this path): `)).trim();
    if (!answer && current.gitBoundary) return null;
    const candidate = resolve(currentDirectory, answer || currentDirectory);
    try {
      const inspected = await inspectControlRoot(candidate);
      if (inspected.gitBoundary) {
        process.stdout.write(`Unsafe as a new Control Workspace: it is inside Git root ${inspected.gitBoundary}. Choose a separate path; no files were changed.\n`);
        continue;
      }
      const loaded = await loadInstallationManifest(candidate);
      if (loaded) {
        const manage = (await prompt.question(`A Triad+ installation already exists at ${candidate}. Type manage to open its existing adapter menu; anything else chooses another root: `)).trim();
        if (manage === 'manage') return { existing: candidate };
        continue;
      }
      return inspected.path;
    } catch (error) {
      process.stdout.write(`Cannot safely use ${candidate}: ${error.message}\n`);
    }
  }
}

async function collectGreenfieldRepositoryPlan(prompt, controlRoot, previousPlan = null) {
  process.stdout.write('\nGreenfield repository setup remains a text-entry flow in this P0 prototype; candidate discovery never creates a repository.\n');
  let count = null;
  const previous = previousPlan?.mode === 'greenfield' ? previousPlan.repositories : [];
  while (!count) {
    const suggested = String(previous.length || 1);
    const answer = (await prompt.question(`Number of greenfield repositories (1-20) [${suggested}]: `)).trim();
    count = parsePositiveCount(answer || suggested, 20);
    if (!count) process.stdout.write('Enter a whole number from 1 to 20.\n');
  }
  const repositories = [];
  for (let index = 0; index < count; index += 1) {
    const prior = previous[index];
    const suggestedId = prior?.id ?? `repo-${index + 1}`;
    const id = (await prompt.question(`Greenfield repository ${index + 1} stable ID [${suggestedId}]: `)).trim() || suggestedId;
    const suggestedPath = prior?.path ?? `./${id}`;
    const repoPath = (await prompt.question(`${id} repository path [${suggestedPath}]: `)).trim() || suggestedPath;
    const suggestedBase = prior?.base_branch ?? 'main';
    const baseBranch = (await prompt.question(`${id} base branch [${suggestedBase}]: `)).trim() || suggestedBase;
    const branchDefault = prior?.projectBranchEdited ? prior.project_branch : `triad/${id}-feature`;
    const branchAnswer = (await prompt.question(`${id} project branch [${branchDefault}]: `)).trim();
    const projectBranch = branchAnswer || branchDefault;
    const worktreeDefault = prior?.worktreeEdited ? prior.worktree : `worktrees/${id}-feature`;
    const worktreeAnswer = (await prompt.question(`${id} worktree mapping [${worktreeDefault}]: `)).trim();
    const worktree = worktreeAnswer || worktreeDefault;
    repositories.push({
      id,
      path: repoPath,
      base_branch: baseBranch,
      project_branch: projectBranch,
      worktree,
      projectBranchEdited: Boolean(branchAnswer) || Boolean(prior?.projectBranchEdited),
      worktreeEdited: Boolean(worktreeAnswer) || Boolean(prior?.worktreeEdited),
    });
  }
  return { mode: 'greenfield', repositories };
}

async function collectRepositoryPlan(prompt, controlRoot, previousPlan = null) {
  let candidates = [];
  const paths = new Set();
  for (const candidatePath of await immediateGitChildren(controlRoot)) {
    try {
      const candidate = await inspectExistingRepositoryRoot(controlRoot, candidatePath);
      candidates.push(candidate);
      paths.add(candidate.absolutePath);
    } catch (error) {
      process.stdout.write(`A direct-child candidate could not be safely inspected and is not selectable: ${candidatePath} — ${error.message}\n`);
    }
  }

  if (previousPlan?.mode === 'existing') {
    for (const repository of previousPlan.repositories) {
      try {
        const candidate = await inspectExistingRepositoryRoot(controlRoot, repository.path);
        if (!paths.has(candidate.absolutePath)) {
          candidates.push(candidate);
          paths.add(candidate.absolutePath);
        }
      } catch (error) {
        process.stdout.write(`Previously selected repository is no longer valid: ${repository.path} — ${error.message}\n`);
      }
    }
  }
  candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const previousMode = previousPlan?.mode;
  const priorByPath = new Map((previousPlan?.mode === 'existing' ? previousPlan.repositories : [])
    .map((repository) => [resolve(controlRoot, repository.path), repository]));
  const generatedIds = uniqueRepositoryIds(candidates);
  const generatedIdByPath = new Map(candidates.map((candidate, index) => [candidate.absolutePath, generatedIds[index]]));
  let selectedPaths = previousPlan?.mode === 'existing'
    ? previousPlan.repositories.map((repository) => resolve(controlRoot, repository.path)).filter((candidate) => paths.has(candidate))
    : [];
  let focusId = selectedPaths[0] ?? (previousMode === 'greenfield' ? 'greenfield' : previousMode === 'defer' ? 'defer' : undefined);
  let initialMessage = '';

  while (true) {
    const items = candidates.map((candidate) => ({
      kind: 'checkbox',
      id: candidate.absolutePath,
      label: candidate.path,
      description: candidate.currentBranch ? `current branch ${candidate.currentBranch}` : 'current branch detached HEAD',
    }));
    items.push(
      { kind: 'action', id: 'add-repository', action: 'add-path', label: 'Add repository by path', description: 'explicit existing local Git root' },
      { kind: 'action', id: 'greenfield', action: 'greenfield', label: previousMode === 'greenfield' ? 'Continue greenfield setup' : 'Create greenfield repository', description: 'text-based paths; created only after approval' },
      { kind: 'action', id: 'defer', action: 'defer', label: 'Defer repository configuration', description: 'explicitly leave mappings empty' },
    );
    const result = await prompt.checklist({
      step: 'Triad+ / 2 of 5 — Product repositories',
      title: 'Select product repositories',
      context: [`Control Workspace: ${controlRoot}`],
      description: 'Only immediate-child Git roots are suggested. No ancestor/sibling search, clone, or implicit selection.',
      items,
      initialSelection: selectedPaths,
      initialFocus: focusId,
      minimum: 1,
      maximum: 20,
      escapeBehavior: 'cancel',
      selectionSummary: (selection) => `${selection.length} selected / 20 max`,
      hint: '↑↓ move · Space check a repository · Enter confirm selection / open action · Esc cancel',
      initialMessage,
    });
    initialMessage = '';
    if (result.kind === 'interrupt') return { kind: 'interrupt' };
    if (result.kind === 'cancel') return null;
    if (result.kind === 'selected') {
      selectedPaths = result.selected;
      const selectedCandidates = selectedPaths.map((id) => candidates.find((candidate) => candidate.absolutePath === id)).filter(Boolean);
      const suggestedIds = uniqueRepositoryIds(selectedCandidates);
      const repositories = [];
      for (const [index, candidate] of selectedCandidates.entries()) {
        const prior = priorByPath.get(candidate.absolutePath);
        const suggestedId = prior?.id ?? generatedIdByPath.get(candidate.absolutePath) ?? suggestedIds[index];
        const idAnswer = (await prompt.question(`${candidate.path} stable ID [${suggestedId}]: `)).trim();
        const id = idAnswer || suggestedId;
        const baseDefault = prior?.base_branch ?? candidate.currentBranch ?? 'main';
        const baseBranch = (await prompt.question(`${id} detected base branch ${candidate.currentBranch ?? '(detached HEAD)'} [${baseDefault}]: `)).trim() || baseDefault;
        const branchDefault = prior?.projectBranchEdited ? prior.project_branch : `triad/${id}-feature`;
        const branchAnswer = (await prompt.question(`${id} project branch [${branchDefault}]: `)).trim();
        const projectBranch = branchAnswer || branchDefault;
        const worktreeDefault = prior?.worktreeEdited ? prior.worktree : `worktrees/${id}-feature`;
        const worktreeAnswer = (await prompt.question(`${id} worktree mapping [${worktreeDefault}]: `)).trim();
        const worktree = worktreeAnswer || worktreeDefault;
        repositories.push({
          id,
          path: candidate.path,
          base_branch: baseBranch,
          project_branch: projectBranch,
          worktree,
          projectBranchEdited: Boolean(branchAnswer) || Boolean(prior?.projectBranchEdited),
          worktreeEdited: Boolean(worktreeAnswer) || Boolean(prior?.worktreeEdited),
        });
      }
      return { mode: 'existing', repositories, selectedPaths };
    }

    selectedPaths = result.selected;
    if (result.action === 'defer') return { mode: 'defer', repositories: [], selectedPaths: [] };
    if (result.action === 'greenfield') return await collectGreenfieldRepositoryPlan(prompt, controlRoot, previousPlan);
    if (result.action === 'add-path') {
      const rawPath = (await prompt.question('Existing Git repository root path to add (absolute or relative; blank returns to selection): ')).trim();
      if (!rawPath) {
        focusId = 'add-repository';
        continue;
      }
      try {
        const candidate = await inspectExistingRepositoryRoot(controlRoot, rawPath);
        const already = candidates.find((item) => item.absolutePath === candidate.absolutePath);
        if (!already && selectedPaths.length >= 20) {
          initialMessage = 'You can select at most 20 repositories.';
          focusId = 'add-repository';
          continue;
        }
        if (!already) candidates.push(candidate);
        if (!selectedPaths.includes(candidate.absolutePath)) selectedPaths.push(candidate.absolutePath);
        candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        focusId = candidate.absolutePath;
        initialMessage = already ? 'That Git root is now explicitly selected.' : 'Repository path validated and explicitly selected.';
      } catch (error) {
        initialMessage = `Path was not added; no workspace changes were made: ${error.message}`;
        focusId = 'add-repository';
      }
    }
  }
}

async function collectAdapterSelection(prompt, initialSelection = []) {
  const adapters = listAdapters();
  const explanations = {
    opencode: 'project-local agents and /triad command',
    codex: 'project-local skills and role launcher',
    'claude-code': 'project-local agents and commands',
    copilot: 'project-local agent and instructions',
    antigravity: 'project-local rules and workflow assets',
    hermes: 'project-local skills and runtime assets',
  };
  const result = await prompt.checklist({
    step: 'Triad+ / 3 of 5 — Harnesses',
    title: 'Select coding harnesses',
    context: ['Control Workspace project-local install only; no host/global files or settings.'],
    description: 'Multi-adapter installation is supported. Per-Attempt cross-harness dispatch is not.',
    items: adapters.map((adapter) => ({
      kind: 'checkbox',
      id: adapter.id,
      label: `${adapter.label} (${adapter.id})`,
      description: explanations[adapter.id] ?? 'project-local adapter assets',
    })),
    initialSelection,
    initialFocus: initialSelection[0],
    minimum: 1,
    maximum: adapters.length,
    escapeBehavior: 'back',
    selectionSummary: (selection) => {
      const primary = adapters.find((adapter) => adapter.id === selection[0]);
      return `${selection.length} selected${primary ? ` · primary ${primary.label} (${primary.id})` : ''}`;
    },
    hint: '↑↓ move · Space toggle · Enter confirm · Esc Back',
  });
  if (result.kind === 'interrupt' || result.kind === 'back') return result;
  return { ...result, adapters: result.selected.map((id) => adapters.find((adapter) => adapter.id === id)).filter(Boolean) };
}

async function preflightInteractiveSetup({ root, repositories, adapters, projectYamlPlan, team, useExistingTeam }) {
  const adapterPlans = new Map();
  const first = await init({ host: adapters[0].id, control: root, planOnly: true, team, useExistingTeam });
  adapterPlans.set(adapters[0].id, first);
  const simulatedRecords = [{ id: first.adapterId, managed_assets: first.managedAssets }];
  for (const adapter of adapters.slice(1)) {
    const plan = await adapterAdd({
      adapterCommand: 'add',
      host: adapter.id,
      control: root,
      planOnly: true,
      setupRecords: simulatedRecords,
    });
    adapterPlans.set(adapter.id, plan);
    simulatedRecords.push({ id: adapter.id, managed_assets: plan.managedAssets });
  }
  const readiness = await setupReadiness(root, repositories);
  const roleOverlayPlan = team ? await overlayPlan(root, team) : null;
  const roleBindingActions = team ? adapters.flatMap((adapter) => {
    if (adapter.modelBinding !== 'project-frontmatter' || typeof adapter.roleModelPaths !== 'function') return [];
    return adapter.roleModelPaths(root, context(root)).map((target) => ({ adapterId: adapter.id, target }));
  }) : [];
  return {
    root, repositories, adapters, adapterPlans, projectYamlPlan, readiness,
    roleOverlayPlan, roleBindingActions,
    teamMode: useExistingTeam ? 'reuse existing without rewriting' : team ? 'create requested team config' : 'leave unconfigured',
    team,
    useExistingTeam,
    currentVersion: packageVersion,
  };
}

async function applyInteractiveSetup(plan) {
  const createdRepos = [];
  const installedAdapters = [];
  let createdRoot = false;
  let projectYamlWritten = false;
  try {
    await assertNoSymlinkPath(plan.root);
    if (plan.roleOverlayPlan) {
      const currentOverlay = await overlayPlan(plan.root, plan.team);
      if (currentOverlay.before !== plan.roleOverlayPlan.before || currentOverlay.content !== plan.roleOverlayPlan.content) {
        throw new Error('AGENTS.md changed after preview; no repository or adapter setup was started. Review the updated file and run the wizard again.');
      }
    }
    createdRoot = !(await exists(plan.root));
    await mkdir(plan.root, { recursive: true });
    await assertNoSymlinkPath(plan.root, { allowMissing: false });
    const recheckedRoot = await inspectControlRoot(plan.root);
    if (recheckedRoot.gitBoundary) throw new Error(`Control Workspace became part of Git root ${recheckedRoot.gitBoundary}; no repository migration was attempted.`);
    try { createdRepos.push(...await initializeGreenfieldRepositories(plan.repositories)); }
    catch (error) {
      createdRepos.push(...(error.createdRepositories ?? []));
      throw error;
    }
    if (plan.projectYamlPlan.changed) {
      await writeProjectYamlPlan(plan.projectYamlPlan);
      projectYamlWritten = true;
    }
    await init({ host: plan.adapters[0].id, control: plan.root, team: plan.team, useExistingTeam: plan.useExistingTeam });
    installedAdapters.push(plan.adapters[0].id);
    for (const adapter of plan.adapters.slice(1)) {
      await adapterAdd({ adapterCommand: 'add', host: adapter.id, control: plan.root, apply: true });
      installedAdapters.push(adapter.id);
    }
  } catch (error) {
    process.stderr.write(`Setup is incomplete; no successful step was removed.\n`);
    process.stderr.write(`  Control Workspace: ${plan.root}\n`);
    process.stderr.write(`  Control Workspace directory created: ${createdRoot ? 'yes' : 'no'}\n`);
    process.stderr.write(`  Greenfield repositories initialized: ${createdRepos.join(', ') || 'none'}\n`);
    process.stderr.write(`  project.yaml updated: ${projectYamlWritten ? 'yes' : 'no'}\n`);
    process.stderr.write(`  Harnesses fully installed: ${installedAdapters.join(', ') || 'none'}\n`);
    if (installedAdapters.length < plan.adapters.length) process.stderr.write('  The failing harness may have partial files; inspect with adapter doctor before retrying.\n');
    process.stderr.write(`  Safe re-entry: run triad-plus from this root, choose Manage existing, then add only missing adapters.\n`);
    throw error;
  }

  process.stdout.write('\nTriad+ setup completed.\n');
  const readiness = await setupReadiness(plan.root, plan.repositories);
  process.stdout.write(`Readiness: ${readiness.ready ? 'READY' : 'NOT READY'}${readiness.missing.length ? ` — missing: ${readiness.missing.join('; ')}` : ''}\n`);
  for (const adapter of plan.adapters) await adapterDoctor({ adapterCommand: 'doctor', host: adapter.id, control: plan.root });
  for (const adapter of plan.adapters) {
    for (const line of projectLaunchHint(adapter, plan.root)) process.stdout.write(`${line}\n`);
  }
  process.stdout.write('No PRD, gate, branch baseline, worktree, remote, or successful verification was created implicitly.\n');
}

async function interactiveNewProjectSetup(prompt, currentDirectory) {
  const root = await chooseNewControlRoot(prompt, currentDirectory);
  if (!root) {
    process.stdout.write('Cancelled. No files were changed.\n');
    return;
  }
  if (typeof root === 'object' && root.existing) {
    await interactiveAdapterManagement({
      prompt,
      control: root.existing,
      adapters: listAdapters(),
      getInstalledAdapterIds: async (controlRoot) => adapterRecords((await loadInstallationManifest(controlRoot))?.manifest ?? null).map((record) => record.id),
      runCommand: adapterCommand,
    });
    return;
  }

  let repositoryPlan = null;
  let repositories = null;
  let adapters = null;
  let initialAdapters = [];
  while (!adapters) {
    const selection = await collectRepositoryPlan(prompt, root, repositoryPlan);
    if (selection?.kind === 'interrupt') return 'interrupt';
    if (!selection) {
      process.stdout.write('Cancelled. No files were changed.\n');
      return;
    }
    try {
      repositories = await validateRepositoryPlan(root, selection.repositories, { mode: selection.mode });
      repositoryPlan = selection;
    } catch (error) {
      process.stdout.write(`Repository preflight failed; nothing was changed: ${error.message}\n`);
      const answer = (await prompt.question('Correct repository mapping and retry from this workspace? [Y/n]: ')).trim().toLowerCase();
      if (answer === 'n' || answer === 'no') {
        process.stdout.write('Cancelled. No files were changed.\n');
        return;
      }
      repositoryPlan = selection;
      continue;
    }
    const adapterSelection = await collectAdapterSelection(prompt, initialAdapters);
    if (adapterSelection.kind === 'interrupt') return 'interrupt';
    if (adapterSelection.kind === 'back') {
      initialAdapters = adapterSelection.selected;
      continue;
    }
    adapters = adapterSelection.adapters;
  }
  let team = null;
  let useExistingTeam = false;
  process.stdout.write('\nTriad+ / 4 of 5 — Optional team setup\n');
  try {
    if (await exists(teamConfigPath(root))) {
      team = await currentTeam(root);
      useExistingTeam = Boolean(team);
    } else if (['y', 'yes'].includes((await prompt.question('Configure optional Triad+ team identities/models now? [y/N]: ')).trim().toLowerCase())) {
      team = await collectTeamConfiguration(prompt, adapters[0]);
    }
  } catch (error) {
    process.stdout.write(`Preflight failed; nothing was changed: ${error.message}\n`);
    return;
  }
  let plan;
  try {
    const projectYamlPlan = await readProjectYamlPlan(root, repositories, {
      projectId: basename(root),
      title: basename(root),
    });
    plan = await preflightInteractiveSetup({ root, repositories, adapters, projectYamlPlan, team, useExistingTeam });
  } catch (error) {
    process.stdout.write(`Preflight failed; nothing was changed: ${error.message}\n`);
    return;
  }
  await confirmAndApplySetup({
    prompt,
    preview: `Triad+ / 5 of 5 — Review exact plan\n${formatSetupPreview(plan)}`,
    apply: () => applyInteractiveSetup(plan),
  });
}

async function interactiveInit() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The interactive wizard needs a terminal. Use init in a non-interactive shell.');
  const prompt = interactivePrompt();
  try {
    const currentDirectory = resolve(process.cwd());
    let currentManifest = null;
    let currentManifestError = null;
    try { currentManifest = await loadInstallationManifest(currentDirectory); }
    catch (error) { currentManifestError = error; }
    const defaultMode = currentManifest ? 'm' : 'n';
    process.stdout.write('\nTriad+\n');
    if (currentManifest) {
      process.stdout.write(`Detected a valid ${currentManifest.manifest.schema_version === 1 ? 'schema-v1' : 'schema-v2'} installation manifest in the current Control Workspace.\n`);
    } else if (currentManifestError) {
      process.stdout.write(`The current directory does not have a valid installation manifest: ${currentManifestError.message}\n`);
    } else {
      process.stdout.write('No valid installation manifest was found in the current directory.\n');
    }
    process.stdout.write('No sibling directories will be searched.\n');
    const mode = (await prompt.question(`Choose [N]ew workspace or [M]anage existing [${defaultMode.toUpperCase()}]: `)).trim().toLowerCase() || defaultMode;
    if (mode === 'm' || mode === 'manage' || mode === 'manage existing') {
      let control = currentManifest ? currentDirectory : null;
      while (!control) {
        const candidate = (await prompt.question('Enter the existing Control Workspace path explicitly (blank cancels): ')).trim();
        if (!candidate) {
          process.stdout.write('Cancelled. No files were changed.\n');
          return;
        }
        const candidatePath = resolve(candidate);
        try {
          await requireExistingDirectory(candidatePath);
          const manifest = await loadInstallationManifest(candidatePath);
          if (!manifest) {
            process.stdout.write(`No installation manifest was found at ${candidatePath}; legacy/uninitialized state will be shown without scanning elsewhere.\n`);
            const confirm = (await prompt.question('Type manage to inspect this explicitly selected directory: ')).trim();
            if (confirm !== 'manage') {
              process.stdout.write('Cancelled. No files were changed.\n');
              return;
            }
          } else {
            process.stdout.write(`Using the valid Control Workspace at ${candidatePath}.\n`);
          }
          control = candidatePath;
        } catch (error) {
          process.stdout.write(`Cannot safely manage ${candidatePath}: ${error.message}\n`);
        }
      }
      await interactiveAdapterManagement({
        prompt,
        control,
        adapters: listAdapters(),
        getInstalledAdapterIds: async (controlRoot) => adapterRecords((await loadInstallationManifest(controlRoot))?.manifest ?? null).map((record) => record.id),
        runCommand: adapterCommand,
      });
      return;
    }
    if (!['n', 'new', 'new workspace'].includes(mode)) {
      process.stdout.write('Choose New workspace or Manage existing. No files were changed.\n');
      return;
    }

    process.stdout.write('\nNew project setup\n');
    const result = await interactiveNewProjectSetup(prompt, currentDirectory);
    if (result === 'interrupt') {
      process.stdout.write('Cancelled by Ctrl+C. No workspace or repository changes were applied.\n');
      process.exitCode = 130;
    }
  } finally { prompt.close(); }
}

try {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    process.stdout.write(`${packageVersion}\n`);
    process.exit(0);
  }
  const options = parseArgs(argv);
  if (options.command === 'init') await init(options);
  else if (options.command === 'adapter') await adapterCommand(options);
  else if (options.command === 'doctor') await doctor(options);
  else if (options.command === 'version') await versionCommand(options);
  else if (options.command === 'upgrade') await upgrade(options);
  else if (options.command === 'uninstall') await uninstall(options);
  else if (options.command === 'import-bmad-story') await importBmadStory(options);
  else if (options.command === 'cockpit') await cockpit(options);
  else if (!options.command) await interactiveInit();
  else if (options.command === '--help' || options.command === '-h') usage(0);
  else throw new Error(`Unknown command: ${options.command}`);
} catch (error) {
  process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
  process.stderr.write('Run npx triad-plus --help for command syntax.\n');
  process.exitCode = 2;
}
