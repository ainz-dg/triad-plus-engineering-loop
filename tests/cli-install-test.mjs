import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = await mkdtemp(join(tmpdir(), 'triad-plus-cli-'));
const codexHome = join(fixtureRoot, 'codex-home');
const userFacingIdentityInvariant = "Before the first owner-facing reply, read `.triad-plus/team.json` when it exists.\nUser-facing identity is permanent: adopt its non-empty\n`roles.orchestrator.displayName` as the sole user-facing identity for every\nowner-facing reply, including the first. If the file is absent or has no\nnon-empty display name, use `Triad Orchestrator`; never present a hidden\nintermediary or another Triad role to the owner. You may report delegated roles'\noutputs, but never claim their identity.";
const configuredRoleBindings = {
  orchestrator: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
  developer: { model: 'gpt-5.6-luna', reasoning_effort: 'max' },
  reviewer: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
  evaluator: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' }
};

async function assertOpenCodeBindings(controlRoot, expectedBindings) {
  for (const [role, expected] of Object.entries(expectedBindings)) {
    const source = await readFile(join(controlRoot, '.opencode', 'agents', `triad-${role}.md`), 'utf8');
    const modelLines = source.split('\n').filter((line) => line.startsWith('model:'));
    const reasoningLines = source.split('\n').filter((line) => line.startsWith('reasoningEffort:'));
    assert.deepEqual(modelLines, expected.model ? [`model: ${JSON.stringify(expected.model)}`] : []);
    assert.deepEqual(reasoningLines, expected.reasoning_effort
      ? [`reasoningEffort: ${JSON.stringify(expected.reasoning_effort)}`]
      : []);
  }
}

async function assertClaudeBindings(controlRoot, expectedBindings) {
  for (const role of ['developer', 'reviewer', 'evaluator']) {
    const source = await readFile(join(controlRoot, '.claude', 'agents', `triad-${role}.md`), 'utf8');
    const modelLines = source.split('\n').filter((line) => line.startsWith('model:'));
    assert.deepEqual(modelLines, expectedBindings[role].model
      ? [`model: ${JSON.stringify(expectedBindings[role].model)}`]
      : []);
    assert.equal(source.split('\n').filter((line) => line.startsWith('reasoningEffort:')).length, 0);
  }
}

async function assertCopilotBindings(controlRoot, expectedBindings) {
  for (const [role, expected] of Object.entries(expectedBindings)) {
    const source = await readFile(join(controlRoot, '.github', 'agents', `triad-${role}.agent.md`), 'utf8');
    const modelLines = source.split('\n').filter((line) => line.startsWith('model:'));
    const reasoningLines = source.split('\n').filter((line) => line.startsWith('reasoningEffort:'));
    assert.deepEqual(modelLines, expected.model ? [`model: ${JSON.stringify(expected.model)}`] : []);
    assert.deepEqual(reasoningLines, expected.reasoning_effort
      ? [`reasoningEffort: ${JSON.stringify(expected.reasoning_effort)}`]
      : []);
  }
}

async function assertCopilotAgentFrontmatter(controlRoot) {
  const orchestrator = await readFile(join(controlRoot, '.github', 'agents', 'triad-orchestrator.agent.md'), 'utf8');
  assert.match(orchestrator, /^user-invocable: true$/m);
  assert.match(orchestrator, /^disable-model-invocation: true$/m);
  assert.match(orchestrator, /^agents: \["triad-developer", "triad-reviewer", "triad-evaluator"\]$/m);
  assert.doesNotMatch(orchestrator, /^infer:/m);

  for (const role of ['developer', 'reviewer', 'evaluator']) {
    const source = await readFile(join(controlRoot, '.github', 'agents', `triad-${role}.agent.md`), 'utf8');
    assert.match(source, /^user-invocable: false$/m);
    assert.match(source, /^disable-model-invocation: false$/m);
    assert.doesNotMatch(source, /^infer:/m);
  }
}

try {
  for (const host of ['codex', 'opencode', 'claude-code', 'antigravity', 'hermes', 'copilot']) {
    const controlRoot = join(fixtureRoot, host, 'control');
    const cliArgs = ['bin/triad-plus.js', 'init', '--host', host, '--control', controlRoot];
    if (host === 'codex') cliArgs.push('--global');
    const first = spawnSync(process.execPath, cliArgs, {
      cwd: repositoryRoot,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8'
    });
    assert.equal(first.status, 0, first.stderr);
    const doctor = spawnSync(process.execPath, [
      'bin/triad-plus.js', 'doctor', '--host', host, '--control', controlRoot
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(doctor.status, 0, doctor.stderr);
  }
  const controlRoot = join(fixtureRoot, 'codex', 'control');
  const second = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'codex', '--control', controlRoot, '--global'
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8'
  });
  assert.equal(second.status, 2, second.stderr);
  assert.match(second.stderr, /would be overwritten/);
  const nonInteractiveWizard = spawnSync(process.execPath, ['bin/triad-plus.js'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  assert.equal(nonInteractiveWizard.status, 2, nonInteractiveWizard.stderr);
  assert.match(nonInteractiveWizard.stderr, /interactive wizard needs a terminal/);

  const teamConfigSource = join(fixtureRoot, 'team.json');
  await writeFile(teamConfigSource, `${JSON.stringify({
    schema_version: 1,
    interaction: {
      language: 'Italian',
      owner_name: 'Martina',
      communication_style: 'direct'
    },
    roles: {
      orchestrator: { displayName: 'Ada', persona: 'calm and exact', model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
      developer: { displayName: 'Lin', persona: 'precise and focused', model: 'gpt-5.6-luna', reasoning_effort: 'max' },
      evaluator: { displayName: 'Iris', persona: 'adversarial and evidence-led', model: 'gpt-5.6-terra', reasoning_effort: 'medium', enabled: false },
      reviewer: { displayName: 'Noah', persona: 'independent and rigorous', model: 'gpt-5.6-terra', reasoning_effort: 'medium' }
    }
  }, null, 2)}\n`);
  const configuredControl = join(fixtureRoot, 'configured-codex-control');
  const configuredCodexHome = join(fixtureRoot, 'configured-codex-home');
  const configured = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'codex', '--control', configuredControl,
    '--global', '--team-config', teamConfigSource
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, CODEX_HOME: configuredCodexHome },
    encoding: 'utf8'
  });
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(await readFile(join(configuredControl, '.triad-plus', 'team.json'), 'utf8'), /"Italian"/);
  assert.match(await readFile(join(configuredControl, '.triad-plus', 'team.json'), 'utf8'), /"enabled": false/);
  assert.ok((await readFile(join(configuredCodexHome, 'prompts', 'triad.md'), 'utf8')).includes(userFacingIdentityInvariant));
  assert.match(await readFile(join(configuredCodexHome, 'prompts', 'triad.md'), 'utf8'), /first owner-facing message/i);
  assert.match(await readFile(join(configuredCodexHome, 'prompts', 'triad.md'), 'utf8'), /--hook-config \.codex\/hooks\.json/);
  const developerProfile = await readFile(join(configuredCodexHome, 'agents', 'triad_developer.toml'), 'utf8');
  assert.match(developerProfile, /gpt-5\.6-luna/);
  assert.match(developerProfile, /precise and focused/);
  assert.match(developerProfile, /identify yourself as Lin, the Triad\+ Developer/);
  const instructionPath = join(configuredControl, 'AGENTS.md');
  assert.match(await readFile(instructionPath, 'utf8'), /Orchestrator is `Ada` for this run/);
  await writeFile(instructionPath, `${await readFile(instructionPath, 'utf8')}\n## Owner note\nKeep this note.\n`);
  await mkdir(join(configuredControl, '.loop'), { recursive: true });
  const legacyRunState = join(configuredControl, '.loop', 'run-state.yaml');
  await writeFile(legacyRunState, 'version: 2\nupdated_at: null\nproject_decision: not_started\n');
  const stalePrompt = join(configuredCodexHome, 'prompts', 'triad.md');
  await writeFile(stalePrompt, 'stale prompt\n');
  const plannedUpgrade = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'upgrade', '--host', 'codex', '--control', configuredControl, '--global'
  ], { cwd: repositoryRoot, env: { ...process.env, CODEX_HOME: configuredCodexHome }, encoding: 'utf8' });
  assert.equal(plannedUpgrade.status, 0, plannedUpgrade.stderr);
  assert.match(plannedUpgrade.stdout, /Dry run only/);
  assert.match(plannedUpgrade.stdout, /Would initialize delivery state/);
  assert.doesNotMatch(await readFile(legacyRunState, 'utf8'), /^delivery:/m);
  assert.equal(await readFile(stalePrompt, 'utf8'), 'stale prompt\n');
  const appliedUpgrade = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'upgrade', '--host', 'codex', '--control', configuredControl, '--global', '--apply'
  ], { cwd: repositoryRoot, env: { ...process.env, CODEX_HOME: configuredCodexHome }, encoding: 'utf8' });
  assert.equal(appliedUpgrade.status, 0, appliedUpgrade.stderr);
  assert.ok((await readFile(stalePrompt, 'utf8')).includes(userFacingIdentityInvariant));
  assert.match(await readFile(stalePrompt, 'utf8'), /first owner-facing message/i);
  assert.match(await readFile(instructionPath, 'utf8'), /Keep this note/);
  assert.match(await readFile(instructionPath, 'utf8'), /triad-plus:managed-instructions:start/);
  assert.match(await readFile(legacyRunState, 'utf8'), /^delivery:\n  status: not_delivered/m);
  assert.equal(await readFile(join(configuredControl, '.triad-plus', 'team.json'), 'utf8'), await readFile(teamConfigSource, 'utf8'));
  assert.ok((await stat(join(configuredControl, '.triad-plus', 'backups'))).isDirectory());
  const shippedCodexHooks = JSON.parse(await readFile(join(repositoryRoot, 'integrations', 'codex', 'hooks.json'), 'utf8'));
  assert.equal(typeof shippedCodexHooks.description, 'string');
  assert.equal('minimum_codex_cli_version' in shippedCodexHooks, false);
  assert.equal('purpose' in shippedCodexHooks, false);
  for (const host of ['opencode', 'claude-code']) {
    const control = join(fixtureRoot, `${host}-configured-control`);
    const result = spawnSync(process.execPath, [
      'bin/triad-plus.js', 'init', '--host', host, '--control', control,
      '--team-config', teamConfigSource
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const hostDirectory = host === 'opencode' ? '.opencode' : '.claude';
    assert.match(
      await readFile(join(control, hostDirectory, 'agents', 'triad-developer.md'), 'utf8'),
      /model: "gpt-5\.6-luna"/
    );
    if (host === 'opencode') await assertOpenCodeBindings(control, configuredRoleBindings);
    assert.ok((await readFile(join(control, hostDirectory, 'commands', 'triad.md'), 'utf8')).includes(userFacingIdentityInvariant));
  }

  const opencodeConfiguredControl = join(fixtureRoot, 'opencode-configured-control');
  const opencodeTeamPath = join(opencodeConfiguredControl, '.triad-plus', 'team.json');
  const teamBeforeOpenCodeUpgrade = await readFile(opencodeTeamPath, 'utf8');
  for (const role of Object.keys(configuredRoleBindings)) {
    const agentPath = join(opencodeConfiguredControl, '.opencode', 'agents', `triad-${role}.md`);
    const staleAgent = (await readFile(agentPath, 'utf8'))
      .replace(/^model:.*$/m, 'model: "stale/provider-model"')
      .replace(/^reasoningEffort:.*$/m, 'reasoningEffort: "low"');
    await writeFile(agentPath, staleAgent, 'utf8');
  }
  const opencodeUpgrade = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'upgrade', '--host', 'opencode', '--control', opencodeConfiguredControl, '--apply'
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(opencodeUpgrade.status, 0, opencodeUpgrade.stderr);
  assert.equal(await readFile(opencodeTeamPath, 'utf8'), teamBeforeOpenCodeUpgrade);
  await assertOpenCodeBindings(opencodeConfiguredControl, configuredRoleBindings);

  const claudeConfiguredControl = join(fixtureRoot, 'claude-code-configured-control');
  const claudeTeamPath = join(claudeConfiguredControl, '.triad-plus', 'team.json');
  const teamBeforeClaudeUpgrade = await readFile(claudeTeamPath, 'utf8');
  for (const role of ['developer', 'reviewer', 'evaluator']) {
    const agentPath = join(claudeConfiguredControl, '.claude', 'agents', `triad-${role}.md`);
    const staleAgent = (await readFile(agentPath, 'utf8'))
      .replace(/^model:.*$/m, 'model: "stale/provider-model"');
    await writeFile(agentPath, staleAgent, 'utf8');
  }
  const claudeUpgrade = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'upgrade', '--host', 'claude-code', '--control', claudeConfiguredControl, '--apply'
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(claudeUpgrade.status, 0, claudeUpgrade.stderr);
  assert.equal(await readFile(claudeTeamPath, 'utf8'), teamBeforeClaudeUpgrade);
  await assertClaudeBindings(claudeConfiguredControl, configuredRoleBindings);

  const nullTeamConfigSource = join(fixtureRoot, 'opencode-null-team.json');
  const nullTeam = JSON.parse(await readFile(teamConfigSource, 'utf8'));
  for (const role of Object.keys(nullTeam.roles)) {
    nullTeam.roles[role].model = null;
    nullTeam.roles[role].reasoning_effort = null;
  }
  await writeFile(nullTeamConfigSource, `${JSON.stringify(nullTeam, null, 2)}\n`);
  const nullOpenCodeControl = join(fixtureRoot, 'opencode-null-control');
  const nullOpenCode = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'opencode', '--control', nullOpenCodeControl,
    '--team-config', nullTeamConfigSource
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(nullOpenCode.status, 0, nullOpenCode.stderr);
  await assertOpenCodeBindings(nullOpenCodeControl, {
    orchestrator: { model: null, reasoning_effort: null },
    developer: { model: null, reasoning_effort: null },
    reviewer: { model: null, reasoning_effort: null },
    evaluator: { model: null, reasoning_effort: null }
  });
  const antigravityControl = join(fixtureRoot, 'antigravity-configured-control');
  const antigravity = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'antigravity', '--control', antigravityControl,
    '--team-config', teamConfigSource
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(antigravity.status, 0, antigravity.stderr);
  assert.match(
    await readFile(join(antigravityControl, '.agents', 'agents', 'triad-developer', 'agent.md'), 'utf8'),
    /Load `triad-loop-developer`/
  );
  assert.match(
    await readFile(join(antigravityControl, '.agents', 'skills', 'triad', 'SKILL.md'), 'utf8'),
    /Triad\+ workflow/
  );
  assert.ok((await readFile(join(antigravityControl, '.agents', 'skills', 'triad', 'SKILL.md'), 'utf8')).includes(userFacingIdentityInvariant));
  const antigravityHome = join(fixtureRoot, 'antigravity-home');
  const antigravityGlobalControl = join(fixtureRoot, 'antigravity-global-control');
  const globalAntigravity = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'antigravity', '--control', antigravityGlobalControl, '--global'
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, HOME: antigravityHome },
    encoding: 'utf8'
  });
  assert.equal(globalAntigravity.status, 0, globalAntigravity.stderr);
  await readFile(join(antigravityHome, '.gemini', 'config', 'agents', 'triad-reviewer', 'agent.md'), 'utf8');
  await readFile(join(antigravityHome, '.gemini', 'config', 'skills', 'triad', 'SKILL.md'), 'utf8');
  const hermesControl = join(fixtureRoot, 'hermes-configured-control');
  const hermes = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'hermes', '--control', hermesControl, '--global', '--team-config', teamConfigSource
  ], { cwd: repositoryRoot, env: { ...process.env, HERMES_HOME: join(fixtureRoot, 'hermes-home') }, encoding: 'utf8' });
  assert.equal(hermes.status, 0, hermes.stderr);
  await readFile(join(hermesControl, '.triad-runtime', 'adapter.json'), 'utf8');
  // Native BMAD intake is shipped as an integration runtime asset, not only
  // as a source-tree module.  Verify an installed control workspace can load
  // the parser through the same path used by the runtime CLI.
  await readFile(join(hermesControl, '.triad-runtime', 'integrations', 'bmad', 'epics-parser.mjs'), 'utf8');
  await readFile(join(hermesControl, '.triad-runtime', 'integrations', 'bmad', 'story-importer.mjs'), 'utf8');
  await readFile(join(hermesControl, '.triad-runtime', 'triad-bmad-intake.mjs'), 'utf8');
  const installedEpics = join(fixtureRoot, 'installed-epics.md');
  await writeFile(installedEpics, '# Epic Breakdown\n\n### Epic E1: Installed intake\n\n### Story S1: Parse installed artifact\n\n**Intent / outcome:** The installed runtime parses native BMAD planning.\n\n**Acceptance Criteria:**\n**Given** a native epics.md file\n**When** the installed intake runs\n**Then** it returns a canonical Story.\n');
  const installedIntake = spawnSync(process.execPath, [
    join(hermesControl, '.triad-runtime', 'triad-bmad-intake.mjs'), '--source', installedEpics
  ], { cwd: hermesControl, encoding: 'utf8' });
  assert.equal(installedIntake.status, 0, installedIntake.stderr);
  assert.match(installedIntake.stdout, /"story_id":"S1"/);
  assert.ok((await readFile(join(fixtureRoot, 'hermes-home', 'skills', 'triad', 'SKILL.md'), 'utf8')).includes(userFacingIdentityInvariant));
  const copilotControl = join(fixtureRoot, 'copilot-configured-control');
  const copilot = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'copilot', '--control', copilotControl, '--team-config', teamConfigSource
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(copilot.status, 0, copilot.stderr);
  await assertCopilotAgentFrontmatter(copilotControl);
  const copilotDeveloper = await readFile(join(copilotControl, '.github', 'agents', 'triad-developer.agent.md'), 'utf8');
  assert.match(copilotDeveloper, /model: "gpt-5\.6-luna"/);
  assert.match(copilotDeveloper, /reasoningEffort: "max"/);
  assert.match(await readFile(join(copilotControl, '.github', 'skills', 'triad', 'SKILL.md'), 'utf8'), /explicitly run[\s\S]*triad-verify/);
  const copilotDoctor = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'doctor', '--host', 'copilot', '--control', copilotControl
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(copilotDoctor.status, 0, copilotDoctor.stderr);
  assert.match(copilotDoctor.stdout, /GitHub Copilot\s+OK/);
  const copilotTeamPath = join(copilotControl, '.triad-plus', 'team.json');
  const teamBeforeCopilotUpgrade = await readFile(copilotTeamPath, 'utf8');
  for (const role of Object.keys(configuredRoleBindings)) {
    const agentPath = join(copilotControl, '.github', 'agents', `triad-${role}.agent.md`);
    const staleAgent = (await readFile(agentPath, 'utf8'))
      .replace(/^model:.*$/m, 'model: "stale/provider-model"')
      .replace(/^reasoningEffort:.*$/m, 'reasoningEffort: "low"');
    await writeFile(agentPath, staleAgent, 'utf8');
  }
  const copilotUpgrade = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'upgrade', '--host', 'copilot', '--control', copilotControl, '--apply'
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(copilotUpgrade.status, 0, copilotUpgrade.stderr);
  assert.equal(await readFile(copilotTeamPath, 'utf8'), teamBeforeCopilotUpgrade);
  await assertCopilotBindings(copilotControl, configuredRoleBindings);
  const copilotHome = join(fixtureRoot, 'copilot-home');
  const copilotGlobalControl = join(fixtureRoot, 'copilot-global-control');
  const globalCopilot = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'copilot', '--control', copilotGlobalControl, '--global'
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, HOME: copilotHome },
    encoding: 'utf8'
  });
  assert.equal(globalCopilot.status, 0, globalCopilot.stderr);
  await readFile(join(copilotHome, '.copilot', 'agents', 'triad-orchestrator.agent.md'), 'utf8');
  await readFile(join(copilotHome, '.copilot', 'skills', 'triad', 'SKILL.md'), 'utf8');
  const evaluatorEnabledSource = join(fixtureRoot, 'team-evaluator-enabled.json');
  const evaluatorEnabled = JSON.parse(await readFile(teamConfigSource, 'utf8'));
  evaluatorEnabled.roles.evaluator.enabled = true;
  await writeFile(evaluatorEnabledSource, `${JSON.stringify(evaluatorEnabled, null, 2)}\n`);
  const evaluatorEnabledControl = join(fixtureRoot, 'evaluator-enabled-control');
  const enabledInstall = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'init', '--host', 'hermes', '--control', evaluatorEnabledControl, '--team-config', evaluatorEnabledSource
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(enabledInstall.status, 0, enabledInstall.stderr);
  const enabledDoctor = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'doctor', '--host', 'hermes', '--control', evaluatorEnabledControl
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(enabledDoctor.status, 0, enabledDoctor.stderr);
  assert.match(enabledDoctor.stdout, /Evaluator\+\s+configured/);
  process.stdout.write('Triad+ CLI install test passed.\n');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
