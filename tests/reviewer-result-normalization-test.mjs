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

test('accepts a complete bound-skill compliance attestation', () => {
  const result = parseReviewerResultJsonl(event('text', `TRIAD_REVIEW_RESULT: ${JSON.stringify({
    decision: 'approved',
    skill_compliance: [{
      path: '.agents/skills/component-workflow/SKILL.md',
      rule: 'Red Flags / shared behavior placement',
      status: 'compliant',
      evidence_refs: ['src/components/Foo.tsx']
    }]
  })}`), { boundSkillPaths: ['.agents/skills/component-workflow/SKILL.md'] });
  assert.equal(result.skill_compliance[0].status, 'compliant');
});

test('rejects incomplete, violated, duplicate, unknown, and invalid skill compliance', () => {
  const bound = ['.agents/skills/router/SKILL.md'];
  const parse = (value) => parseReviewerResultJsonl(event('text', `TRIAD_REVIEW_RESULT: ${JSON.stringify(value)}`), { boundSkillPaths: bound });
  assert.throws(() => parse({ decision: 'approved' }), /cover every bound repository skill/);
  assert.throws(() => parse({ decision: 'approved', skill_compliance: [{ path: bound[0], rule: 'rule', status: 'violated' }] }), /cannot contain violated/);
  assert.throws(() => parse({ decision: 'approved', skill_compliance: [
    { path: bound[0], rule: 'rule', status: 'compliant' },
    { path: bound[0], rule: 'rule-2', status: 'compliant' }
  ] }), /paths must be unique/);
  assert.throws(() => parse({ decision: 'approved', skill_compliance: [{ path: bound[0], rule: 'rule', status: 'unknown' }] }), /status must be/);
  assert.throws(() => parse({ decision: 'approved', skill_compliance: [{ path: bound[0], rule: 'rule', status: 'compliant', extra: true }] }), /unknown fields/);
  assert.throws(() => parse({ decision: 'approved', skill_compliance: [{ path: '.agents/skills/other/SKILL.md', rule: 'rule', status: 'compliant' }] }), /not a bound/);
});

test('legacy results remain valid and rework/blocked may report violations', () => {
  assert.deepEqual(parseReviewerResultJsonl(event('text', 'TRIAD_REVIEW_RESULT: {"decision":"approved"}')), { decision: 'approved' });
  for (const decision of ['rework', 'blocked']) {
    const result = parseReviewerResultJsonl(event('text', `TRIAD_REVIEW_RESULT: ${JSON.stringify({
      decision,
      skill_compliance: [{ path: '.agents/skills/router/SKILL.md', rule: 'rule', status: 'violated' }]
    })}`), { boundSkillPaths: ['.agents/skills/router/SKILL.md'] });
    assert.equal(result.decision, decision);
  }
});

console.log('Reviewer result normalization contract: PASS');
