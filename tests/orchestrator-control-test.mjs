import assert from 'node:assert/strict';
import test from 'node:test';
import { controlActions, nextAction } from '../runtime/lib/orchestrator-control.mjs';

const card = (status = 'ready', id = 'CARD-001', depends_on = []) => ({ id, status, depends_on });

test('control action set is closed and dispatches a ready card', () => {
  assert.ok(controlActions.includes('dispatch_developer'));
  assert.deepEqual(nextAction({ phase: 'ready', card: card() }), {
    action: 'dispatch_developer',
    reason: 'ready_card_selected',
    card_id: 'CARD-001'
  });
});

test('active Developer waits and completion reaches the verifier', () => {
  assert.equal(nextAction({ phase: 'developer_active', card: card('in_progress'), assignment: { status: 'active' } }).action, 'wait_for_developer');
  assert.equal(nextAction({ phase: 'developer_active', card: card('in_progress'), assignment: { status: 'completed' } }).action, 'run_verifier');
  assert.equal(nextAction({ phase: 'developer_complete', card: card('in_progress') }).action, 'run_verifier');
});

test('verifier PASS reaches an independent Reviewer', () => {
  const result = nextAction({ phase: 'verifier_result', card: card('verifying'), verifier: { status: 'pass' } });
  assert.equal(result.action, 'dispatch_reviewer');
  assert.equal(result.reason, 'verifier_passed');
});

test('candidate and runtime failures use the already validated retry family', () => {
  const candidate = nextAction({
    phase: 'verifier_result',
    verifier: { status: 'fail' },
    failure: { kind: 'verifier_candidate_failure' },
    retry: { kind: 'verifier_candidate_failure', family: 'candidate_remediation', allowed: true, previous_automatic_transitions: 0, maximum: 2 }
  });
  assert.equal(candidate.action, 'start_rework_attempt');
  assert.equal(candidate.retry_kind, 'verifier_candidate_failure');

  const runtime = nextAction({
    phase: 'verifier_result',
    verifier: { status: 'fail' },
    failure: { kind: 'runtime_recovery' },
    retry: { kind: 'runtime_recovery', family: 'runtime', allowed: true, previous_automatic_transitions: 1, maximum: 2 }
  });
  assert.equal(runtime.action, 'start_rework_attempt');
  assert.equal(runtime.budget_family, 'runtime');
});

test('invalid, stale, and mismatched verifier evidence fail closed without a Reviewer', () => {
  for (const status of ['invalid_context', 'stale', 'mismatch']) {
    const result = nextAction({ phase: 'verifier_result', verifier: { status } });
    assert.equal(result.action, 'semantic_escalation');
    assert.equal(result.fail_closed, true);
  }
});

test('reviewer approval commits then selects the next dependency-ready card', () => {
  assert.equal(nextAction({ phase: 'reviewer_result', card: card('in_review'), reviewer: { verdict: 'approved' } }).action, 'commit_approved_card');
  const result = nextAction({
    phase: 'card_committed',
    cards: [card('approved', 'CARD-001'), card('ready', 'CARD-002', ['CARD-001'])]
  });
  assert.deepEqual(result, { action: 'select_next_card', reason: 'dependency_ready_card_available', card_id: 'CARD-002' });
});

test('reviewer rework creates a new attempt and blocked reviewer escalates', () => {
  const rework = nextAction({
    phase: 'reviewer_result',
    reviewer: { verdict: 'rework' },
    retry: { kind: 'reviewer_rework', family: 'candidate_remediation', allowed: true, previous_automatic_transitions: 0, maximum: 2 }
  });
  assert.equal(rework.action, 'start_rework_attempt');
  assert.equal(nextAction({ phase: 'reviewer_result', reviewer: { verdict: 'blocked' } }).action, 'blocked');
});

test('retry exhaustion escalates the exact policy family', () => {
  const result = nextAction({
    phase: 'reviewer_result',
    reviewer: { verdict: 'rework' },
    retry: { kind: 'reviewer_rework', family: 'candidate_remediation', allowed: false, previous_automatic_transitions: 2, maximum: 2 }
  });
  assert.equal(result.action, 'semantic_escalation');
  assert.equal(result.retry_kind, 'reviewer_rework');
  assert.equal(result.fail_closed, true);
});

test('no ready card with incomplete required work is truthful owner escalation', () => {
  const result = nextAction({ phase: 'card_committed', cards: [card('approved', 'CARD-001'), card('in_progress', 'CARD-002')] });
  assert.equal(result.action, 'owner_escalation');
  assert.equal(result.fail_closed, true);
});

test('all approved cards close directly when Evaluator+ is disabled', () => {
  const result = nextAction({
    phase: 'card_committed',
    cards: [card('approved')],
    evaluator: { enabled: false }
  });
  assert.equal(result.action, 'close_delivery');
});

test('Evaluator+ is dispatched once, collected, and cannot reopen Triad', () => {
  const dispatch = nextAction({ phase: 'card_committed', cards: [card('approved')], evaluator: { enabled: true } });
  assert.equal(dispatch.action, 'dispatch_evaluator');
  assert.equal(nextAction({ phase: 'card_committed', cards: [card('approved')], evaluator: { enabled: true, status: 'active' } }).action, 'wait_for_evaluator');
  assert.equal(nextAction({ phase: 'card_committed', cards: [card('approved')], evaluator: { enabled: true, status: 'completed' } }).action, 'semantic_escalation');
  assert.equal(nextAction({ phase: 'evaluator_active', evaluator: { enabled: true, status: 'active' } }).action, 'wait_for_evaluator');
  assert.equal(nextAction({ phase: 'evaluator_active', evaluator: { enabled: true, status: 'completed' } }).action, 'collect_evaluator_result');
  for (const verdict of ['PASS', 'FAIL', 'INDETERMINATE']) {
    const result = nextAction({ phase: 'evaluator_result', evaluator: { verdict } });
    assert.equal(result.action, 'close_delivery');
    assert.match(result.reason, /cannot_reopen/);
  }
});

test('a blocked required card never proceeds to Evaluator+ or delivery', () => {
  const result = nextAction({
    phase: 'card_committed',
    cards: [card('approved', 'CARD-001'), card('blocked', 'CARD-002'), card('ready', 'CARD-003')],
    evaluator: { enabled: true }
  });
  assert.deepEqual(result, { action: 'blocked', reason: 'required_card_blocked', card_id: 'CARD-002', fail_closed: true });
});

test('delivery closure only becomes done after validated PASS', () => {
  assert.equal(nextAction({ phase: 'delivery_result', delivery: { status: 'pass' } }).action, 'done');
  assert.equal(nextAction({ phase: 'delivery_result', delivery: { status: 'fail' } }).action, 'blocked');
  assert.equal(nextAction({ phase: 'delivery_result', delivery: { status: 'indeterminate' } }).action, 'blocked');
});

test('semantic-boundary state escalates instead of guessing', () => {
  const result = nextAction({ phase: 'semantic_boundary', reason: 'reviewer finding changes product intent' });
  assert.deepEqual(result, {
    action: 'semantic_escalation',
    reason: 'reviewer finding changes product intent',
    fail_closed: true
  });
  assert.equal(nextAction({ semantic_boundary: { required: true, reason: 'architecture decision required' }, phase: 'ready', card: card() }).action, 'semantic_escalation');
});

console.log('Orchestrator deterministic control contract: PASS');
