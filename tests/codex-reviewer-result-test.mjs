import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexReviewerResultJsonl } from '../adapters/codex/reviewer-result.mjs';

function event(item) {
  return JSON.stringify({ type: 'item.completed', item });
}

test('extracts only one Codex agent-message Reviewer result', () => {
  const source = [
    event({ type: 'reasoning', text: 'TRIAD_REVIEW_RESULT: {"decision":"blocked"}' }),
    event({ type: 'command_execution', aggregated_output: 'TRIAD_REVIEW_RESULT: {"decision":"rework"}' }),
    event({ type: 'agent_message', text: 'Independent review. TRIAD_REVIEW_RESULT: {"decision":"approved","evidence_refs":["verification.json"]}' })
  ].join('\n');
  assert.deepEqual(parseCodexReviewerResultJsonl(source), { decision: 'approved', evidence_refs: ['verification.json'] });
});

test('rejects missing, malformed, and duplicate Codex results', () => {
  assert.throws(() => parseCodexReviewerResultJsonl(event({ type: 'agent_message', text: 'approved' })), /exactly one result marker/);
  assert.throws(() => parseCodexReviewerResultJsonl(event({ type: 'agent_message', text: 'TRIAD_REVIEW_RESULT: {"decision":}' })), /cannot be parsed|incomplete/);
  const duplicate = [
    event({ type: 'agent_message', text: 'TRIAD_REVIEW_RESULT: {"decision":"approved"}' }),
    event({ type: 'agent_message', text: 'TRIAD_REVIEW_RESULT: {"decision":"blocked"}' })
  ].join('\n');
  assert.throws(() => parseCodexReviewerResultJsonl(duplicate), /exactly one result marker/);
});

console.log('Codex Reviewer result normalization contract: PASS');

