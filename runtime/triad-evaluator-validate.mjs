import { loadQualityBaseline, qualityCriteriaByScope, validateQualityBaselineManifest } from "./lib/quality-baseline.mjs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERDICTS = new Set(["PASS", "FAIL", "INDETERMINATE"]);
const SHA256 = /^[a-f0-9]{64}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function evaluatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rejectUnknownProperties(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw evaluatorError("evaluator_result_invalid", `${label} contains unknown property: ${key}`);
  }
}

function requireBaseResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ result must be an object");
  rejectUnknownProperties(result, new Set(["schema_version", "feature_id", "candidate_fingerprint", "quality_baseline_fingerprint", "verdict", "summary", "evidence_refs", "criteria", "created_at"]), "Evaluator+ result");
  if (result.schema_version !== 1) throw evaluatorError("evaluator_result_invalid", "Evaluator+ schema_version must be 1");
  if (typeof result.feature_id !== "string" || !result.feature_id.trim()) throw evaluatorError("evaluator_result_invalid", "Evaluator+ feature_id must be non-empty");
  if (typeof result.candidate_fingerprint !== "string" || !result.candidate_fingerprint.trim()) throw evaluatorError("evaluator_result_invalid", "Evaluator+ candidate_fingerprint must be non-empty");
  if (result.quality_baseline_fingerprint !== undefined && (typeof result.quality_baseline_fingerprint !== "string" || !SHA256.test(result.quality_baseline_fingerprint))) throw evaluatorError("evaluator_result_invalid", "Evaluator+ quality_baseline_fingerprint must be a SHA-256 hex digest");
  if (!VERDICTS.has(result.verdict)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ verdict must be PASS, FAIL, or INDETERMINATE");
  if (typeof result.summary !== "string" || !result.summary.trim()) throw evaluatorError("evaluator_result_invalid", "Evaluator+ summary must be non-empty");
  if (!Array.isArray(result.evidence_refs) || result.evidence_refs.some((ref) => typeof ref !== "string")) throw evaluatorError("evaluator_result_invalid", "Evaluator+ evidence_refs must be an array of strings");
  if (typeof result.created_at !== "string" || !DATE_TIME.test(result.created_at) || Number.isNaN(Date.parse(result.created_at))) throw evaluatorError("evaluator_result_invalid", "Evaluator+ created_at must be an RFC 3339 date-time");
}

export function aggregateEvaluatorVerdict(criteria) {
  if (!Array.isArray(criteria)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ criteria must be an array");
  if (criteria.some((criterion) => criterion.verdict === "FAIL")) return "FAIL";
  if (criteria.some((criterion) => criterion.verdict === "INDETERMINATE")) return "INDETERMINATE";
  return "PASS";
}

function validateCriterionShape(criterion) {
  if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ criterion entries must be objects");
  rejectUnknownProperties(criterion, new Set(["id", "scope", "verdict", "summary", "evidence_refs"]), "Evaluator+ criterion");
  if (typeof criterion.id !== "string" || !criterion.id.trim()) throw evaluatorError("evaluator_result_invalid", "Evaluator+ criterion id must be non-empty");
  if (criterion.scope !== "product_quality") throw evaluatorError("evaluator_result_invalid", `Evaluator+ criterion ${criterion.id} is not product_quality`);
  if (!VERDICTS.has(criterion.verdict)) throw evaluatorError("evaluator_result_invalid", `Evaluator+ criterion ${criterion.id} has an invalid verdict`);
  if (typeof criterion.summary !== "string" || !criterion.summary.trim()) throw evaluatorError("evaluator_result_invalid", `Evaluator+ criterion ${criterion.id} summary must be non-empty`);
  if (!Array.isArray(criterion.evidence_refs) || criterion.evidence_refs.some((ref) => typeof ref !== "string")) throw evaluatorError("evaluator_result_invalid", `Evaluator+ criterion ${criterion.id} evidence_refs must be an array of strings`);
}

/**
 * Validate an Evaluator+ result. Without a quality baseline the v1.7 legacy
 * result contract remains valid. With a baseline, every product-quality
 * criterion must be covered exactly once and the aggregate is deterministic.
 */
export function validateEvaluatorResult(result, { qualityBaseline = null, expectedCandidateFingerprint = null } = {}) {
  requireBaseResult(result);
  if (!qualityBaseline) {
    if (result.criteria !== undefined) {
      if (!Array.isArray(result.criteria)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ criteria must be an array");
      for (const criterion of result.criteria) validateCriterionShape(criterion);
    }
    return { valid: true, legacy: true, verdict: result.verdict, result };
  }

  const baseline = qualityBaseline.manifest ?? qualityBaseline;
  const validatedBaseline = validateQualityBaselineManifest(baseline);
  const expectedBaselineFingerprint = validatedBaseline.fingerprint;
  if (qualityBaseline.fingerprint !== undefined && qualityBaseline.fingerprint !== expectedBaselineFingerprint) {
    throw evaluatorError("evaluator_quality_baseline_mismatch", "loaded Quality Baseline fingerprint does not match its canonical content");
  }
  if (result.quality_baseline_fingerprint !== expectedBaselineFingerprint) {
    throw evaluatorError("evaluator_quality_baseline_mismatch", "Evaluator+ result quality baseline fingerprint does not match the approved contract");
  }
  if (typeof expectedCandidateFingerprint !== "string" || !expectedCandidateFingerprint.trim()) {
    throw evaluatorError("evaluator_candidate_binding_missing", "Quality Contract Evaluator+ validation requires an expected candidate fingerprint");
  }
  if (result.candidate_fingerprint !== expectedCandidateFingerprint) {
    throw evaluatorError("evaluator_candidate_fingerprint_mismatch", "Evaluator+ result candidate fingerprint does not match the approved candidate");
  }

  const { product_quality: expectedCriteria, delivery_closure: deliveryCriteria } = qualityCriteriaByScope(baseline);
  if (!Array.isArray(result.criteria)) throw evaluatorError("evaluator_result_invalid", "Quality Contract Evaluator+ result must include criteria");
  const expectedById = new Map(expectedCriteria.map((criterion) => [criterion.id, criterion]));
  const deliveryIds = new Set(deliveryCriteria.map((criterion) => criterion.id));
  const seen = new Set();
  for (const criterion of result.criteria) {
    validateCriterionShape(criterion);
    if (seen.has(criterion.id)) throw evaluatorError("evaluator_result_invalid", `duplicate Evaluator+ criterion: ${criterion.id}`);
    seen.add(criterion.id);
    if (deliveryIds.has(criterion.id)) throw evaluatorError("evaluator_result_invalid", `delivery_closure criterion was sent to Evaluator+: ${criterion.id}`);
    if (!expectedById.has(criterion.id)) throw evaluatorError("evaluator_result_invalid", `unexpected product_quality criterion: ${criterion.id}`);
  }
  for (const criterion of expectedCriteria) {
    if (!seen.has(criterion.id)) throw evaluatorError("evaluator_result_invalid", `missing product_quality criterion: ${criterion.id}`);
  }
  const aggregate = aggregateEvaluatorVerdict(result.criteria);
  if (result.verdict !== aggregate) throw evaluatorError("evaluator_result_invalid", `Evaluator+ aggregate verdict must be ${aggregate}`);
  return {
    valid: true,
    legacy: false,
    verdict: aggregate,
    quality_baseline_fingerprint: expectedBaselineFingerprint,
    product_quality_criteria: result.criteria,
    excluded_delivery_closure_ids: deliveryCriteria.map((criterion) => criterion.id),
    result,
  };
}

function validateClosureCriterion(criterion, expectedScope = "delivery_closure") {
  if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) throw evaluatorError("delivery_closure_invalid", "delivery closure criteria must be objects");
  const allowed = new Set(["id", "scope", "verdict", "summary", "evidence_refs"]);
  for (const key of Object.keys(criterion)) if (!allowed.has(key)) throw evaluatorError("delivery_closure_invalid", `delivery closure criterion contains unknown property: ${key}`);
  if (typeof criterion.id !== "string" || !criterion.id.trim()) throw evaluatorError("delivery_closure_invalid", "delivery closure criterion id must be non-empty");
  if (criterion.scope !== expectedScope) throw evaluatorError("delivery_closure_invalid", `delivery closure criterion ${criterion.id} has the wrong scope`);
  if (!VERDICTS.has(criterion.verdict)) throw evaluatorError("delivery_closure_invalid", `delivery closure criterion ${criterion.id} has an invalid verdict`);
  if (typeof criterion.summary !== "string" || !criterion.summary.trim()) throw evaluatorError("delivery_closure_invalid", `delivery closure criterion ${criterion.id} summary must be non-empty`);
  if (!Array.isArray(criterion.evidence_refs) || criterion.evidence_refs.some((ref) => typeof ref !== "string")) throw evaluatorError("delivery_closure_invalid", `delivery closure criterion ${criterion.id} evidence_refs must be an array of strings`);
}

/** Validate the separate delivery-closure criterion record. */
export function validateDeliveryClosureCriteria(qualityBaseline, results) {
  const baseline = qualityBaseline?.manifest ?? qualityBaseline;
  const validatedBaseline = validateQualityBaselineManifest(baseline);
  const expected = qualityCriteriaByScope(baseline).delivery_closure;
  if (!Array.isArray(results)) throw evaluatorError("delivery_closure_invalid", "delivery closure results must be an array");
  const expectedIds = new Set(expected.map((criterion) => criterion.id));
  const seen = new Set();
  for (const result of results) {
    validateClosureCriterion(result);
    if (seen.has(result.id)) throw evaluatorError("delivery_closure_invalid", `duplicate delivery closure criterion: ${result.id}`);
    seen.add(result.id);
    if (!expectedIds.has(result.id)) throw evaluatorError("delivery_closure_invalid", `unexpected delivery closure criterion: ${result.id}`);
  }
  for (const criterion of expected) {
    if (!seen.has(criterion.id)) throw evaluatorError("delivery_closure_invalid", `missing delivery closure criterion: ${criterion.id}`);
  }
  const verdict = aggregateEvaluatorVerdict(results);
  if (qualityBaseline?.fingerprint !== undefined && qualityBaseline.fingerprint !== validatedBaseline.fingerprint) {
    throw evaluatorError("delivery_closure_invalid", "loaded Quality Baseline fingerprint does not match its canonical content");
  }
  return {
    valid: true,
    verdict,
    can_deliver: verdict === "PASS",
    quality_baseline_fingerprint: validatedBaseline.fingerprint,
    criteria: results,
  };
}

export { VERDICTS };

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArgs(argv) {
  const args = { mode: null, project: process.cwd(), baseline: null, result: null, expectedCandidateFingerprint: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write("Usage: node runtime/triad-evaluator-validate.mjs --mode <baseline|evaluator|delivery> --baseline <path> [--result <path>] [--project <root>] [--expected-candidate-fingerprint <sha256>]\n");
      return null;
    }
    const key = {
      "--mode": "mode",
      "--project": "project",
      "--baseline": "baseline",
      "--result": "result",
      "--expected-candidate-fingerprint": "expectedCandidateFingerprint",
    }[flag];
    if (!key) throw cliError("quality_contract_cli_invalid", `unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw cliError("quality_contract_cli_invalid", `${flag} requires a value`);
    args[key] = value;
    index += 1;
  }
  if (!args.mode || !["baseline", "evaluator", "delivery"].includes(args.mode)) throw cliError("quality_contract_cli_invalid", "--mode must be baseline, evaluator, or delivery");
  if (args.mode !== "baseline" && !args.result) throw cliError("quality_contract_cli_invalid", "--result is required");
  if ((args.mode === "baseline" || args.mode === "delivery") && !args.baseline) throw cliError("quality_contract_cli_invalid", `--baseline is required for ${args.mode} validation`);
  return args;
}

async function readJsonFile(root, value, label) {
  const target = path.isAbsolute(value) ? value : path.resolve(root, value);
  let source;
  try {
    source = await readFile(target, "utf8");
  } catch (error) {
    throw cliError("quality_contract_cli_invalid", `${label} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw cliError("quality_contract_cli_invalid", `${label} is not valid JSON: ${error.message}`);
  }
}

/**
 * Explicit control-plane entry point. It reloads the baseline from disk on
 * every invocation so Evaluator+ and delivery closure cannot rely on a stale
 * manifest/source check performed earlier in the run.
 */
async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  const projectRoot = await realpath(args.project);
  const qualityBaseline = args.baseline
    ? await loadQualityBaseline(args.baseline, { projectRoot })
    : null;
  if (args.mode === "baseline") {
    process.stdout.write(`${JSON.stringify({
      valid: true,
      mode: "baseline",
      quality_baseline_fingerprint: qualityBaseline.fingerprint,
      sources: qualityBaseline.sources,
    })}\n`);
    return;
  }
  if (args.mode === "evaluator") {
    const result = await readJsonFile(projectRoot, args.result, "Evaluator+ result");
    if (qualityBaseline && (!args.expectedCandidateFingerprint || !SHA256.test(args.expectedCandidateFingerprint))) {
      throw cliError("evaluator_candidate_binding_missing", "Quality Contract Evaluator+ validation requires --expected-candidate-fingerprint");
    }
    const validated = validateEvaluatorResult(result, {
      qualityBaseline,
      expectedCandidateFingerprint: qualityBaseline ? args.expectedCandidateFingerprint : null,
    });
    process.stdout.write(`${JSON.stringify({
      valid: true,
      mode: "evaluator",
      legacy: validated.legacy,
      verdict: validated.verdict,
      quality_baseline_fingerprint: validated.quality_baseline_fingerprint ?? null,
      candidate_fingerprint: result.candidate_fingerprint,
      product_quality_criteria: validated.product_quality_criteria ?? null,
    })}\n`);
    return;
  }

  const results = await readJsonFile(projectRoot, args.result, "delivery closure results");
  const validated = validateDeliveryClosureCriteria(qualityBaseline, results);
  process.stdout.write(`${JSON.stringify({
    valid: true,
    mode: "delivery",
    verdict: validated.verdict,
    can_deliver: validated.can_deliver,
    quality_baseline_fingerprint: validated.quality_baseline_fingerprint,
    criteria: validated.criteria,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stdout.write(`${JSON.stringify({ valid: false, error: { code: error.code ?? "quality_contract_cli_invalid", message: error.message } })}\n`);
    process.exitCode = 2;
  });
}
