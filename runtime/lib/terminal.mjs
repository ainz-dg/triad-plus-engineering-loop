import { roleDefinitions } from '../../adapters/registry.mjs';
import { hostModelField, modelBindingSummary, supportsNativeReasoning } from './model-config.mjs';

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

const retroColors = {
  violet: '#7C8CFF',
  turquoise: '#35C3B1',
  amber: '#F5B95E',
};

const retroGlyphs = {
  t: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  r: ['██████╗  ', '██╔══██╗ ', '██████╔╝ ', '██╔══██╗ ', '██║  ██║ ', '╚═╝  ╚═╝ '],
  i: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  a: [' █████╗  ', '██╔══██╗ ', '███████║ ', '██╔══██║ ', '██║  ██║ ', '╚═╝  ╚═╝ '],
  d: ['██████╗  ', '██╔══██╗ ', '██║  ██║ ', '██║  ██║ ', '██████╔╝ ', '╚═════╝  '],
};

export function colorEnabled(stream = process.stdout) {
  return Boolean(stream?.isTTY) && process.env.NO_COLOR === undefined;
}

function paintHex(value, hex, stream) {
  const text = String(value);
  if (!colorEnabled(stream)) return text;
  const digits = hex.slice(1);
  const red = Number.parseInt(digits.slice(0, 2), 16);
  const green = Number.parseInt(digits.slice(2, 4), 16);
  const blue = Number.parseInt(digits.slice(4, 6), 16);
  return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

function center(text, columns) {
  const visibleText = String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const width = Array.from(visibleText).length;
  return `${' '.repeat(Math.max(0, Math.floor((columns - width) / 2)))}${text}`;
}

function plainRetroHeader(columns) {
  const label = 'TRIAD+ / Engineering Loop';
  return columns >= Array.from(label).length ? label : 'TRIAD+';
}

function compactRetroHeader(stream, columns, includeTagline) {
  const name = [
    paintHex('TRI', retroColors.violet, stream),
    paintHex('AD', retroColors.turquoise, stream),
    paintHex('+', retroColors.amber, stream),
  ].join('');
  const rows = [
    center(name, columns),
    center(`  ${paintHex('●', retroColors.violet, stream)}  `, columns),
    center(` / ✓ \\ `, columns),
    center(`${paintHex('●', retroColors.turquoise, stream)}─────${paintHex('●', retroColors.amber, stream)}`, columns),
  ];
  if (includeTagline) rows.push(center('ENGINEERING LOOP', columns));
  return rows.join('\n');
}

function fullRetroHeader(stream, columns, includeTagline) {
  const rows = [];
  for (let row = 0; row < 6; row += 1) {
    const chunks = [
      [retroGlyphs.t[row], retroColors.violet],
      [retroGlyphs.r[row], retroColors.violet],
      [retroGlyphs.i[row], retroColors.violet],
      [retroGlyphs.a[row], retroColors.turquoise],
      [retroGlyphs.d[row], retroColors.turquoise],
    ];
    const suffix = row === 0 ? '   +' : '    ';
    const plain = chunks.map(([text]) => text).join('  ') + suffix;
    const padding = Math.max(0, Math.floor((columns - Array.from(plain).length) / 2));
    const colored = chunks.map(([text, color]) => paintHex(text, color, stream)).join('  ')
      + (row === 0 ? `   ${paintHex('+', retroColors.amber, stream)}` : '    ');
    rows.push(`${' '.repeat(padding)}${colored}`);
  }
  rows.push(center(`    ${paintHex('●', retroColors.violet, stream)}`, columns));
  rows.push(center('   / ✓ \\', columns));
  rows.push(center(`  ${paintHex('●', retroColors.turquoise, stream)}─────${paintHex('●', retroColors.amber, stream)}`, columns));
  if (includeTagline) rows.push(center('ENGINEERING LOOP', columns));
  return rows.join('\n');
}

/** Render the non-blocking retro identity used by the interactive first-run menu. */
export function formatRetroPixelHeader({
  stream = process.stdout,
  columns = Number(stream?.columns) || 80,
  rows = Number(stream?.rows) || 24,
  term = process.env.TERM,
  locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '',
} = {}) {
  if (!stream?.isTTY) return '';
  if (rows < 12) return plainRetroHeader(columns);
  if (term === 'dumb' || columns < 40 || !/(?:utf-8|utf8)/i.test(locale)) {
    return plainRetroHeader(columns);
  }
  if (columns >= 72 && rows >= 24) return fullRetroHeader(stream, columns, rows >= 24);
  if (columns >= 40 && rows >= 14) return compactRetroHeader(stream, columns, rows >= 18);
  return plainRetroHeader(columns);
}

/** Keep the initial brand mark compact when checklist screens are redrawn. */
export function formatCompactRetroHeader({
  stream = process.stdout,
  columns = Number(stream?.columns) || 80,
  rows = Number(stream?.rows) || 24,
  term = process.env.TERM,
  locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '',
} = {}) {
  if (!stream?.isTTY) return '';
  if (rows < 12 || term === 'dumb' || columns < 40 || !/(?:utf-8|utf8)/i.test(locale)) return 'TRIAD+';
  return compactRetroHeader(stream, columns, false);
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
    const field = hostModelField(adapter, role.id, 'reasoning_effort');
    parts.push(`${field === 'variant' ? 'variant' : 'reasoning'}: ${display(configuration?.reasoning_effort)}`);
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
