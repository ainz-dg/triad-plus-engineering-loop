#!/usr/bin/env node

import { access, cp, mkdir, readFile, rm, rmdir, stat, writeFile, lstat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { getAdapter, listAdapters, roleDefinitions, sharedSkillNames } from '../adapters/registry.mjs';
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
  collectManagedAssetRecords,
  installationManifestFingerprint,
  installationManifestPath,
  loadInstallationManifest,
  manifestIsUninstalled,
  manifestScopeStatus,
  sha256File,
  writeInstallationManifest
} from '../runtime/lib/installation-manifest.mjs';

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
  npx triad-plus import-bmad-story --source <story.md> --output <card.md> [--target-repository <id>] [--provenance <record.json>] [--required-gate <id>] [--depends-on <card-id>]

Adapters: ${listAdapters().map((adapter) => adapter.id).join(', ')}

The control path is a project-control workspace, not a product repository.
Installation refuses every asset overwrite. Upgrade is a dry run unless --apply is supplied.
`);
  process.exit(exitCode);
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = { command, global: false, allowProductRepo: false, apply: false, requiredGates: [], dependsOn: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--global') options.global = true;
    else if (argument === '--allow-product-repo') options.allowProductRepo = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--required-gate' || argument === '--depends-on') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      const target = argument === '--required-gate' ? options.requiredGates : options.dependsOn;
      target.push(value);
      index += 1;
    }
    else if (['--host', '--control', '--team-config', '--hook-config', '--source', '--output', '--target-repository', '--provenance'].includes(argument)) {
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

/** Expand registry assets to the exact files copied, never to a host directory. */
async function materializedAssetPaths(assets, root, installContext) {
  const paths = [];
  for (const asset of assets) {
    const destination = resolveDestination(asset.destination, root, installContext);
    if (asset.source === 'shared-skills') {
      for (const name of sharedSkillNames) {
        const source = join(packageRoot, 'skills', name);
        const sourceRoot = resolve(source);
        for (const file of await sourceFiles(sourceRoot)) {
          paths.push(join(destination, name, relative(sourceRoot, file)));
        }
      }
      continue;
    }
    const source = sourcePath(asset.source);
    const sourceInfo = await lstat(source);
    if (asset.file || sourceInfo.isFile()) {
      paths.push(destination);
      continue;
    }
    const sourceRoot = resolve(source);
    for (const file of await sourceFiles(sourceRoot)) paths.push(join(destination, relative(sourceRoot, file)));
  }
  return [...new Set(paths.map((target) => resolve(target)))];
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
    managedAssets: [...projectAssets, ...globalAssets],
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

async function overlayPlan(controlRoot, team) {
  const target = join(controlRoot, 'AGENTS.md');
  const overlay = instructionOverlay(team);
  if (!(await exists(target))) return { target, action: 'create', content: `# Project instructions\n\n${overlay}\n` };
  const source = await readFile(target, 'utf8');
  const start = source.indexOf(overlayStart);
  const end = source.indexOf(overlayEnd);
  if (start === -1 && end === -1) return { target, action: 'append', content: `${source.replace(/\s*$/, '')}\n\n${overlay}\n` };
  if (start < 0 || end < start) throw new Error(`Cannot safely update managed instruction block: ${target}`);
  return { target, action: 'update', content: `${source.slice(0, start)}${overlay}${source.slice(end + overlayEnd.length)}` };
}

async function applyOverlay(controlRoot, apply, team) {
  const plan = await overlayPlan(controlRoot, team);
  process.stdout.write(`  Instructions ${apply ? plan.action : `would ${plan.action}`} ${plan.target}\n`);
  if (apply) await writeFile(plan.target, plan.content, 'utf8');
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
  if (manifest.adapter !== adapter.id) {
    return {
      state: 'invalid',
      message: `manifest adapter ${manifest.adapter} does not match selected ${adapter.id}`,
      manifest,
      issues: []
    };
  }
  const issues = await installationAssetIssues(controlRoot, adapter, installContext, manifest);
  const versionRelation = compareVersions(packageVersion, manifest.triad_version);
  return { state: manifestIsUninstalled(manifest) ? 'uninstalled' : 'valid', manifest, issues, versionRelation };
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
  const team = await loadTeamConfig(options);
  const controlRoot = resolve(options.control);
  await requireDirectory(controlRoot);
  if (!options.allowProductRepo && productRepositoryAt(controlRoot)) {
    throw new Error('Control path appears to be a product repository. Use a separate project-control workspace, or pass --allow-product-repo after reviewing the risk.');
  }
  let previousManifest = null;
  if (await exists(installationManifestPath(controlRoot))) previousManifest = await loadInstallationManifest(controlRoot);
  const installContext = context(controlRoot);
  const planned = [
    ...adapter.projectPaths(controlRoot, installContext),
    ...(team ? [teamConfigPath(controlRoot)] : []),
    ...(options.global ? adapter.globalPaths(installContext) : []),
    ...(team && options.global && adapter.modelBinding === 'global-profiles' ? adapter.roleModelPaths(installContext) : []),
    ...(team && options.global && adapter.modelBinding === 'project-frontmatter' && adapter.globalRoleModelPaths
      ? adapter.globalRoleModelPaths(installContext)
      : [])
  ];
  const existing = await collisions(planned);
  if (existing.length > 0) throw new Error(`Installation aborted; existing paths would be overwritten:\n${existing.map((target) => `  ${target}`).join('\n')}`);
  await installAssets(adapter.projectAssets, controlRoot, installContext);
  if (team) await writeTeamConfig(controlRoot, team);
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
  process.stdout.write(`Triad+ installed for ${adapter.label} in ${controlRoot}\n`);
  if (adapter.globalEntry) {
    process.stdout.write(`Install user-level assets with --global to expose ${adapter.entry}.\n`);
  }
  process.stdout.write(`Open the control workspace and use ${adapter.entry} <PRD path>. Configured Evaluator+ runs automatically post-approval.\n`);
}

async function currentTeam(controlRoot) {
  const target = teamConfigPath(controlRoot);
  if (!(await exists(target))) return null;
  try { return validateTeamConfiguration(JSON.parse(await readFile(target, 'utf8'))); }
  catch { throw new Error(`Cannot safely upgrade an invalid team config: ${target}`); }
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
  await requireDirectory(controlRoot);
  let previousManifest = null;
  if (await exists(installationManifestPath(controlRoot))) previousManifest = await loadInstallationManifest(controlRoot);
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

async function versionCommand(options) {
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  await requireDirectory(controlRoot);
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
  const adapter = getAdapter(manifest.adapter);
  const uninstalled = manifestIsUninstalled(manifest);
  process.stdout.write(`Installed Triad   ${uninstalled ? 'unknown (uninstalled)' : manifest.triad_version}\n`);
  process.stdout.write(`Manifest          ${uninstalled ? 'OK (uninstalled)' : 'OK'}\n`);
  process.stdout.write(`Adapter           ${adapter?.label ?? manifest.adapter}\n`);
  process.stdout.write(`Project install   ${installationScopeText(manifest, 'project')}\n`);
  process.stdout.write(`Global install    ${installationScopeText(manifest, 'global')}\n`);
}

async function pruneEmptyParents(target, stopRoot) {
  let current = dirname(target);
  const root = resolve(stopRoot);
  while (current !== root && pathWithin(root, current)) {
    let entries;
    try { entries = await readdir(current); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (entries.length > 0) return;
    await rmdir(current);
    current = dirname(current);
  }
}

async function uninstall(options) {
  const adapter = getAdapter(options.host);
  if (!adapter) throw new Error(`Choose --host ${listAdapters().map((item) => item.id).join(', ')}.`);
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  await requireDirectory(controlRoot);
  const loaded = await loadInstallationManifest(controlRoot);
  process.stdout.write(`Triad+ uninstall — ${adapter.label}\n`);
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
  for (const scope of selectedScopes) {
    const registryPaths = await managedAssetPaths(adapter, controlRoot, installContext, scope);
    process.stdout.write(`\n${scope === 'project' ? 'Project' : 'Global'} managed assets\n`);
    const entries = manifest.managed_assets.filter((asset) => asset.scope === scope);
    if (entries.length === 0) process.stdout.write('  (none)\n');
    for (const asset of entries) {
      const target = manifestAssetPath(controlRoot, asset);
      const display = displayManagedAssetPath(asset);
      if (!assetAllowedByRegistry(registryPaths, controlRoot, asset)) {
        process.stdout.write(`  PRESERVE  ${display}\n`);
        process.stdout.write('            path is not in the current adapter managed plan\n');
        scopeStats[scope].modified += 1;
        continue;
      }
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
        await pruneEmptyParents(target, scope === 'project' ? controlRoot : homedir());
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
  process.stdout.write(status === 'uninstalled'
    ? 'Uninstall complete; user state was preserved.\n'
    : 'Uninstall completed conservatively; modified assets were preserved.\n');
}

async function doctor(options) {
  if (!options.control) throw new Error('Provide --control <project-control-path>.');
  const controlRoot = resolve(options.control);
  const requested = options.host ? [getAdapter(options.host)] : listAdapters();
  if (requested.some((adapter) => !adapter)) throw new Error(`Choose --host ${listAdapters().map((item) => item.id).join(', ')}.`);
  let team = null;
  if (await exists(teamConfigPath(controlRoot))) {
    try { team = validateTeamConfiguration(JSON.parse(await readFile(teamConfigPath(controlRoot), 'utf8'))); }
    catch { team = 'invalid'; }
  }
  for (const adapter of requested) {
    const installContext = context(controlRoot);
    const absent = [];
    for (const target of adapter.projectPaths(controlRoot, installContext)) if (!(await exists(target))) absent.push(target);
    const globalDetected = adapter.globalPaths ? await anyExist(adapter.globalPaths(installContext)) : false;
    const inspectGlobal = Boolean(options.global || globalDetected);
    const globalTargets = inspectGlobal && adapter.globalPaths ? adapter.globalPaths(installContext) : [];
    const globalAbsent = [];
    for (const target of globalTargets) if (!(await exists(target))) globalAbsent.push(target);
    const binary = commandVersion(adapter.binaryCandidates ?? adapter.binary);
    const node = commandVersion('node');
    const manifestPath = join(controlRoot, '.triad-runtime', 'adapter.json');
    let manifest = false;
    try { manifest = (JSON.parse(await readFile(manifestPath, 'utf8'))?.id === adapter.id); } catch {}
    const targets = adapter.projectPaths(controlRoot, installContext);
    const roleTargets = targets.filter((target) => /[/\\]agents[/\\]triad-/.test(target));
    const triadSkillTargets = targets.filter((target) => /[/\\]skills[/\\]triad$/.test(target));
    const capability = manifest ? capabilitySnapshot(controlRoot, manifestPath) : null;
    process.stdout.write(`\n${formatDoctorSection(`Triad+ doctor — ${adapter.label}`)}\n`);
    process.stdout.write(`${formatDoctorLine(adapter.label, absent.length || globalAbsent.length ? 'incomplete' : 'OK')}\n`);
    const installation = await inspectInstallation(controlRoot, adapter, installContext);
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

async function interactiveInit() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The interactive wizard needs a terminal. Use init in a non-interactive shell.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('\nTriad+ setup\n');
    listAdapters().forEach((adapter, index) => process.stdout.write(`${index + 1}) ${adapter.label}\n`));
    let adapter;
    while (!adapter) {
      const answer = (await prompt.question(`Choose the host [1-${listAdapters().length}]: `)).trim().toLowerCase();
      adapter = listAdapters()[Number(answer) - 1] ?? getAdapter(answer);
      if (!adapter) process.stdout.write('Choose a listed host.\n');
    }
    const control = (await prompt.question(`Project-control workspace [${join(process.cwd(), 'triad-control')}]: `)).trim() || join(process.cwd(), 'triad-control');
    const global = ['y', 'yes'].includes((await prompt.question(`Also install user-level ${adapter.entry} assets? [y/N]: `)).trim().toLowerCase());
    const team = await collectTeamConfiguration(prompt, adapter);
    process.stdout.write(`\n${formatSetupSummary({ adapter, control, global, team })}`);
    const confirm = (await prompt.question('Type install to continue: ')).trim().toLowerCase();
    if (confirm !== 'install') return process.stdout.write('Cancelled. No files were changed.\n');
    await init({ host: adapter.id, control, global, team });
    await doctor({ host: adapter.id, control });
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
  else if (options.command === 'doctor') await doctor(options);
  else if (options.command === 'version') await versionCommand(options);
  else if (options.command === 'upgrade') await upgrade(options);
  else if (options.command === 'uninstall') await uninstall(options);
  else if (options.command === 'import-bmad-story') await importBmadStory(options);
  else if (!options.command) await interactiveInit();
  else if (options.command === '--help' || options.command === '-h') usage(0);
  else throw new Error(`Unknown command: ${options.command}`);
} catch (error) {
  process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
  usage(2);
}
