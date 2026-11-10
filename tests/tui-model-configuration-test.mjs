import assert from 'node:assert/strict';
import { getAdapter } from '../adapters/registry.mjs';
import {
  materializedRoleConfiguration,
  materializedHostRoleConfiguration,
  modelFieldMappings,
  hostModelField,
  mergeTeamModelConfiguration,
  modelBindingSummary,
  modelInputIssue,
  supportsNativeModel,
  supportsNativeReasoning,
  validateRequestedModelPatch,
  validateTeamConfiguration
} from '../runtime/lib/model-config.mjs';
import {
  colorEnabled,
  formatDoctorLine,
  formatModelValue,
  formatSetupSummary,
  paint
} from '../runtime/lib/terminal.mjs';

const nonTty = { isTTY: false };
const tty = { isTTY: true };
const originalTerm = process.env.TERM;
process.env.TERM = 'xterm';

const team = {
  schema_version: 1,
  interaction: {
    language: 'Italian',
    owner_name: 'Ainz',
    communication_style: 'direct'
  },
  roles: {
    orchestrator: { displayName: 'Solution', persona: 'calm', model: null, reasoning_effort: null },
    developer: { displayName: 'Builder', persona: 'focused', model: 'provider/dev', reasoning_effort: 'high' },
    reviewer: { displayName: 'Yuri', persona: 'rigorous', model: 'provider/review', reasoning_effort: 'low' },
    evaluator: { displayName: 'Gauntlet', persona: 'fresh', model: 'provider/eval', reasoning_effort: 'medium', enabled: true }
  }
};

const opencode = getAdapter('opencode');
const claude = getAdapter('claude-code');
const codex = getAdapter('codex');
const antigravity = getAdapter('antigravity');

try {
  assert.equal(colorEnabled(nonTty), false);
  assert.equal(paint('title', 'title', { stream: nonTty }), 'title');

  const previousNoColor = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    assert.equal(colorEnabled(tty), true);
    assert.match(paint('title', 'title', { stream: tty }), /\u001b\[/);
    process.env.NO_COLOR = '1';
    assert.equal(colorEnabled(tty), false);
    assert.doesNotMatch(paint('title', 'title', { stream: tty }), /\u001b\[/);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }

  const summary = formatSetupSummary({ adapter: opencode, control: '/tmp/triad-control', global: true, team, stream: nonTty });
  assert.doesNotMatch(summary, /\u001b\[/, 'non-TTY summary must remain plain text');
  for (const expected of [
    'Host: OpenCode (opencode)',
    'Control workspace: /tmp/triad-control',
    'User-level assets: yes',
    'Interaction: Italian — owner Ainz — direct',
    'Evaluator+: enabled'
  ]) assert.match(summary, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(summary, /Orchestrator\s+Solution — requested model: host default/);
  assert.match(summary, /Developer\s+Builder — requested model: provider\/dev — variant: high/);
  assert.match(summary, /Reviewer\s+Yuri — requested model: provider\/review — variant: low/);
  assert.match(summary, /Evaluator\+\s+Gauntlet — requested model: provider\/eval — variant: medium/);
  assert.match(formatDoctorLine('GitHub Copilot', 'OK', { stream: nonTty }), /^GitHub Copilot\s+OK$/);

  assert.equal(supportsNativeModel(opencode, 'developer'), true);
  assert.equal(supportsNativeReasoning(opencode, 'developer'), true);
  assert.deepEqual(modelFieldMappings(opencode, 'developer'), [
    { field: 'model', source: 'model' },
    { field: 'variant', source: 'reasoning_effort' }
  ]);
  assert.equal(hostModelField(opencode, 'developer', 'reasoning_effort'), 'variant');
  assert.equal(supportsNativeModel(claude, 'orchestrator'), false);
  assert.equal(supportsNativeModel(claude, 'developer'), true);
  assert.equal(supportsNativeReasoning(claude, 'developer'), false);
  assert.equal(supportsNativeModel(codex, 'reviewer'), true);
  assert.equal(supportsNativeReasoning(codex, 'reviewer'), true);
  assert.match(modelBindingSummary(codex, 'reviewer'), /host default; requested model\/effort recorded only/);
  assert.equal(supportsNativeModel(antigravity, 'developer'), false);
  assert.match(modelBindingSummary(antigravity, 'developer'), /recorded in team\.json/);

  assert.deepEqual(materializedRoleConfiguration(opencode, 'developer', team.roles.developer), {
    model: 'provider/dev', reasoning_effort: 'high'
  });
  assert.deepEqual(materializedHostRoleConfiguration(opencode, 'developer', team.roles.developer), {
    model: null, variant: null
  });
  assert.deepEqual(materializedHostRoleConfiguration(opencode, 'orchestrator', team.roles.orchestrator), {
    model: null, variant: null
  });
  assert.deepEqual(materializedHostRoleConfiguration(opencode, 'developer', {
    model: 'provider/dev', reasoning_effort: '   '
  }), { model: null, variant: null });
  assert.deepEqual(materializedRoleConfiguration(claude, 'developer', team.roles.developer), {
    model: 'provider/dev'
  });
  assert.deepEqual(materializedRoleConfiguration(antigravity, 'developer', team.roles.developer), {});

  for (const host of ['opencode', 'claude-code', 'codex', 'copilot', 'antigravity', 'hermes']) {
    const adapter = getAdapter(host);
    for (const model of ['gpt 6 luna medium', 'unknown/provider-model', '\u001b[31msecret']) {
      const intent = structuredClone(team);
      intent.roles.developer.model = model;
      assert.equal(validateTeamConfiguration(intent), intent, 'legacy intent must remain recoverable');
      assert.ok(Object.values(materializedHostRoleConfiguration(adapter, 'developer', intent.roles.developer)).every((value) => value === null));
      assert.equal(intent.roles.developer.model, model, 'native defaults must not replace canonical intent');
    }
    assert.match(modelInputIssue(adapter, 'gpt 6 luna medium'), /exact model ID/);
    assert.match(modelInputIssue(adapter, '\u001b[31mmodel'), /control characters/);
    assert.equal(modelInputIssue(adapter, ''), null);
    assert.equal(modelInputIssue(adapter, 'provider/model-name'), null, 'syntax is not a catalog attestation');
  }
  assert.match(modelInputIssue(opencode, 'gpt-6'), /provider\/model/);
  assert.equal(modelInputIssue(opencode, 'provider/model#variant'), null);
  assert.equal(modelInputIssue(opencode, 'openrouter/anthropic/model-name'), null);
  assert.equal(modelInputIssue(opencode, 'vertex/model@001'), null);
  assert.equal(formatModelValue('secret=never-show-this\u001b[31m'), 'invalid request (inspect team.json locally)');
  const invalidSummary = structuredClone(team);
  invalidSummary.roles.developer.model = 'secret=never-show-this\u001b[31m';
  assert.doesNotMatch(formatSetupSummary({ adapter: opencode, control: '/tmp/control', team: invalidSummary, stream: nonTty }), /never-show-this|\u001b/);

  validateTeamConfiguration(team);
  assert.throws(() => validateTeamConfiguration({ ...team, roles: { ...team.roles, developer: { ...team.roles.developer, model: 42 } } }), /developer\.model must be a string or null/);
  assert.throws(() => validateRequestedModelPatch(opencode, 'developer', { temperature: 0.2 }), /Unsupported model configuration field/);
  assert.throws(() => validateRequestedModelPatch(claude, 'developer', { reasoning_effort: 'high' }), /Reasoning effort is not natively supported/);
  assert.throws(() => validateRequestedModelPatch(opencode, 'developer', { model: 42 }), /developer\.model must be a string or null/);

  const updated = mergeTeamModelConfiguration(team, 'developer', { model: 'provider/new-dev' });
  assert.equal(updated.roles.developer.model, 'provider/new-dev');
  assert.equal(updated.roles.developer.reasoning_effort, 'high');
  assert.equal(updated.roles.developer.persona, team.roles.developer.persona);
  assert.equal(updated.roles.reviewer.model, team.roles.reviewer.model);
  assert.equal(team.roles.developer.model, 'provider/dev', 'merge must not mutate source');

  process.stdout.write('Triad+ TUI and model configuration tests passed.\n');
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
} finally {
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
}
