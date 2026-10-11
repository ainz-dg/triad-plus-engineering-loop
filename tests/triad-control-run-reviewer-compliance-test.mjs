import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const packetCli = path.join(repositoryRoot, 'runtime', 'triad-assignment-packet.mjs');
const verifierCli = path.join(repositoryRoot, 'runtime', 'triad-verify.mjs');
const controlRun = path.join(repositoryRoot, 'runtime', 'triad-control-run.mjs');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return result;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(root, reviewerPayload, { verifierMode = 'real', mutateCandidateInReviewer = false } = {}) {
  const control = path.join(root, 'control');
  const product = path.join(control, 'product');
  const assignmentDir = path.join(control, '.loop', 'runtime', 'assignments');
  await mkdir(path.join(control, 'artifacts'), { recursive: true });
  await mkdir(path.join(control, 'features'), { recursive: true });
  await mkdir(assignmentDir, { recursive: true });
  await mkdir(path.join(product, '.agents', 'skills', 'router'), { recursive: true });
  await writeFile(path.join(product, 'candidate.txt'), 'baseline\n');
  const skill = path.join(product, '.agents', 'skills', 'router', 'SKILL.md');
  await writeFile(skill, '# Router skill\n\nKeep shared behavior in the component layer.\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'triad-test@example.invalid'], ['config', 'user.name', 'Triad Test'], ['add', '.'], ['commit', '-qm', 'baseline']]) {
    const result = run('git', args, product);
    assert.equal(result.status, 0, result.stderr);
  }
  const branch = run('git', ['branch', '--show-current'], product).stdout.trim();
  const controlRoot = path.resolve(control);
  const productRoot = path.resolve(product);
  const prdPath = path.join(control, 'artifacts', 'prd.md');
  const cardPath = path.join(control, 'features', 'COMPLIANCE-001.md');
  const gatesPath = path.join(control, '.loop', 'quality-gates.yaml');
  await writeFile(prdPath, '# Fixture PRD\n');
  await writeFile(cardPath, '# COMPLIANCE-001\n\n## Outcome and scope\n\nBounded result.\n\n## Acceptance criteria\n\n- Result is verified.\n');
  await mkdir(path.dirname(gatesPath), { recursive: true });
  await writeFile(gatesPath, 'version: 2\ngates: []\n');
  const assignment = {
    schema_version: 1,
    assignment_id: 'compliance-assignment-001',
    status: 'active',
    agent_id: 'developer-compliance-001',
    agent_type: 'triad_developer',
    feature_id: 'COMPLIANCE-001',
    attempt: 1,
    project_root: controlRoot,
    worktree: productRoot,
    expected_branch: branch,
    repository_id: 'product',
    prd_path: 'artifacts/prd.md',
    card_path: 'features/COMPLIANCE-001.md',
    gates_path: '.loop/quality-gates.yaml',
    expected_prd_sha256: digest(await readFile(prdPath)),
    expected_card_sha256: digest(await readFile(cardPath)),
    expected_gates_sha256: digest(await readFile(gatesPath)),
    required_repository_skills: [{ path: '.agents/skills/router/SKILL.md', sha256: digest(await readFile(skill)) }],
    verification_run_id: 'run-compliance-001',
    evidence_directory: '.loop/evidence/COMPLIANCE-001/attempt-001',
    context: {
      relevant_prd_excerpts: ['# Fixture PRD'],
      acceptance_criteria: ['Result is verified.'],
      verification_mapping: ['AC-1 → deterministic fixture verifier'],
      expected_paths: ['candidate.txt'],
      constraints: ['Keep the skill contract intact.']
    }
  };
  const assignmentPath = path.join(assignmentDir, `${assignment.agent_id}.json`);
  await writeJson(assignmentPath, assignment);
  const packet = run(process.execPath, [packetCli, '--project', controlRoot, '--assignment', assignmentPath], controlRoot);
  assert.equal(packet.status, 0, packet.stderr);
  const developer = path.join(root, 'developer.mjs');
  const verifier = path.join(root, 'verifier.mjs');
  const reviewer = path.join(root, 'reviewer.mjs');
  const commit = path.join(root, 'commit.mjs');
  const marker = path.join(product, 'commit-marker.txt');
  const reviewerStarted = path.join(root, 'reviewer-started.txt');
  await writeFile(developer, 'process.exit(0);\n');
  const verifierInput = {
    event: 'manual_explicit_dispatch',
    agent_id: assignment.agent_id,
    agent_type: assignment.agent_type,
    run_id: assignment.verification_run_id,
  };
  const realVerifierCommand = [
    process.execPath,
    verifierCli,
    '--project', controlRoot,
    '--assignment', assignmentPath,
    '--run-id', assignment.verification_run_id,
  ];
  let verifierCommand = realVerifierCommand;
  if (verifierMode === 'missing-evidence') {
    await writeFile(verifier, `console.log(JSON.stringify({status:'pass',run_id:${JSON.stringify(assignment.verification_run_id)},evidence:${JSON.stringify(path.join(control, '.loop/evidence/COMPLIANCE-001/attempt-001/verification.json'))}}));\n`);
    verifierCommand = [process.execPath, verifier];
  } else if (verifierMode === 'mismatched-assignment') {
    await writeFile(verifier, `
      const { spawnSync } = await import('node:child_process');
      const { readFile, writeFile } = await import('node:fs/promises');
      const child = spawnSync(${JSON.stringify(process.execPath)}, ${JSON.stringify(realVerifierCommand.slice(1))}, {
        input: ${JSON.stringify(`${JSON.stringify(verifierInput)}\n`)}, encoding: 'utf8'
      });
      if (child.status !== 0) { process.stderr.write(child.stderr); process.exit(child.status ?? 1); }
      const evidencePath = ${JSON.stringify(path.join(control, '.loop/evidence/COMPLIANCE-001/attempt-001/verification.json'))};
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
      evidence.assignment_id = 'another-project-assignment';
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\\n');
      process.stdout.write(child.stdout);
    `);
    verifierCommand = [process.execPath, verifier];
  } else if (verifierMode === 'mismatched-candidate') {
    await writeFile(verifier, `
      const { spawnSync } = await import('node:child_process');
      const { readFile, writeFile } = await import('node:fs/promises');
      const child = spawnSync(${JSON.stringify(process.execPath)}, ${JSON.stringify(realVerifierCommand.slice(1))}, {
        input: ${JSON.stringify(`${JSON.stringify(verifierInput)}\n`)}, encoding: 'utf8'
      });
      if (child.status !== 0) { process.stderr.write(child.stderr); process.exit(child.status ?? 1); }
      const evidencePath = ${JSON.stringify(path.join(control, '.loop/evidence/COMPLIANCE-001/attempt-001/verification.json'))};
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
      evidence.baseline.candidate_fingerprint = '0'.repeat(64);
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\\n');
      process.stdout.write(child.stdout);
    `);
    verifierCommand = [process.execPath, verifier];
  }
  if (!['missing-evidence', 'mismatched-assignment', 'mismatched-candidate'].includes(verifierMode)) {
    await writeFile(verifier, 'process.exit(0);\n');
  }
  const reviewerPrelude = mutateCandidateInReviewer
    ? `await (await import('node:fs/promises')).writeFile(${JSON.stringify(path.join(product, 'candidate.txt'))}, 'changed after verification\\n');\n`
    : '';
  await writeFile(reviewer, `await (await import('node:fs/promises')).writeFile(${JSON.stringify(reviewerStarted)}, 'started\\n');\n${reviewerPrelude}console.log(JSON.stringify({type:"text",part:{type:"text",text:${JSON.stringify(`TRIAD_REVIEW_RESULT: ${JSON.stringify(reviewerPayload)}`)}}}));\n`);
  await writeFile(commit, `const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(marker)}, 'committed\\n');\n`);
  const configPath = path.join(root, 'run.json');
  await writeJson(configPath, {
    project_root: controlRoot,
    assignment: path.relative(controlRoot, assignmentPath),
    developer: { command: [process.execPath, developer] },
    verifier: { command: verifierCommand, input: verifierInput },
    reviewer: { command: [process.execPath, reviewer], result_file: path.join(control, 'reviewer-result.json') },
    commit: { command: [process.execPath, commit] },
    output: path.join(control, 'control-run.json')
  });
  return { control, configPath, marker, reviewerStarted, assignmentPath, skillPath: skill, product };
}

function runControl(fixture) {
  return run(process.execPath, [controlRun, '--config', fixture.configPath], fixture.control);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'triad-control-reviewer-compliance-'));
try {
  const valid = await fixture(root, {
    decision: 'approved',
    skill_compliance: [{
      path: '.agents/skills/router/SKILL.md',
      rule: 'shared behavior placement',
      status: 'compliant',
      evidence_refs: ['candidate.txt']
    }]
  });
  const validRun = runControl(valid);
  assert.equal(validRun.status, 0, `${validRun.stderr}\n${validRun.stdout}`);
  await readFile(valid.marker, 'utf8');

  const noEvidence = await fixture(path.join(root, 'no-evidence'), {
    decision: 'approved',
    skill_compliance: [{ path: '.agents/skills/router/SKILL.md', rule: 'shared behavior placement', status: 'compliant' }],
  }, { verifierMode: 'missing-evidence' });
  const noEvidenceRun = runControl(noEvidence);
  assert.notEqual(noEvidenceRun.status, 0);
  await assert.rejects(() => readFile(noEvidence.marker, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(() => readFile(noEvidence.reviewerStarted, 'utf8'), { code: 'ENOENT' });
  assert.match(noEvidenceRun.stdout, /verifier evidence/);

  const mismatchedAssignment = await fixture(path.join(root, 'mismatched-assignment'), {
    decision: 'approved',
    skill_compliance: [{ path: '.agents/skills/router/SKILL.md', rule: 'shared behavior placement', status: 'compliant' }],
  }, { verifierMode: 'mismatched-assignment' });
  const mismatchedAssignmentRun = runControl(mismatchedAssignment);
  assert.notEqual(mismatchedAssignmentRun.status, 0);
  await assert.rejects(() => readFile(mismatchedAssignment.marker, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(() => readFile(mismatchedAssignment.reviewerStarted, 'utf8'), { code: 'ENOENT' });
  assert.match(mismatchedAssignmentRun.stdout, /verifier evidence/);

  const mismatchedCandidate = await fixture(path.join(root, 'mismatched-candidate'), {
    decision: 'approved',
    skill_compliance: [{ path: '.agents/skills/router/SKILL.md', rule: 'shared behavior placement', status: 'compliant' }],
  }, { verifierMode: 'mismatched-candidate' });
  const mismatchedCandidateRun = runControl(mismatchedCandidate);
  assert.notEqual(mismatchedCandidateRun.status, 0);
  await assert.rejects(() => readFile(mismatchedCandidate.marker, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(() => readFile(mismatchedCandidate.reviewerStarted, 'utf8'), { code: 'ENOENT' });
  assert.match(mismatchedCandidateRun.stdout, /candidate fingerprint/);

  const changedCandidate = await fixture(path.join(root, 'changed-candidate'), {
    decision: 'approved',
    skill_compliance: [{ path: '.agents/skills/router/SKILL.md', rule: 'shared behavior placement', status: 'compliant' }],
  }, { mutateCandidateInReviewer: true });
  const changedCandidateRun = runControl(changedCandidate);
  assert.notEqual(changedCandidateRun.status, 0);
  await assert.rejects(() => readFile(changedCandidate.marker, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(() => readFile(path.join(changedCandidate.control, 'reviewer-result.json'), 'utf8'), { code: 'ENOENT' });
  await readFile(changedCandidate.reviewerStarted, 'utf8');
  assert.match(changedCandidateRun.stdout, /candidate fingerprint/);

  const validOutput = JSON.parse(await readFile(path.join(valid.control, 'control-run.json'), 'utf8'));
  assert.equal(validOutput.verifier_evidence.status, 'pass');
  assert.equal(validOutput.reviewer_binding.assignment_id, 'compliance-assignment-001');
  assert.equal(validOutput.reviewer_binding.candidate_fingerprint, validOutput.verifier_evidence.candidate_fingerprint);
  const reviewerResultSource = await readFile(path.join(valid.control, 'reviewer-result.json'));
  assert.equal(validOutput.reviewer_binding.reviewer_result_sha256, digest(reviewerResultSource));
  assert.equal(JSON.parse(reviewerResultSource.toString('utf8')).decision, 'approved');

  const missing = await fixture(path.join(root, 'missing'), { decision: 'approved' });
  const missingRun = runControl(missing);
  assert.notEqual(missingRun.status, 0);
  await assert.rejects(() => readFile(missing.marker, 'utf8'), { code: 'ENOENT' });
  assert.match(missingRun.stderr, /reviewer_result_invalid/);

  const violated = await fixture(path.join(root, 'violated'), {
    decision: 'approved',
    skill_compliance: [{ path: '.agents/skills/router/SKILL.md', rule: 'shared behavior placement', status: 'violated' }]
  });
  const violatedRun = runControl(violated);
  assert.notEqual(violatedRun.status, 0);
  await assert.rejects(() => readFile(violated.marker, 'utf8'), { code: 'ENOENT' });
  assert.match(violatedRun.stderr, /reviewer_result_invalid/);
  console.log('Triad control-run Reviewer skill compliance boundary: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
