/**
 * Host-independent lifecycle decisions for the Triad Orchestrator.
 *
 * This module is intentionally pure: it consumes already validated control
 * state and returns one mechanical action. It does not read product prose,
 * invoke a host, interpret a role report, or mutate run state. Runtime/adapter
 * drivers apply the returned action and feed their validated result back into
 * the next call.
 */

export const controlActions = Object.freeze([
  'dispatch_developer',
  'wait_for_developer',
  'run_verifier',
  'dispatch_reviewer',
  'wait_for_reviewer',
  'collect_reviewer_result',
  'start_rework_attempt',
  'commit_approved_card',
  'select_next_card',
  'dispatch_evaluator',
  'wait_for_evaluator',
  'collect_evaluator_result',
  'close_delivery',
  'owner_escalation',
  'semantic_escalation',
  'blocked',
  'done'
]);

const actionSet = new Set(controlActions);
const terminalCardStates = new Set(['approved', 'blocked', 'done']);
const validReviewVerdicts = new Set(['approved', 'rework', 'blocked']);
const validEvaluatorVerdicts = new Set(['PASS', 'FAIL', 'INDETERMINATE']);

function decision(action, reason, details = {}) {
  if (!actionSet.has(action)) throw new Error(`Unknown orchestrator control action: ${action}`);
  return Object.freeze({ action, reason, ...details });
}

function invalidState(reason, details = {}) {
  return decision('semantic_escalation', reason, { ...details, fail_closed: true });
}

function dependencyReady(card, cards) {
  if (!card || card.status !== 'ready') return false;
  const dependencies = Array.isArray(card.depends_on) ? card.depends_on : [];
  const byId = new Map(cards.filter(Boolean).map((item) => [item.id, item]));
  return dependencies.every((id) => byId.get(id)?.status === 'approved' || byId.get(id)?.status === 'done');
}

function nextReadyCard(cards = []) {
  return cards.find((card) => dependencyReady(card, cards)) ?? null;
}

function allRequiredCardsTerminal(cards = []) {
  const required = cards.filter((card) => card?.required !== false);
  return required.length > 0 && required.every((card) => terminalCardStates.has(card.status));
}

function retryDecision(state, kind) {
  const retry = state.retry;
  if (!retry || typeof retry !== 'object' || retry.kind !== kind) {
    return invalidState('retry_policy_result_missing', { retry_kind: kind });
  }
  if (retry.allowed === true) {
    return decision('start_rework_attempt', `${kind}_retry_allowed`, {
      retry_kind: kind,
      budget_family: retry.family ?? null,
      previous_automatic_transitions: retry.previous_automatic_transitions ?? null,
      maximum: retry.maximum ?? null
    });
  }
  return decision('semantic_escalation', `${kind}_retry_exhausted`, {
    retry_kind: kind,
    budget_family: retry.family ?? null,
    previous_automatic_transitions: retry.previous_automatic_transitions ?? null,
    maximum: retry.maximum ?? null,
    fail_closed: true
  });
}

function selectAfterCommit(state) {
  const cards = Array.isArray(state.cards) ? state.cards : [];
  const blocked = cards.find((card) => card?.required !== false && card.status === 'blocked');
  if (blocked) return decision('blocked', 'required_card_blocked', { card_id: blocked.id, fail_closed: true });
  const next = nextReadyCard(cards);
  if (next) return decision('select_next_card', 'dependency_ready_card_available', { card_id: next.id });
  if (!allRequiredCardsTerminal(cards)) {
    return decision('owner_escalation', 'required_cards_incomplete_without_ready_card', { fail_closed: true });
  }
  if (state.evaluator?.enabled === true) {
    if (state.evaluator.status === 'active' || state.evaluator.status === 'pending') {
      return decision('wait_for_evaluator', 'evaluator_active');
    }
    if (state.evaluator.status === 'completed') {
      return invalidState('evaluator_result_missing');
    }
    return decision('dispatch_evaluator', 'all_required_cards_approved_evaluator_enabled');
  }
  return decision('close_delivery', 'all_required_cards_terminal');
}

/**
 * Return the next mechanical lifecycle action for validated state.
 *
 * The caller must supply role results and retry-accounting decisions after
 * validating them with the existing runtime contracts. Missing or ambiguous
 * state is deliberately escalated instead of guessed.
 */
export function nextAction(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return invalidState('control_state_invalid');
  if (state.semantic_boundary?.required === true) {
    return decision('semantic_escalation', state.semantic_boundary.reason || 'semantic_boundary_requires_governance', { fail_closed: true });
  }

  const phase = state.phase;
  switch (phase) {
    case 'ready': {
      if (!state.card?.id) return invalidState('ready_card_missing');
      if (state.assignment?.status === 'active') return decision('wait_for_developer', 'developer_assignment_active', { card_id: state.card.id });
      if (state.card.status !== 'ready') return invalidState('card_not_ready_for_dispatch', { card_id: state.card.id });
      return decision('dispatch_developer', 'ready_card_selected', { card_id: state.card.id });
    }

    case 'developer_active': {
      if (!state.assignment || !state.card?.id) return invalidState('developer_assignment_context_missing');
      if (state.assignment.status === 'active') return decision('wait_for_developer', 'developer_assignment_active', { card_id: state.card.id });
      if (state.assignment.status === 'completed') return decision('run_verifier', 'developer_completed', { card_id: state.card.id });
      if (state.assignment.status === 'failed') {
        return state.failure?.kind ? retryDecision(state, state.failure.kind) : invalidState('developer_failure_unclassified');
      }
      return invalidState('developer_assignment_status_invalid');
    }

    case 'developer_complete':
      return state.card?.id ? decision('run_verifier', 'developer_completed', { card_id: state.card.id }) : invalidState('developer_completion_card_missing');

    case 'verifying':
      if (state.verifier?.status === 'active' || state.verifier?.status === 'pending') return decision('run_verifier', 'verifier_pending');
      if (state.verifier?.status === 'pass') return decision('dispatch_reviewer', 'verifier_passed', { card_id: state.card?.id ?? null });
      if (state.verifier?.status === 'invalid_context' || state.verifier?.status === 'stale' || state.verifier?.status === 'mismatch') {
        return decision('semantic_escalation', 'verifier_evidence_invalid', { fail_closed: true });
      }
      if (state.verifier?.status === 'fail') {
        return state.failure?.kind ? retryDecision(state, state.failure.kind) : invalidState('verifier_failure_unclassified');
      }
      return invalidState('verifier_result_missing');

    case 'verifier_result': {
      const status = state.verifier?.status;
      if (status === 'pass') return decision('dispatch_reviewer', 'verifier_passed', { card_id: state.card?.id ?? null });
      if (status === 'invalid_context' || status === 'stale' || status === 'mismatch') return decision('semantic_escalation', 'verifier_evidence_invalid', { fail_closed: true });
      if (status === 'fail') return state.failure?.kind ? retryDecision(state, state.failure.kind) : invalidState('verifier_failure_unclassified');
      return invalidState('verifier_result_invalid');
    }

    case 'reviewer_active':
      if (state.reviewer?.status === 'active' || state.reviewer?.status === 'pending') return decision('wait_for_reviewer', 'reviewer_assignment_active', { card_id: state.card?.id ?? null });
      if (state.reviewer?.status === 'completed') return decision('collect_reviewer_result', 'reviewer_completed_result_pending');
      return invalidState('reviewer_assignment_status_invalid');

    case 'reviewer_result': {
      const verdict = state.reviewer?.verdict;
      if (!validReviewVerdicts.has(verdict)) return invalidState('reviewer_verdict_invalid');
      if (verdict === 'approved') return decision('commit_approved_card', 'reviewer_approved', { card_id: state.card?.id ?? null });
      if (verdict === 'rework') return retryDecision(state, 'reviewer_rework');
      return decision('blocked', 'reviewer_blocked', { card_id: state.card?.id ?? null, fail_closed: true });
    }

    case 'card_committed':
      return selectAfterCommit(state);

    case 'evaluator_active':
      if (state.evaluator?.status === 'active' || state.evaluator?.status === 'pending') return decision('wait_for_evaluator', 'evaluator_active');
      if (state.evaluator?.status === 'completed') return decision('collect_evaluator_result', 'evaluator_result_pending_validation');
      return invalidState('evaluator_status_invalid');

    case 'evaluator_result':
      if (!validEvaluatorVerdicts.has(state.evaluator?.verdict)) return invalidState('evaluator_result_invalid', { fail_closed: true });
      return decision('close_delivery', 'evaluator_result_cannot_reopen_triad', { evaluator_verdict: state.evaluator.verdict });

    case 'delivery_result':
      if (state.delivery?.status === 'pass') return decision('done', 'delivery_closure_passed');
      if (state.delivery?.status === 'fail' || state.delivery?.status === 'indeterminate') {
        return decision('blocked', 'delivery_closure_not_satisfied', { fail_closed: true });
      }
      return invalidState('delivery_result_invalid');

    case 'semantic_boundary':
      return decision('semantic_escalation', state.reason || 'semantic_boundary_requires_governance', { fail_closed: true });

    default:
      return invalidState('control_phase_invalid', { phase: phase ?? null });
  }
}

export { allRequiredCardsTerminal, dependencyReady, nextReadyCard };
