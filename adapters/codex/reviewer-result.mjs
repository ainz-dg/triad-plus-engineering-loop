import { access } from 'node:fs/promises';

const sourceRuntime = new URL('../../runtime/lib/reviewer-result.mjs', import.meta.url);
const installedRuntime = new URL('../../lib/reviewer-result.mjs', import.meta.url);
let validatorModule;
try {
  await access(sourceRuntime);
  validatorModule = await import(sourceRuntime.href);
} catch {
  validatorModule = await import(installedRuntime.href);
}
const { validateReviewerResult } = validatorModule;

function invalid(message) {
  const error = new Error(`invalid Codex Reviewer result: ${message}`);
  error.code = 'codex_reviewer_result_invalid';
  throw error;
}

function extractBalancedObject(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function markerPayloads(text) {
  const marker = 'TRIAD_REVIEW_RESULT:';
  const payloads = [];
  let offset = 0;
  while (offset < text.length) {
    const markerIndex = text.indexOf(marker, offset);
    if (markerIndex < 0) break;
    const objectStart = text.indexOf('{', markerIndex + marker.length);
    if (objectStart < 0) invalid('result marker has no JSON object');
    const source = extractBalancedObject(text, objectStart);
    if (!source) invalid('result marker contains incomplete JSON');
    try {
      payloads.push(JSON.parse(source));
    } catch (error) {
      invalid(`result marker JSON cannot be parsed: ${error.message}`);
    }
    offset = objectStart + source.length;
  }
  return payloads;
}

function agentMessageText(event) {
  if (event?.type !== 'item.completed' || event.item?.type !== 'agent_message') return [];
  const text = [];
  if (typeof event.item.text === 'string') text.push(event.item.text);
  if (Array.isArray(event.item.content)) {
    for (const part of event.item.content) {
      if (typeof part?.text === 'string') text.push(part.text);
    }
  }
  return text;
}

/** Parse only Codex native final agent-message events. */
export function parseCodexReviewerResultJsonl(source) {
  if (typeof source !== 'string' || source.length === 0) invalid('JSONL stream is empty');
  const candidates = [];
  for (const [lineNumber, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      invalid(`line ${lineNumber + 1} is not valid JSON: ${error.message}`);
    }
    for (const text of agentMessageText(event)) candidates.push(...markerPayloads(text));
  }
  if (candidates.length !== 1) invalid(`expected exactly one result marker, found ${candidates.length}`);
  return validateReviewerResult(candidates[0]);
}
