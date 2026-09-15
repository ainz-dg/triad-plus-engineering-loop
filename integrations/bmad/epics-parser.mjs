import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BmadStoryImportError,
  buildTriadCardFromCanonicalStory,
  parseBmadStoryContent
} from './story-importer.mjs';

const SOURCE_KIND = 'bmad-epics';
const READY_STATUS = 'ready-for-dev';
const STORY_HEADING = /^Story\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*[:—-]\s*(.+))?$/i;
const EPIC_HEADING = /^Epic\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*[:—-]\s*(.+))?$/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clean(value) {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function error(code, message, details = {}) {
  return new BmadStoryImportError(code, message, details);
}

function safeId(value, label) {
  const normalized = clean(value);
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw error('bmad_epics_invalid', `${label} must be a non-empty stable identifier.`, { value });
  }
  return normalized;
}

function parseHeading(line) {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  return match ? { level: match[1].length, text: match[2].trim() } : null;
}

function looksLikeStoryHeading(text) {
  return /^Story(?:\s|$)/i.test(text);
}

function looksLikeEpicHeading(text) {
  return /^Epic(?:\s|$)/i.test(text);
}

function ignorableEpicSection(text) {
  return /^(?:Epic\s+List|Epic\s+Breakdown)$/i.test(clean(text));
}

function ignorableStorySection(text) {
  return /^Story\s+List$/i.test(clean(text));
}

function flushStory(stories, current, endLine) {
  if (!current) return;
  const body = current.lines.join('\n').trim();
  if (!body) throw error('bmad_epics_invalid', `BMAD Story ${current.id} has no body.`, { story_id: current.id });
  const story = parseBmadStoryContent(body, {
    sourcePath: current.sourcePath,
    id: current.id,
    title: current.title,
    epicId: current.epic.id,
    epicTitle: current.epic.title,
    sourceHeading: current.heading,
    sourceHeadingMarkdown: `${'#'.repeat(current.level)} ${current.heading}`,
    sourceRange: { start_line: current.startLine, end_line: endLine }
  });
  story.ingestionReady = true;
  story.executionReady = false;
  stories.push(story);
}

/**
 * Parse a native BMAD planning artifact.  Only Epic/Story headings delimit
 * records; all Story fields come from the bounded Story body and are parsed
 * deterministically without an LLM.
 */
export function parseBmadEpics(source, { sourcePath = null } = {}) {
  if (typeof source !== 'string' || !source.trim()) {
    throw error('bmad_epics_invalid', 'BMAD epics.md source is empty.');
  }
  const lines = source.split(/\r?\n/);
  const epics = [];
  const stories = [];
  const epicIds = new Set();
  const storyIds = new Set();
  let currentEpic = null;
  let currentStory = null;

  const finishStory = (endLine) => {
    flushStory(stories, currentStory, endLine);
    currentStory = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = parseHeading(line);
    if (heading) {
      if (ignorableEpicSection(heading.text)) continue;
      if (ignorableStorySection(heading.text)) continue;
      const epicMatch = heading.text.match(EPIC_HEADING);
      const storyMatch = heading.text.match(STORY_HEADING);
      if (epicMatch || (looksLikeEpicHeading(heading.text) && !ignorableEpicSection(heading.text))) {
        if (!epicMatch || !epicMatch[2]?.trim()) {
          throw error('bmad_epics_invalid', `Malformed Epic heading at line ${index + 1}.`, { line: index + 1, heading: heading.text });
        }
        if (currentStory) finishStory(index);
        const id = safeId(epicMatch[1], 'Epic id');
        if (epicIds.has(id)) throw error('bmad_epics_ambiguous', `Duplicate Epic id: ${id}.`, { epic_id: id });
        currentEpic = {
          id,
          title: clean(epicMatch[2]),
          heading: heading.text,
          sourceHeadingMarkdown: `${'#'.repeat(heading.level)} ${heading.text}`,
          level: heading.level,
          sourceRange: { start_line: index + 1, end_line: null }
        };
        epics.push(currentEpic);
        epicIds.add(id);
        continue;
      }
      if (storyMatch || looksLikeStoryHeading(heading.text)) {
        if (!storyMatch || !storyMatch[2]?.trim()) {
          throw error('bmad_epics_invalid', `Malformed Story heading at line ${index + 1}.`, { line: index + 1, heading: heading.text });
        }
        if (!currentEpic) {
          throw error('bmad_epics_unmappable', `Story ${storyMatch[1]} is not nested under an Epic.`, { story_id: storyMatch[1], line: index + 1 });
        }
        if (currentStory) finishStory(index);
        const id = safeId(storyMatch[1], 'Story id');
        if (storyIds.has(id)) throw error('bmad_epics_ambiguous', `Duplicate Story id: ${id}.`, { story_id: id });
        currentStory = {
          id,
          title: clean(storyMatch[2]),
          heading: heading.text,
          level: heading.level,
          epic: currentEpic,
          sourcePath,
          startLine: index + 1,
          lines: []
        };
        storyIds.add(id);
        continue;
      }
    }
    if (currentStory) currentStory.lines.push(line);
  }
  if (currentStory) finishStory(lines.length);
  if (!epics.length) throw error('bmad_epics_not_found', 'No Epic heading found in BMAD epics.md.');
  if (!stories.length) throw error('bmad_epics_unmappable', 'No Story heading found under the BMAD Epics.');
  for (const epic of epics) {
    epic.sourceRange.end_line = epic.sourceRange.end_line ?? lines.length;
  }
  return { sourceKind: SOURCE_KIND, epics, stories };
}

async function readStableSource(sourcePath) {
  const resolved = resolve(sourcePath);
  let first;
  try {
    const sourceStat = await stat(resolved);
    if (!sourceStat.isFile()) throw new Error('not a file');
    first = await readFile(resolved);
  } catch (cause) {
    throw error('bmad_epics_not_found', `Cannot read BMAD epics source: ${resolved}.`, { cause: cause.code ?? 'not_a_file' });
  }
  let second;
  try { second = await readFile(resolved); }
  catch (cause) { throw error('bmad_epics_source_mutated', `BMAD epics source changed during import: ${resolved}.`, { cause: cause.code ?? 'read_failed' }); }
  if (!first.equals(second)) throw error('bmad_epics_source_mutated', `BMAD epics source changed during import: ${resolved}.`);
  return { resolved, source: first.toString('utf8'), sourceSha256: sha256(first) };
}

/** Resolve an epics.md file or a BMAD output directory without changing it. */
export async function detectBmadPlanningArtifact(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  const input = resolve(inputPath);
  let inputStat;
  try { inputStat = await stat(input); } catch { return null; }
  if (inputStat.isFile()) {
    const source = await readFile(input, 'utf8');
    if (input.toLowerCase().endsWith('/epics.md') || /^#{1,6}\s+.*Epic Breakdown/i.test(source) || /^(#{1,6})\s+Epic\s+/mi.test(source)) {
      return { kind: SOURCE_KIND, sourcePath: input };
    }
    return null;
  }
  const candidates = [
    join(input, '_bmad-output', 'planning-artifacts', 'epics.md'),
    join(input, 'planning-artifacts', 'epics.md'),
    join(input, 'epics.md')
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return { kind: SOURCE_KIND, sourcePath: candidate };
    } catch {}
  }
  return null;
}

function scalar(value) {
  const trimmed = clean(value);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  return trimmed.replace(/^['"]|['"]$/g, '');
}

/** Parse only the stable repository-list subset of Triad's project.yaml. */
export function parseProjectRepositories(source) {
  if (typeof source !== 'string' || !source.trim()) throw error('bmad_execution_not_ready', 'Triad project.yaml is empty.');
  try {
    const parsed = JSON.parse(source);
    return normalizeProjectConfig(parsed);
  } catch {}

  const repositories = [];
  const projectFields = { prdPath: null, prdBaselineSnapshot: null, qualityBaseline: null, qualityFingerprint: null };
  let projectIndent = null;
  let nestedProjectSection = null;
  let inRepositories = false;
  let repositoryIndent = null;
  let current = null;
  let defaultRepository = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indentation = line.search(/\S/);
    const projectMatch = line.match(/^(\s*)project:\s*$/i);
    if (projectMatch) {
      projectIndent = projectMatch[1].length;
      nestedProjectSection = null;
      continue;
    }
    if (projectIndent !== null && indentation > projectIndent) {
      const nestedSection = line.match(/^(\s*)(prd_baseline|quality_contract):\s*$/i);
      if (nestedSection && nestedSection[1].length === projectIndent + 2) {
        nestedProjectSection = nestedSection[2].toLowerCase();
        continue;
      }
      const projectProperty = line.match(/^(\s*)(prd|snapshot|baseline|fingerprint):\s*(.*?)\s*$/i);
      if (projectProperty) {
        const propertyIndent = projectProperty[1].length;
        const key = projectProperty[2].toLowerCase();
        const value = scalar(projectProperty[3]);
        if (propertyIndent === projectIndent + 2 && key === 'prd') projectFields.prdPath = value;
        if (propertyIndent === projectIndent + 4 && nestedProjectSection === 'prd_baseline' && key === 'snapshot') projectFields.prdBaselineSnapshot = value;
        if (propertyIndent === projectIndent + 4 && nestedProjectSection === 'quality_contract' && key === 'baseline') projectFields.qualityBaseline = value;
        if (propertyIndent === projectIndent + 4 && nestedProjectSection === 'quality_contract' && key === 'fingerprint') projectFields.qualityFingerprint = value;
      }
      if (indentation <= projectIndent + 2 && !line.trimStart().startsWith('- ')) nestedProjectSection = null;
    } else if (projectIndent !== null && indentation <= projectIndent) {
      nestedProjectSection = null;
    }
    const defaultMatch = line.match(/^\s*(?:project\.)?default[_-]?repository:\s*(.*?)\s*$/i);
    if (defaultMatch) defaultRepository = scalar(defaultMatch[1]);
    const repositoriesMatch = line.match(/^(\s*)repositories:\s*$/i);
    if (repositoriesMatch) {
      inRepositories = true;
      repositoryIndent = repositoriesMatch[1].length;
      continue;
    }
    if (!inRepositories) continue;
    const itemMatch = line.match(/^(\s*)-\s+id:\s*(.*?)\s*$/i);
    if (itemMatch && itemMatch[1].length > repositoryIndent) {
      if (current) repositories.push(current);
      current = { id: scalar(itemMatch[2]) };
      continue;
    }
    if (!current) continue;
    const propertyMatch = line.match(/^(\s+)([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (propertyMatch && propertyMatch[1].length > repositoryIndent) {
      current[propertyMatch[2]] = scalar(propertyMatch[3]);
      continue;
    }
    if (line.search(/\S/) <= repositoryIndent && !line.trimStart().startsWith('- ')) {
      inRepositories = false;
    }
  }
  if (current) repositories.push(current);
  return normalizeProjectConfig({
    repositories,
    defaultRepository,
    prdPath: projectFields.prdPath,
    prdBaseline: projectFields.prdBaselineSnapshot ? { snapshot: projectFields.prdBaselineSnapshot } : null,
    qualityContract: projectFields.qualityBaseline
      ? { baseline: projectFields.qualityBaseline, fingerprint: projectFields.qualityFingerprint }
      : null
  });
}

function normalizeProjectConfig(value) {
  const source = asObject(value) ? value : {};
  const project = asObject(source.project) ? source.project : {};
  const repositories = Array.isArray(source.repositories)
    ? source.repositories
    : Array.isArray(project.repositories) ? project.repositories : [];
  const normalized = repositories.map((repository) => {
    if (!asObject(repository) || typeof repository.id !== 'string' || !repository.id.trim()) {
      throw error('bmad_execution_not_ready', 'Every Triad repository mapping requires a unique id.');
    }
    return {
      ...repository,
      id: repository.id.trim(),
      path: typeof repository.path === 'string' ? repository.path.trim() : null,
      worktree: typeof repository.worktree === 'string' ? repository.worktree.trim() : null
    };
  });
  const ids = new Set();
  for (const repository of normalized) {
    if (ids.has(repository.id)) throw error('bmad_repository_ambiguous', `Duplicate Triad repository id: ${repository.id}.`);
    ids.add(repository.id);
    if (!repository.path && !repository.worktree) throw error('bmad_execution_not_ready', `Repository ${repository.id} has no path/worktree mapping.`);
  }
  const defaultRepository = clean(source.defaultRepository ?? source.default_repository ?? project.defaultRepository ?? project.default_repository) || null;
  const prdPath = source.prdPath ?? source.prd_path ?? project.prdPath ?? project.prd_path ?? project.prd ?? null;
  const prdBaseline = asObject(source.prdBaseline)
    ? source.prdBaseline
    : asObject(source.prd_baseline) ? source.prd_baseline
      : asObject(project.prdBaseline) ? project.prdBaseline
        : asObject(project.prd_baseline) ? project.prd_baseline : null;
  const qualityContract = asObject(source.qualityContract)
    ? source.qualityContract
    : asObject(source.quality_contract) ? source.quality_contract
      : asObject(project.qualityContract) ? project.qualityContract
        : asObject(project.quality_contract) ? project.quality_contract : null;
  return {
    repositories: normalized,
    defaultRepository,
    prdPath: typeof prdPath === 'string' ? prdPath.trim() : null,
    prdBaseline,
    qualityContract,
    gatesPath: source.gatesPath ?? source.gates_path ?? project.gatesPath ?? project.gates_path ?? null,
    worktreeStrategy: source.worktreeStrategy ?? source.worktree_strategy ?? project.worktreeStrategy ?? project.worktree_strategy ?? null
  };
}

// Execution readiness only needs to know that the trusted catalog is present
// and non-placeholder.  Gate parsing/execution remains authoritative in the
// existing runtime/lib/gates.mjs verifier; this small check keeps the BMAD
// integration consumable when its assets are materialized under .triad-runtime.
function inspectGateCatalog(source) {
  try {
    const parsed = JSON.parse(source);
    const gates = Array.isArray(parsed?.gates) ? parsed.gates : [];
    return {
      count: gates.length,
      ids: gates.map((gate) => clean(gate?.id)).filter(Boolean),
      invalid: gates.some((gate) => !gate?.id || !gate.command || /^REPLACE_ME/.test(String(gate.command)))
    };
  } catch {}
  const entries = [];
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const item = line.match(/^\s*-\s+id:\s*(.*?)\s*$/i);
    if (item) {
      if (current) entries.push(current);
      current = { id: clean(item[1]), command: null };
      continue;
    }
    if (current) {
      const command = line.match(/^\s+command:\s*(.*?)\s*$/i);
      if (command) current.command = clean(command[1]).replace(/^['"]|['"]$/g, '');
    }
  }
  if (current) entries.push(current);
  return {
    count: entries.length,
    ids: entries.map((gate) => gate.id).filter(Boolean),
    invalid: entries.some((gate) => !gate.id || !gate.command || /^REPLACE_ME/.test(gate.command))
  };
}

async function loadQualityBaselineValidator() {
  const candidates = [
    new URL('../../runtime/lib/quality-baseline.mjs', import.meta.url),
    new URL('../../lib/quality-baseline.mjs', import.meta.url)
  ];
  for (const candidate of candidates) {
    try {
      await access(fileURLToPath(candidate));
      return await import(candidate.href);
    } catch {}
  }
  return null;
}

async function loadExecutionContext({ projectRoot = null, projectConfigPath = null, projectConfig = null, gatesPath = null } = {}) {
  const root = projectRoot ? resolve(projectRoot) : null;
  let normalized;
  if (projectConfig) normalized = normalizeProjectConfig(projectConfig);
  else {
    if (!root) throw error('bmad_execution_not_ready', 'A Triad project root or project config is required for execution readiness.');
    const configPath = resolve(root, projectConfigPath || 'project.yaml');
    let source;
    try { source = await readFile(configPath, 'utf8'); }
    catch (cause) { throw error('bmad_execution_not_ready', `Triad project configuration is missing: ${configPath}.`, { cause: cause.code ?? 'read_failed' }); }
    normalized = parseProjectRepositories(source);
  }
  if (!root) throw error('bmad_execution_not_ready', 'A project root is required to validate repositories and the trusted gate catalog.');
  if (!normalized.repositories.length) throw error('bmad_execution_not_ready', 'Triad project configuration declares no repositories.');
  for (const repository of normalized.repositories) {
    const declaredWorktree = repository.worktree || repository.path;
    const candidate = resolve(root, declaredWorktree);
    try {
      if (!(await stat(candidate)).isDirectory()) throw new Error('not a directory');
    } catch (cause) {
      throw error('bmad_execution_not_ready', `Repository ${repository.id} worktree is not available: ${declaredWorktree}.`, { cause: cause.code ?? 'not_a_directory' });
    }
  }
  const configuredQualityPath = normalized.qualityContract?.baseline
    || normalized.prdBaseline?.snapshot
    || normalized.prdPath
    || 'artifacts/prd.md';
  if (typeof configuredQualityPath !== 'string' || !configuredQualityPath.trim()) {
    throw error('bmad_execution_not_ready', 'Triad quality baseline path must be a non-empty project-relative path.');
  }
  if (configuredQualityPath.split(/[\\/]/).includes('..')) {
    throw error('bmad_execution_not_ready', 'Triad quality baseline path must remain inside the control workspace.');
  }
  if (normalized.qualityContract) {
    const expectedQualityFingerprint = normalized.qualityContract.fingerprint;
    if (typeof expectedQualityFingerprint !== 'string' || !expectedQualityFingerprint.trim()) {
      throw error('bmad_execution_not_ready', 'Configured Triad quality contract requires a baseline fingerprint.');
    }
    const validator = await loadQualityBaselineValidator();
    if (!validator?.loadQualityBaseline) {
      throw error('bmad_execution_not_ready', 'Configured Triad quality contract cannot be validated by the installed runtime.');
    }
    try {
      await validator.loadQualityBaseline(configuredQualityPath, {
        projectRoot: root,
        expectedFingerprint: expectedQualityFingerprint
      });
    } catch (cause) {
      throw error('bmad_execution_not_ready', `Triad quality contract is not valid: ${cause.message}.`, {
        cause: cause.code ?? 'quality_baseline_invalid',
        quality_baseline_path: configuredQualityPath
      });
    }
  }
  const qualityPath = resolve(root, configuredQualityPath);
  if (!qualityPath.startsWith(`${root}${sep}`)) {
    throw error('bmad_execution_not_ready', 'Triad quality baseline path escapes the control workspace.');
  }
  try {
    const qualityStat = await stat(qualityPath);
    if (!qualityStat.isFile()) throw new Error('not a file');
  } catch (cause) {
    throw error('bmad_execution_not_ready', `Triad quality baseline source is not available: ${configuredQualityPath}.`, {
      cause: cause.code ?? 'not_a_file',
      quality_baseline_path: configuredQualityPath
    });
  }
  const resolvedGatesPath = gatesPath || normalized.gatesPath || (root ? '.loop/quality-gates.yaml' : null);
  if (!resolvedGatesPath) throw error('bmad_execution_not_ready', 'Triad quality-gates catalog path is not configured.');
  if (!root) throw error('bmad_execution_not_ready', 'A project root is required to validate the trusted gate catalog.');
  const absoluteGatesPath = resolve(root, resolvedGatesPath);
  let gateSource;
  try { gateSource = await readFile(absoluteGatesPath, 'utf8'); }
  catch (cause) { throw error('bmad_execution_not_ready', `Triad quality-gates catalog is missing: ${resolvedGatesPath}.`, { cause: cause.code ?? 'read_failed' }); }
  const gateCatalog = inspectGateCatalog(gateSource);
  if (!gateCatalog.count || gateCatalog.invalid) {
    throw error('bmad_execution_not_ready', 'Triad quality-gates catalog is empty or contains placeholder definitions.');
  }
  return {
    ...normalized,
    projectRoot: root,
    qualityBaselinePath: configuredQualityPath,
    gatesPath: resolvedGatesPath,
    gateCatalog,
    gateSourceSha256: sha256(gateSource)
  };
}

function mapValue(map, storyId, label) {
  if (map === undefined || map === null) return [];
  if (!asObject(map)) throw error('bmad_epics_unmappable', `${label} must be an object keyed by Story id.`);
  if (!Object.hasOwn(map, storyId)) return [];
  const value = map[storyId];
  if (!Array.isArray(value)) throw error('bmad_epics_unmappable', `${label}.${storyId} must be an array.`);
  return value;
}

function validateStoryKeyedOptions(parsedStories, value, label) {
  if (value === undefined || value === null) return;
  if (!asObject(value)) throw error('bmad_epics_unmappable', `${label} must be an object keyed by Story id.`);
  const known = new Set(parsedStories.map((story) => story.id));
  const unknown = Object.keys(value).filter((storyId) => !known.has(storyId));
  if (unknown.length) throw error('bmad_epics_unmappable', `${label} contains unknown Story ids: ${unknown.join(', ')}.`, { story_ids: unknown });
}

function validateSelectedGates(gates, storyId, gateCatalog) {
  for (const gateId of gates) {
    if (!gateCatalog.ids.includes(gateId)) {
      throw error('bmad_gate_unknown', `Story ${storyId} selects an unavailable trusted gate: ${gateId}.`, {
        story_id: storyId,
        gate_id: gateId,
        available_gate_ids: gateCatalog.ids
      });
    }
  }
}

function resolveRepository(story, execution, { targetRepository = null, repositoryOverrides = {} } = {}) {
  const storyOverride = Object.hasOwn(repositoryOverrides ?? {}, story.id)
    ? repositoryOverrides[story.id]
    : null;
  if (storyOverride !== null && (typeof storyOverride !== 'string' || !storyOverride.trim())) {
    throw error('bmad_repository_ambiguous', `Repository override for Story ${story.id} must be a non-empty repository id.`);
  }
  if (targetRepository !== null && targetRepository !== undefined
    && (typeof targetRepository !== 'string' || !targetRepository.trim())) {
    throw error('bmad_repository_ambiguous', 'targetRepository must be a non-empty repository id when supplied.');
  }
  const declared = clean(story.targetRepository);
  const explicitOverride = clean(storyOverride);
  const explicitGlobal = clean(targetRepository);
  const explicit = explicitOverride || declared || explicitGlobal;
  // A per-Story caller override is intentionally the strongest binding.  If
  // no such override exists, conflicting Story/caller declarations fail closed
  // instead of silently selecting one.
  const conflicting = explicitOverride ? [] : [declared, explicitGlobal].filter(Boolean);
  if (new Set(conflicting).size > 1) {
    throw error('bmad_repository_ambiguous', `Story ${story.id} has conflicting repository mappings.`, {
      story_id: story.id,
      mappings: { story_override: explicitOverride || null, story: declared || null, caller: explicitGlobal || null }
    });
  }
  const requested = clean(explicit || execution.defaultRepository);
  let repository;
  if (requested) repository = execution.repositories.find((item) => item.id === requested);
  else if (execution.repositories.length === 1) repository = execution.repositories[0];
  else throw error('bmad_repository_ambiguous', `Cannot resolve a repository for Story ${story.id}; multiple repositories are configured.`, {
    story_id: story.id,
    repositories: execution.repositories.map((item) => item.id)
  });
  if (!repository) throw error('bmad_repository_unknown', `Story ${story.id} names an unknown repository: ${requested}.`, {
    story_id: story.id,
    repository: requested
  });
  return repository;
}

function sourceProvenance({ loaded, story, card = null, targetRepository = null, requiredGates = [], dependsOn = [], executionReady = false }) {
  return {
    schema_version: 1,
    source_kind: SOURCE_KIND,
    source_path: loaded.resolved,
    source_file: loaded.resolved,
    source_sha256: loaded.sourceSha256,
    epic_id: story.epicId,
    epic_title: story.epicTitle,
    story_id: story.id,
    bmad_story_id: story.id,
    source_heading: story.sourceHeading,
    source_heading_markdown: story.sourceHeadingMarkdown ?? null,
    source_range: story.sourceRange,
    ingestion_ready: story.ingestionReady === true,
    execution_ready: executionReady,
    target_repository: targetRepository,
    required_gate_ids: requiredGates,
    depends_on: dependsOn,
    card_sha256: card ? sha256(card) : null
  };
}

/**
 * Read native BMAD epics.md.  By default this is ingestion only: no project
 * assumptions are made and no Card is emitted until execution readiness is
 * explicitly requested with a Triad project context.
 */
export async function ingestBmadEpics({
  sourcePath,
  projectRoot = null,
  projectConfigPath = null,
  projectConfig = null,
  gatesPath = null,
  execution = false,
  targetRepository = null,
  repositoryOverrides = {},
  requiredGatesByStory = {},
  dependsOnByStory = {}
} = {}) {
  if (!sourcePath || typeof sourcePath !== 'string') throw error('bmad_epics_not_found', 'Provide a BMAD epics.md source path.');
  const detected = await detectBmadPlanningArtifact(sourcePath);
  if (!detected) throw error('bmad_epics_not_found', `No native BMAD epics.md found at ${resolve(sourcePath)}.`);
  const loaded = await readStableSource(detected.sourcePath);
  const parsed = parseBmadEpics(loaded.source, { sourcePath: loaded.resolved });
  if (!execution) {
    return {
      source_kind: SOURCE_KIND,
      source_path: loaded.resolved,
      source_sha256: loaded.sourceSha256,
      epics: parsed.epics,
      stories: parsed.stories,
      cards: [],
      execution_ready: false
    };
  }

  const context = await loadExecutionContext({ projectRoot, projectConfigPath, projectConfig, gatesPath });
  validateStoryKeyedOptions(parsed.stories, repositoryOverrides, 'repositoryOverrides');
  validateStoryKeyedOptions(parsed.stories, requiredGatesByStory, 'requiredGatesByStory');
  validateStoryKeyedOptions(parsed.stories, dependsOnByStory, 'dependsOnByStory');
  const cards = [];
  const stories = [];
  for (const originalStory of parsed.stories) {
    if (originalStory.status && originalStory.status !== READY_STATUS) {
      throw error('bmad_story_not_ready', `BMAD Story ${originalStory.id} has status ${originalStory.status}; it is ingestible but not execution-ready.`, { status: originalStory.status });
    }
    const repository = resolveRepository(originalStory, context, { targetRepository, repositoryOverrides });
    const gates = mapValue(requiredGatesByStory, originalStory.id, 'requiredGatesByStory');
    const dependencies = mapValue(dependsOnByStory, originalStory.id, 'dependsOnByStory');
    validateSelectedGates(gates, originalStory.id, context.gateCatalog);
    const story = { ...originalStory, targetRepository: repository.id, executionReady: true };
    const card = buildTriadCardFromCanonicalStory(story, {
      executionReady: true,
      requiredGates: gates,
      dependsOn: dependencies,
      sourceKind: SOURCE_KIND
    });
    const provenance = sourceProvenance({ loaded, story, card, targetRepository: repository.id, requiredGates: [...gates], dependsOn: [...dependencies], executionReady: true });
    stories.push({ ...story, executionReady: true });
    cards.push({ story, card, provenance, repository, execution: { gates_path: context.gatesPath, gates_sha256: context.gateSourceSha256 } });
  }
  return {
    source_kind: SOURCE_KIND,
    source_path: loaded.resolved,
    source_sha256: loaded.sourceSha256,
    epics: parsed.epics,
    stories,
    cards,
    execution_ready: true,
    execution: { project_root: context.projectRoot, gates_path: context.gatesPath, gates_sha256: context.gateSourceSha256 }
  };
}

async function pathExists(target) {
  try { await access(target); return true; } catch { return false; }
}

/** Write normal Triad Cards and integration-side provenance, never Story files. */
export async function writeImportedEpics({ sourcePath, outputDirectory, ...options } = {}) {
  if (!outputDirectory || typeof outputDirectory !== 'string') throw error('bmad_epics_unmappable', 'Provide an output directory for generated Triad Cards.');
  const result = await ingestBmadEpics({ sourcePath, ...options, execution: true });
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const outputs = [];
  // Check every destination before writing any Card so a stale/duplicate
  // output cannot leave a partially materialized Epic behind.
  for (const item of result.cards) {
    const cardPath = join(directory, `${item.story.id}.md`);
    const provenancePath = `${cardPath}.bmad-provenance.json`;
    if (await pathExists(cardPath) || await pathExists(provenancePath)) {
      throw error('bmad_epics_unmappable', `Refusing to overwrite an existing Card or provenance record for ${item.story.id}.`, { cardPath, provenancePath });
    }
  }
  for (const item of result.cards) {
    const cardPath = join(directory, `${item.story.id}.md`);
    const provenancePath = `${cardPath}.bmad-provenance.json`;
    const cardTemp = `${cardPath}.tmp-${process.pid}`;
    const provenanceTemp = `${provenancePath}.tmp-${process.pid}`;
    let cardWritten = false;
    try {
      await writeFile(cardTemp, item.card, { encoding: 'utf8', flag: 'wx' });
      await writeFile(provenanceTemp, `${JSON.stringify({ ...item.provenance, card_path: cardPath }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(cardTemp, cardPath);
      cardWritten = true;
      await rename(provenanceTemp, provenancePath);
      outputs.push({ ...item, cardPath, provenancePath });
    } catch (cause) {
      await rm(cardTemp, { force: true });
      await rm(provenanceTemp, { force: true });
      if (cardWritten) await rm(cardPath, { force: true });
      throw error('bmad_epics_unmappable', `Could not write imported Card ${item.story.id}: ${cause.message}.`, { cause: cause.code ?? 'write_failed' });
    }
  }
  return { ...result, outputs };
}

export const bmadEpicsIntegration = {
  sourceKind: SOURCE_KIND,
  detect: detectBmadPlanningArtifact,
  parse: parseBmadEpics,
  ingest: ingestBmadEpics,
  write: writeImportedEpics,
  parseProjectRepositories
};
