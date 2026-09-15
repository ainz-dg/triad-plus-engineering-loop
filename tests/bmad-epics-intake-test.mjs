import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BmadStoryImportError,
  validateTriadCard
} from '../integrations/bmad/story-importer.mjs';
import {
  detectBmadPlanningArtifact,
  ingestBmadEpics,
  parseBmadEpics,
  parseProjectRepositories,
  writeImportedEpics
} from '../integrations/bmad/epics-parser.mjs';

const repositoryRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const intakeCli = join(repositoryRoot, 'runtime', 'triad-bmad-intake.mjs');
const digest = (value) => createHash('sha256').update(value).digest('hex');

const sourceText = `---
stepsCompleted:
  - step-04-final-validation
---

# jsonform - Epic Breakdown

## Epic List

### Epic 1: Provider boundary

The first bounded product slice.

### Story 1.1: Route the provider document

**Intent / outcome:** Establish the provider boundary without duplicating the document.

**Technical context / code map:** Reuse the existing registry and converter paths.

**Acceptance Criteria:**

**Given** a valid provider document
**When** JFR is requested
**Then** the existing component receives the document unchanged.

**Verification expectations:** Run the repository route gate.

**Source references:** PRD §1; Quality Bar QB-001.

### Story 1.2: Render native values

**Intent / outcome:** Render and edit the declared native values.

**Dependencies / order:** Requires Story 1.1; ordering is not an inferred dependency.

**Acceptance Criteria:**

**Given** a valid schema and native data
**When** the component renders
**Then** values retain their JSON types.

**Technical context / code map:** Use the provider Cell boundary.

### Epic 2: Verification evidence

The second bounded product slice.

### Story 2.1: Prove the route deterministically

**Intent / outcome:** Record deterministic evidence for the integrated route.

**Acceptance Criteria:**

**Given** a local fixture
**When** the focused gate runs
**Then** routing and response behavior are observable.

**Source references:** Quality Bar QB-010.
`;

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

async function expectError(action, code) {
  await assert.rejects(action, (failure) => failure instanceof BmadStoryImportError && failure.code === code);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'triad-plus-bmad-epics-'));
try {
  const sourcePath = join(temporaryRoot, 'epics.md');
  await writeFile(sourcePath, sourceText, 'utf8');
  const original = await readFile(sourcePath);
  const sourceSha = digest(original);
  const control = join(temporaryRoot, 'control');
  await mkdir(join(control, '.loop'), { recursive: true });
  await mkdir(join(control, 'artifacts'), { recursive: true });
  await writeFile(join(control, 'artifacts', 'prd.md'), '# Test PRD\n', 'utf8');
  await writeFile(join(control, '.loop', 'quality-gates.yaml'), [
    'version: 2',
    'gates:',
    '  - id: test',
    '    command: true',
    '    required: true',
    '    executor: control-plane',
    '    timeout_seconds: 1',
    ''
  ].join('\n'));
  const webup = join(control, 'webup');
  const ketchup2 = join(control, 'ketchup2');
  await mkdir(webup, { recursive: true });
  await mkdir(ketchup2, { recursive: true });
  const projectConfig = {
    repositories: [
      { id: 'webup', path: 'webup', worktree: 'webup' },
      { id: 'ketchup2', path: 'ketchup2', worktree: 'ketchup2' }
    ]
  };
  await writeFile(join(control, 'project.yaml'), [
    'version: 2',
    'repositories:',
    '  - id: webup',
    '    path: webup',
    '    worktree: webup',
    '  - id: ketchup2',
    '    path: ketchup2',
    '    worktree: ketchup2',
    ''
  ].join('\n'), 'utf8');

  const parsed = parseBmadEpics(sourceText, { sourcePath });
  assert.deepEqual(parsed.epics.map((epic) => epic.id), ['1', '2']);
  assert.deepEqual(parsed.stories.map((story) => story.id), ['1.1', '1.2', '2.1']);
  assert.deepEqual(parsed.stories.map((story) => story.epicId), ['1', '1', '2']);
  assert.equal(parsed.stories[0].status, null, 'native epics.md does not need artificial ready-for-dev metadata');
  assert.equal(parsed.stories.every((story) => story.ingestionReady), true);
  assert.match(parsed.stories[0].acceptanceCriteria, /Given/);
  assert.match(parsed.stories[0].outcome, /provider boundary/);

  const detectedFile = await detectBmadPlanningArtifact(sourcePath);
  assert.deepEqual(detectedFile, { kind: 'bmad-epics', sourcePath });
  const detectedDir = await detectBmadPlanningArtifact(temporaryRoot);
  assert.deepEqual(detectedDir, { kind: 'bmad-epics', sourcePath });
  const nonBmad = join(temporaryRoot, 'prd.md');
  await writeFile(nonBmad, '# Product PRD\n', 'utf8');
  assert.equal(await detectBmadPlanningArtifact(nonBmad), null);

  const ingested = await ingestBmadEpics({ sourcePath });
  assert.equal(ingested.source_kind, 'bmad-epics');
  assert.equal(ingested.source_sha256, sourceSha);
  assert.equal(ingested.stories.length, 3);
  assert.equal(ingested.cards.length, 0, 'ingestion must not silently assign a project');
  assert.deepEqual(await readFile(sourcePath), original, 'BMAD epics source remains read-only');
  const ingestedFromDirectory = await ingestBmadEpics({ sourcePath: temporaryRoot });
  assert.equal(ingestedFromDirectory.source_path, sourcePath);
  assert.equal(ingestedFromDirectory.stories.length, 3);

  await expectError(() => ingestBmadEpics({ sourcePath, projectRoot: control, projectConfig, execution: true }), 'bmad_repository_ambiguous');
  await expectError(() => ingestBmadEpics({ sourcePath, projectRoot: control, projectConfig, execution: true, targetRepository: 'missing' }), 'bmad_repository_unknown');
  await expectError(() => ingestBmadEpics({
    sourcePath,
    projectRoot: control,
    projectConfig,
    execution: true,
    targetRepository: 'webup',
    requiredGatesByStory: { missing: ['test'] }
  }), 'bmad_epics_unmappable');

  const execution = await ingestBmadEpics({
    sourcePath,
    projectRoot: control,
    projectConfig,
    execution: true,
    targetRepository: 'webup',
    requiredGatesByStory: { '2.1': ['test'] },
    dependsOnByStory: { '1.2': ['1.1'] }
  });
  assert.equal(execution.execution_ready, true);
  assert.equal(execution.cards.length, 3);
  assert.equal(execution.cards[0].story.targetRepository, 'webup');
  assert.equal(execution.cards[1].provenance.depends_on[0], '1.1');
  assert.deepEqual(execution.cards[2].provenance.required_gate_ids, ['test']);
  assert.equal(validateTriadCard(execution.cards[0].card).valid, true);
  assert.match(execution.cards[0].card, /BMAD epics\.md Story/);
  assert.equal(execution.cards[0].provenance.source_kind, 'bmad-epics');
  assert.equal(execution.cards[0].provenance.source_sha256, sourceSha);
  assert.equal(execution.cards[0].provenance.epic_id, '1');
  assert.equal(execution.cards[0].provenance.source_heading, 'Story 1.1: Route the provider document');
  assert.equal(execution.cards[0].provenance.source_heading_markdown, '### Story 1.1: Route the provider document');
  assert.equal(execution.cards[0].provenance.card_sha256, digest(execution.cards[0].card));
  assert.equal(execution.cards[0].provenance.execution_ready, true);
  assert.deepEqual(execution.cards[0].provenance.depends_on, []);
  await expectError(() => ingestBmadEpics({
    sourcePath,
    projectRoot: control,
    projectConfig,
    execution: true,
    targetRepository: 'webup',
    requiredGatesByStory: { '1.1': ['missing-gate'] }
  }), 'bmad_gate_unknown');

  const explicitOverride = await ingestBmadEpics({
    sourcePath,
    projectRoot: control,
    projectConfig,
    execution: true,
    targetRepository: 'webup',
    repositoryOverrides: { '2.1': 'ketchup2' }
  });
  assert.equal(explicitOverride.cards[2].story.targetRepository, 'ketchup2');

  const declaredRepository = join(temporaryRoot, 'declared-repository.md');
  await writeFile(declaredRepository, sourceText.replace(
    '### Story 1.1: Route the provider document',
    '### Story 1.1: Route the provider document\n\n**Target repository:** ketchup2'
  ), 'utf8');
  await expectError(() => ingestBmadEpics({
    sourcePath: declaredRepository,
    projectRoot: control,
    projectConfig,
    execution: true,
    targetRepository: 'webup'
  }), 'bmad_repository_ambiguous');

  const singleRepoConfig = { repositories: [{ id: 'webup', path: 'webup', worktree: 'webup' }] };
  const singleResolved = await ingestBmadEpics({ sourcePath, projectRoot: control, projectConfig: singleRepoConfig, execution: true });
  assert.equal(singleResolved.cards.every((item) => item.story.targetRepository === 'webup'), true);

  const outputDirectory = join(control, 'features');
  const written = await writeImportedEpics({ sourcePath, outputDirectory, projectRoot: control, projectConfig, targetRepository: 'webup' });
  assert.equal(written.outputs.length, 3);
  const outputNames = await readdir(outputDirectory);
  assert.deepEqual(outputNames.sort(), [
    '1.1.md', '1.1.md.bmad-provenance.json',
    '1.2.md', '1.2.md.bmad-provenance.json',
    '2.1.md', '2.1.md.bmad-provenance.json'
  ]);
  assert.equal(outputNames.some((name) => name.includes('story')), false, 'no intermediate BMAD Story files are created');
  const provenance = JSON.parse(await readFile(join(outputDirectory, '1.1.md.bmad-provenance.json'), 'utf8'));
  assert.equal(provenance.source_kind, 'bmad-epics');
  assert.equal(provenance.source_sha256, sourceSha);
  assert.equal(provenance.story_id, '1.1');

  const collisionDirectory = join(control, 'collision-features');
  await mkdir(collisionDirectory, { recursive: true });
  await writeFile(join(collisionDirectory, '1.2.md'), 'pre-existing\n', 'utf8');
  await expectError(() => writeImportedEpics({
    sourcePath,
    outputDirectory: collisionDirectory,
    projectRoot: control,
    projectConfig,
    targetRepository: 'webup'
  }), 'bmad_epics_unmappable');
  assert.deepEqual((await readdir(collisionDirectory)).sort(), ['1.2.md'], 'collision preflight must not partially write Cards');

  const yaml = `version: 2\nproject:\n  id: demo\nrepositories:\n  - id: webup\n    path: product/webup\n    worktree: worktrees/webup\n`;
  const parsedProject = parseProjectRepositories(yaml);
  assert.equal(parsedProject.repositories[0].id, 'webup');
  assert.equal(parsedProject.repositories[0].worktree, 'worktrees/webup');
  assert.equal(parsedProject.prdPath, null);

  const projectWithBaseline = `version: 2\nproject:\n  prd: artifacts/prd.md\n  prd_baseline:\n    snapshot: artifacts/prd.md\n  quality_contract:\n    baseline: artifacts/quality-baseline.json\nrepositories:\n  - id: webup\n    path: webup\n`;
  const parsedBaselineProject = parseProjectRepositories(projectWithBaseline);
  assert.equal(parsedBaselineProject.prdPath, 'artifacts/prd.md');
  assert.equal(parsedBaselineProject.prdBaseline.snapshot, 'artifacts/prd.md');
  assert.equal(parsedBaselineProject.qualityContract.baseline, 'artifacts/quality-baseline.json');

  const draft = join(temporaryRoot, 'draft-epics.md');
  await writeFile(draft, sourceText.replace('**Intent / outcome:** Establish', '**Status:** draft\n\n**Intent / outcome:** Establish'), 'utf8');
  const draftIngested = await ingestBmadEpics({ sourcePath: draft });
  assert.equal(draftIngested.stories[0].status, 'draft');
  await expectError(() => ingestBmadEpics({ sourcePath: draft, projectRoot: control, projectConfig: singleRepoConfig, execution: true }), 'bmad_story_not_ready');

  const duplicate = join(temporaryRoot, 'duplicate.md');
  await writeFile(duplicate, sourceText.replace('### Story 2.1: Prove the route deterministically', '### Story 1.1: Duplicate route'), 'utf8');
  await expectError(() => ingestBmadEpics({ sourcePath: duplicate }), 'bmad_epics_ambiguous');

  const malformedHeading = join(temporaryRoot, 'malformed-heading.md');
  await writeFile(malformedHeading, sourceText.replace('### Story 2.1: Prove the route deterministically', '### Story 2.1'), 'utf8');
  await expectError(() => ingestBmadEpics({ sourcePath: malformedHeading }), 'bmad_epics_invalid');

  const missingAcceptance = join(temporaryRoot, 'missing-acceptance.md');
  await writeFile(missingAcceptance, sourceText.replace(/\n\*\*Acceptance Criteria:\*\*[\s\S]*?\n\*\*Verification expectations:/, '\n**Verification expectations:'), 'utf8');
  await expectError(() => ingestBmadEpics({ sourcePath: missingAcceptance }), 'bmad_story_unmappable');

  const duplicateOutcome = join(temporaryRoot, 'duplicate-outcome.md');
  await writeFile(duplicateOutcome, sourceText.replace(
    '**Acceptance Criteria:**',
    '**Intent / outcome:** A conflicting outcome.\n\n**Acceptance Criteria:**'
  ), 'utf8');
  await expectError(() => ingestBmadEpics({ sourcePath: duplicateOutcome }), 'bmad_story_ambiguous');

  const outsideStory = join(temporaryRoot, 'outside-story.md');
  await writeFile(outsideStory, sourceText.replace('### Epic 1: Provider boundary', '').replace('### Epic 2: Verification evidence', ''), 'utf8');
  await expectError(() => ingestBmadEpics({ sourcePath: outsideStory }), 'bmad_epics_unmappable');

  const cliOutput = JSON.parse(run([intakeCli, '--source', sourcePath], repositoryRoot));
  assert.equal(cliOutput.status, 'ingested');
  assert.equal(cliOutput.story_count, 3);
  assert.equal(cliOutput.source_sha256, sourceSha);
  const cliExecution = JSON.parse(run([
    intakeCli,
    '--source', sourcePath,
    '--project', control,
    '--output', join(control, 'cli-features'),
    '--repository', 'webup',
    '--required-gate', '2.1=test',
    '--depends-on', '1.2=1.1'
  ], repositoryRoot));
  assert.equal(cliExecution.status, 'ready');
  assert.equal(cliExecution.card_count ?? cliExecution.cards.length, 3);
  assert.equal(cliExecution.source_sha256, sourceSha);

  console.log('BMAD native epics intake tests passed: deterministic parsing, readiness split, repository resolution, provenance, CLI, and fail-closed validation.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
