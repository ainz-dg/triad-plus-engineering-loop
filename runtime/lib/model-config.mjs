import { roleDefinitions } from '../../adapters/registry.mjs';

const roleIds = new Set(roleDefinitions.map((role) => role.id));
const modelFields = new Set(['model', 'reasoning_effort']);

function nullableString(value, field) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw new Error(`${field} must be a string or null.`);
}

function adapterModelRoles(adapter) {
  return new Set(adapter?.modelRoles ?? roleDefinitions.map((role) => role.id));
}

/**
 * Return whether the selected host can materialize a model for this role.
 * A team-record adapter still records the requested value in team.json, but
 * deliberately returns false because it has no native file to update.
 */
export function supportsNativeModel(adapter, roleId) {
  if (adapter?.modelBinding === 'global-profiles') return roleIds.has(roleId);
  if (adapter?.modelBinding === 'project-frontmatter') return adapterModelRoles(adapter).has(roleId);
  return false;
}

/** Return whether the selected host exposes a native reasoning field. */
export function supportsNativeReasoning(adapter, roleId) {
  if (!supportsNativeModel(adapter, roleId)) return false;
  if (adapter?.modelBinding === 'global-profiles') return true;
  return Array.isArray(adapter?.modelFields) && adapter.modelFields.includes('reasoningEffort');
}

/**
 * Describe how a role's requested configuration is handled by the adapter.
 * This is presentation metadata; team.json remains authoritative in every
 * mode.
 */
export function modelBindingSummary(adapter, roleId) {
  if (adapter?.modelBinding === 'team-record') return 'recorded in team.json (host-native binding unavailable)';
  if (!supportsNativeModel(adapter, roleId)) return 'recorded in team.json (role field unsupported by host)';
  if (supportsNativeReasoning(adapter, roleId)) return 'host-native model + reasoning';
  return 'host-native model; reasoning is host-managed';
}

/**
 * Validate a complete schema-version-1 team configuration without changing or
 * stripping fields. Unknown fields remain forward-compatible and are
 * preserved; malformed model values fail closed before installation/upgrade.
 */
export function validateTeamConfiguration(team) {
  if (!team || typeof team !== 'object' || Array.isArray(team)) throw new Error('team config must be an object.');
  if (team.schema_version !== 1) throw new Error('team config must contain schema_version 1.');
  if (!team.interaction || typeof team.interaction !== 'object' || Array.isArray(team.interaction)) {
    throw new Error('team config must contain interaction.');
  }
  if (!team.roles || typeof team.roles !== 'object' || Array.isArray(team.roles)) {
    throw new Error('team config must contain roles.');
  }
  for (const role of roleDefinitions) {
    const configuration = team.roles[role.id];
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
      throw new Error(`team config has an invalid ${role.id} role definition.`);
    }
    if (typeof configuration.displayName !== 'string' || !configuration.displayName.trim()) {
      throw new Error(`team config has an invalid ${role.id} displayName.`);
    }
    nullableString(configuration.model, `${role.id}.model`);
    nullableString(configuration.reasoning_effort, `${role.id}.reasoning_effort`);
    if (configuration.enabled !== undefined && typeof configuration.enabled !== 'boolean') {
      throw new Error(`team config has an invalid ${role.id}.enabled value.`);
    }
  }
  return team;
}

/**
 * Validate a user-requested native model patch. This intentionally rejects
 * unknown fields and fields the selected host cannot materialize. Callers
 * that only want to record intent should use team.json directly and report
 * the adapter's modelBindingSummary instead of pretending native support.
 */
export function validateRequestedModelPatch(adapter, roleId, patch) {
  if (!roleIds.has(roleId)) throw new Error(`Unknown Triad role: ${roleId}.`);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('model patch must be an object.');
  for (const field of Object.keys(patch)) {
    if (!modelFields.has(field)) throw new Error(`Unsupported model configuration field: ${field}.`);
    nullableString(patch[field], `${roleId}.${field}`);
    if (field === 'model' && !supportsNativeModel(adapter, roleId)) {
      throw new Error(`Model binding is not natively supported for ${adapter?.id ?? 'the selected host'} role ${roleId}.`);
    }
    if (field === 'reasoning_effort' && !supportsNativeReasoning(adapter, roleId)) {
      throw new Error(`Reasoning effort is not natively supported for ${adapter?.id ?? 'the selected host'} role ${roleId}.`);
    }
  }
  return patch;
}

/**
 * Apply an explicitly requested model/reasoning patch to an in-memory team
 * document while preserving every unrelated field. Callers still decide when
 * to persist the returned document and must use the adapter binding afterwards.
 */
export function mergeTeamModelConfiguration(team, roleId, patch) {
  validateTeamConfiguration(team);
  if (!roleIds.has(roleId)) throw new Error(`Unknown Triad role: ${roleId}.`);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('model patch must be an object.');
  for (const field of Object.keys(patch)) {
    if (!modelFields.has(field)) throw new Error(`Unsupported model configuration field: ${field}.`);
    nullableString(patch[field], `${roleId}.${field}`);
  }
  const updated = structuredClone(team);
  Object.assign(updated.roles[roleId], patch);
  return updated;
}

/** Return only fields that the adapter can materialize in host-managed assets. */
export function materializedRoleConfiguration(adapter, roleId, configuration = {}) {
  const result = {};
  if (supportsNativeModel(adapter, roleId)) result.model = configuration.model ?? null;
  if (supportsNativeReasoning(adapter, roleId)) result.reasoning_effort = configuration.reasoning_effort ?? null;
  return result;
}
