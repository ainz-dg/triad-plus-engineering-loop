#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));

async function loadIntegration() {
  const candidates = [
    path.join(runtimeDirectory, 'integrations', 'bmad', 'epics-parser.mjs'),
    path.resolve(runtimeDirectory, '..', 'integrations', 'bmad', 'epics-parser.mjs')
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return import(pathToFileURL(candidate).href);
    } catch {}
  }
  throw new Error('BMAD native intake assets are not installed');
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function repeated(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function usage() {
  process.stderr.write(`Native BMAD epics.md intake (integration/automation API)

Usage:
  node .triad-runtime/triad-bmad-intake.mjs --source <epics.md>
  node .triad-runtime/triad-bmad-intake.mjs --source <epics.md> --project <control> --output <features-dir> [--repository <id>] [--required-gate <story-id>=<gate-id>] [--depends-on <story-id>=<card-id>]

Without --output the command performs read-only ingestion and prints canonical
Stories. With --output it resolves Triad execution readiness and writes normal
Cards plus integration-side provenance. This command is an internal
deterministic primitive; the normal user entry point is the host's /triad
workflow with the epics.md path.
`);
}

function keyed(values, label) {
  const result = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) throw new Error(`${label} must use STORY-ID=VALUE`);
    const storyId = value.slice(0, separator).trim();
    const item = value.slice(separator + 1).trim();
    if (!storyId || !item) throw new Error(`${label} must use STORY-ID=VALUE`);
    (result[storyId] ??= []).push(item);
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  const source = option(argv, '--source');
  if (!source) throw new Error('--source is required');
  const output = option(argv, '--output');
  const project = option(argv, '--project');
  const repository = option(argv, '--repository');
  const requiredGatesByStory = keyed(repeated(argv, '--required-gate'), '--required-gate');
  const dependsOnByStory = keyed(repeated(argv, '--depends-on'), '--depends-on');
  const { ingestBmadEpics, writeImportedEpics } = await loadIntegration();
  if (output && !project) throw new Error('--project is required when --output is supplied');
  const options = {
    sourcePath: source,
    projectRoot: project,
    targetRepository: repository,
    requiredGatesByStory,
    dependsOnByStory
  };
  if (output) {
    const result = await writeImportedEpics({ ...options, outputDirectory: output });
    process.stdout.write(`${JSON.stringify({
      status: 'ready',
      source_kind: result.source_kind,
      source_path: result.source_path,
      source_sha256: result.source_sha256,
      epic_count: result.epics.length,
      story_count: result.stories.length,
      card_count: result.outputs.length,
      cards: result.outputs.map(({ story, cardPath, provenancePath, provenance }) => ({
        story_id: story.id,
        epic_id: story.epicId,
        card_path: cardPath,
        provenance_path: provenancePath,
        card_sha256: provenance.card_sha256
      }))
    })}\n`);
    return;
  }
  const result = await ingestBmadEpics(options);
  process.stdout.write(`${JSON.stringify({
    status: 'ingested',
    source_kind: result.source_kind,
    source_path: result.source_path,
    source_sha256: result.source_sha256,
    epic_count: result.epics.length,
    story_count: result.stories.length,
    stories: result.stories.map((story) => ({
      epic_id: story.epicId,
      epic_title: story.epicTitle,
      story_id: story.id,
      title: story.title,
      status: story.status,
      ingestion_ready: story.ingestionReady,
      execution_ready: story.executionReady,
      source_heading: story.sourceHeading,
      source_range: story.sourceRange
    }))
  })}\n`);
}

// `mktemp`/system temporary roots on macOS are commonly reached through the
// `/var` -> `/private/var` symlink.  Compare canonical paths so the installed
// runtime CLI still runs when invoked from such a control workspace.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 2;
  });
}
