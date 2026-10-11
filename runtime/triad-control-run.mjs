#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { nextAction } from './lib/orchestrator-control.mjs';
import { resolveAssignmentContext, validateAssignmentPacket } from './lib/assignment-packet.mjs';
import { calculateCandidateFingerprint } from './lib/fingerprint.mjs';
import { parseReviewerResultJsonl } from './lib/reviewer-result.mjs';
import { validateVerificationEvidence } from './lib/verification-evidence.mjs';

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node runtime/triad-control-run.mjs --config <run.json>\n\nThe config supplies declared role commands and paths; lifecycle decisions come\nonly from runtime/lib/orchestrator-control.mjs and existing verifier/packet contracts.\n`);
  process.exit(exitCode);
}

function fail(message) {
  const error = new Error(message);
  error.code = 'orchestrator_control_invalid';
  throw error;
}

function commandResult(command, { cwd, input = null, env = {} } = {}) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string')) fail('declared command must be a non-empty argv array');
  const start = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    input: input === null ? undefined : `${JSON.stringify(input)}\n`,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const end = Date.now();
  return {
    command,
    cwd,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    start,
    end,
    wall_ms: end - start
  };
}

function lastJsonLine(text) {
  for (const line of text.trim().split('\n').reverse()) {
    if (!line.trim()) continue;
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

async function readJson(file, label) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
}

async function writeOutput(file, value) {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file, value) {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value ?? '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function evidencePathFor(control, assignment) {
  const directory = assignment.evidence_directory
    ? path.resolve(control, assignment.evidence_directory)
    : path.join(control, '.loop', 'evidence', assignment.feature_id, `attempt-${String(assignment.attempt).padStart(3, '0')}`);
  if (!directory.startsWith(`${control}${path.sep}`)) return null;
  return path.join(directory, 'verification.json');
}

function relativeRef(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function verifierEvidenceError(message) {
  return { valid: false, error: `verifier evidence ${message}` };
}

async function loadVerifierEvidence({ control, worktree, assignment, assignmentPath, assignmentSha256, packet, verifierJson }) {
  if (!verifierJson || typeof verifierJson !== 'object' || verifierJson.status !== 'pass') {
    return verifierEvidenceError('did not report a passing run');
  }
  const evidencePath = evidencePathFor(control, assignment);
  if (!evidencePath) return verifierEvidenceError('path escapes the active Control Workspace');
  if (typeof verifierJson.evidence !== 'string' || path.resolve(control, verifierJson.evidence) !== evidencePath) {
    return verifierEvidenceError('path does not match the active attempt');
  }

  let source;
  let evidence;
  try {
    source = await readFile(evidencePath, 'utf8');
    const actualPath = await realpath(evidencePath);
    if (!actualPath.startsWith(`${control}${path.sep}`)) return verifierEvidenceError('resolves outside the active Control Workspace');
    evidence = JSON.parse(source);
  } catch {
    return verifierEvidenceError('is missing or unreadable');
  }
  const contract = validateVerificationEvidence(evidence);
  if (!contract.valid) return verifierEvidenceError(`does not match its schema (${contract.errors.join('; ')})`);

  const expectedRunId = assignment.verification_run_id ?? verifierJson.run_id;
  const identityProblems = [];
  const requireEqual = (label, actual, expected) => {
    if (actual !== expected) identityProblems.push(label);
  };
  let evidenceAssignmentPath = null;
  try {
    evidenceAssignmentPath = await realpath(path.resolve(control, evidence.assignment_ref));
  } catch {}
  requireEqual('run_id', evidence.run_id, expectedRunId);
  requireEqual('verifier run_id', evidence.run_id, verifierJson.run_id);
  requireEqual('status', evidence.status, verifierJson.status);
  requireEqual('feature_id', evidence.feature_id, assignment.feature_id);
  requireEqual('attempt', evidence.attempt, assignment.attempt);
  requireEqual('assignment_id', evidence.assignment_id, assignment.assignment_id);
  requireEqual('assignment_ref', evidenceAssignmentPath, await realpath(assignmentPath));
  requireEqual('assignment_sha256', evidence.assignment_sha256, assignmentSha256);
  requireEqual('trigger.agent_id', evidence.trigger?.agent_id, assignment.agent_id);
  requireEqual('trigger.agent_type', evidence.trigger?.agent_type, assignment.agent_type);
  requireEqual('baseline.prd_sha256', evidence.baseline?.prd_sha256, assignment.expected_prd_sha256);
  requireEqual('baseline.card_sha256', evidence.baseline?.card_sha256, assignment.expected_card_sha256);
  if (assignment.expected_gates_sha256) requireEqual('baseline.gates_sha256', evidence.baseline?.gates_sha256, assignment.expected_gates_sha256);
  if (assignment.expected_branch) requireEqual('baseline.branch', evidence.baseline?.branch, assignment.expected_branch);
  if (evidence.required_gates_passed !== true) identityProblems.push('required_gates_passed');
  if (typeof evidence.baseline?.candidate_fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(evidence.baseline.candidate_fingerprint)) {
    identityProblems.push('baseline.candidate_fingerprint');
  }
  if (identityProblems.length > 0) return verifierEvidenceError(`does not bind to the active assignment, run, or passing candidate (${identityProblems.join(', ')})`);

  const currentCandidate = await calculateCandidateFingerprint(worktree);
  if (currentCandidate.value !== evidence.baseline.candidate_fingerprint) {
    return verifierEvidenceError('candidate fingerprint does not match the current worktree');
  }

  const recordedPacket = evidence.assignment_packet;
  if (packet) {
    if (recordedPacket?.path !== packet.path || recordedPacket?.sha256 !== packet.sha256) {
      return verifierEvidenceError('assignment-packet binding does not match the active packet');
    }
  } else if (recordedPacket !== null && recordedPacket !== undefined) {
    return verifierEvidenceError('contains an unrecognized assignment-packet binding');
  }

  return {
    valid: true,
    evidence,
    source,
    reference: {
      path: relativeRef(control, evidencePath),
      sha256: sha256(source),
      run_id: evidence.run_id,
      feature_id: evidence.feature_id,
      attempt: evidence.attempt,
      assignment_id: evidence.assignment_id,
      assignment_sha256: evidence.assignment_sha256,
      assignment_packet: recordedPacket ?? null,
      candidate_fingerprint: evidence.baseline.candidate_fingerprint,
      required_gates_passed: evidence.required_gates_passed,
      status: evidence.status,
    },
  };
}

async function reviewerResultPathFor(control, configuredRoot, configuredPath) {
  if (typeof configuredPath !== 'string' || configuredPath.length === 0) fail('Reviewer result_file must be configured');
  const configRoot = path.resolve(configuredRoot);
  const configuredAbsolute = path.resolve(configRoot, configuredPath);
  const relative = path.relative(configRoot, configuredAbsolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('Reviewer result_file must stay inside the active Control Workspace');
  }
  const resultPath = path.resolve(control, relative);
  if (!resultPath.startsWith(`${control}${path.sep}`)) fail('Reviewer result_file must stay inside the active Control Workspace');
  await mkdir(path.dirname(resultPath), { recursive: true });
  const parent = await realpath(path.dirname(resultPath));
  if (parent !== control && !parent.startsWith(`${control}${path.sep}`)) fail('Reviewer result_file must stay inside the active Control Workspace');
  try {
    if ((await lstat(resultPath)).isSymbolicLink()) fail('Reviewer result_file must not be a symlink');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resultPath;
}

function reviewerBinding({ control, assignment, assignmentPath, assignmentSha256, packet, verifierEvidence, reviewerResultPath, reviewerResultSha256 }) {
  return {
    schema_version: 2,
    assignment_ref: relativeRef(control, assignmentPath),
    assignment_sha256: assignmentSha256,
    assignment_id: assignment.assignment_id,
    feature_id: assignment.feature_id,
    attempt: assignment.attempt,
    assignment_packet: packet ? { path: packet.path, sha256: packet.sha256 } : null,
    verifier_evidence: verifierEvidence,
    candidate_fingerprint: verifierEvidence.candidate_fingerprint,
    reviewer_result_ref: {
      path: relativeRef(control, reviewerResultPath),
      sha256: reviewerResultSha256,
    },
  };
}

async function reviewerBindingProblem({ control, worktree, assignment, assignmentPath, assignmentSha256, packet, verifierEvidence }) {
  if (sha256(await readFile(assignmentPath)) !== assignmentSha256) return 'assignment changed during Reviewer execution';
  let currentPacket;
  try { currentPacket = await validateAssignmentPacket(assignment, control); }
  catch { return 'assignment packet changed or became invalid during Reviewer execution'; }
  if ((currentPacket?.path ?? null) !== (packet?.path ?? null) || (currentPacket?.sha256 ?? null) !== (packet?.sha256 ?? null)) {
    return 'assignment packet changed during Reviewer execution';
  }
  let currentEvidence;
  try { currentEvidence = await readFile(path.resolve(control, verifierEvidence.path), 'utf8'); }
  catch { return 'verifier evidence disappeared during Reviewer execution'; }
  if (sha256(currentEvidence) !== verifierEvidence.sha256) return 'verifier evidence changed during Reviewer execution';
  const currentCandidate = await calculateCandidateFingerprint(worktree);
  if (currentCandidate.value !== verifierEvidence.candidate_fingerprint) return 'candidate fingerprint changed after verification';
  return null;
}

function tokenTotal(text) {
  let total = null;
  for (const line of text.split('\n')) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'step_finish' && Number.isFinite(parsed?.part?.tokens?.total)) total = parsed.part.tokens.total;
    } catch {}
  }
  return total;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) usage(0);
  const configPath = option(argv, '--config');
  if (!configPath) usage(2);
  const config = await readJson(path.resolve(configPath), 'control run config');
  const control = await realpath(path.resolve(config.project_root));
  const assignmentPath = path.resolve(control, config.assignment);
  const assignment = await readJson(assignmentPath, 'assignment');
  const assignmentSha256 = sha256(await readFile(assignmentPath));
  const outputPath = config.output ? path.resolve(config.output) : path.join(control, '.loop/runtime/deterministic-control-run.json');
  const started = Date.now();
  const trace = [];
  const record = (state, decision) => trace.push({ at: Date.now(), phase: state.phase, action: decision.action, reason: decision.reason });

  // The packet is prepared by normal Triad setup. The driver validates and
  // reuses it; it never rebuilds a packet for a later role.
  const assignmentContext = await resolveAssignmentContext(assignment, { projectRoot: control });
  const packet = await validateAssignmentPacket(assignment, control);
  if (assignmentContext.cwd !== assignmentContext.worktree) fail('assignment context cwd/worktree mismatch');

  let state = {
    phase: 'ready',
    card: { id: assignment.feature_id, status: 'ready', depends_on: [] },
    cards: [{ id: assignment.feature_id, status: 'ready', depends_on: [] }],
    evaluator: { enabled: config.evaluator?.enabled === true },
    delivery: { status: 'pending' }
  };
  let developerResult;
  let verifierResult;
  let reviewerResult;
  let commitResult = null;
  let reviewerTokenTotal = null;
  let developerTokenTotal = null;
  let evaluatorProcess = null;
  let evaluatorContract = null;
  let evaluatorTokenTotal = null;

  let decision = nextAction(state);
  record(state, decision);
  if (decision.action !== 'dispatch_developer') fail(`expected dispatch_developer, got ${decision.action}`);
  developerResult = commandResult(config.developer.command, {
    cwd: assignmentContext.cwd,
    env: config.developer.env
  });
  await writeText(config.developer.output, developerResult.stdout);
  await writeText(config.developer.stderr_output, developerResult.stderr);
  developerTokenTotal = tokenTotal(developerResult.stdout);
  if (developerResult.status !== 0) fail(`Developer command failed with status ${developerResult.status}`);
  state = { ...state, phase: 'developer_complete', assignment: { status: 'completed' } };

  decision = nextAction(state);
  record(state, decision);
  if (decision.action !== 'run_verifier') fail(`expected run_verifier, got ${decision.action}`);
  verifierResult = commandResult(config.verifier.command, {
    cwd: config.verifier.cwd ? path.resolve(config.verifier.cwd) : control,
    input: config.verifier.input,
    env: config.verifier.env
  });
  await writeText(config.verifier.output, verifierResult.stdout);
  await writeText(config.verifier.stderr_output, verifierResult.stderr);
  const verifierJson = lastJsonLine(verifierResult.stdout);
  const verifierEvidenceCheck = verifierResult.status === 0 && verifierJson?.status === 'pass'
    ? await loadVerifierEvidence({ control, worktree: assignmentContext.worktree, assignment, assignmentPath, assignmentSha256, packet, verifierJson })
    : { valid: false, error: 'verifier evidence is unavailable because the verifier did not pass' };
  if (verifierResult.status !== 0 || verifierJson?.status !== 'pass' || !verifierEvidenceCheck.valid) {
    const verifierStatus = verifierResult.status !== 0 || verifierJson?.status !== 'pass'
      ? verifierJson?.status ?? 'invalid_context'
      : 'invalid_context';
    state = {
      ...state,
      phase: 'verifier_result',
      verifier: { status: verifierStatus },
      failure: { kind: config.verifier.failure_kind ?? 'verifier_candidate_failure' },
      retry: config.verifier.retry ?? { kind: config.verifier.failure_kind ?? 'verifier_candidate_failure', allowed: false }
    };
    const stopped = nextAction(state);
    record(state, stopped);
    const output = {
      status: 'stopped_before_review',
      stop_action: stopped,
      trace,
      packet,
      assignment_context: assignmentContext,
      timings: { started, ended: Date.now(), control_wall_ms: Date.now() - started },
      developer: { ...developerResult, stdout: undefined, stderr: undefined, tokens: developerTokenTotal },
      verifier: {
        ...verifierResult,
        stdout: undefined,
        stderr: undefined,
        parsed: verifierJson ? { run_id: verifierJson.run_id ?? null, status: verifierJson.status ?? null } : null,
      },
      verifier_evidence: verifierEvidenceCheck.valid ? verifierEvidenceCheck.reference : null,
      verifier_evidence_error: verifierEvidenceCheck.valid ? null : verifierEvidenceCheck.error,
    };
    await writeOutput(outputPath, output);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = verifierResult.status !== 0 || verifierJson?.status !== 'pass' ? 2 : 3;
    return;
  }

  const verifierEvidence = verifierEvidenceCheck.reference;
  state = { ...state, phase: 'verifier_result', verifier: { status: 'pass' } };
  decision = nextAction(state);
  record(state, decision);
  if (decision.action !== 'dispatch_reviewer') fail(`expected dispatch_reviewer, got ${decision.action}`);
  reviewerResult = commandResult(config.reviewer.command, {
    cwd: config.reviewer.cwd ? path.resolve(config.reviewer.cwd) : assignmentContext.cwd,
    env: config.reviewer.env
  });
  await writeText(config.reviewer.output, reviewerResult.stdout);
  await writeText(config.reviewer.stderr_output, reviewerResult.stderr);
  reviewerTokenTotal = tokenTotal(reviewerResult.stdout);
  if (reviewerResult.status !== 0) fail(`Reviewer command failed with status ${reviewerResult.status}`);
  state = { ...state, phase: 'reviewer_active', reviewer: { status: 'completed' } };
  decision = nextAction(state);
  record(state, decision);
  if (decision.action !== 'collect_reviewer_result') fail(`expected collect_reviewer_result, got ${decision.action}`);

  let reviewerContract;
  try {
    const boundSkillPaths = Array.isArray(packet?.metadata?.mandatory_skills)
      ? packet.metadata.mandatory_skills.map((skill) => skill?.path).filter(Boolean)
      : Array.isArray(assignment.required_repository_skills)
        ? assignment.required_repository_skills.map((skill) => skill?.path).filter(Boolean)
        : [];
    reviewerContract = parseReviewerResultJsonl(reviewerResult.stdout, { boundSkillPaths });
  } catch (error) {
    if (error?.code === 'reviewer_result_invalid') throw error;
    fail(error.message);
  }
  const bindingProblem = await reviewerBindingProblem({
    control,
    worktree: assignmentContext.worktree,
    assignment,
    assignmentPath,
    assignmentSha256,
    packet,
    verifierEvidence,
  });
  if (bindingProblem) {
    const invalidState = { ...state, phase: 'verifier_result', verifier: { status: 'mismatch' } };
    const stopped = nextAction(invalidState);
    record(invalidState, stopped);
    const output = {
      status: 'stopped_after_review',
      stop_action: stopped,
      provenance_error: bindingProblem,
      trace,
      packet,
      assignment_context: assignmentContext,
      verifier_evidence: verifierEvidence,
      reviewer: reviewerContract,
      timings: { started, ended: Date.now(), control_wall_ms: Date.now() - started },
    };
    await writeOutput(outputPath, output);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 3;
    return;
  }

  // Persist only after the result is bound to the unchanged assignment,
  // verifier evidence, and candidate. The result is never an input that can
  // override the streamed role output.
  const reviewerResultPath = await reviewerResultPathFor(control, config.project_root, config.reviewer.result_file);
  await writeOutput(reviewerResultPath, reviewerContract);
  const reviewerResultSource = await readFile(reviewerResultPath);
  const reviewerBindingRecord = reviewerBinding({
    control,
    assignment,
    assignmentPath,
    assignmentSha256,
    packet,
    verifierEvidence,
    reviewerResultPath,
    reviewerResultSha256: sha256(reviewerResultSource),
  });

  // Persist a bound Reviewer result before an approved verdict can reach the
  // commit transition. The result contains the bounded contract, not a private
  // model transcript.
  await writeOutput(outputPath, {
    status: 'review_pending_commit',
    trace,
    packet,
    assignment_context: assignmentContext,
    verifier_evidence: verifierEvidence,
    reviewer: reviewerContract,
    reviewer_binding: reviewerBindingRecord,
  });
  state = { ...state, phase: 'reviewer_result', reviewer: { verdict: reviewerContract.decision } };
  if (reviewerContract.decision !== 'approved') {
    const stopped = nextAction({ ...state, retry: config.reviewer.retry ?? { kind: 'reviewer_rework', allowed: false } });
    record(state, stopped);
    const output = {
      status: 'stopped_after_review',
      stop_action: stopped,
      reviewer: reviewerContract,
      reviewer_binding: reviewerBindingRecord,
      verifier_evidence: verifierEvidence,
      trace,
      packet,
      timings: { started, ended: Date.now(), control_wall_ms: Date.now() - started },
    };
    await writeOutput(outputPath, output);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 2;
    return;
  }

  decision = nextAction(state);
  record(state, decision);
  if (decision.action !== 'commit_approved_card') fail(`expected commit_approved_card, got ${decision.action}`);
  if (config.commit?.command) {
    commitResult = commandResult(config.commit.command, { cwd: config.commit.cwd ? path.resolve(config.commit.cwd) : assignmentContext.cwd, env: config.commit.env });
    if (commitResult.status !== 0) fail(`commit command failed with status ${commitResult.status}`);
  }
  const committedCards = [{ id: assignment.feature_id, status: 'approved', depends_on: [] }];
  state = { ...state, phase: 'card_committed', cards: committedCards, card: committedCards[0] };
  decision = nextAction(state);
  record(state, decision);
  if (decision.action === 'dispatch_evaluator') {
    if (!config.evaluator?.command || !config.evaluator?.result_file) fail('Evaluator+ is enabled but no explicit evaluator command/result_file is configured');
    evaluatorProcess = commandResult(config.evaluator.command, {
      cwd: config.evaluator.cwd ? path.resolve(config.evaluator.cwd) : control,
      input: config.evaluator.input,
      env: config.evaluator.env
    });
    evaluatorTokenTotal = tokenTotal(evaluatorProcess.stdout);
    await writeText(config.evaluator.output, evaluatorProcess.stdout);
    await writeText(config.evaluator.stderr_output, evaluatorProcess.stderr);
    if (evaluatorProcess.status !== 0) fail(`Evaluator+ command failed with status ${evaluatorProcess.status}`);
    state = { ...state, phase: 'evaluator_active', evaluator: { enabled: true, status: 'completed' } };
    decision = nextAction(state);
    record(state, decision);
    if (decision.action !== 'collect_evaluator_result') fail(`expected collect_evaluator_result, got ${decision.action}`);
    evaluatorContract = await readJson(path.resolve(config.evaluator.result_file), 'Evaluator+ result');
    if (!['PASS', 'FAIL', 'INDETERMINATE'].includes(evaluatorContract.verdict)) fail('Evaluator+ result verdict must be PASS, FAIL, or INDETERMINATE');
    state = { ...state, phase: 'evaluator_result', evaluator: { enabled: true, verdict: evaluatorContract.verdict } };
    decision = nextAction(state);
    record(state, decision);
  }
  if (decision.action !== 'close_delivery') fail(`expected close_delivery, got ${decision.action}`);
  state = { ...state, phase: 'delivery_result', delivery: { status: 'pass' } };
  decision = nextAction(state);
  record(state, decision);
  if (decision.action !== 'done') fail(`expected done, got ${decision.action}`);

  const ended = Date.now();
  const output = {
    status: 'done',
    trace,
    packet,
    assignment_context: assignmentContext,
    verifier_evidence: verifierEvidence,
    reviewer: reviewerContract,
    reviewer_binding: reviewerBindingRecord,
    timings: {
      started,
      ended,
      control_wall_ms: ended - started,
      developer_wall_ms: developerResult.wall_ms,
      verifier_wall_ms: verifierResult.wall_ms,
      reviewer_wall_ms: reviewerResult.wall_ms,
      control_outside_children_ms: ended - started - developerResult.wall_ms - verifierResult.wall_ms - reviewerResult.wall_ms
    },
    tokens: {
      coordinator: 0,
      developer: developerTokenTotal,
      reviewer: reviewerTokenTotal,
      evaluator: evaluatorTokenTotal,
      comparable_total: [developerTokenTotal, reviewerTokenTotal, evaluatorTokenTotal].every((value) => value === null || Number.isFinite(value))
        ? [developerTokenTotal, reviewerTokenTotal, evaluatorTokenTotal].filter(Number.isFinite).reduce((sum, value) => sum + value, 0)
        : null
    },
    developer: { status: developerResult.status, output: config.developer.output ?? null },
    verifier: { status: verifierResult.status, parsed: verifierJson, output: config.verifier.output ?? null },
    reviewer_process: { status: reviewerResult.status, output: config.reviewer.output ?? null },
    evaluator: evaluatorContract ? { verdict: evaluatorContract.verdict, output: config.evaluator.output ?? null } : null,
    commit: commitResult ? { status: commitResult.status, stdout: commitResult.stdout.trim() } : null,
    delivery: { status: 'pass', evaluator: 'disabled' }
  };
  await writeOutput(outputPath, output);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
  process.exitCode = 1;
});
