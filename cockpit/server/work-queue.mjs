// Tolerant reader for the `items:` list of .loop/work-queue.yaml.
//
// The work queue is written by host agents, not by runtime code, and real
// workspaces drift from the template. This is deliberately not a YAML parser:
// it recognizes the template shape (a block list of flat mappings whose values
// are scalars, flow lists, or block lists of scalars) and reports everything
// else as a warning instead of guessing. Scalars stay strings so IDs such as
// `1.1` are never coerced to numbers.

const MAX_ITEMS = 2000;

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function scalar(text) {
  const value = text.trim();
  if (value === "" || value === "~" || value === "null") return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function flowList(text) {
  const inner = text.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((part) => scalar(part)).filter((part) => part !== null);
}

function value(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return flowList(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("|") || trimmed.startsWith(">") || trimmed.startsWith("&") || trimmed.startsWith("*")) {
    return undefined;
  }
  return scalar(trimmed);
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

/** Return `{ items, warnings }`; never throws on malformed input. */
export function parseWorkQueueItems(source) {
  const warnings = [];
  const items = [];
  if (typeof source !== "string") return { items, warnings: ["work queue is not text"] };
  const lines = source.split(/\r?\n/).map((raw, index) => ({ number: index + 1, text: stripComment(raw).replace(/\s+$/, "") }));
  const start = lines.findIndex((line) => /^items:\s*$/.test(line.text));
  if (start < 0) return { items, warnings: ["no top-level items: list"] };

  let current = null;
  let itemIndent = null;
  let keyIndent = null;
  let pendingListKey = null;

  const finish = () => {
    if (!current) return;
    if (typeof current.id !== "string" || !current.id) warnings.push(`item at line ${current.__line} has no scalar id and was skipped`);
    else items.push(current);
    current = null;
  };

  const assign = (line, text) => {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(text);
    if (!match) {
      warnings.push(`line ${line.number}: unrecognized entry ignored`);
      pendingListKey = null;
      return;
    }
    const [, key, rest = ""] = match;
    if (rest.trim() === "") {
      current[key] = [];
      pendingListKey = key;
      return;
    }
    const parsed = value(rest);
    if (parsed === undefined) {
      warnings.push(`line ${line.number}: ${key} uses unsupported YAML and was ignored`);
      delete current[key];
    } else {
      current[key] = parsed;
    }
    pendingListKey = null;
  };

  for (const line of lines.slice(start + 1)) {
    if (!line.text.trim()) continue;
    const indent = indentation(line.text);
    const text = line.text.trim();
    if (indent === 0) break; // next top-level key ends the list
    if (itemIndent === null && text.startsWith("- ")) itemIndent = indent;

    if (indent === itemIndent && text.startsWith("- ")) {
      finish();
      if (items.length >= MAX_ITEMS) {
        warnings.push(`more than ${MAX_ITEMS} items; remaining items ignored`);
        break;
      }
      current = { __line: line.number };
      keyIndent = null;
      pendingListKey = null;
      assign(line, text.slice(2).trim());
      continue;
    }
    if (!current) {
      warnings.push(`line ${line.number}: content outside an item ignored`);
      continue;
    }
    if (pendingListKey && text.startsWith("- ") && (keyIndent === null || indent >= keyIndent)) {
      const entry = value(text.slice(2));
      if (entry === undefined || Array.isArray(entry)) {
        warnings.push(`line ${line.number}: nested value in ${pendingListKey} ignored`);
      } else if (entry !== null) {
        current[pendingListKey].push(entry);
      }
      continue;
    }
    if (keyIndent === null) keyIndent = indent;
    if (indent !== keyIndent) {
      warnings.push(`line ${line.number}: nested mapping ignored`);
      pendingListKey = null;
      continue;
    }
    assign(line, text);
  }
  finish();

  for (const item of items) {
    const line = item.__line;
    delete item.__line;
    // An empty `key:` with nothing beneath it is a null scalar, not a list.
    for (const [key, entry] of Object.entries(item)) {
      if (Array.isArray(entry) && entry.length === 0 && !/^(depends_on|required_gates|acceptance_metric_ids)$/.test(key)) item[key] = null;
    }
    Object.defineProperty(item, "source_line", { value: line, enumerable: true });
  }
  return { items, warnings };
}
