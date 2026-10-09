import { Fragment, type ReactNode } from "react";

// A deliberately small Markdown renderer for review notes and reports.
// Safety by construction: it builds React elements from text and never uses
// innerHTML, so HTML in an artifact is shown as text, not executed. Links and
// images are rendered as inert text with their target visible: nothing is
// fetched and nothing navigates away from the Cockpit.

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" }
  | { kind: "table"; rows: string[][] };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index += 1;
      blocks.push({ kind: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); index += 1; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ kind: "rule" }); index += 1; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) body.push(lines[index++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        const cells = lines[index].trim().slice(1, -1).split("|").map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells);
        index += 1;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }
    const listItem = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (index < lines.length && (listItem.test(lines[index]) || (/^\s{2,}\S/.test(lines[index]) && items.length))) {
        const match = listItem.exec(lines[index]);
        if (match) items.push(match[2]);
        else items[items.length - 1] += ` ${lines[index].trim()}`;
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s|\s*(```|~~~))/.test(lines[index])) body.push(lines[index++].trim());
    // Always consume at least one line, whatever its shape, so parsing ends.
    if (body.length === 0) body.push(lines[index++].trim());
    blocks.push({ kind: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

/** Inline: `code`, **strong**, *em*, [text](url) and ![alt](src) as inert text. */
export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|!\[([^\]]*)\]\(([^)\s]*)[^)]*\)|\[([^\]]+)\]\(([^)\s]*)[^)]*\)/g;
  let last = 0;
  let key = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) nodes.push(<code key={key++}>{match[2]}</code>);
    else if (match[3] || match[4]) nodes.push(<strong key={key++}>{match[3] ?? match[4]}</strong>);
    else if (match[5]) nodes.push(<em key={key++}>{match[5]}</em>);
    else if (match[7] !== undefined) nodes.push(<span key={key++} className="md-inert" title="Images are not loaded">[image: {match[6] || "untitled"}] <span className="md-url">{match[7]}</span></span>);
    else nodes.push(<span key={key++} className="md-inert" title="Links are shown, not followed">{match[8]} <span className="md-url">({match[9]})</span></span>);
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      {parseBlocks(source).map((block, index) => {
        switch (block.kind) {
          case "heading": {
            // Artifact headings sit below the viewer's own heading levels.
            const level = Math.min(6, block.level + 2);
            const Tag = `h${level}` as "h3";
            return <Tag key={index}>{renderInline(block.text)}</Tag>;
          }
          case "paragraph":
            return <p key={index}>{renderInline(block.text)}</p>;
          case "quote":
            return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
          case "code":
            return <pre key={index} className="code-block" data-lang={block.lang || undefined}><code>{block.text}</code></pre>;
          case "rule":
            return <hr key={index} />;
          case "list": {
            const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>);
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
          case "table":
            return (
              <div key={index} className="table-scroll">
                <table>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>{row.map((cell, cellIndex) => (rowIndex === 0 ? <th key={cellIndex}>{renderInline(cell)}</th> : <td key={cellIndex}>{renderInline(cell)}</td>))}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <Fragment key={index} />;
        }
      })}
    </div>
  );
}
