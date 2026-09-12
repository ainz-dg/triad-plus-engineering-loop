import { qualityCriteriaByScope, validateQualityBaselineManifest } from "./lib/quality-baseline.mjs";

const VERDICTS = new Set(["PASS", "FAIL", "INDETERMINATE"]);

function evaluatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireBaseResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ result must be an object");
  if (result.schema_version !== 1) throw evaluatorError("evaluator_result_invalid", "Evaluator+ schema_version must be 1");
  if (typeof result.feature_id !== "string" || !result.feature_id.trim()) throw evaluatorError("evaluator_result_invalid", "Evaluator+ feature_id must be non-empty");
  if (typeof result.candidate_fingerprint !== "string" || !result.candidate_fingerprint.trim()) throw evaluatorError("evaluator_result_invalid", "Evaluator+ candidate_fingerprint must be non-empty");
  if (!VERDICTS.has(result.verdict)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ verdict must be PASS, FAIL, or INDETERMINATE");
  if (typeof result.summary !== "string" || !result.summary.trim()) throw evaluatorError("evaluator_result_invalid", "Evaluator+ summary must be non-empty");
  if (!Array.isArray(result.evidence_refs) || result.evidence_refs.some((ref) => typeof ref !== "string")) throw evaluatorError("evaluator_result_invalid", "Evaluator+ evidence_refs must be an array of strings");
}

export function aggregateEvaluatorVerdict(criteria) {
  if (!Array.isArray(criteria)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ criteria must be an array");
  if (criteria.some((criterion) => criterion.verdict === "FAIL")) return "FAIL";
  if (criteria.some((criterion) => criterion.verdict === "INDETERMINATE")) return "INDETERMINATE";
  return "PASS";
}

function validateCriterionShape(criterion) {
  if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) throw evaluatorError("evaluator_result_invalid", "Evaluator+ criterion entries must be objects");
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
  if (!qualityBaseline) return { valid: true, legacy: true, verdict: result.verdict, result };

  const baseline = qualityBaseline.manifest ?? qualityBaseline;
  const validatedBaseline = validateQualityBaselineManifest(baseline);
  const expectedBaselineFingerprint = qualityBaseline.fingerprint ?? validatedBaseline.fingerprint;
  if (result.quality_baseline_fingerprint !== expectedBaselineFingerprint) {
    throw evaluatorError("evaluator_quality_baseline_mismatch", "Evaluator+ result quality baseline fingerprint does not match the approved contract");
  }
  if (expectedCandidateFingerprint !== null && result.candidate_fingerprint !== expectedCandidateFingerprint) {
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
  return {
    valid: true,
    verdict,
    can_deliver: verdict === "PASS",
    quality_baseline_fingerprint: qualityBaseline?.fingerprint ?? validatedBaseline.fingerprint,
    criteria: results,
  };
}

export { VERDICTS };
