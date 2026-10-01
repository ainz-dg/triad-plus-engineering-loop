#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { nextAction } from './lib/orchestrator-control.mjs';
import { resolveAssignmentContext, validateAssignmentPacket } from './lib/assignment-packet.mjs';
import { parseReviewerResultJsonl } from './lib/reviewer-result.mjs';

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
  const control = path.resolve(config.project_root);
  const assignmentPath = path.resolve(control, config.assignment);
  const assignment = await readJson(assignmentPath, 'assignment');
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
  if (verifierResult.status !== 0 || verifierJson?.status !== 'pass') {
    state = {
      ...state,
      phase: 'verifier_result',
      verifier: { status: verifierJson?.status ?? 'invalid_context' },
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
      verifier: { ...verifierResult, stdout: undefined, stderr: undefined, parsed: verifierJson }
    };
    await writeOutput(outputPath, output);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 2;
    return;
  }

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
  // Persist the validated native result for auditability; it is never an
  // input that can override the streamed role output.
  await writeOutput(config.reviewer.result_file, reviewerContract);
  state = { ...state, phase: 'reviewer_result', reviewer: { verdict: reviewerContract.decision } };
  if (reviewerContract.decision !== 'approved') {
    const stopped = nextAction({ ...state, retry: config.reviewer.retry ?? { kind: 'reviewer_rework', allowed: false } });
    record(state, stopped);
    const output = { status: 'stopped_after_review', stop_action: stopped, reviewer: reviewerContract, trace, packet, timings: { started, ended: Date.now(), control_wall_ms: Date.now() - started } };
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
    reviewer: reviewerContract,
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
