import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sharedSkillNames = [
  'triad-loop-bootstrap',
  'triad-loop-orchestrator',
  'triad-loop-developer',
  'triad-loop-evaluator',
  'triad-loop-reviewer'
];

export const roleDefinitions = [
  { id: 'orchestrator', label: 'Orchestrator', defaultEffort: 'medium', core: true },
  { id: 'developer', label: 'Developer', defaultEffort: 'max', core: true },
  { id: 'reviewer', label: 'Reviewer', defaultEffort: 'medium', core: true },
  { id: 'evaluator', label: 'Evaluator+', defaultEffort: 'medium', core: false }
];

const regularRoles = roleDefinitions.filter((role) => role.core);

function hostHome(...parts) {
  return join(homedir(), ...parts);
}

function hermesProfileHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const root = hostHome('.hermes');
  try {
    const profile = readFileSync(join(root, 'active_profile'), 'utf8').trim();
    if (profile) return join(root, 'profiles', profile);
  } catch {}
  return root;
}

function projectRuntimeAssets(id) {
  return [
    { source: 'runtime', destination: '.triad-runtime' },
    { source: 'schemas', destination: '.triad-runtime/schemas' },
    { source: `adapters/${id}/runtime.json`, destination: '.triad-runtime/adapter.json', file: true }
  ];
}

function sharedSkills(destination) {
  return { source: 'shared-skills', destination };
}

function rolePaths(root, names, extension = '.md') {
  return names.map((name) => join(root, 'agents', `${name}${extension}`));
}

const definitions = [
  {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    entry: '/prompts:triad',
    lifecycle: { kind: 'SubagentStop', agentType: 'triad_developer', requiresAsync: true },
    modelBinding: 'global-profiles',
    globalEntry: true,
    projectAssets: [
      sharedSkills('.agents/skills'),
      ...projectRuntimeAssets('codex')
    ],
    globalAssets: [
      { source: 'adapters/codex/prompts/triad.md', destination: ({ codexHome }) => join(codexHome, 'prompts', 'triad.md'), file: true },
      sharedSkills(({ codexHome }) => join(codexHome, 'skills'))
    ],
    projectPaths(controlRoot) {
      return [
        ...sharedSkillNames.map((name) => join(controlRoot, '.agents', 'skills', name)),
        join(controlRoot, '.triad-runtime')
      ];
    },
    globalPaths({ codexHome }) {
      return [join(codexHome, 'prompts', 'triad.md'), ...sharedSkillNames.map((name) => join(codexHome, 'skills', name))];
    },
    roleModelPaths({ codexHome }) {
      return roleDefinitions.map((role) => join(codexHome, 'agents', `triad_${role.id}.toml`));
    }
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    entry: '/triad',
    lifecycle: null,
    modelBinding: 'project-frontmatter',
    modelFields: ['model', 'reasoningEffort'],
    modelRoles: roleDefinitions.map((role) => role.id),
    projectAssets: [
      { source: 'adapters/opencode/.opencode/agents', destination: '.opencode/agents' },
      { source: 'adapters/opencode/.opencode/commands/triad.md', destination: '.opencode/commands/triad.md', file: true },
      sharedSkills('.opencode/skills'),
      ...projectRuntimeAssets('opencode')
    ],
    globalAssets: [
      { source: 'adapters/opencode/.opencode/agents', destination: () => hostHome('.config', 'opencode', 'agents') },
      { source: 'adapters/opencode/.opencode/commands/triad.md', destination: () => hostHome('.config', 'opencode', 'commands', 'triad.md'), file: true },
      sharedSkills(() => hostHome('.config', 'opencode', 'skills'))
    ],
    projectPaths(controlRoot) {
      return [
        ...rolePaths(join(controlRoot, '.opencode'), roleDefinitions.map((role) => `triad-${role.id}`)),
        join(controlRoot, '.opencode', 'commands', 'triad.md'),
        ...sharedSkillNames.map((name) => join(controlRoot, '.opencode', 'skills', name)),
        join(controlRoot, '.triad-runtime')
      ];
    },
    globalPaths() {
      const root = hostHome('.config', 'opencode');
      return [...rolePaths(root, roleDefinitions.map((role) => `triad-${role.id}`)), join(root, 'commands', 'triad.md'), ...sharedSkillNames.map((name) => join(root, 'skills', name))];
    },
    roleModelPaths(controlRoot) {
      return roleDefinitions.map((role) => join(controlRoot, '.opencode', 'agents', `triad-${role.id}.md`));
    }
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    entry: '/triad',
    lifecycle: { kind: 'SubagentStop', agentType: 'triad-developer', requiresAsync: false },
    modelBinding: 'project-frontmatter',
    modelRoles: ['developer', 'reviewer', 'evaluator'],
    projectAssets: [
      { source: 'adapters/claude-code/.claude/agents', destination: '.claude/agents' },
      { source: 'adapters/claude-code/.claude/commands/triad.md', destination: '.claude/commands/triad.md', file: true },
      { source: 'integrations/claude-code/hooks.json', destination: '.claude/triad-hooks.json', file: true },
      sharedSkills('.claude/skills'),
      ...projectRuntimeAssets('claude-code')
    ],
    globalAssets: [
      { source: 'adapters/claude-code/.claude/agents', destination: () => hostHome('.claude', 'agents') },
      { source: 'adapters/claude-code/.claude/commands/triad.md', destination: () => hostHome('.claude', 'commands', 'triad.md'), file: true },
      sharedSkills(() => hostHome('.claude', 'skills'))
    ],
    projectPaths(controlRoot) {
      const root = join(controlRoot, '.claude');
      return [
        join(root, 'agents', 'triad-developer.md'),
        join(root, 'agents', 'triad-reviewer.md'),
        join(root, 'agents', 'triad-evaluator.md'),
        join(root, 'commands', 'triad.md'),
        join(root, 'triad-hooks.json'),
        ...sharedSkillNames.map((name) => join(root, 'skills', name)),
        join(controlRoot, '.triad-runtime')
      ];
    },
    globalPaths() {
      const root = hostHome('.claude');
      return [
        join(root, 'agents', 'triad-developer.md'), join(root, 'agents', 'triad-reviewer.md'), join(root, 'agents', 'triad-evaluator.md'),
        join(root, 'commands', 'triad.md'), ...sharedSkillNames.map((name) => join(root, 'skills', name))
      ];
    },
    roleModelPaths(controlRoot) {
      return ['developer', 'reviewer', 'evaluator'].map((role) => join(controlRoot, '.claude', 'agents', `triad-${role}.md`));
    }
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    binary: 'agy',
    entry: '/triad',
    lifecycle: null,
    modelBinding: 'team-record',
    projectAssets: [
      { source: 'adapters/antigravity/.agents/agents', destination: '.agents/agents' },
      { source: 'adapters/antigravity/.agents/skills/triad', destination: '.agents/skills/triad' },
      sharedSkills('.agents/skills'),
      ...projectRuntimeAssets('antigravity')
    ],
    globalAssets: [
      { source: 'adapters/antigravity/.agents/agents', destination: () => hostHome('.gemini', 'config', 'agents') },
      { source: 'adapters/antigravity/.agents/skills/triad', destination: () => hostHome('.gemini', 'config', 'skills', 'triad') },
      sharedSkills(() => hostHome('.gemini', 'config', 'skills'))
    ],
    projectPaths(controlRoot) {
      const root = join(controlRoot, '.agents');
      return [
        ...roleDefinitions.map((role) => join(root, 'agents', `triad-${role.id}`, 'agent.md')),
        join(root, 'skills', 'triad'), ...sharedSkillNames.map((name) => join(root, 'skills', name)), join(controlRoot, '.triad-runtime')
      ];
    },
    globalPaths() {
      const root = hostHome('.gemini', 'config');
      return [...roleDefinitions.map((role) => join(root, 'agents', `triad-${role.id}`, 'agent.md')), join(root, 'skills', 'triad'), ...sharedSkillNames.map((name) => join(root, 'skills', name))];
    }
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    binary: 'hermes',
    binaryCandidates: ['hermes', join(homedir(), '.local', 'bin', 'hermes')],
    entry: '/triad',
    lifecycle: null,
    modelBinding: 'team-record',
    globalEntry: true,
    projectAssets: [
      ...projectRuntimeAssets('hermes')
    ],
    globalAssets: [
      { source: 'adapters/hermes/skills/triad', destination: () => join(hermesProfileHome(), 'skills', 'triad') },
      sharedSkills(() => join(hermesProfileHome(), 'skills'))
    ],
    projectPaths(controlRoot) {
      return [join(controlRoot, '.triad-runtime')];
    },
    globalPaths() {
      const root = join(hermesProfileHome(), 'skills');
      return [join(root, 'triad'), ...sharedSkillNames.map((name) => join(root, name))];
    }
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    binary: 'copilot',
    entry: '/triad',
    fallbackEntry: '/agent',
    lifecycle: null,
    modelBinding: 'project-frontmatter',
    modelFields: ['model', 'reasoningEffort'],
    modelRoles: roleDefinitions.map((role) => role.id),
    projectAssets: [
      { source: 'adapters/copilot/.github/agents', destination: '.github/agents' },
      { source: 'adapters/copilot/.github/skills/triad', destination: '.github/skills/triad' },
      sharedSkills('.github/skills'),
      ...projectRuntimeAssets('copilot')
    ],
    globalAssets: [
      { source: 'adapters/copilot/.github/agents', destination: () => hostHome('.copilot', 'agents') },
      { source: 'adapters/copilot/.github/skills/triad', destination: () => hostHome('.copilot', 'skills', 'triad') },
      sharedSkills(() => hostHome('.copilot', 'skills'))
    ],
    projectPaths(controlRoot) {
      const root = join(controlRoot, '.github');
      return [
        ...roleDefinitions.map((role) => join(root, 'agents', `triad-${role.id}.agent.md`)),
        join(root, 'skills', 'triad'),
        ...sharedSkillNames.map((name) => join(root, 'skills', name)),
        join(controlRoot, '.triad-runtime')
      ];
    },
    globalPaths() {
      const root = hostHome('.copilot');
      return [
        ...roleDefinitions.map((role) => join(root, 'agents', `triad-${role.id}.agent.md`)),
        join(root, 'skills', 'triad'),
        ...sharedSkillNames.map((name) => join(root, 'skills', name))
      ];
    },
    roleModelPaths(controlRoot) {
      return roleDefinitions.map((role) => join(controlRoot, '.github', 'agents', `triad-${role.id}.agent.md`));
    }
  }
];

export const adapterRegistry = new Map(definitions.map((adapter) => [adapter.id, adapter]));

export function getAdapter(id) {
  return adapterRegistry.get(id) ?? null;
}

export function listAdapters() {
  return definitions;
}
