import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseWorkQueueItems } from "../cockpit/server/work-queue.mjs";

// Contract under test: the reader either returns a value exactly as the YAML
// author wrote it, or does not return it and warns. It never returns a
// truncated, unescaped, coerced, or defaulted value.

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const queue = (body) => `version: 2\nitems:\n${body}`;
const only = (source) => {
  const parsed = parseWorkQueueItems(source);
  assert.equal(parsed.items.length, 1, JSON.stringify(parsed));
  return parsed;
};

// --- Supported shapes return exact author text ------------------------------

{
  const parsed = parseWorkQueueItems(`---
# leading comment
version: 2
items:
  - id: 1.10                       # stays "1.10", never the float 1.1
    title: "Quoted # not a comment"
    owner: 'it''s mine'
    state: in_review
    attempts: 2
    depends_on: []
    required_gates: [npm-test, diff-check]
    acceptance_metric_ids:
      - M-1
      - M-2
    blocked_by: ~
    reviewer: null
    note:
policy:
  - id: not-an-item
`);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.unreadable, false);
  assert.deepEqual(parsed.items, [{
    id: "1.10",
    title: "Quoted # not a comment",
    owner: "it's mine",
    state: "in_review",
    attempts: "2",
    depends_on: [],
    required_gates: ["npm-test", "diff-check"],
    acceptance_metric_ids: ["M-1", "M-2"],
    blocked_by: null,
    reviewer: null,
    note: null,
    source_line: 5,
    unsupported_keys: [],
  }]);
}

// Block list items at column 0 under items: are valid YAML and supported.
assert.deepEqual(parseWorkQueueItems("items:\n- id: A\n  state: ready\n- id: B\nnext: 1\n").items.map((item) => item.id), ["A", "B"]);
// Empty and absent queues are distinguishable.
assert.deepEqual(parseWorkQueueItems("items:\n"), { items: [], warnings: [], unreadable: false });
assert.deepEqual(parseWorkQueueItems("version: 2\n"), { items: [], warnings: ["no top-level items: list"], unreadable: false });

// --- Valid but unsupported values: the key is dropped, the item is kept ------

const keyLevel = [
  ["multi-line plain scalar", "    title: first line\n      continues here\n", "title"],
  ["literal block scalar", "    title: |\n      text\n", "title"],
  ["folded block scalar", "    title: >\n      text\n", "title"],
  ["anchor", "    state: &s ready\n", "state"],
  ["alias", "    state: *s\n", "state"],
  ["tag", "    attempts: !!int 3\n", "attempts"],
  ["double-quoted escape", '    title: "a\\"b"\n', "title"],
  ["double-quoted backslash", '    title: "C:\\\\path"\n', "title"],
  ["multi-line double-quoted scalar", '    title: "first\n      second"\n', "title"],
  ["quoted comma in flow list", '    required_gates: [a, "b,c"]\n', "required_gates"],
  ["nested flow list", "    required_gates: [a, [b]]\n", "required_gates"],
  ["multi-line flow list", "    required_gates: [a,\n      b]\n", "required_gates"],
  ["flow mapping", "    owner: {name: x}\n", "owner"],
  ["nested block mapping", "    owner:\n      name: x\n", "owner"],
  ["mapping inside block list", "    depends_on:\n      - id: X\n", "depends_on"],
  ["nested content under list entry", "    depends_on:\n      - X\n        extra\n", "depends_on"],
  ["empty block list entry", "    depends_on:\n      -\n", "depends_on"],
  ["mixed list indentation", "    depends_on:\n      - A\n        - B\n", "depends_on"],
  ["duplicate key", "    state: ready\n    state: approved\n", "state"],
  ["dash-led plain scalar", "    title: -x\n", "title"],
];
for (const [label, body, key] of keyLevel) {
  const parsed = only(queue(`  - id: X-1\n${body}    card: features/X-1.md\n`));
  const [item] = parsed.items;
  assert.equal(Object.hasOwn(item, key), false, `${label}: ${key} must not be returned`);
  assert.deepEqual(item.unsupported_keys, [key], `${label}: ${key} must be listed as unsupported`);
  assert.equal(item.card, "features/X-1.md", `${label}: unaffected keys are still read`);
  assert.ok(parsed.warnings.some((warning) => warning.includes(`key ${key} not read`)), `${label}: must warn`);
}

// --- Unsupported item structure: the whole item is dropped ------------------

const itemLevel = [
  ["merge key", "  - id: X-1\n    <<: *base\n"],
  ["quoted key", '  - "id": X-1\n'],
  ["anchored id", "  - id: &a X-1\n"],
  ["missing id", "  - state: ready\n"],
  ["null id", "  - id: ~\n"],
  ["scalar list entry", "  - X-1\n"],
  ["compact key without space", "  - id:X-1\n"],
];
for (const [label, body] of itemLevel) {
  const parsed = parseWorkQueueItems(queue(`${body}  - id: KEEP\n`));
  assert.deepEqual(parsed.items.map((item) => item.id), ["KEEP"], `${label}: the item must be dropped, neighbours kept`);
  assert.ok(parsed.warnings.some((warning) => /item at line \d+ not read/.test(warning)), `${label}: must warn`);
}
{
  const parsed = parseWorkQueueItems(queue("  - id: DUP\n    state: a\n  - id: DUP\n    state: b\n  - id: KEEP\n"));
  assert.deepEqual(parsed.items.map((item) => item.id), ["KEEP"], "duplicate IDs are never resolved by order");
  assert.ok(parsed.warnings.some((warning) => warning.includes("DUP appears more than once")));
}

// --- Invalid YAML anywhere: nothing is read ----------------------------------
// A real parser rejects these documents. Reading "the other keys" would be
// wrong: an unclosed quote, for example, swallows the following lines.

const invalidValue = [
  ["unterminated double quote", '    title: "abc\n'],
  ["unterminated single quote", "    title: 'abc\n"],
  ["stray single quote", "    title: 'it's'\n"],
  ["unescaped inner double quote", '    title: "a"b"\n'],
  ["empty flow list entry", "    required_gates: [a, , b]\n"],
  ["unterminated flow list", "    required_gates: [a, b\n"],
  ["mapping-like plain scalar", "    title: a: b\n"],
  ["trailing colon plain scalar", "    title: done:\n"],
  ["reserved indicator", "    title: @handle\n"],
  ["block sequence as inline value", "    title: - x\n"],
  ["key-like continuation line", "      state: ready\n"],
  ["invalid entry in block list", "    depends_on:\n      - \"open\n"],
];
for (const [label, body] of invalidValue) {
  const parsed = parseWorkQueueItems(queue(`  - id: X-1\n${body}    card: features/X-1.md\n  - id: KEEP\n`));
  assert.deepEqual(parsed.items, [], `${label}: no item may be returned from invalid YAML`);
  assert.equal(parsed.unreadable, true, label);
  assert.match(parsed.warnings[0], /^work queue not read: line \d+: \w+ is not valid YAML$/, label);
}

// --- Unsupported document structure: nothing is read -------------------------

const queueLevel = [
  ["tab indentation", "items:\n\t- id: X-1\n"],
  ["tab inside an item", "items:\n  - id: X-1\n\t  state: ready\n"],
  ["multiple documents", "items:\n  - id: X-1\n---\nitems:\n  - id: X-2\n"],
  ["document end marker", "items:\n  - id: X-1\n...\n"],
  ["inline items", "items: [{id: X-1}]\n"],
  ["anchored items", "items: &all\n  - id: X-1\n"],
  ["duplicate items key", "items:\n  - id: X-1\nitems:\n  - id: X-2\n"],
  ["items is a mapping", "items:\n  first:\n    id: X-1\n"],
  ["inconsistent list indentation", "items:\n    - id: X-1\n  - id: X-2\n"],
];
for (const [label, source] of queueLevel) {
  const parsed = parseWorkQueueItems(source);
  assert.deepEqual(parsed.items, [], `${label}: no item may be returned`);
  assert.equal(parsed.unreadable, true, `${label}: the queue is unreadable`);
  assert.match(parsed.warnings[0], /^work queue not read: /, label);
}

// --- The shipped template is fully supported --------------------------------

{
  const template = await readFile(path.join(repositoryRoot, "skills/triad-loop-bootstrap/assets/loop-template/work-queue.yaml"), "utf8");
  const parsed = parseWorkQueueItems(template);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.items[0].id, "EXAMPLE-001");
  assert.equal(parsed.items[0].state, "draft");
  assert.deepEqual(parsed.items[0].unsupported_keys, []);
}

process.stdout.write("cockpit work-queue reader tests passed\n");
