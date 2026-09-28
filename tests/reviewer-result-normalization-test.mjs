import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewerResultJsonl } from '../runtime/lib/reviewer-result.mjs';

function event(type, value) {
  return JSON.stringify({ type, part: type === 'text' ? { type: 'text', text: value } : { type: 'tool', state: { output: value } } });
}

test('extracts one escaped OpenCode text result and ignores tool output', () => {
  const source = [
    event('tool_use', 'TRIAD_REVIEW_RESULT: {"decision":"blocked"}'),
    event('text', 'Independent report.\nTRIAD_REVIEW_RESULT: {"decision":"approved","evidence_refs":["verification.json"]}')
  ].join('\n');
  assert.deepEqual(parseReviewerResultJsonl(source), { decision: 'approved', evidence_refs: ['verification.json'] });
});

test('rejects missing and malformed result markers', () => {
  assert.throws(() => parseReviewerResultJsonl(event('text', 'approved')), /exactly one result marker/);
  assert.throws(() => parseReviewerResultJsonl(event('text', 'TRIAD_REVIEW_RESULT: {"decision":}')), /cannot be parsed|incomplete/);
});

test('rejects conflicting duplicate markers and invalid decisions', () => {
  const duplicate = [
    event('text', 'TRIAD_REVIEW_RESULT: {"decision":"approved"}'),
    event('text', 'TRIAD_REVIEW_RESULT: {"decision":"rework"}')
  ].join('\n');
  assert.throws(() => parseReviewerResultJsonl(duplicate), /exactly one result marker/);
  assert.throws(() => parseReviewerResultJsonl(event('text', 'TRIAD_REVIEW_RESULT: {"decision":"maybe"}')), /decision must be/);
});

test('rejects unknown and unbounded result fields', () => {
  assert.throws(() => parseReviewerResultJsonl(event('text', 'TRIAD_REVIEW_RESULT: {"decision":"approved","unexpected":true}')), /unknown fields/);
  assert.throws(() => parseReviewerResultJsonl(event('text', `TRIAD_REVIEW_RESULT: ${JSON.stringify({ decision: 'approved', summary: 'x'.repeat(4001) })}`)), /bounded string/);
});

console.log('Reviewer result normalization contract: PASS');
