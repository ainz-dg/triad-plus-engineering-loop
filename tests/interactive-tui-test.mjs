import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { selectChecklist } from '../runtime/lib/interactive-tui.mjs';
import { formatRetroPixelHeader } from '../runtime/lib/terminal.mjs';
import { terminalScreen } from './terminal-screen-emulator.mjs';

const originalTerm = process.env.TERM;
const originalNoColor = process.env.NO_COLOR;
process.env.TERM = 'xterm-256color';
delete process.env.NO_COLOR;

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  rawTransitions = [];

  setRawMode(value) {
    this.isRaw = value;
    this.rawTransitions.push(value);
    return this;
  }

  resume() { this.paused = false; }
  pause() { this.paused = true; }
}

class FakeOutput {
  isTTY = true;
  columns = 48;
  rows = 16;
  writes = [];
  failAt = null;

  write(value) {
    this.writes.push(String(value));
    if (this.failAt === this.writes.length) throw new Error('injected terminal write failure');
    return true;
  }
}

function start(options = {}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  if (options.columns) output.columns = options.columns;
  if (options.failAt) output.failAt = options.failAt;
  const promise = selectChecklist({
    step: 'Triad+ / 2 of 5 — Product repositories',
    title: 'Select repositories',
    items: [{ kind: 'checkbox', id: 'one', label: 'one' }, { kind: 'checkbox', id: 'two', label: 'two' }],
    ...options,
    input,
    output,
  });
  return { input, output, promise };
}

function keys(input, value) {
  input.emit('data', Buffer.from(value));
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

const selectionSummary = (selected) => `${selected.length} selected${selected[0] ? ` · primary ${selected[0]}` : ''}`;

// The approved six-row pixel mark uses the SVG palette and never paints a background.
{
  const output = new FakeOutput();
  const header = formatRetroPixelHeader({ stream: output, columns: 80, rows: 24, term: 'xterm-256color', locale: 'C.UTF-8' });
  const lines = header.split('\n');
  assert.equal(lines.length, 10, 'full mark has six aligned glyph rows, triangle, and wordmark');
  assert.ok(header.includes('\u001b[38;2;124;140;255m'), 'violet matches #7C8CFF');
  assert.ok(header.includes('\u001b[38;2;53;195;177m'), 'turquoise matches #35C3B1');
  assert.ok(header.includes('\u001b[38;2;245;185;94m'), 'amber matches #F5B95E');
  assert.doesNotMatch(header, /\u001b\[48;/, 'the logo never sets a terminal background');
  const plainLines = stripAnsi(header).split('\n');
  assert.ok(plainLines.every((line) => Array.from(line).length <= 80), 'full mark fits its terminal width');
  assert.equal(new Set(plainLines.slice(0, 6).map((line) => Array.from(line).length)).size, 1, 'all six pixel rows share one fixed cell width');
}

// Compact, fallback, NO_COLOR, and redirected output paths stay bounded and safe.
{
  const output = new FakeOutput();
  const compact = formatRetroPixelHeader({ stream: output, columns: 50, rows: 24, term: 'xterm-256color', locale: 'C.UTF-8' });
  assert.match(stripAnsi(compact), /TRIAD\+/);
  assert.match(stripAnsi(compact), /ENGINEERING LOOP/);
  assert.ok(stripAnsi(compact).split('\n').every((line) => Array.from(line).length <= 50), 'compact mark fits its terminal width');

  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const monochrome = formatRetroPixelHeader({ stream: output, columns: 80, rows: 24, term: 'xterm-256color', locale: 'C.UTF-8' });
  assert.doesNotMatch(monochrome, /\u001b\[/, 'NO_COLOR suppresses every header escape sequence');
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;

  assert.equal(formatRetroPixelHeader({ stream: output, columns: 36, rows: 24, term: 'xterm-256color', locale: 'C.UTF-8' }), 'TRIAD+ / Engineering Loop');
  assert.equal(formatRetroPixelHeader({ stream: output, columns: 80, rows: 24, term: 'dumb', locale: 'C.UTF-8' }), 'TRIAD+ / Engineering Loop');
  assert.equal(formatRetroPixelHeader({ stream: output, columns: 80, rows: 20, term: 'xterm-256color', locale: 'C.UTF-8' }), 'TRIAD+ / Engineering Loop', 'short viewports prioritize menu space');
  assert.equal(formatRetroPixelHeader({ stream: output, columns: 80, rows: 24, term: 'xterm-256color', locale: 'C' }), 'TRIAD+ / Engineering Loop', 'non-UTF-8 locales avoid glyphs');
  assert.equal(formatRetroPixelHeader({ stream: { isTTY: false }, columns: 80, rows: 24 }), '', 'redirected output gets no splash');
}

// Real escape/arrow bytes toggle in selection order and restore the original raw mode.
{
  const session = start({ selectionSummary });
  keys(session.input, '\u001b[B');
  keys(session.input, ' ');
  keys(session.input, '\u001b[A');
  keys(session.input, ' ');
  keys(session.input, '\r');
  const result = await session.promise;
  assert.deepEqual(result, { kind: 'selected', selected: ['two', 'one'] });
  assert.match(session.output.writes.join(''), /primary two/);
  assert.deepEqual(session.input.rawTransitions, [true, false]);
  assert.equal(session.input.isRaw, false);
  assert.equal(session.input.paused, true);
}

// Header stays fixed while one buffered redraw updates only the menu region.
{
  const session = start({ header: 'TRIAD+\n' });
  keys(session.input, '\u001b[B');
  const redraws = session.output.writes.slice(1);
  assert.ok(redraws.length >= 2);
  assert.ok(redraws[0].startsWith('\r\u001b[2K'), 'the first frame begins at the live prompt cursor');
  assert.ok(redraws.slice(1).every((write) => /^\u001b\[\d+A\r\u001b\[2K/.test(write)), 'redraws return to the previous frame relative to the live cursor');
  assert.doesNotMatch(redraws.join(''), /\u001b\[2J/, 'redraw does not clear the visible screen first');
  assert.doesNotMatch(redraws.join(''), /\u001b\[J/, 'redraw clears only its bounded rows');
  assert.doesNotMatch(redraws.join(''), /TRIAD\+/, 'the static header is not duplicated by menu redraws');
  keys(session.input, '\u001b');
  await session.promise;
}

// A selected row can shrink when the former primary is unchecked. Assert the
// visible cells, not the ANSI source string, so no suffix survives the redraw.
{
  const session = start({
    header: 'TRIAD+\n',
    items: [
      { kind: 'checkbox', id: 'one', label: 'First option' },
      { kind: 'checkbox', id: 'two', label: 'Second option' },
    ],
  });
  keys(session.input, ' \u001b[B \u001b[A ');
  const result = terminalScreen(session.output.writes.join(''), { rows: 16, columns: 48 }).join('\n');
  assert.doesNotMatch(result, /› \[ \] First option · primary/, 'the old longer primary suffix is erased from the rendered cells');
  keys(session.input, '\u001b');
  await session.promise;
}

// A wrapped inline error must not desynchronize the logical frame height from
// physical terminal rows; the following redraw stays at the original anchor.
{
  process.env.NO_COLOR = '1';
  const session = start({
    minimum: 1,
    columns: 48,
    items: [
      { kind: 'checkbox', id: 'one', label: 'one' },
      { kind: 'checkbox', id: 'two', label: 'two' },
    ],
  });
  keys(session.input, '\r'); // zero selection paints the long inline error
  assert.match(session.output.writes.join(''), /Select a row with Space/);
  keys(session.input, ' \u001b[B'); // select, move focus, and redraw
  const writes = session.output.writes.join('');
  const screen = terminalScreen(writes, { rows: 16, columns: 48 });
  assert.equal(screen.filter((line) => line.includes('Select repositories')).length, 1, `title appears once:\n${screen.join('\n')}`);
  assert.ok(screen[1].includes('Select repositories'), `title remains at row 2:\n${screen.join('\n')}`);
  assert.equal(screen[2].trim(), 'Selection: 1 selected', `selection stays at row 3:\n${screen.join('\n')}`);
  assert.ok(screen[5].includes('› [ ] two'), `focus stays on the second option row:\n${screen.join('\n')}`);
  assert.doesNotMatch(screen.join('\n'), /Select a row with Space/, 'the expired inline error is absent from visible cells');
  assert.doesNotMatch(writes, /\u001b\[[0-9;]*m/, 'NO_COLOR remains respected while clipping error text');
  keys(session.input, '\u001b');
  await session.promise;
  delete process.env.NO_COLOR;
}

// Wide graphemes are clipped by terminal cells, so their text cannot wrap into
// the next menu row and corrupt the list layout.
{
  const session = start({ columns: 40, items: [
    { kind: 'checkbox', id: 'wide', label: '界'.repeat(30) },
    { kind: 'checkbox', id: 'second', label: 'second option' },
  ] });
  keys(session.input, '\u001b[B');
  const screen = terminalScreen(session.output.writes.join(''), { rows: 16, columns: 40 });
  assert.ok(screen[5].includes('› [ ] second option'), `wide text stays on one row:\n${screen.join('\n')}`);
  keys(session.input, '\u001b');
  await session.promise;
}

// A long list scrolls its visible window with focus and keeps the viewport
// index readable after multiple relative redraws.
{
  const session = start({ items: Array.from({ length: 12 }, (_, index) => ({
    kind: 'checkbox', id: `item-${index + 1}`, label: `option ${index + 1}`,
  })) });
  keys(session.input, '\u001b[B'.repeat(8));
  const screen = terminalScreen(session.output.writes.join(''), { rows: 16, columns: 48 }).join('\n');
  assert.match(screen, /Options 5–9 of 12/);
  assert.match(screen, /› \[ \] option 9/);
  keys(session.input, '\u001b');
  await session.promise;
}

// Enter with no choices reports an inline error; Escape then cancels safely.
{
  const session = start();
  keys(session.input, '\r');
  assert.match(session.output.writes.join(''), /Select a row with Space/);
  keys(session.input, '\u001b');
  const result = await session.promise;
  assert.equal(result.kind, 'cancel');
  assert.deepEqual(result.selected, []);
  assert.deepEqual(session.input.rawTransitions, [true, false]);
}

// Dumb terminals keep a readable, width-limited focus and selection update.
{
  process.env.TERM = 'dumb';
  const session = start({ items: [
    { kind: 'checkbox', id: 'one', label: 'a-very-long-first-option' },
    { kind: 'checkbox', id: 'two', label: 'two' },
  ] });
  session.output.columns = 20;
  keys(session.input, '\u001b[B');
  keys(session.input, ' ');
  const updates = session.output.writes.slice(-2).join('');
  assert.match(updates, /Focus: two/);
  assert.match(updates, /Selection: 1/);
  assert.ok(updates.split('\n').every((line) => Array.from(line).length <= 19), 'dumb-terminal updates stay within the available width');
  keys(session.input, '\u001b');
  await session.promise;
  process.env.TERM = 'xterm-256color';
}

// The maximum is enforced before confirmation, without dropping the first choice.
{
  const session = start({ maximum: 1 });
  keys(session.input, ' ');
  keys(session.input, '\u001b[B');
  keys(session.input, ' ');
  assert.match(session.output.writes.join(''), /Select no more than 1 items/);
  keys(session.input, '\r');
  const result = await session.promise;
  assert.deepEqual(result.selected, ['one']);
  assert.deepEqual(session.input.rawTransitions, [true, false]);
}

// A broken terminal output still rejects and restores raw mode; cleanup output is best-effort.
{
  const session = start({ failAt: 2 });
  await assert.rejects(session.promise, /injected terminal write failure/);
  assert.deepEqual(session.input.rawTransitions, [true, false]);
  assert.equal(session.input.isRaw, false);
}

process.stdout.write('Interactive TUI tests passed: retro header palettes/fallbacks, redraw layout, key selection, and terminal cleanup.\n');
if (originalTerm === undefined) delete process.env.TERM;
else process.env.TERM = originalTerm;
if (originalNoColor === undefined) delete process.env.NO_COLOR;
else process.env.NO_COLOR = originalNoColor;
