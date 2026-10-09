// Fail-closed reader for the `items:` list of .loop/work-queue.yaml.
//
// The work queue is written by host agents, not by runtime code. This is not a
// YAML parser and does not try to be one. It accepts exactly the template
// shape:
//
//   items:
//     - id: 1.1                      # plain or quoted scalars
//       required_gates: [a, b]       # flow list of plain scalars
//       depends_on:                  # block list of scalars
//         - 1.0
//
// Anything else is never approximated:
// - valid YAML outside that shape (anchors, tags, block scalars, escapes,
//   nested mappings, ...) drops the affected key or item, with a warning;
// - text that is not valid YAML makes the whole queue unreadable, because a
//   real parser would reject the document and line-local recovery could
//   attribute later lines to the wrong key (an unclosed quote swallows them).
// Scalars stay strings, so `1.10` is not read as the float `1.1`.

const MAX_ITEMS = 2000;
const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ ]+(.*))?$/;
const NULLS = new Set(["", "~", "null", "Null", "NULL"]);
// Characters that start a YAML construct other than a plain scalar.
const INDICATOR_START = /^[-?:,\[\]{}#&*!|>'"%@`]/;
// Indicators that YAML reserves or forbids at the start of a plain scalar.
const INVALID_START = /^([@`%,\]}]|- |-$)/;
const BLOCK_SCALAR = /^[|>][+-]?[1-9]?[+-]?$/;
const UNSUPPORTED = Symbol("unsupported");
const INVALID = Symbol("invalid");

function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || text[index - 1] === " " || text[index - 1] === "\t")) {
      return text.slice(0, index);
    }
  }
  return text;
}

/**
 * One single-line scalar: a string, null, UNSUPPORTED (valid YAML this reader
 * does not interpret), or INVALID (not valid YAML on one line).
 */
function scalar(raw) {
  const text = raw.trim();
  if (NULLS.has(text)) return null;
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) return INVALID;
    const inner = text.slice(1, -1);
    // Escapes change meaning; refuse rather than re-implement them.
    if (inner.includes("\\")) return UNSUPPORTED;
    return inner.includes('"') ? INVALID : inner;
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) return INVALID;
    const inner = text.slice(1, -1);
    if (inner.replaceAll("''", "").includes("'")) return INVALID;
    return inner.replaceAll("''", "'");
  }
  if (INVALID_START.test(text)) return INVALID;
  // Anchors, aliases, tags, flow mappings, block scalars: valid, not read.
  if (INDICATOR_START.test(text)) return UNSUPPORTED;
  if (text.includes(": ") || text.endsWith(":")) return INVALID;
  if (text.includes("\t")) return UNSUPPORTED;
  return text;
}

/** A single-line flow list of plain scalars, UNSUPPORTED, or INVALID. */
function flowList(text) {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  if (/["'\[\]{}]/.test(inner)) return UNSUPPORTED;
  const values = inner.split(",").map((part) => (part.trim() === "" ? INVALID : scalar(part)));
  if (values.includes(INVALID)) return INVALID;
  if (values.some((value) => value === UNSUPPORTED || value === null)) return UNSUPPORTED;
  return values;
}

function inlineValue(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return trimmed.endsWith("]") ? flowList(trimmed) : INVALID;
  return scalar(trimmed);
}

/** A value followed by deeper lines: valid multi-line YAML or an error. */
function continuedValue(rest, children) {
  const text = rest.trim();
  // Block scalars and multi-line flow collections are valid YAML we do not read.
  if (BLOCK_SCALAR.test(text) || text.startsWith("[") || text.startsWith("{")) return UNSUPPORTED;
  // A plain or quoted scalar may continue on deeper lines, but a continuation
  // that looks like `key: value` is a mapping YAML does not allow there.
  if (children.some((child) => child.text.includes(": ") || child.text.endsWith(":"))) return INVALID;
  return UNSUPPORTED;
}

function lineRecords(source) {
  return source.split(/\r?\n/).map((raw, index) => {
    const leading = raw.length - raw.replace(/^[ \t]+/, "").length;
    const text = stripComment(raw).replace(/[ \t]+$/, "");
    return { number: index + 1, indent: leading, tab: raw.slice(0, leading).includes("\t"), text: text.trimStart() };
  }).filter((line) => line.text !== "");
}

function failQueue(reason) {
  return { items: [], warnings: [`work queue not read: ${reason}`], unreadable: true };
}

/** Parse one `- ` entry: { item, unsupported }, { dropped }, or { invalid }. */
function parseItem(lines) {
  const [first, ...rest] = lines;
  if (lines.some((line) => line.tab)) return { dropped: "tab indentation" };
  const afterDash = first.text.slice(1);
  const offset = afterDash.length - afterDash.trimStart().length;
  const entries = [];
  if (afterDash.trim() !== "") entries.push({ number: first.number, indent: first.indent + 1 + offset, text: afterDash.trimStart() });
  entries.push(...rest);
  if (entries.length === 0) return { dropped: "empty item" };
  const keyIndent = entries[0].indent;

  const item = {};
  const unsupported = new Set();
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.indent !== keyIndent) return { dropped: `line ${entry.number}: unexpected indentation` };
    const match = KEY.exec(entry.text);
    if (!match) return { dropped: `line ${entry.number}: unsupported key syntax` };
    const [, key, rest = ""] = match;

    // Children: deeper lines, or `- ` entries at the key's own indentation.
    const children = [];
    while (index + 1 < entries.length) {
      const next = entries[index + 1];
      if (next.indent > keyIndent || (next.indent === keyIndent && next.text.startsWith("- "))) {
        children.push(next);
        index += 1;
      } else break;
    }

    let value;
    if (rest.trim() !== "") {
      // A value plus deeper lines is never truncated to its first line.
      value = children.length ? continuedValue(rest, children) : inlineValue(rest);
    } else if (children.length === 0) {
      value = null;
    } else {
      const listIndent = children[0].indent;
      // `- key: value` inside a list is a nested mapping: valid, not read.
      const entryValue = (text) => (KEY.test(text.trim()) ? UNSUPPORTED : scalar(text));
      const list = children.every((child) => child.indent === listIndent && child.text.startsWith("- "))
        ? children.map((child) => entryValue(child.text.slice(2)))
        : [UNSUPPORTED];
      if (list.includes(INVALID)) value = INVALID;
      else value = list.some((entry) => entry === UNSUPPORTED || entry === null) ? UNSUPPORTED : list;
    }
    if (value === INVALID) return { invalid: `line ${entry.number}: ${key} is not valid YAML` };

    if (seen.has(key)) {
      unsupported.add(key);
      delete item[key];
      continue;
    }
    seen.add(key);
    if (value === UNSUPPORTED) unsupported.add(key);
    else item[key] = value;
  }

  if (unsupported.has("id")) return { dropped: "id uses unsupported YAML" };
  if (typeof item.id !== "string" || item.id === "") return { dropped: "no scalar id" };
  return { item, unsupported: [...unsupported].sort() };
}

/**
 * Return `{ items, warnings, unreadable }`. Never throws. Each item carries
 * `source_line` and `unsupported_keys` (keys present but deliberately not read).
 */
export function parseWorkQueueItems(source) {
  if (typeof source !== "string") return failQueue("not text");
  const lines = lineRecords(source);
  const markers = lines.filter((line) => line.indent === 0 && /^(---|\.\.\.)(\s|$)/.test(line.text));
  if (markers.length > 1 || (markers.length === 1 && (lines[0] !== markers[0] || lines[0].text !== "---"))) {
    return failQueue("multiple documents or document markers");
  }
  const body = markers.length ? lines.slice(1) : lines;
  const starts = body.filter((line) => line.indent === 0 && /^items\s*:/.test(line.text));
  if (starts.length === 0) return { items: [], warnings: ["no top-level items: list"], unreadable: false };
  if (starts.length > 1) return failQueue("duplicate top-level items key");
  if (!/^items:$/.test(starts[0].text)) return failQueue("items uses inline, tagged, or anchored YAML");

  const block = [];
  for (const line of body.slice(body.indexOf(starts[0]) + 1)) {
    if (line.indent === 0 && !(line.text === "-" || line.text.startsWith("- "))) break;
    block.push(line);
  }
  if (block.length === 0) return { items: [], warnings: [], unreadable: false };
  const itemIndent = block[0].indent;
  if (!(block[0].text === "-" || block[0].text.startsWith("- "))) return failQueue("items is not a block list");
  if (block.some((line) => line.tab)) return failQueue("tab indentation");

  const groups = [];
  for (const line of block) {
    if (line.indent < itemIndent) return failQueue(`line ${line.number}: inconsistent list indentation`);
    if (line.indent === itemIndent) {
      if (!(line.text === "-" || line.text.startsWith("- "))) return failQueue(`line ${line.number}: unexpected content in items list`);
      groups.push([line]);
    } else {
      groups.at(-1).push(line);
    }
  }

  const items = [];
  const warnings = [];
  for (const group of groups) {
    if (items.length >= MAX_ITEMS) {
      warnings.push(`more than ${MAX_ITEMS} items; remaining items not read`);
      break;
    }
    const parsed = parseItem(group);
    if (parsed.invalid) return failQueue(parsed.invalid);
    if (parsed.dropped) {
      warnings.push(`item at line ${group[0].number} not read: ${parsed.dropped}`);
      continue;
    }
    for (const key of parsed.unsupported) warnings.push(`item ${parsed.item.id} (line ${group[0].number}): key ${key} not read (unsupported YAML)`);
    items.push({ ...parsed.item, source_line: group[0].number, unsupported_keys: parsed.unsupported });
  }
  const ids = items.map((item) => item.id);
  const duplicates = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
  if (duplicates.size) {
    for (const id of duplicates) warnings.push(`id ${id} appears more than once; those items are not read`);
    return { items: items.filter((item) => !duplicates.has(item.id)), warnings, unreadable: false };
  }
  return { items, warnings, unreadable: false };
}
