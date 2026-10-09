import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Structural check of verifier evidence against the contract Triad+ ships:
// schemas/verification-evidence.schema.json. The schema file is the single
// source of truth and is loaded as-is; nothing here re-runs gates, re-hashes
// the candidate, or second-guesses the verifier. It only decides whether a
// verification.json has the shape the verifier writes, plus the two
// invariants triad-verify.mjs establishes when it sets `status`.
//
// The validator implements exactly the keywords that schema uses. An unknown
// keyword makes the contract unavailable instead of being silently ignored,
// so a future schema change cannot widen what the Cockpit accepts.

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "verification-evidence.schema.json");
const KEYWORDS = new Set([
  "$schema", "$id", "title",
  "type", "required", "properties", "additionalProperties", "items",
  "enum", "const", "minLength", "minimum", "minItems", "pattern", "format",
]);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_ERRORS = 5;

function assertSupported(schema, where = "#") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`schema node at ${where} is not an object`);
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`unsupported schema keyword ${key} at ${where}`);
  if (schema.format !== undefined && schema.format !== "date-time") throw new Error(`unsupported format ${schema.format} at ${where}`);
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertSupported(child, `${where}/properties/${name}`);
  if (schema.items !== undefined) assertSupported(schema.items, `${where}/items`);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  return (Array.isArray(expected) ? expected : [expected]).some((type) => type === actual || (type === "number" && actual === "integer"));
}

function check(schema, value, where, errors) {
  if (errors.length >= MAX_ERRORS) return;
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${where} must be ${[].concat(schema.type).join(" or ")}`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${where} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${where} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where} is too short`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${where} has an invalid format`);
    if (schema.format === "date-time" && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) errors.push(`${where} must be an RFC 3339 date-time`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${where} is below ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where} needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((entry, index) => check(schema.items, entry, `${where}[${index}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${where}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) check(child, value[key], `${where}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${where}.${key} is not allowed`);
    }
  }
}

let contract;
try {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  assertSupported(schema);
  contract = { schema, error: null };
} catch (error) {
  contract = { schema: null, error: `verification evidence contract unavailable: ${error.message}` };
}

/**
 * Return `{ valid: true }` or `{ valid: false, errors: [...] }`. Errors name
 * fields only, never values, so evidence content does not leak into messages.
 */
export function validateVerificationEvidence(value) {
  if (!contract.schema) return { valid: false, errors: [contract.error] };
  const errors = [];
  check(contract.schema, value, "evidence", errors);
  if (errors.length === 0) {
    // Writer invariants: triad-verify.mjs sets required_gates_passed only when
    // every required gate passed, and status "pass" only when it is true.
    if (value.status === "pass" && value.required_gates_passed !== true) errors.push("evidence.status is pass but required_gates_passed is not true");
    if (value.required_gates_passed === true && value.gates.some((gate) => gate?.required === true && gate.status !== "pass")) {
      errors.push("evidence.required_gates_passed is true but a required gate did not pass");
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}
