// Shared workspace onboarding. No discovered command or model/provider probe is run.
import { access, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { validateHostEntry, checkDeclaredWorkspaces, assertNoSymlinkPath } from './host-entry-validation.mjs';
import { discoverQualityGates, readGateSource } from './gate-discovery.mjs';
import { lintQualityGateSource } from './gates.mjs';
import { modelInputIssue, validateTeamConfiguration } from './model-config.mjs';

export const READINESS_RECEIPT = '.triad-plus/readiness.json';
const ROLES = ['orchestrator', 'developer', 'reviewer', 'evaluator'];
export const ENTRY_CAPABILITIES = Object.freeze({
  opencode: 'Use the project-specific /models picker (provider/model and its available variants).',
  'claude-code': 'Use the Claude Code model picker; current session and subagent controls differ.',
  codex: 'Use the Codex session model controls; managed user-level profiles require separate exact-path consent.',
  copilot: 'Use the model picker of the actual CLI/IDE/cloud surface; capabilities differ between surfaces.',
  antigravity: 'Use the native model picker; per-role native model identity is not exposed by this adapter.',
  hermes: 'Use the active Hermes profile/provider controls; CLI presence is not a working session.',
});
const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = (message) => { throw Object.assign(new Error(message), { code: 'READINESS_BLOCKED' }); };
const emptyReceipt = () => ({ schema_version: 1, models: {}, repositories: {}, prerequisites: null });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const finding = (id, message, severity = 'fixable', kind = 'manual') => ({ id, severity, kind, message });

export async function gateSourceSnapshot(worktree) {
  const entries = [];
  for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'pom.xml', 'Makefile', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    const source = await readGateSource(path.join(worktree, name));
    entries.push({ name, status: source.status, sha256: source.sha256 ?? null });
  }
  return { entries, fingerprint: digest(entries), valid: entries.every((entry) => ['read', 'missing'].includes(entry.status)) };
}

async function workspaceTarget(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) fail('Use a workspace-relative file path.');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) fail('File path escapes the Control Workspace.');
  // Walk existing parents before creating anything. Never follow a user symlink.
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) fail('Workspace destination contains a symlink.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

async function writeWorkspace(root, relative, content, { immutable = false, expectedHash } = {}) {
  const target = await workspaceTarget(root, relative);
  const old = await readGateSource(target);
  if (!['read', 'missing'].includes(old.status)) fail('Workspace destination is not a safe regular file.');
  if (expectedHash !== undefined && (old.sha256 ?? null) !== expectedHash) fail('Workspace file changed during approval; inspect again.');
  if (old.text === content) return;
  if (immutable && old.status !== 'missing') fail('Existing catalog has different bytes; it will not be overwritten.');
  await mkdir(path.dirname(target), { recursive: true });
  await assertNoSymlinkPath(path.dirname(target));
  if (immutable) { await writeFile(target, content, { flag: 'wx', mode: 0o600 }); return; }
  const temporary = await mkdtemp(path.join(path.dirname(target), '.readiness-'));
  try {
    const pending = path.join(temporary, 'pending.json');
    await writeFile(pending, content, { flag: 'wx', mode: 0o600 });
    await workspaceTarget(root, relative);
    if ((await readGateSource(target)).sha256 !== old.sha256) fail('Workspace file changed during approval; inspect again.');
    await rename(pending, target);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function parseReceipt(source) {
  if (source.status === 'missing') return emptyReceipt();
  if (source.status !== 'read') fail('Readiness receipt is unsafe or unreadable; inspect it locally.');
  let receipt;
  try { receipt = JSON.parse(source.text); } catch { fail('Readiness receipt is malformed; inspect it locally.'); }
  if (!object(receipt) || receipt.schema_version !== 1 || !object(receipt.models) || !object(receipt.repositories)) fail('Unsupported readiness receipt; inspect it locally.');
  return receipt;
}

function intentOf(team) {
  return ROLES.map((role) => ({ role, model: team?.roles?.[role]?.model ?? null,
    effort: team?.roles?.[role]?.reasoning_effort ?? null, enabled: role !== 'evaluator' || team?.roles?.evaluator?.enabled === true }));
}

function repositoryFingerprint(context, source) {
  return digest({ id: context.id, repository: context.repositoryRoot, worktree: context.worktreeRoot,
    common: context.gitCommon, base: context.base_branch, branch: context.project_branch, source: source.fingerprint });
}

function prerequisitesFingerprint(prd, repositories) {
  return digest({ prd: prd.sha256, repositories, policy: 'prerequisites-v1' });
}

async function catalogAt(root, relative) {
  const target = await workspaceTarget(root, relative);
  const source = await readGateSource(target);
  if (source.status !== 'read') return null;
  const lint = lintQualityGateSource(source.text);
  return { ...source, relative, valid: lint.valid, issues: lint.issues };
}

async function evaluate({ adapter, cwd = process.cwd(), requireGlobalEntry = false, expectedVersion, review, catalog: requestedCatalog }) {
  const root = path.resolve(cwd);
  const report = { schema_version: 1, adapter, ready: false, state_sha256: null, actions: [], advisories: [], catalogs: [],
    model_binding: 'unconfirmed', effective_model_identity: 'not-observable', entry_enforcement: 'model-instructed, post-LLM in native skills' };
  const internal = { root };
  if (!Object.hasOwn(ENTRY_CAPABILITIES, adapter) || Number(process.versions.node.split('.')[0]) < 20) {
    report.actions.push(finding('installation', 'Select one of the six supported adapters and use Node >=20.', 'fatal'));
    return { report, internal };
  }
  const installation = await validateHostEntry({ adapter, cwd: root, checkReadiness: false, requireGlobalEntry });
  if (!installation.ready || expectedVersion && installation.version !== expectedVersion) {
    report.actions.push(finding('installation', 'Installation/adapter integrity or exact workspace path is invalid. Use trusted package doctor/upgrade; do not repair hashes or search other workspaces.', 'fatal'));
    return { report, internal };
  }
  const receiptSource = await readGateSource(path.join(root, READINESS_RECEIPT));
  let receipt;
  try { receipt = parseReceipt(receiptSource); }
  catch { report.actions.push(finding('receipt', 'Readiness receipt is malformed, incompatible or unsafe; inspect it locally.', 'fatal')); return { report, internal }; }
  internal.receipt = receipt;
  internal.receiptSource = receiptSource;
  const teamSource = await readGateSource(path.join(root, '.triad-plus/team.json'));
  let team = null;
  try {
    if (teamSource.status === 'read') team = validateTeamConfiguration(JSON.parse(teamSource.text));
    else if (teamSource.status !== 'missing') throw new Error('unsafe');
  } catch {
    report.actions.push(finding('team', 'Team configuration is malformed or unsafe; repair its schema locally without changing generated assets.', 'fatal'));
    return { report, internal };
  }
  internal.team = team; internal.teamSource = teamSource;
  const intent = intentOf(team);
  internal.modelsFingerprint = digest({ adapter, intent, policy: 'explicit-host-defaults-v1' });
  report.model_requests = intent.filter((role) => role.enabled).map((role) => ({ role: role.role,
    model: modelInputIssue({ id: adapter }, role.model) ? 'invalid-request' : role.model ? 'unverified-request' : 'host-default',
    effort: modelInputIssue(null, role.effort) ? 'invalid-request' : role.effort ? 'unverified-request' : 'host-default' }));
  report.advisories.push(ENTRY_CAPABILITIES[adapter], 'Requested models/effort remain intent. Native overrides are not applied; provider/model identity and project code safety are not verified.');
  if (receipt.models[adapter]?.fingerprint !== internal.modelsFingerprint || receipt.models[adapter]?.mode !== 'host-default') {
    report.actions.push(finding('models', 'Explicitly accept host model/effort defaults for this host, or correct requested intent. This does not fulfill or verify requested per-role models.', 'fixable', 'confirm-models'));
  } else report.model_binding = 'owner-confirmed-host-default; requested overrides not applied';
  const prd = await readGateSource(path.join(root, 'PRD.md'));
  if (prd.status !== 'read' || !prd.text.trim()) report.actions.push(finding('prd', 'Create a safe, non-empty root PRD.md. Preflight will not invent requirements or rebaseline an existing run.'));
  const project = await readGateSource(path.join(root, 'project.yaml'));
  const problems = [];
  const mappingIssues = [];
  const contexts = project.status === 'read' ? await checkDeclaredWorkspaces(root, problems, { strict: true, issues: mappingIssues }) : [];
  internal.contexts = contexts; internal.project = project; internal.prd = prd;
  if (project.status !== 'read' || problems.length || !contexts.length) {
    const messages = {
      'invalid-mapping': 'Correct missing/duplicate repository IDs and explicit paths in project.yaml.',
      'worktree-missing-or-unsafe': 'Create/check the exact declared worktree, its canonical path and committed Git baseline.',
      'repository-missing-or-unsafe': 'Correct the declared repository path, Git root and initial baseline commit.',
      'foreign-worktree': 'The mapped worktree must belong to this repository, not another Git root.',
      'invalid-branch-mapping': 'Declare valid existing base/project branch names.',
      'base-branch-missing': 'Create/select the declared base branch through an explicit owner action.',
      'worktree-branch-mismatch': 'Switch the mapped worktree to its declared project branch through an explicit owner action.',
      'separate-worktree-required': 'Declare a separate worktree rather than the repository root.',
    };
    for (const issue of mappingIssues.length ? mappingIssues : [{ reason: 'invalid-mapping' }]) report.actions.push({
      ...finding('repositories:' + (issue.repository_id ?? 'mapping') + ':' + issue.reason,
        messages[issue.reason] + ' Preflight does not change external repositories, branches or worktrees.'), ...issue });
  }
  const discovered = await discoverQualityGates(root, contexts);
  internal.repositories = new Map();
  const catalogStates = [];
  for (const context of contexts) {
    const source = await gateSourceSnapshot(context.worktreeRoot);
    const proposal = discovered.repositories.find((entry) => entry.id === context.id);
    const fingerprint = repositoryFingerprint(context, source);
    const record = receipt.repositories[context.id];
    const data = { context, source, fingerprint, proposal, record };
    internal.repositories.set(context.id, data);
    if (!source.valid || proposal?.status === 'malformed-manifest' || proposal?.status === 'invalid-scripts') {
      report.actions.push(finding('source:' + context.id, `Repair unreadable, unsupported or malformed gate sources for ${context.id}; no source body is printed.`));
      continue;
    }
    const manifest = await readGateSource(path.join(context.worktreeRoot, 'package.json'));
    if (manifest.status === 'read') {
      const parsed = JSON.parse(manifest.text);
      const needsDependencies = Object.keys(parsed?.dependencies ?? {}).length || Object.keys(parsed?.devDependencies ?? {}).length;
      if (needsDependencies) {
        const modules = path.join(context.worktreeRoot, 'node_modules');
        let present = false;
        try { await assertNoSymlinkPath(modules); present = (await lstat(modules)).isDirectory(); } catch {}
        if (!present) report.actions.push(finding('dependencies:' + context.id, `Install/review project dependencies for ${context.id} in its exact worktree through a separately explicit owner action. Preflight never runs install or lifecycle scripts.`));
      }
    }
    if (proposal?.candidates?.length) {
      let npmFound = false;
      for (const directory of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        try { await access(path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm'), constants.X_OK); npmFound = true; break; } catch {}
      }
      if (!npmFound) report.actions.push(finding('npm:' + context.id, `Make npm accessible for ${context.id}; no executable/version probe or installation was run.`));
    }
    let catalog = null;
    if (record?.decision === 'approved' && record.fingerprint === fingerprint && typeof record.catalog === 'string') {
      try { catalog = await catalogAt(root, record.catalog); } catch {}
      catalogStates.push({ repository: context.id, path: record.catalog, sha256: catalog?.sha256 ?? null });
      if (!catalog?.valid || catalog.sha256 !== record.catalog_sha256) catalog = null;
      if (review === 'gates:' + context.id) catalog = null;
    }
    if (catalog) report.catalogs.push({ repository_id: context.id, worktree: context.worktree, branch: context.project_branch,
      gates_path: record.catalog, expected_gates_sha256: catalog.sha256, source_fingerprint: source.fingerprint });
    else {
      const declined = record?.decision === 'declined' && record.fingerprint === fingerprint && review !== 'gates:' + context.id;
      report.actions.push({ ...finding('gates:' + context.id, declined
        ? `Gate candidates for ${context.id} were declined. Provide/review a manual catalog explicitly; no repeated confirmation is requested.`
        : `Review and select/edit/reject gates for ${context.id}. Scripts execute arbitrary project code; ignore-scripts is not a safety certificate.`, 'fixable', declined ? 'manual' : 'confirm-gates'),
        repository_id: context.id, worktree: context.worktree, branch: context.project_branch, source_fingerprint: source.fingerprint,
        commands: (proposal?.candidates ?? []).map(({ id, category, command, timeout_seconds, command_source }) => ({ id, category, command, timeout_seconds, command_source })),
        prerequisites: ['Exact current worktree/branch/source hashes', 'Node/npm and project dependencies where required', 'Owner review of script bodies and referenced project code'],
        source: 'Read package.json and referenced scripts locally; manifest bodies are data and are not emitted as agent instructions.',
        catalog_options: ['.loop/quality-gates.yaml', 'workspace-relative manual catalog'],
      });
    }
  }
  let manualCatalog = null;
  if (requestedCatalog) {
    try { manualCatalog = await catalogAt(root, requestedCatalog); } catch {}
    const gateAction = report.actions.find((action) => action.kind === 'confirm-gates');
    if (gateAction) gateAction.manual_catalog = manualCatalog?.valid ? {
      path: requestedCatalog, sha256: manualCatalog.sha256,
      review: 'Review the commands locally in this catalog; bodies are not emitted as agent instructions. Approval binds these exact bytes.',
    } : { path: 'unavailable', review: 'Manual catalog is unsafe, missing or invalid; no approval is possible.' };
  }
  internal.prerequisitesFingerprint = prerequisitesFingerprint(prd,
    [...internal.repositories.values()].map(({ fingerprint }) => fingerprint));
  if (receipt.prerequisites?.fingerprint !== internal.prerequisitesFingerprint) {
    report.actions.push(finding('prerequisites', 'Confirm the PRD, mapped worktrees/branches and reviewed tool/dependency prerequisites. Host credentials/effective model identity and command safety remain unverified.', 'fixable', 'confirm-prerequisites'));
  }
  report.state_sha256 = digest({ adapter, installation: installation.fingerprint, team: teamSource.sha256 ?? null, prd: prd.sha256 ?? null, project: project.sha256 ?? null,
    repositories: [...internal.repositories.values()].map(({ fingerprint }) => fingerprint),
    catalogs: catalogStates, manual_catalog: requestedCatalog ? { path: requestedCatalog, sha256: manualCatalog?.sha256 ?? null } : null,
    receipt: receiptSource.sha256 ?? null });
  report.ready = report.actions.length === 0;
  return { report, internal };
}

export function readinessErrorMessage(error) {
  return error?.code === 'READINESS_BLOCKED' ? error.message : 'Preflight evidence is unavailable or changed; inspect locally. No discovered command was executed.';
}

export async function inspectReadiness(options) {
  try { return (await evaluate(options)).report; }
  catch {
    return { schema_version: 1, adapter: options.adapter, ready: false, state_sha256: null,
      actions: [finding('evidence', 'Evidence is unsafe, unavailable or changed during inspection; inspect locally.', 'fatal')],
      advisories: [], catalogs: [], model_binding: 'unconfirmed', effective_model_identity: 'not-observable' };
  }
}

async function applyReadinessApproval(options) {
  if (options.setModel !== undefined && options.setEffort !== undefined) fail('Correct one model/effort field at a time.');
  if ((options.setModel !== undefined || options.setEffort !== undefined) && (options.approve || options.select || options.catalog)) fail('Keep intent correction separate from approval.');
  if (options.approve && !options.approve.startsWith('gates:') && (options.select || options.catalog || options.timeout !== undefined)) fail('Gate selection options apply only to a gate approval.');
  const { report, internal } = await evaluate(options);
  if (!report.state_sha256 || options.expectedState !== report.state_sha256) fail('Preflight inputs changed or expected state is missing. Inspect again; nothing was approved.');
  if (report.actions.some((action) => action.severity === 'fatal')) fail('Resolve fatal installation/configuration findings first.');
  const { root, receipt } = internal;
  if (options.setModel !== undefined || options.setEffort !== undefined) {
    const value = options.setModel ?? options.setEffort;
    const separator = value.indexOf('=');
    const role = value.slice(0, separator);
    const requested = value.slice(separator + 1);
    if (separator < 0 || !ROLES.includes(role) || modelInputIssue(options.setModel !== undefined ? { id: options.adapter } : null, requested)) fail('Use a known role and an exact, syntactically valid requested ID/effort, or blank to clear it. No native selection is verified.');
    const team = internal.team ?? { schema_version: 1, interaction: { language: 'English', owner_name: 'Owner', communication_style: 'professional and concise' },
      roles: Object.fromEntries(ROLES.map((id) => [id, { displayName: id === 'evaluator' ? 'Evaluator+' : id[0].toUpperCase() + id.slice(1), persona: 'professional and role-focused', model: null, reasoning_effort: null, enabled: id !== 'evaluator' }])) };
    team.roles[role][options.setModel !== undefined ? 'model' : 'reasoning_effort'] = requested || null;
    validateTeamConfiguration(team);
    await writeWorkspace(root, '.triad-plus/team.json', JSON.stringify(team, null, 2) + '\n', { expectedHash: internal.teamSource.sha256 ?? null });
    return inspectReadiness({ adapter: options.adapter, cwd: options.cwd, requireGlobalEntry: options.requireGlobalEntry, expectedVersion: options.expectedVersion });
  }
  const action = report.actions[0];
  if (!action || options.approve !== action.id || action.kind === 'manual') fail('Approve only the current first confirmable action after review.');
  const confirmation = { confirmed_via: 'explicit-preflight-approval', approved_state_sha256: report.state_sha256 };
  if (action.id === 'models') receipt.models[options.adapter] = { ...confirmation, fingerprint: internal.modelsFingerprint, mode: 'host-default', identity: 'not-observable', requested_overrides_applied: false };
  else if (action.id === 'prerequisites') receipt.prerequisites = { ...confirmation, fingerprint: internal.prerequisitesFingerprint };
  else if (action.kind === 'confirm-gates') {
    const data = internal.repositories.get(action.repository_id);
    if (!data || !data.source.valid) fail('Current repository/worktree source cannot be verified.');
    if (options.select === 'reject') receipt.repositories[action.repository_id] = { ...confirmation, fingerprint: data.fingerprint, decision: 'declined' };
    else {
      if (Boolean(options.catalog) === Boolean(options.select)) fail('Choose explicit candidate IDs or a workspace-relative manual catalog.');
      let catalog;
      if (options.catalog) {
        catalog = await catalogAt(root, options.catalog);
        if (!catalog?.valid) fail('Manual catalog is missing, unsafe or fails structure-only lint; no commands executed.');
      } else {
        const ids = options.select.split(',');
        if (!ids.length || new Set(ids).size !== ids.length) fail('Choose distinct current candidate IDs.');
        const candidates = data.proposal?.candidates ?? [];
        const selected = ids.map((id) => candidates.find((candidate) => candidate.id === id));
        if (selected.some((candidate) => !candidate)) fail('Candidate is unavailable; no inferred or caller-supplied command is accepted.');
        const timeout = options.timeout ?? 600;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) fail('Gate timeout must be 1..3600 seconds.');
        const text = JSON.stringify({ version: 2, gates: selected.map(({ id, command, executor }) => ({ id, command, executor, required: true, timeout_seconds: timeout })) }, null, 2) + '\n';
        const relative = '.loop/gates/' + action.repository_id + '.' + digest(text) + '.json';
        catalog = { relative, text, sha256: digest(text) };
      }
      // Re-read every current input just before persisting owner consent.
      if ((await inspectReadiness(options)).state_sha256 !== report.state_sha256) fail('Inputs changed before approval; no catalog or receipt was committed.');
      if (!options.catalog) await writeWorkspace(root, catalog.relative, catalog.text, { immutable: true });
      receipt.repositories[action.repository_id] = { ...confirmation, fingerprint: data.fingerprint, decision: 'approved',
        catalog: catalog.relative, catalog_sha256: catalog.sha256, source_fingerprint: data.source.fingerprint,
        worktree: data.context.worktree, branch: data.context.project_branch };
    }
  } else fail('Unsupported approval action.');
  await writeWorkspace(root, READINESS_RECEIPT, JSON.stringify(receipt, null, 2) + '\n', { expectedHash: internal.receiptSource.sha256 ?? null });
  return inspectReadiness({ adapter: options.adapter, cwd: options.cwd, requireGlobalEntry: options.requireGlobalEntry, expectedVersion: options.expectedVersion });
}

export async function approveReadiness(options) {
  try { return await applyReadinessApproval(options); }
  catch (error) { fail(readinessErrorMessage(error)); }
}

/** Shared pre-dispatch/verifier guard. No Reviewer verdict or caller hash grants consent. */
export async function validateReadinessAssignment({ projectRoot, assignment, worktree, repository }) {
  const root = path.resolve(projectRoot);
  const source = await readGateSource(path.join(root, READINESS_RECEIPT));
  let installed = false;
  try { await lstat(path.join(root, '.triad-runtime/lib/readiness.mjs')); installed = true; } catch (error) { if (error.code !== 'ENOENT') installed = true; }
  const installation = await readGateSource(path.join(root, '.triad-plus/installation.json'));
  if (installation.status === 'read') {
    let manifest;
    try { manifest = JSON.parse(installation.text); } catch { fail('Installation evidence is malformed; consent cannot be bypassed.'); }
    const records = manifest?.schema_version === 2 ? manifest.adapters : [manifest];
    if (!Array.isArray(records) || records.some((record) => !object(record) || !Array.isArray(record.managed_assets))) fail('Installation evidence is incompatible; consent cannot be bypassed.');
    installed ||= records.some((record) => record.managed_assets.some((asset) => asset.path === '.triad-runtime/lib/readiness.mjs'));
  } else if (installation.status !== 'missing') fail('Installation evidence is unsafe; consent cannot be bypassed.');
  if (source.status === 'missing' && !installed) return; // Legacy standalone verifier contract.
  const receipt = parseReceipt(source);
  const record = receipt.repositories[repository];
  if (record?.decision !== 'approved') fail('Owner gate approval is missing for this repository.');
  const problems = [];
  const project = await readGateSource(path.join(root, 'project.yaml'));
  if (project.status !== 'read') fail('Current project mapping is missing or unsafe.');
  // Prerequisite consent is global: revalidate every mapped repository, even
  // when the assignment executes gates in just one worktree.
  const contexts = await checkDeclaredWorkspaces(root, problems, { strict: true });
  const context = contexts.find((item) => item.id === repository);
  if (problems.length || !context || context.worktreeRoot !== worktree) fail('Current repository/worktree/branch mapping is not approved.');
  const snapshot = await gateSourceSnapshot(worktree);
  if (!snapshot.valid || repositoryFingerprint(context, snapshot) !== record.fingerprint) fail('Gate source, worktree or branch changed since owner consent.');
  if (assignment.gates_path !== record.catalog || assignment.expected_gates_sha256 !== record.catalog_sha256) fail('Assignment must bind the exact per-repository owner-approved catalog and SHA-256.');
  const catalog = await catalogAt(root, record.catalog);
  if (!catalog?.valid || catalog.sha256 !== record.catalog_sha256) fail('Owner-approved catalog bytes changed.');
  const prd = await readGateSource(path.join(root, 'PRD.md'));
  if (prd.status !== 'read' || !prd.text.trim()) fail('Current root PRD is missing, empty or unsafe; prerequisite consent is invalid.');
  const fingerprints = [];
  for (const mapped of contexts) {
    const current = mapped.id === repository ? snapshot : await gateSourceSnapshot(mapped.worktreeRoot);
    if (!current.valid) fail('Current repository sources are unsafe; prerequisite consent is invalid.');
    fingerprints.push(repositoryFingerprint(mapped, current));
  }
  if (receipt.prerequisites?.fingerprint !== prerequisitesFingerprint(prd, fingerprints)) {
    fail('Owner prerequisite consent is missing or stale; inspect readiness and explicitly reconfirm before dispatch.');
  }
}

export function parseReadinessArguments(argv) {
  const options = { nonInteractive: false, json: false };
  const values = { '--adapter': 'adapter', '--host': 'adapter', '--workspace': 'cwd', '--control': 'cwd',
    '--approve': 'approve', '--expected-state': 'expectedState', '--select': 'select', '--catalog': 'catalog',
    '--timeout': 'timeout', '--set-model': 'setModel', '--set-effort': 'setEffort', '--review': 'review' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--onboarding') continue;
    if (arg === '--non-interactive') options.nonInteractive = true;
    else if (arg === '--json') options.json = true;
    else if (Object.hasOwn(values, arg) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      const key = values[arg];
      if (options[key] !== undefined) fail('Duplicate preflight option.');
      options[key] = argv[++i];
    } else fail('Unsupported or incomplete preflight option.');
  }
  if (!options.adapter) fail('Select --host/--adapter explicitly; installation order never selects a host.');
  if (options.timeout !== undefined) {
    if (!/^[1-9][0-9]*$/.test(options.timeout)) fail('Timeout must be a positive integer.');
    options.timeout = Number(options.timeout);
  }
  if ((options.select || options.timeout !== undefined) && !options.approve) fail('Gate selection requires explicit --approve and --expected-state.');
  if ((options.approve || options.setModel !== undefined || options.setEffort !== undefined) && !/^[a-f0-9]{64}$/.test(options.expectedState ?? '')) fail('Approval/correction requires the exact current --expected-state SHA-256.');
  if (options.json) options.nonInteractive = true;
  return options;
}

function render(report, output, { firstOnly = false } = {}) {
  output.write(`${report.ready ? 'READY' : 'BLOCKED'}: workspace preflight; no discovered command, install, provider probe or delegation executed.\n`);
  output.write(`Model binding: ${report.model_binding}; effective identity ${report.effective_model_identity}.\n`);
  if (report.ready) return;
  for (const text of report.advisories) output.write(`  Advisory: ${text}\n`);
  for (const action of firstOnly ? report.actions.slice(0, 1) : report.actions) {
    output.write(`  ${action.severity} ${action.id}: ${action.message}\n`);
    if (action.worktree) output.write(`    Worktree ${JSON.stringify(action.worktree)}; branch ${JSON.stringify(action.branch)}; source ${action.source_fingerprint}.\n`);
    for (const gate of action.commands ?? []) output.write(`    ${gate.id}: ${gate.command}; timeout ${gate.timeout_seconds}s; script sha256=${gate.command_source.script_sha256}\n`);
    for (const prerequisite of action.prerequisites ?? []) output.write(`    Prerequisite: ${prerequisite}\n`);
    if (action.source) output.write(`    ${action.source}\n`);
    if (action.manual_catalog) output.write(`    Manual catalog: ${JSON.stringify(action.manual_catalog)}\n`);
  }
  if (report.state_sha256) output.write(`Current state: ${report.state_sha256}\n`);
}

export async function runReadinessCommand(options, { input = process.stdin, output = process.stdout, question } = {}) {
  let report;
  if (options.approve || options.setModel !== undefined || options.setEffort !== undefined) report = await approveReadiness(options);
  else report = await inspectReadiness(options);
  const interactive = !options.nonInteractive && !options.json && (question || input.isTTY && output.isTTY);
  if (!interactive) {
    if (options.json) output.write(JSON.stringify(report) + '\n'); else render(report, output);
    return report;
  }
  let terminal;
  const aborted = new AbortController();
  if (!question) {
    terminal = createInterface({ input, output });
    terminal.on('SIGINT', () => aborted.abort());
    question = (text) => terminal.question(text, { signal: AbortSignal.any([aborted.signal, AbortSignal.timeout(120_000)]) });
  }
  try {
    // A finite pass; committed confirmations survive cancellation/interruption.
    for (let step = 0; step < 128; step += 1) {
      render(report, output, { firstOnly: true });
      if (report.ready) return report;
      const action = report.actions[0];
      if (!action || action.kind === 'manual' || action.severity === 'fatal') return report;
      let change = null;
      for (let attempt = 0; attempt < 3 && !change; attempt += 1) {
        if (action.kind === 'confirm-models') {
          const answer = (await question('Type defaults to accept host defaults, model ROLE=ID / effort ROLE=VARIANT to correct intent, or blank to stop: ')).trim();
          if (!answer) return report;
          if (answer === 'defaults') change = { approve: 'models' };
          else if (answer.startsWith('model ') || answer.startsWith('effort ')) {
            const isModel = answer.startsWith('model ');
            const field = answer.slice(isModel ? 6 : 7);
            const split = field.indexOf('=');
            if (split > 0 && ROLES.includes(field.slice(0, split)) && !modelInputIssue(isModel ? { id: options.adapter } : null, field.slice(split + 1))) change = isModel ? { setModel: field } : { setEffort: field };
            else output.write('Use a known role and exact ID without spaces (OpenCode: provider/model), or blank after = to clear intent.\n');
          }
        } else if (action.kind === 'confirm-gates') {
          const answer = (await question('Select candidate IDs (comma-separated), catalog PATH, reject, or blank to stop: ')).trim();
          if (!answer) return report;
          change = answer.startsWith('catalog ') ? { approve: action.id, catalog: answer.slice(8) }
            : { approve: action.id, select: answer };
          if (change.catalog) {
            report = await inspectReadiness({ ...options, catalog: change.catalog });
            render(report, output, { firstOnly: true });
            if (!report.actions[0]?.manual_catalog?.sha256) { change = null; continue; }
          } else if (answer !== 'reject' && !answer.split(',').every((id) => action.commands.some((gate) => gate.id === id))) {
            change = null; continue;
          }
          if (await question('Type approve to persist this repository/worktree/source consent; anything else stops: ') !== 'approve') return report;
        } else if (action.kind === 'confirm-prerequisites') {
          if (await question('Type confirm for the stated prerequisites/limits; anything else stops: ') !== 'confirm') return report;
          change = { approve: 'prerequisites' };
        }
        if (!change) output.write('Choose one of the stated actions; no values were changed.\n');
      }
      if (!change) return report;
      try { report = await approveReadiness({ ...options, ...change, expectedState: report.state_sha256 }); }
      catch {
        output.write('BLOCKED: invalid choice or changed inputs; inspect again. Previous confirmations are preserved.\n');
        const current = await inspectReadiness(options);
        return { ...current, ready: false, actions: [finding('approval', 'Approval did not complete; inspect again.', 'fatal'), ...current.actions] };
      }
    }
    output.write('BLOCKED: finite preflight step limit reached; resume explicitly.\n');
    const current = await inspectReadiness(options);
    return { ...current, ready: false, actions: [finding('limit', 'Preflight step limit reached; resume explicitly.'), ...current.actions] };
  } catch {
    output.write('BLOCKED: prompt timed out or was interrupted; prior confirmations are preserved. No commands were executed.\n');
    const current = await inspectReadiness(options);
    return { ...current, ready: false, actions: [finding('interrupted', 'Prompt timed out or was interrupted; resume explicitly.'), ...current.actions] };
  } finally { terminal?.close(); }
}
