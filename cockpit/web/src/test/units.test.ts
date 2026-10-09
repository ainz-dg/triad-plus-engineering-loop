import { describe, expect, it } from "vitest";
import { parseBlocks } from "../components/Markdown";
import { formatDuration } from "../format";
import { parseRoute, routeHref } from "../route";

describe("route", () => {
  it("round-trips project, card, and file, including awkward IDs", () => {
    const route = { project: "mobile-shell", card: "1.1/x?y", file: ".loop/evidence/1.1/attempt-001/logs/unit.stdout.log" };
    expect(parseRoute(routeHref(route))).toEqual(route);
    expect(parseRoute("#/p/root")).toEqual({ project: "root", card: null, file: null });
    expect(parseRoute("#/garbage/%E0%A4%A")).toEqual({ project: null, card: null, file: null });
  });
});

describe("markdown parser", () => {
  it("always terminates and classifies blocks", () => {
    const blocks = parseBlocks("# Title\n\n- a\n- b\n\n```js\nx()\n```\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\nplain #tag\n-\n1.");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "list", "code", "quote", "table", "rule", "paragraph"]);
  });
});

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(102)).toBe("102 ms");
    expect(formatDuration(3984)).toBe("3.98 s");
    expect(formatDuration(16004)).toBe("16.0 s");
    expect(formatDuration(null)).toBe("—");
  });
});
