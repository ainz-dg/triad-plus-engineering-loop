const DECISIONS = new Set(['approved', 'rework', 'blocked']);
const OPTIONAL_FIELDS = new Set(['summary', 'findings', 'evidence_refs']);
const MAX_SUMMARY_LENGTH = 4000;
const MAX_FINDINGS = 50;
const MAX_EVIDENCE_REFS = 50;
const MAX_REFERENCE_LENGTH = 1000;

function invalid(message) {
  const error = new Error(`invalid Reviewer result: ${message}`);
  error.code = 'reviewer_result_invalid';
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
  const payloads = [];
  const marker = 'TRIAD_REVIEW_RESULT:';
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

function validateFindings(findings) {
  if (findings === undefined) return;
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) invalid('findings must be a bounded array');
  for (const finding of findings) {
    if (typeof finding !== 'string' && (!finding || typeof finding !== 'object' || Array.isArray(finding))) {
      invalid('findings entries must be strings or objects');
    }
    if (typeof finding === 'string' && finding.length > MAX_SUMMARY_LENGTH) invalid('finding text is too long');
    if (finding && typeof finding === 'object' && JSON.stringify(finding).length > MAX_SUMMARY_LENGTH) invalid('finding object is too large');
  }
}

function validateResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('result must be an object');
  const unknown = Object.keys(value).filter((key) => key !== 'decision' && !OPTIONAL_FIELDS.has(key));
  if (unknown.length > 0) invalid(`unknown fields: ${unknown.join(', ')}`);
  if (!DECISIONS.has(value.decision)) invalid('decision must be approved, rework, or blocked');
  if (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.length > MAX_SUMMARY_LENGTH)) {
    invalid('summary must be a bounded string');
  }
  validateFindings(value.findings);
  if (value.evidence_refs !== undefined) {
    if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length > MAX_EVIDENCE_REFS) invalid('evidence_refs must be a bounded array');
    if (value.evidence_refs.some((reference) => typeof reference !== 'string' || reference.length > MAX_REFERENCE_LENGTH)) {
      invalid('evidence_refs entries must be bounded strings');
    }
  }
  return value;
}

function textParts(event) {
  if (!event || typeof event !== 'object' || event.type !== 'text') return [];
  const parts = [];
  if (typeof event.text === 'string') parts.push(event.text);
  if (typeof event.part?.text === 'string') parts.push(event.part.text);
  if (typeof event.data?.text === 'string') parts.push(event.data.text);
  return parts;
}

/**
 * Parse the native OpenCode JSONL stream. Tool output is deliberately ignored:
 * prompts can contain a literal example marker, but only model text events are
 * authoritative Reviewer results.
 */
export function parseReviewerResultJsonl(source) {
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
    for (const text of textParts(event)) {
      for (const payload of markerPayloads(text)) candidates.push(payload);
    }
  }
  if (candidates.length !== 1) invalid(`expected exactly one result marker, found ${candidates.length}`);
  return validateResult(candidates[0]);
}

export function validateReviewerResult(value) {
  return validateResult(value);
}
