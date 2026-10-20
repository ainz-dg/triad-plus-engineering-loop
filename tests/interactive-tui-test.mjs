import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { selectChecklist } from '../runtime/lib/interactive-tui.mjs';

const originalTerm = process.env.TERM;
process.env.TERM = 'xterm-256color';

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

const selectionSummary = (selected) => `${selected.length} selected${selected[0] ? ` · primary ${selected[0]}` : ''}`;

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

process.stdout.write('Interactive TUI raw-key and cleanup tests passed: selection order, zero-selection, max-selection, dumb-terminal width updates, injected output failure.\n');
if (originalTerm === undefined) delete process.env.TERM;
else process.env.TERM = originalTerm;
