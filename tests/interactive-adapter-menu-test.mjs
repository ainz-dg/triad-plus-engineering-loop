import assert from 'node:assert/strict';
import { interactiveAdapterManagement } from '../runtime/lib/interactive-adapter-menu.mjs';

const adapters = [
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'GitHub Copilot' },
];

function scriptedPrompt(answers) {
  const questions = [];
  return {
    questions,
    async question(message) {
      questions.push(message);
      return answers.shift() ?? '';
    },
  };
}

function capture() {
  let output = '';
  return { write: (value) => { output += value; }, text: () => output };
}

{
  const prompt = scriptedPrompt(['2', '1', 'apply', '1', '3', '4', '2', 'apply', '5', '2', 'apply', '6']);
  const calls = [];
  const installed = new Set(['codex']);
  const membershipSnapshots = [];
  const output = capture();
  await interactiveAdapterManagement({
    prompt,
    control: '/fixture/control',
    adapters,
    getInstalledAdapterIds: async () => {
      const snapshot = [...installed];
      membershipSnapshots.push(snapshot);
      return snapshot;
    },
    runCommand: async (options) => {
      calls.push(options);
      if (options.adapterCommand === 'list') output.write('Attempt-bound host dispatch remains unsupported.\n');
      if (options.adapterCommand === 'add' && options.apply) installed.add(options.host);
      if (options.adapterCommand === 'remove' && options.apply) installed.delete(options.host);
    },
    write: output.write,
  });

  assert.deepEqual(calls.map(({ adapterCommand, host, apply }) => [adapterCommand, host ?? null, apply ?? false]), [
    ['list', null, false],
    ['add', 'copilot', false],
    ['add', 'copilot', true],
    ['list', null, false],
    ['list', null, false],
    ['doctor', null, false],
    ['list', null, false],
    ['upgrade', 'copilot', false],
    ['upgrade', 'copilot', true],
    ['list', null, false],
    ['remove', 'copilot', false],
    ['remove', 'copilot', true],
    ['list', null, false],
  ]);
  assert.ok(prompt.questions.some((question) => question.includes('Type apply')));
  assert.match(output.text(), /Attempt-bound host dispatch remains unsupported/);
  assert.match(output.text(), /Leaving the Control Workspace unchanged/);
  assert.deepEqual(membershipSnapshots[0], ['codex']);
  assert.deepEqual(membershipSnapshots[1], ['codex', 'copilot'], 'menu refresh shows the newly added adapter');
  assert.deepEqual(membershipSnapshots.at(-1), ['codex'], 'menu refresh shows the removed adapter');
  assert.deepEqual([...installed], ['codex']);
}

{
  const prompt = scriptedPrompt(['2', '1', ' apply ', '6']);
  const calls = [];
  const output = capture();
  await interactiveAdapterManagement({
    prompt,
    control: '/fixture/control',
    adapters,
    getInstalledAdapterIds: async () => [],
    runCommand: async (options) => calls.push(options),
    write: output.write,
  });
  assert.ok(calls.some((options) => options.adapterCommand === 'add' && options.apply === false));
  assert.ok(!calls.some((options) => options.apply === true), 'confirmation must be the exact lowercase word apply');
  assert.match(output.text(), /Cancelled\. No files were changed\./);
}

{
  const prompt = scriptedPrompt(['2', '1', '6']);
  const output = capture();
  const calls = [];
  await interactiveAdapterManagement({
    prompt,
    control: '/fixture/control',
    adapters,
    getInstalledAdapterIds: async () => [],
    runCommand: async (options) => {
      calls.push(options);
      if (options.adapterCommand === 'add') throw new Error('asset collision');
    },
    write: output.write,
  });
  assert.equal(calls.filter((options) => options.adapterCommand === 'add').length, 1);
  assert.ok(!calls.some((options) => options.apply === true));
  assert.match(output.text(), /Preflight failed; nothing was changed: asset collision/);
}

{
  const prompt = scriptedPrompt(['4', '6']);
  const output = capture();
  const calls = [];
  await interactiveAdapterManagement({
    prompt,
    control: '/fixture/control',
    adapters,
    getInstalledAdapterIds: async () => [],
    runCommand: async (options) => calls.push(options),
    write: output.write,
  });
  assert.equal(prompt.questions.filter((question) => question.startsWith('Choose adapter')).length, 0);
  assert.match(output.text(), /No installed adapters are available/);
  assert.ok(!calls.some((options) => ['upgrade', 'remove'].includes(options.adapterCommand)));
}

process.stdout.write('interactive adapter menu: PASS\n');
