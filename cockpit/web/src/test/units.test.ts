import { beforeAll, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Markdown, parseBlocks } from "../components/Markdown";
import { formatDuration } from "../format";
import { parseRoute, routeHref } from "../route";

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
  document.head.append(style);
});

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

describe("markdown containment", () => {
  it("wraps prose while keeping wide code and tables in their own scrollports", () => {
    const token = "a".repeat(64);
    const { container } = render(createElement(Markdown, {
      source: `### ${token}\n\nA hash: \`${token}\` and [inert](https://example.invalid).\n\n- ${token}\n\n> ${token}\n\n\`\`\`text\n${token}\n\`\`\`\n\n| Key | Value |\n|---|---|\n| ${token} | value |`,
    }));
    const markdown = container.querySelector<HTMLElement>(".markdown")!;
    const paragraph = container.querySelector<HTMLElement>("p")!;
    const tableScroll = container.querySelector<HTMLElement>(".table-scroll")!;
    const codeBlock = container.querySelector<HTMLElement>(".code-block")!;

    expect(getComputedStyle(markdown).minWidth).toBe("0");
    expect(getComputedStyle(markdown).gridTemplateColumns).toContain("minmax(0, 1fr)");
    expect(getComputedStyle(paragraph).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(tableScroll).overflowX).toBe("auto");
    expect(getComputedStyle(codeBlock).overflowX).toBe("auto");
    expect(container.textContent).toContain(token);
    expect(container.querySelector("a, img, script")).toBeNull();
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
