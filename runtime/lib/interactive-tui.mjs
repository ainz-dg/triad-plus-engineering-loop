import { paint } from './terminal.mjs';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function cellWidth(cluster) {
  if (/\p{Extended_Pictographic}/u.test(cluster) || /[\u{1f1e6}-\u{1f1ff}]{2}/u.test(cluster)) return 2;
  let width = 0;
  for (const character of cluster) {
    const codePoint = character.codePointAt(0);
    if (/\p{Mark}/u.test(character) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) continue;
    if ((codePoint >= 0x1100 && codePoint <= 0x115f)
      || codePoint === 0x2329 || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)) return 2;
    width += 1;
  }
  return width;
}

function takeCells(characters, budget, fromEnd = false) {
  const selected = [];
  let width = 0;
  const source = fromEnd ? [...characters].reverse() : characters;
  for (const character of source) {
    const nextWidth = cellWidth(character);
    if (width + nextWidth > budget) break;
    selected.push(character);
    width += nextWidth;
  }
  return fromEnd ? selected.reverse() : selected;
}

function clip(value, width) {
  width = Math.max(1, Math.floor(width));
  const chars = Array.from(graphemes.segment(String(value)), (entry) => entry.segment);
  if (chars.reduce((total, character) => total + cellWidth(character), 0) <= width) return chars.join('');
  if (width <= 1) return '…'.slice(0, width);
  if (width <= 5) return `${takeCells(chars, width - 1).join('')}…`;
  const left = Math.ceil((width - 1) / 2);
  const right = Math.floor((width - 1) / 2);
  return `${takeCells(chars, left).join('')}…${takeCells(chars, right, true).join('')}`;
}

function clipEnd(value, width) {
  const chars = Array.from(graphemes.segment(String(value)), (entry) => entry.segment);
  if (chars.reduce((total, character) => total + cellWidth(character), 0) <= width) return chars.join('');
  if (width <= 1) return '…'.slice(0, width);
  return `${takeCells(chars, width - 1).join('')}…`;
}

function style(value, tone, output) {
  if (process.env.TERM === 'dumb') return String(value);
  return paint(value, tone, { stream: output });
}

/** A small raw-key checklist with deterministic terminal restoration. */
export async function selectChecklist({
  step,
  title,
  context = [],
  description = '',
  items,
  initialSelection = [],
  initialFocus,
  minimum = 1,
  maximum = Infinity,
  escapeBehavior = 'cancel',
  selectionSummary = (selected) => `${selected.length} selected`,
  hint = '↑↓ move · Space toggle · Enter continue · Esc cancel',
  initialMessage = '',
  header = '',
  input = process.stdin,
  output = process.stdout,
}) {
  if (!input?.isTTY || typeof input.setRawMode !== 'function' || !output?.isTTY) {
    throw new Error('The keyboard selection screen requires an interactive terminal.');
  }
  if (!Array.isArray(items) || !items.length) throw new Error('The keyboard selection screen needs at least one option.');
  if (!['cancel', 'back'].includes(escapeBehavior)) throw new Error(`Unsupported Escape behavior: ${escapeBehavior}`);
  if (!Number.isInteger(minimum) || minimum < 0) throw new Error('The minimum selection must be a non-negative integer.');
  if (!(maximum === Infinity || (Number.isInteger(maximum) && maximum >= minimum))) {
    throw new Error('The maximum selection must be an integer no smaller than the minimum.');
  }

  const selectableIds = new Set(items.filter((item) => item.kind !== 'action').map((item) => item.id));
  const order = [...new Set(initialSelection)].filter((id) => selectableIds.has(id));
  const selected = new Set(order);
  const start = initialFocus ? items.findIndex((item) => item.id === initialFocus) : -1;
  let focus = start >= 0 ? start : Math.max(0, items.findIndex((item) => item.kind !== 'action'));
  let scrollTop = 0;
  let message = initialMessage;
  let buffer = '';
  let escapeTimer = null;
  const useScreenControls = output.isTTY && process.env.TERM !== 'dumb';
  const originalRawMode = Boolean(input.isRaw);
  const headerLineCount = header ? header.trimEnd().split('\n').length : 0;
  let renderedLineCount = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (escapeTimer) clearTimeout(escapeTimer);
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      process.removeListener('SIGINT', onSigint);
      try { input.setRawMode(originalRawMode); } catch {}
      if (!originalRawMode) input.pause();
      if (useScreenControls) {
        const restore = process.env.NO_COLOR === undefined ? '\u001b[?25h\u001b[0m\n' : '\u001b[?25h\n';
        try { output.write(restore); } catch {}
      }
    };
    const finish = (value) => { cleanup(); resolve(value); };
    const fail = (error) => { cleanup(); reject(error); };
    const selectedIds = () => [...order];
    const visibleCount = () => Math.max(1, Math.min(14, (Number(output.rows) || 24) - 11 - headerLineCount));

    const render = (full = true) => {
      const rows = visibleCount();
      if (focus < scrollTop) scrollTop = focus;
      if (focus >= scrollTop + rows) scrollTop = focus - rows + 1;
      const width = Math.max(1, (Number(output.columns) || 80) - 1);
      if (!useScreenControls && !full) {
        const focused = items[focus];
        output.write(`\n${clip(`Focus: ${focused.label}`, width)}\n${clipEnd(`Selection: ${selectionSummary(selectedIds())}`, width)}\n`);
        if (message) output.write(`${clip(message, width)}\n`);
        message = '';
        return;
      }
      const lines = [
        style(clip(step, width), 'hint', output),
        style(clip(title, width), 'title', output),
        ...context.map((line) => style(clip(line, width), 'hint', output)),
        ...(description ? [style(clip(description, width), 'hint', output)] : []),
        clip(`Selection: ${selectionSummary(selectedIds())}`, width),
        '',
      ];
      for (let index = scrollTop; index < Math.min(items.length, scrollTop + rows); index += 1) {
        const item = items[index];
        const active = index === focus;
        let line;
        if (item.kind === 'action') {
          const detail = item.description ? ` — ${item.description}` : '';
          line = `  ${item.label}${detail}`;
        } else {
          const isSelected = selected.has(item.id);
          const primary = isSelected && order[0] === item.id ? ' · primary' : '';
          line = `${isSelected ? '[x]' : '[ ]'} ${item.label}${primary}${item.description ? ` — ${item.description}` : ''}`;
        }
        const clipped = clip(`${active ? '›' : ' '} ${line}`, width);
        const tone = active ? 'value' : item.kind === 'action' ? 'warning' : selected.has(item.id) ? 'success' : 'hint';
        lines.push(style(clipped, tone, output));
      }
      if (items.length > rows) lines.push(`Options ${scrollTop + 1}–${Math.min(items.length, scrollTop + rows)} of ${items.length}`);
      lines.push('', clip(hint, width));
      if (message) lines.push(style(message, 'error', output));
      if (useScreenControls) {
        // Anchor subsequent frames to the live cursor rather than an absolute
        // row: readline prompts may have scrolled since the one-time brand mark.
        // Clear each bounded frame row so shorter content cannot leave residue.
        // One buffered write avoids a blank frame while retaining the header.
        const frameHeight = Math.max(renderedLineCount, lines.length);
        const cursor = renderedLineCount ? `\u001b[${renderedLineCount}A\r` : '\r';
        const frame = Array.from({ length: frameHeight }, (_, index) => `\u001b[2K${lines[index] ?? ''}`).join('\n');
        output.write(`${cursor}${frame}\n`);
        renderedLineCount = frameHeight;
      } else {
        output.write(`${lines.join('\n')}\n`);
      }
      message = '';
    };

    const changed = () => {
      try { render(useScreenControls); }
      catch (error) { fail(error); }
    };
    const handleEscape = () => finish({ kind: escapeBehavior, selected: selectedIds() });
    const handleKey = (key) => {
      if (key === 'up' || key === 'down') {
        const delta = key === 'up' ? -1 : 1;
        focus = Math.max(0, Math.min(items.length - 1, focus + delta));
        message = '';
        changed();
        return;
      }
      if (key === 'escape') { handleEscape(); return; }
      if (key === 'interrupt') { finish({ kind: 'interrupt', selected: selectedIds() }); return; }
      if (key === 'space') {
        const item = items[focus];
        if (item.kind === 'action') {
          message = 'Use Enter to open this action.';
        } else if (selected.has(item.id)) {
          selected.delete(item.id);
          order.splice(order.indexOf(item.id), 1);
          message = '';
        } else if (selected.size >= maximum) {
          message = `Select no more than ${maximum} items.`;
        } else {
          selected.add(item.id);
          order.push(item.id);
          message = '';
        }
        changed();
        return;
      }
      if (key === 'enter') {
        const item = items[focus];
        if (item.kind === 'action') {
          finish({ kind: 'action', action: item.action, selected: selectedIds() });
          return;
        }
        if (selected.size < minimum) {
          message = minimum === 1
            ? 'Select a row with Space, or choose an explicit repository action.'
            : `Select at least ${minimum} items to continue.`;
          changed();
          return;
        }
        finish({ kind: 'selected', selected: selectedIds() });
      }
    };

    const onData = (chunk) => {
      try {
        buffer += chunk.toString('utf8');
        while (buffer.length && !settled) {
          if (buffer.startsWith('\u001b')) {
            if (buffer.length === 1) {
              if (!escapeTimer) escapeTimer = setTimeout(() => {
                escapeTimer = null;
                if (buffer === '\u001b') { buffer = ''; handleKey('escape'); }
              }, 65);
              return;
            }
            if (buffer.startsWith('\u001b[')) {
              if (buffer.length < 3) return;
              const final = buffer[2];
              buffer = buffer.slice(3);
              if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
              if (final === 'A') handleKey('up');
              else if (final === 'B') handleKey('down');
              continue;
            }
            buffer = buffer.slice(1);
            if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
            handleKey('escape');
            continue;
          }
          const char = buffer[0];
          buffer = buffer.slice(1);
          if (char === '\u0003') handleKey('interrupt');
          else if (char === ' ' || char === '\u0000') handleKey('space');
          else if (char === '\r' || char === '\n') handleKey('enter');
        }
      } catch (error) { fail(error); }
    };
    const onError = (error) => fail(error);
    const onSigint = () => handleKey('interrupt');

    try {
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      input.once('error', onError);
      process.once('SIGINT', onSigint);
      if (useScreenControls) output.write('\u001b[?25l');
      render();
    } catch (error) { fail(error); }
  });
}
