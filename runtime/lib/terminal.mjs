import { roleDefinitions } from '../../adapters/registry.mjs';
import { modelBindingSummary, supportsNativeReasoning } from './model-config.mjs';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  blue: '\u001b[34m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m'
};

const toneCodes = {
  title: `${ANSI.bold}${ANSI.cyan}`,
  section: `${ANSI.bold}${ANSI.blue}`,
  value: ANSI.bold,
  success: ANSI.green,
  warning: ANSI.yellow,
  error: ANSI.red,
  hint: ANSI.dim
};

export function colorEnabled(stream = process.stdout) {
  return Boolean(stream?.isTTY) && process.env.NO_COLOR === undefined;
}

export function paint(value, tone, { stream = process.stdout } = {}) {
  const text = String(value);
  if (!colorEnabled(stream) || !toneCodes[tone]) return text;
  return `${toneCodes[tone]}${text}${ANSI.reset}`;
}

export function statusText(status, { stream = process.stdout } = {}) {
  const normalized = String(status).toLowerCase();
  if (['ok', 'pass', 'passed', 'configured', 'installed', 'enabled'].includes(normalized) || /^ok\b/.test(normalized)) return paint(status, 'success', { stream });
  if (['warning', 'warn', 'disabled', 'not configured', 'not installed', 'unavailable', 'host default'].includes(normalized) || normalized.startsWith('not installed') || normalized.startsWith('host rule detected')) return paint(status, 'warning', { stream });
  if (['error', 'fail', 'failed', 'invalid', 'incomplete', 'missing'].includes(normalized) || normalized.startsWith('missing ') || normalized.startsWith('invalid ')) return paint(status, 'error', { stream });
  return String(status);
}

function display(value, fallback = 'host default') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function roleModelLine(adapter, role, configuration, stream) {
  const model = display(configuration?.model);
  const parts = [`${role.label.padEnd(14)} ${display(configuration?.displayName, role.label)} — model: ${model}`];
  if (supportsNativeReasoning(adapter, role.id)) {
    parts.push(`reasoning: ${display(configuration?.reasoning_effort)}`);
  }
  parts.push(`binding: ${modelBindingSummary(adapter, role.id)}`);
  return `  ${parts.join(' — ')}`;
}

/** Render the compact confirmation shown before the interactive install. */
export function formatSetupSummary({ adapter, control, global = false, team, stream = process.stdout }) {
  const interaction = team?.interaction ?? {};
  const lines = [
    paint('Triad+ setup summary', 'title', { stream }),
    `${paint('Host', 'section', { stream })}: ${paint(`${adapter.label} (${adapter.id})`, 'value', { stream })}`,
    `${paint('Control workspace', 'section', { stream })}: ${control}`,
    `${paint('User-level assets', 'section', { stream })}: ${global ? 'yes' : 'no'}`,
    `${paint('Interaction', 'section', { stream })}: ${display(interaction.language, 'English')} — owner ${display(interaction.owner_name, 'Owner')} — ${display(interaction.communication_style, 'professional and concise')}`,
    `${paint('Evaluator+', 'section', { stream })}: ${team?.roles?.evaluator?.enabled === true ? statusText('enabled', { stream }) : statusText('disabled', { stream })}`,
    paint('Roles', 'section', { stream }),
    ...roleDefinitions.map((role) => roleModelLine(adapter, role, team?.roles?.[role.id], stream)),
    paint('Confirm installation', 'section', { stream })
  ];
  return `${lines.join('\n')}\n`;
}

/** Render a doctor row while preserving scanner-friendly plain text. */
export function formatDoctorLine(label, status, { stream = process.stdout } = {}) {
  return `${label.padEnd(14)} ${statusText(status, { stream })}`;
}

export function formatDoctorSection(title, { stream = process.stdout } = {}) {
  return paint(title, 'section', { stream });
}

export function formatModelValue(value) {
  return display(value);
}
