/** Minimal deterministic terminal-cell interpreter for the interactive TUI tests. */
export function terminalScreen(transcript, { rows = 24, columns = 80 } = {}) {
  const screen = Array.from({ length: rows }, () => Array(columns).fill(' '));
  let row = 0;
  let column = 0;
  let saved = [0, 0];
  let top = 0;
  let bottom = rows - 1;

  const scroll = () => {
    screen.splice(top, 1);
    screen.splice(bottom, 0, Array(columns).fill(' '));
  };
  const lineFeed = () => {
    column = 0;
    if (row === bottom) scroll();
    else row = Math.min(rows - 1, row + 1);
  };
  const clearRow = (target, from, to) => {
    if (target < 0 || target >= rows) return;
    for (let index = Math.max(0, from); index < Math.min(columns, to); index += 1) screen[target][index] = ' ';
  };
  const widthOf = (character) => {
    if (/^[\u0300-\u036f\u200d\ufe00-\ufe0f]$/u.test(character)) return 0;
    return /^[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]$/u.test(character) ? 2 : 1;
  };
  const put = (character) => {
    const width = widthOf(character);
    if (!width) {
      if (column > 0) screen[row][column - 1] += character;
      return;
    }
    if (column >= columns) {
      column = 0;
      lineFeed();
    }
    screen[row][column] = character;
    for (let cell = 1; cell < width && column + cell < columns; cell += 1) screen[row][column + cell] = '';
    column += width;
  };
  const paramsOf = (raw) => raw.replace(/^\?/, '').split(';').map((part) => Number.parseInt(part, 10) || 0);
  const clearDisplay = (mode) => {
    if (mode === 2 || mode === 3) {
      for (const line of screen) line.fill(' ');
    } else if (mode === 0) {
      clearRow(row, column, columns);
      for (let index = row + 1; index < rows; index += 1) screen[index].fill(' ');
    } else if (mode === 1) {
      for (let index = 0; index < row; index += 1) screen[index].fill(' ');
      clearRow(row, 0, column + 1);
    }
  };

  for (let index = 0; index < transcript.length;) {
    const character = transcript[index];
    if (character === '\u001b' && transcript[index + 1] === '[') {
      let end = index + 2;
      while (end < transcript.length && !/[\u0040-\u007e]/.test(transcript[end])) end += 1;
      if (end >= transcript.length) break;
      const body = transcript.slice(index + 2, end);
      const command = transcript[end];
      const params = paramsOf(body);
      const first = params[0] || 1;
      if (command === 'H' || command === 'f') {
        row = Math.max(0, Math.min(rows - 1, (params[0] || 1) - 1));
        column = Math.max(0, Math.min(columns - 1, (params[1] || 1) - 1));
      } else if (command === 'A') row = Math.max(0, row - first);
      else if (command === 'B') row = Math.min(rows - 1, row + first);
      else if (command === 'C') column = Math.min(columns - 1, column + first);
      else if (command === 'D') column = Math.max(0, column - first);
      else if (command === 'G') column = Math.max(0, Math.min(columns - 1, first - 1));
      else if (command === 'd') row = Math.max(0, Math.min(rows - 1, first - 1));
      else if (command === 'J') clearDisplay(params[0]);
      else if (command === 'K') {
        if (params[0] === 2) clearRow(row, 0, columns);
        else if (params[0] === 1) clearRow(row, 0, column + 1);
        else clearRow(row, column, columns);
      } else if (command === 'r') {
        top = Math.max(0, (params[0] || 1) - 1);
        bottom = Math.max(top, Math.min(rows - 1, (params[1] || rows) - 1));
      } else if (command === 's') saved = [row, column];
      else if (command === 'u') [row, column] = saved;
      index = end + 1;
      continue;
    }
    if (character === '\r') column = 0;
    else if (character === '\n') lineFeed();
    else if (character === '\b') column = Math.max(0, column - 1);
    else if (character === '\t') column = Math.min(columns - 1, Math.ceil((column + 1) / 8) * 8);
    else if (character >= ' ') put(character);
    index += 1;
  }

  return screen.map((line) => line.join('').replace(/\s+$/u, ''));
}
