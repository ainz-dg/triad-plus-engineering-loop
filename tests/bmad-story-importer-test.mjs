import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BmadStoryImportError,
  importBmadStory,
  parseBmadStory,
  validateTriadCard,
  writeImportedCard
} from '../integrations/bmad/story-importer.mjs';

const repositoryRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const verifierPath = join(repositoryRoot, 'runtime', 'triad-verify.mjs');
const sourceText = `---
id: JFR-BMAD-001
title: Route a provider JsonForm through the JFR boundary
status: ready-for-dev
target_repository: webup
---

# Story JFR-BMAD-001: Route a provider JsonForm through the JFR boundary

## Intent

As a Webup integrator, I want the provider-owned JsonForm document to cross the
JFR boundary without duplication, so that the existing component can render it.

## Acceptance Criteria

**Given** a valid provider document
**When** the JFR route is requested
**Then** Webup resolves the normal component and preserves the document.

## Tasks & Acceptance

- [ ] Add the route declaration.
- [ ] Preserve the provider document at the boundary.

## Code Map

- \`src/components/smeup/jfr/\`
- \`src/registry.ts\`

## Design Notes

Use the existing shape and converter contracts; do not invent a Webup document schema.

## Verification expectations

Run the repository-owned route and provider-integrity gates.

## Source references

- sources/PRD.md §§1–4
- sources/companions/input-contract.md
`;

const digest = (value) => createHash('sha256').update(value).digest('hex');
const exists = (file) => access(file).then(() => true, () => false);

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function assertImportError(action, code) {
  await assert.rejects(action, (error) => error instanceof BmadStoryImportError && error.code === code);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'triad-plus-bmad-import-'));
try {
  const sourcePath = join(temporaryRoot, 'story.md');
  await writeFile(sourcePath, sourceText, 'utf8');
  const originalBytes = await readFile(sourcePath);

  const first = await importBmadStory({
    sourcePath,
    requiredGates: ['cypress-jfr', 'cypress-jfr'],
    dependsOn: ['JFR-BMAD-000'],
    capturedAt: '2026-09-10T10:00:00Z'
  });
  const second = await importBmadStory({
    sourcePath,
    requiredGates: ['cypress-jfr'],
    dependsOn: ['JFR-BMAD-000'],
    capturedAt: '2026-09-10T10:01:00Z'
  });

  assert.equal(first.story.id, 'JFR-BMAD-001');
  assert.equal(first.story.status, 'ready-for-dev');
  assert.equal(first.story.targetRepository, 'webup');
  assert.equal(first.provenance.source_kind, 'bmad-story');
  assert.equal(first.provenance.source_sha256, digest(originalBytes));
  assert.equal(first.provenance.bmad_story_id, 'JFR-BMAD-001');
  assert.deepEqual(first.provenance.required_gate_ids, ['cypress-jfr']);
  assert.deepEqual(first.provenance.depends_on, ['JFR-BMAD-000']);
  assert.equal(first.card, second.card, 'timestamps must not alter generated Card content');
  assert.equal(first.provenance.card_sha256, second.provenance.card_sha256);
  assert.match(first.card, /^# JFR-BMAD-001 — Route a provider JsonForm/m);
  assert.match(first.card, /Required gates \(`required_gates`\): \[cypress-jfr\]/);
  assert.match(first.card, /Dependencies: `JFR-BMAD-000`/);
  assert.match(first.card, /Tasks & Acceptance/);
  assert.match(first.card, /Code Map/);
  assert.match(first.card, /Design Notes/);
  assert.match(first.card, /Verification expectations/);
  assert.match(first.card, /Source references/);
  assert.equal(validateTriadCard(first.card).valid, true);
  assert.deepEqual(await readFile(sourcePath), originalBytes, 'BMAD source must remain unchanged');

  // Prove that the generated Markdown is accepted by the existing verifier
  // contract, not only by the integration-side shape check.
  const coreRoot = join(temporaryRoot, 'core-validation');
  const coreWorktree = join(coreRoot, 'product');
  await mkdir(coreWorktree, { recursive: true });
  await writeFile(join(coreWorktree, 'candidate.txt'), 'candidate\n', 'utf8');
  run('git', ['init', '-q'], coreWorktree);
  run('git', ['config', 'user.email', 'triad-test@example.invalid'], coreWorktree);
  run('git', ['config', 'user.name', 'Triad Test'], coreWorktree);
  run('git', ['add', '.'], coreWorktree);
  run('git', ['commit', '-qm', 'baseline'], coreWorktree);
  const branch = run('git', ['branch', '--show-current'], coreWorktree);
  await mkdir(join(coreRoot, 'artifacts'), { recursive: true });
  await mkdir(join(coreRoot, 'features'), { recursive: true });
  await writeFile(join(coreRoot, 'artifacts', 'prd.md'), '# PRD\n', 'utf8');
  const coreCardPath = join(coreRoot, 'features', 'JFR-BMAD-001.md');
  await writeFile(coreCardPath, first.card, 'utf8');
  const coreGatesPath = join(coreRoot, '.loop', 'quality-gates.yaml');
  await mkdir(join(coreRoot, '.loop'), { recursive: true });
  await writeFile(coreGatesPath, 'version: 2\ngates:\n  - id: imported-card-gate\n    command: true\n    required: true\n    executor: control-plane\n    timeout_seconds: 1\n', 'utf8');
  const assignment = {
    schema_version: 1,
    assignment_id: 'assignment-imported-card',
    status: 'active',
    agent_id: 'developer-imported-card',
    agent_type: 'triad_developer',
    feature_id: 'JFR-BMAD-001',
    attempt: 1,
    project_root: coreRoot,
    worktree: coreWorktree,
    expected_branch: branch,
    allow_external_worktree: true,
    prd_path: 'artifacts/prd.md',
    card_path: 'features/JFR-BMAD-001.md',
    gates_path: '.loop/quality-gates.yaml',
    expected_prd_sha256: digest(await readFile(join(coreRoot, 'artifacts', 'prd.md'))),
    expected_card_sha256: digest(first.card),
    expected_gates_sha256: digest(await readFile(coreGatesPath)),
    verification_run_id: 'run-imported-card',
    required_gate_ids: ['imported-card-gate']
  };
  const assignmentPath = join(coreRoot, '.loop', 'runtime', 'assignments', `${assignment.agent_id}.json`);
  await writeJson(assignmentPath, assignment);
  const verifierRun = spawnSync(process.execPath, [verifierPath, '--project', coreRoot], {
    input: JSON.stringify({ event: 'SubagentStop', agent_id: assignment.agent_id, agent_type: 'triad_developer' }),
    encoding: 'utf8'
  });
  assert.equal(verifierRun.status, 0, verifierRun.stderr);
  const verifierOutput = JSON.parse(verifierRun.stdout);
  const verifierEvidence = JSON.parse(await readFile(verifierOutput.evidence, 'utf8'));
  assert.equal(verifierEvidence.status, 'pass');
  assert.deepEqual(verifierEvidence.gate_selection.card_required_gate_ids, ['imported-card-gate']);

  const standardBmadTemplate = `---
id: JFR-BMAD-002
title: Add a bounded JsonForm route
type: feature
status: ready-for-dev
context: []
---

## Intent

**Problem:** The route is not exposed.
**Approach:** Reuse the existing registry boundary.

## Code Map

- \`src/components/jfr/\`

## Tasks & Acceptance

**Execution:**
- [ ] Add the route.

**Acceptance Criteria:**
- Given a valid document, when requested, then the route renders.

## Verification

Run the repository route gate.
`;
  const standardPath = join(temporaryRoot, 'standard-bmad-story.md');
  await writeFile(standardPath, standardBmadTemplate, 'utf8');
  const standard = await importBmadStory({ sourcePath: standardPath, targetRepository: 'webup' });
  assert.equal(standard.story.title, 'Add a bounded JsonForm route');
  assert.equal(standard.story.targetRepository, 'webup');
  assert.match(standard.card, /Add the route/);
  assert.match(standard.card, /Given a valid document/);

  const outputPath = join(temporaryRoot, 'features', 'JFR-BMAD-001.md');
  const written = await writeImportedCard({
    sourcePath,
    outputPath,
    requiredGates: ['cypress-jfr'],
    dependsOn: ['JFR-BMAD-000'],
    capturedAt: '2026-09-10T10:02:00Z'
  });
  assert.equal(written.outputPath, outputPath);
  assert.equal(await readFile(outputPath, 'utf8'), first.card);
  assert.equal(await exists(written.provenancePath), true);
  const writtenProvenance = JSON.parse(await readFile(written.provenancePath, 'utf8'));
  assert.equal(writtenProvenance.card_path, outputPath);
  assert.equal(writtenProvenance.source_sha256, first.provenance.source_sha256);
  await assertImportError(() => writeImportedCard({ sourcePath, outputPath }), 'bmad_story_unmappable');

  const cliOutput = join(temporaryRoot, 'features', 'JFR-BMAD-CLI.md');
  const cli = spawnSync(process.execPath, [
    'bin/triad-plus.js', 'import-bmad-story', '--source', sourcePath, '--output', cliOutput,
    '--required-gate', 'api-contract', '--depends-on', 'BASE-001'
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Imported BMAD Story JFR-BMAD-001/);
  assert.match(await readFile(cliOutput, 'utf8'), /\[api-contract\]/);

  for (const status of ['draft', 'in-progress', 'done', 'blocked']) {
    const invalidPath = join(temporaryRoot, `${status}.md`);
    await writeFile(invalidPath, sourceText.replace('status: ready-for-dev', `status: ${status}`));
    await assertImportError(() => importBmadStory({ sourcePath: invalidPath }), 'bmad_story_not_ready');
  }
  const missingStatus = join(temporaryRoot, 'missing-status.md');
  await writeFile(missingStatus, sourceText.replace('status: ready-for-dev\n', ''));
  await assertImportError(() => importBmadStory({ sourcePath: missingStatus }), 'bmad_story_not_ready');

  const malformed = join(temporaryRoot, 'malformed.md');
  await writeFile(malformed, '---\nid: JFR-BMAD-002\nstatus: ready-for-dev\n');
  await assertImportError(() => importBmadStory({ sourcePath: malformed }), 'bmad_story_invalid');

  const ambiguous = join(temporaryRoot, 'ambiguous.md');
  await writeFile(ambiguous, sourceText.replace('# Story JFR-BMAD-001:', '# Story JFR-BMAD-002:'));
  await assertImportError(() => importBmadStory({ sourcePath: ambiguous }), 'bmad_story_ambiguous');

  const missingTarget = join(temporaryRoot, 'missing-target.md');
  await writeFile(missingTarget, sourceText.replace('target_repository: webup\n', ''));
  await assertImportError(() => importBmadStory({ sourcePath: missingTarget }), 'bmad_story_unmappable');
  const suppliedTarget = await importBmadStory({ sourcePath: missingTarget, targetRepository: 'webup' });
  assert.equal(suppliedTarget.story.targetRepository, 'webup', 'caller may supply an explicit target repository');
  await assertImportError(() => importBmadStory({ sourcePath, targetRepository: 'ketchup2' }), 'bmad_story_ambiguous');

  const missingAcceptance = join(temporaryRoot, 'missing-acceptance.md');
  await writeFile(missingAcceptance, sourceText.replace(/## Acceptance Criteria[\s\S]*?## Tasks & Acceptance/, '## Tasks & Acceptance'));
  await assertImportError(() => importBmadStory({ sourcePath: missingAcceptance }), 'bmad_story_unmappable');

  await assertImportError(() => importBmadStory({ sourcePath: join(temporaryRoot, 'not-found.md') }), 'bmad_story_not_found');
  assert.throws(() => parseBmadStory(''), (error) => error instanceof BmadStoryImportError && error.code === 'bmad_story_invalid');
  await assertImportError(() => importBmadStory({ sourcePath, requiredGates: 'cypress-jfr' }), 'bmad_story_unmappable');
  await assertImportError(() => importBmadStory({ sourcePath, requiredGates: null }), 'bmad_story_unmappable');

  console.log('BMAD Story importer tests passed: deterministic mapping, provenance, CLI, and fail-closed statuses.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
