import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const READY_STATUS = 'ready-for-dev';
const SOURCE_KIND = 'bmad-story';

export class BmadStoryImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BmadStoryImportError';
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clean(value) {
  return String(value ?? '').trim();
}

function unquote(value) {
  const text = clean(value);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'");
  }
  return text;
}

function scalar(value) {
  const text = unquote(value);
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const parsed = JSON.parse(text);
      return parsed;
    } catch {
      return text;
    }
  }
  return text;
}

function parseFrontmatter(source) {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return { metadata: {}, body: source };
  const openingEnd = source.indexOf('\n');
  const closing = source.indexOf('\n---', openingEnd + 1);
  if (closing < 0) throw new BmadStoryImportError('bmad_story_invalid', 'BMAD Story frontmatter is not closed.');
  const closingEnd = source.indexOf('\n', closing + 1);
  const frontmatter = source.slice(openingEnd + 1, closing);
  const metadata = {};
  const duplicateKeys = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      // BMAD frontmatter may contain nested lists/maps. They are not part of
      // this importer contract, but are preserved in the source and ignored.
      if (/^\s+/.test(line) || /^\s*-\s+/.test(line)) continue;
      throw new BmadStoryImportError('bmad_story_invalid', `Malformed BMAD Story frontmatter line: ${line}`);
    }
    const [, key, rawValue] = match;
    if (Object.hasOwn(metadata, key)) duplicateKeys.push(key);
    metadata[key] = scalar(rawValue);
  }
  if (duplicateKeys.length) {
    throw new BmadStoryImportError('bmad_story_ambiguous', `BMAD Story frontmatter repeats: ${duplicateKeys.join(', ')}`);
  }
  return { metadata, body: closingEnd < 0 ? '' : source.slice(closingEnd + 1) };
}

function normalizeHeading(value) {
  return clean(value)
    .replaceAll('`', '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/[：:]+$/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseSections(body) {
  const sections = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    sections.push({ heading: current.heading, level: current.level, content });
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      current = { heading: heading[2], level: heading[1].length, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

function parseLabelBlocks(body) {
  const blocks = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    if (content) blocks.push({ heading: current.heading, content });
  };
  for (const line of body.split(/\r?\n/)) {
    const label = line.match(/^\s*(?:[-*]\s*)?\*\*([^*]+)\*\*\s*:?\s*$/);
    if (label) {
      flush();
      current = { heading: label[1], lines: [] };
    } else if (/^#{1,6}\s+/.test(line)) {
      flush();
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return blocks;
}

function valuesForMetadata(metadata, names) {
  const values = [];
  for (const name of names) if (metadata[name] !== undefined && metadata[name] !== null) values.push(metadata[name]);
  return values;
}

function metadataLines(body, names) {
  const wanted = new Set(names.map((name) => normalizeHeading(name)));
  const values = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.+?)\s*$/);
    if (match && wanted.has(normalizeHeading(match[1]))) values.push(unquote(match[2]));
  }
  return values;
}

function contentsFor(sections, labels, labelBlocks = []) {
  const wanted = new Set(labels.map((label) => normalizeHeading(label)));
  const values = [
    ...sections.filter((section) => wanted.has(normalizeHeading(section.heading))).map((section) => section.content),
    ...labelBlocks.filter((block) => wanted.has(normalizeHeading(block.heading))).map((block) => block.content)
  ];
  return [...new Set(values.map(clean).filter(Boolean))];
}

function firstContent(sections, labelBlocks, labels) {
  const values = contentsFor(sections, labels, labelBlocks);
  return values[0] ?? '';
}

function firstLabelOrSectionContent(sections, labelBlocks, labels) {
  const labeled = contentsFor([], labels, labelBlocks);
  return labeled[0] ?? firstContent(sections, labelBlocks, labels);
}

function distinctStrings(values, field) {
  const normalized = values.map((value) => clean(value)).filter(Boolean);
  const distinct = [...new Set(normalized)];
  if (distinct.length > 1) {
    throw new BmadStoryImportError('bmad_story_ambiguous', `BMAD Story has conflicting ${field} values.`, { field, values: distinct });
  }
  return distinct[0] ?? '';
}

function parseStoryHeading(sections) {
  const headings = sections
    .filter((section) => section.level === 1)
    .map((section) => section.heading)
    .map((heading) => {
      const match = clean(heading).match(/^Story\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*[:—-]\s*(.+))?$/i);
      if (match) return { id: match[1], title: clean(match[2]) };
      const plain = clean(heading).match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*[:—-]\s*(.+)$/);
      return plain ? { id: plain[1], title: clean(plain[2]) } : null;
    })
    .filter(Boolean);
  if (headings.length > 1) {
    throw new BmadStoryImportError('bmad_story_ambiguous', 'BMAD Story source contains multiple story headings.', { headings });
  }
  return headings[0] ?? { id: '', title: '' };
}

function normalizeList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BmadStoryImportError('bmad_story_unmappable', `${field} must be an array when supplied.`);
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new BmadStoryImportError('bmad_story_unmappable', `${field} must contain non-empty strings.`);
    const normalized = item.trim();
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function sourcePathLabel(sourcePath) {
  return sourcePath ? resolve(sourcePath) : '<BMAD Story source>';
}

export function parseBmadStory(source, { sourcePath = null, targetRepository = null } = {}) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new BmadStoryImportError('bmad_story_invalid', 'BMAD Story source is empty.');
  }
  const { metadata, body } = parseFrontmatter(source);
  const sections = parseSections(body);
  const labelBlocks = parseLabelBlocks(body);
  const heading = parseStoryHeading(sections);

  const id = distinctStrings([
    ...valuesForMetadata(metadata, ['id', 'story_id', 'storyId']),
    ...metadataLines(body, ['Story ID', 'ID']),
    heading.id
  ], 'story id');
  if (!id) throw new BmadStoryImportError('bmad_story_not_found', `No BMAD Story id found in ${sourcePathLabel(sourcePath)}.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new BmadStoryImportError('bmad_story_invalid', `BMAD Story id is not filename-safe: ${id}`);
  }

  const title = distinctStrings([
    ...valuesForMetadata(metadata, ['title']),
    ...metadataLines(body, ['Title']),
    heading.title
  ], 'title');
  if (!title) throw new BmadStoryImportError('bmad_story_unmappable', 'BMAD Story title is required.');

  const status = distinctStrings([
    ...valuesForMetadata(metadata, ['status']),
    ...metadataLines(body, ['Status']),
    firstContent(sections, labelBlocks, ['Status'])
  ], 'status').toLowerCase();
  if (!status) throw new BmadStoryImportError('bmad_story_not_ready', 'BMAD Story status is required and must be ready-for-dev.');
  if (status !== READY_STATUS) {
    throw new BmadStoryImportError('bmad_story_not_ready', `BMAD Story ${id} has status ${status}; only ready-for-dev can be imported.`, { status });
  }

  const declaredTargetRepository = distinctStrings([
    ...valuesForMetadata(metadata, ['target_repository', 'targetRepository', 'repository', 'repo']),
    ...metadataLines(body, ['Target repository', 'Target repo', 'Repository'])
  ], 'target repository');
  const explicitTargetRepository = targetRepository === undefined || targetRepository === null ? '' : clean(targetRepository);
  if (targetRepository !== undefined && targetRepository !== null && !explicitTargetRepository) {
    throw new BmadStoryImportError('bmad_story_unmappable', 'targetRepository must be a non-empty string when supplied.');
  }
  if (declaredTargetRepository && explicitTargetRepository && declaredTargetRepository !== explicitTargetRepository) {
    throw new BmadStoryImportError('bmad_story_ambiguous', 'BMAD Story target repository conflicts with the explicit importer option.', {
      declared: declaredTargetRepository,
      explicit: explicitTargetRepository
    });
  }
  const resolvedTargetRepository = declaredTargetRepository || explicitTargetRepository;
  if (!resolvedTargetRepository) throw new BmadStoryImportError('bmad_story_unmappable', 'BMAD Story target repository is required.');

  const outcome = firstContent(sections, labelBlocks, ['Intent', 'Outcome', 'User outcome', 'Objective', 'Story', 'Description']) || distinctStrings([
    ...valuesForMetadata(metadata, ['intent', 'outcome', 'objective', 'description']),
    ...metadataLines(body, ['Intent', 'Outcome', 'Objective', 'Description'])
  ], 'intent/outcome');
  if (!outcome) throw new BmadStoryImportError('bmad_story_unmappable', 'BMAD Story intent/outcome is required.');

  const acceptanceCriteria = firstContent(sections, labelBlocks, ['Acceptance Criteria', 'Acceptance']) || '';
  if (!acceptanceCriteria) throw new BmadStoryImportError('bmad_story_unmappable', 'BMAD Story acceptance criteria are required.');

  return {
    id,
    title,
    status,
    targetRepository: resolvedTargetRepository,
    branchWorktree: distinctStrings([
      ...valuesForMetadata(metadata, ['branch', 'worktree', 'branch_worktree', 'branchWorktree']),
      ...metadataLines(body, ['Branch', 'Worktree', 'Branch/worktree'])
    ], 'branch/worktree'),
    outcome,
    acceptanceCriteria,
    tasksAcceptance: firstLabelOrSectionContent(sections, labelBlocks, ['Execution', 'Tasks / Subtasks', 'Tasks', 'Tasks & Acceptance']),
    codeMap: firstContent(sections, labelBlocks, ['Code Map', 'Technical Context', 'Technical context / code map', 'Implementation Context']),
    designNotes: firstContent(sections, labelBlocks, ['Design Notes', 'Boundaries & Constraints', 'Constraints', 'Technical Constraints']),
    verification: firstContent(sections, labelBlocks, ['Verification', 'Verification Expectations', 'Metrics and Gates', 'Verification expectations']),
    references: firstContent(sections, labelBlocks, ['Source References', 'References', 'References / Provenance']),
    inScope: firstContent(sections, labelBlocks, ['In Scope', 'Scope']),
    outOfScope: firstContent(sections, labelBlocks, ['Out of Scope', 'Non-goals', 'Non Goals']),
    sourcePath: sourcePath ? resolve(sourcePath) : null
  };
}

function listText(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : 'none';
}

function sectionOrFallback(value, fallback) {
  return value?.trim() || fallback;
}

export function buildTriadCard(story, { requiredGates = [], dependsOn = [] } = {}) {
  if (!story || typeof story !== 'object') {
    throw new BmadStoryImportError('bmad_story_unmappable', 'A parsed BMAD Story object is required.');
  }
  for (const field of ['id', 'title', 'targetRepository', 'outcome', 'acceptanceCriteria']) {
    if (typeof story[field] !== 'string' || !story[field].trim()) {
      throw new BmadStoryImportError('bmad_story_unmappable', `BMAD Story ${field} is required before Card generation.`);
    }
  }
  if (story.status !== READY_STATUS) {
    throw new BmadStoryImportError('bmad_story_not_ready', 'Only a ready-for-dev BMAD Story can become an executable Triad Card.', { status: story.status ?? null });
  }
  const gates = normalizeList(requiredGates, 'requiredGates');
  const dependencies = normalizeList(dependsOn, 'dependsOn');
  const branch = story.branchWorktree || 'not declared by BMAD Story';
  const inScope = sectionOrFallback(story.inScope, 'Acceptance criteria, tasks, and technical context below define the bounded implementation; no additional scope is inferred.');
  const outOfScope = sectionOrFallback(story.outOfScope, 'No additional out-of-scope constraints were declared by the BMAD Story.');
  const tasks = sectionOrFallback(story.tasksAcceptance, 'No Tasks & Acceptance section was supplied by the BMAD Story.');
  const codeMap = sectionOrFallback(story.codeMap, 'No Code Map or technical context section was supplied by the BMAD Story.');
  const designNotes = sectionOrFallback(story.designNotes, 'No Design Notes or additional constraints were supplied by the BMAD Story.');
  const verification = sectionOrFallback(story.verification, 'Use the repository-owned deterministic gates declared by the caller and the normal Triad verifier.');
  const references = sectionOrFallback(story.references, 'No source references were declared by the BMAD Story.');

  return [
    `# ${story.id} — ${story.title}`,
    '',
    '## Outcome and scope',
    '',
    `- Target repository: \`${story.targetRepository}\``,
    `- Branch/worktree: \`${branch}\``,
    `- Outcome: ${story.outcome}`,
    `- In scope: ${inScope}`,
    `- Out of scope: ${outOfScope}`,
    `- Dependencies: ${listText(dependencies)}`,
    '',
    '## Acceptance criteria',
    '',
    story.acceptanceCriteria,
    '',
    '## Tasks & Acceptance',
    '',
    tasks,
    '',
    '## Technical context / Code Map',
    '',
    codeMap,
    '',
    '## Design Notes / Constraints',
    '',
    designNotes,
    '',
    '## Verification expectations',
    '',
    verification,
    '',
    '## Source references',
    '',
    references,
    '',
    '## Metrics and gates',
    '',
    '| ID | Target | Evidence command or observation |',
    '| --- | --- | --- |',
    '| bmad-story-status | ready-for-dev source imported | source status and hash recorded in integration provenance |',
    `- Required gates (\`required_gates\`): [${gates.join(', ')}]`,
    '- Allowed dependencies: repository-owned dependencies only; no dependency was inferred from BMAD ordering.',
    '',
    '## Integration boundary',
    '',
    '- This card was generated from one BMAD Story; BMAD remains planning authority and Triad remains execution authority.',
    '- The BMAD source is read-only. Provenance is recorded in the integration-side companion record.',
    ''
  ].join('\n');
}

export function validateTriadCard(card) {
  const required = [
    /^#\s+[^\n]+/m,
    /^## Outcome and scope$/m,
    /^## Acceptance criteria$/m,
    /^## Metrics and gates$/m,
    /Required gates \(`required_gates`\):/,
    /^## Integration boundary$/m
  ];
  const missing = required.filter((pattern) => !pattern.test(card)).map((pattern) => pattern.toString());
  return { valid: missing.length === 0, missing };
}

async function readStableSource(sourcePath) {
  const resolved = resolve(sourcePath);
  let first;
  try {
    const sourceStat = await stat(resolved);
    if (!sourceStat.isFile()) throw new Error('not a file');
    first = await readFile(resolved);
  } catch (error) {
    throw new BmadStoryImportError('bmad_story_not_found', `Cannot read BMAD Story source: ${resolved}`, { cause: error.code ?? 'not_a_file' });
  }
  const sourceText = first.toString('utf8');
  let second;
  try { second = await readFile(resolved); }
  catch (error) { throw new BmadStoryImportError('bmad_story_source_mutated', `BMAD Story source changed during import: ${resolved}`, { cause: error.code ?? 'read_failed' }); }
  if (!first.equals(second)) {
    throw new BmadStoryImportError('bmad_story_source_mutated', `BMAD Story source changed during import: ${resolved}`);
  }
  return { resolved, source: sourceText, sourceSha256: sha256(first) };
}

export async function importBmadStory({ sourcePath, targetRepository = null, requiredGates = [], dependsOn = [], capturedAt = null } = {}) {
  if (!sourcePath || typeof sourcePath !== 'string') throw new BmadStoryImportError('bmad_story_not_found', 'Provide a BMAD Story source path.');
  const loaded = await readStableSource(sourcePath);
  const story = parseBmadStory(loaded.source, { sourcePath: loaded.resolved, targetRepository });
  const card = buildTriadCard(story, { requiredGates, dependsOn });
  const cardValidation = validateTriadCard(card);
  if (!cardValidation.valid) throw new BmadStoryImportError('bmad_story_unmappable', 'Generated Triad Card failed integration validation.', { missing: cardValidation.missing });
  const provenance = {
    schema_version: 1,
    source_kind: SOURCE_KIND,
    source_path: loaded.resolved,
    source_sha256: loaded.sourceSha256,
    bmad_story_id: story.id,
    target_repository: story.targetRepository,
    card_sha256: sha256(card),
    required_gate_ids: normalizeList(requiredGates, 'requiredGates'),
    depends_on: normalizeList(dependsOn, 'dependsOn'),
    imported_at: capturedAt ?? new Date().toISOString()
  };
  return { story, card, provenance };
}

async function pathExists(target) {
  try { await access(target); return true; } catch { return false; }
}

export async function writeImportedCard({ sourcePath, outputPath, provenancePath = null, targetRepository = null, requiredGates = [], dependsOn = [], capturedAt = null } = {}) {
  if (!outputPath || typeof outputPath !== 'string') throw new BmadStoryImportError('bmad_story_unmappable', 'Provide an output path for the generated Triad Card.');
  const output = resolve(outputPath);
  const provenance = resolve(provenancePath || `${output}.bmad-provenance.json`);
  if (output === provenance) throw new BmadStoryImportError('bmad_story_unmappable', 'Card output and provenance output must be different paths.');
  if (await pathExists(output) || await pathExists(provenance)) {
    throw new BmadStoryImportError('bmad_story_unmappable', 'Refusing to overwrite an existing Card or provenance record.', { output, provenance });
  }
  const result = await importBmadStory({ sourcePath, targetRepository, requiredGates, dependsOn, capturedAt });
  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(provenance), { recursive: true });
  const outputTemp = `${output}.tmp-${process.pid}`;
  const provenanceTemp = `${provenance}.tmp-${process.pid}`;
  let outputWritten = false;
  let provenanceWritten = false;
  try {
    await writeFile(outputTemp, result.card, { encoding: 'utf8', flag: 'wx' });
    await writeFile(provenanceTemp, `${JSON.stringify({ ...result.provenance, card_path: output }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(outputTemp, output);
    outputWritten = true;
    await rename(provenanceTemp, provenance);
    provenanceWritten = true;
  } catch (error) {
    await rm(outputTemp, { force: true });
    await rm(provenanceTemp, { force: true });
    if (outputWritten) await rm(output, { force: true });
    if (provenanceWritten) await rm(provenance, { force: true });
    throw new BmadStoryImportError('bmad_story_unmappable', `Could not write imported Card: ${error.message}`, { cause: error.code ?? 'write_failed' });
  }
  return { ...result, outputPath: output, provenancePath: provenance };
}

export const bmadStoryImporter = {
  sourceKind: SOURCE_KIND,
  readyStatus: READY_STATUS,
  parse: parseBmadStory,
  buildCard: buildTriadCard,
  import: importBmadStory,
  write: writeImportedCard
};
