"use client";

import { Fragment, useState, type ReactNode } from "react";

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];

    if (token.startsWith("![")) {
      const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      const alt = image?.[1] ?? "";
      const src = image?.[2] ?? "";
      // Only http(s) images are rendered; anything else falls back to alt text.
      if (/^https?:\/\//i.test(src)) {
        nodes.push(<img key={key++} className="md-img" src={src} alt={alt} loading="lazy" />);
      } else {
        nodes.push(<span key={key++}>{alt}</span>);
      }
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? "";
      const safe = /^https?:\/\//i.test(href);
      nodes.push(
        safe ? (
          <a key={key++} href={href} target="_blank" rel="noreferrer">{label}</a>
        ) : (
          <span key={key++}>{label}</span>
        )
      );
    } else {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }

    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard failures
    }
  }

  return (
    <button type="button" className="md-code__copy" onClick={() => void copy()} aria-label="Copy code">
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function isHr(line: string): boolean {
  return /^\s*([-*_])\s*(\1\s*){2,}$/.test(line);
}

function isBlockquote(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function isTableStart(lines: string[], index: number): boolean {
  return Boolean(lines[index]?.includes("|") && lines[index + 1] !== undefined && isTableSeparator(lines[index + 1]));
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) return false;
  return (
    /^```/.test(line) ||
    /^#{1,4}\s+/.test(line) ||
    isHr(line) ||
    isBlockquote(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    isTableStart(lines, index)
  );
}

function renderList(lines: string[], startIndex: number, ordered: boolean): { node: ReactNode; nextIndex: number } {
  const marker = ordered ? /^(\s*)\d+[.)]\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/;
  const first = lines[startIndex].match(marker);
  const baseIndent = first ? first[1].length : 0;
  const items: ReactNode[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(marker);
    if (!match) break;
    const indent = match[1].length;
    if (indent !== baseIndent) break;
    const text = match[2];
    index += 1;

    // Lines indented deeper than this item belong to it (nested list or
    // continuation paragraph); collect and render them recursively.
    const nested: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index];
      if (candidate.trim() === "") break;
      const candidateIndent = (candidate.match(/^\s*/)?.[0].length) ?? 0;
      if (candidateIndent <= baseIndent) break;
      nested.push(candidate);
      index += 1;
    }

    const content: ReactNode[] = [renderInline(text)];
    if (nested.length) {
      const dedented = nested.map((line) => line.slice(Math.min(line.length, baseIndent + 2)));
      content.push(<Fragment key="nested">{renderBlocks(dedented)}</Fragment>);
    }
    items.push(<li key={items.length}>{content}</li>);
  }

  const node = ordered ? <ol className="md-list">{items}</ol> : <ul className="md-list">{items}</ul>;
  return { node, nextIndex: index };
}

function renderBlocks(lines: string[]): ReactNode[] {
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      const code = codeLines.join("\n");
      blocks.push(
        <pre key={key++} className="md-code">
          <div className="md-code__head">
            <span className="md-code__lang">{lang || "code"}</span>
            <CopyCodeButton code={code} />
          </div>
          <code>{code}</code>
        </pre>
      );
      continue;
    }

    if (isHr(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      index += 1;
      continue;
    }

    if (isBlockquote(line)) {
      const quoted: string[] = [];
      while (index < lines.length && isBlockquote(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderBlocks(quoted)}
        </blockquote>
      );
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const alignments = splitTableRow(lines[index + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return undefined;
      });
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={cellIndex} style={{ textAlign: alignments[cellIndex] }}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: alignments[cellIndex] }}>{renderInline(row[cellIndex] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2];
      const Tag = (`h${level}`) as "h1" | "h2" | "h3" | "h4";
      blocks.push(<Tag key={key++}>{renderInline(content)}</Tag>);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const { node, nextIndex } = renderList(lines, index, false);
      blocks.push(<Fragment key={key++}>{node}</Fragment>);
      index = nextIndex;
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const { node, nextIndex } = renderList(lines, index, true);
      blocks.push(<Fragment key={key++}>{node}</Fragment>);
      index = nextIndex;
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const paraLines: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "" && !startsBlock(lines, index)) {
      paraLines.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key++}>{renderInline(paraLines.join(" "))}</p>);
  }

  return blocks;
}

export function renderMarkdown(body: string): ReactNode[] {
  return renderBlocks(body.replace(/\r\n/g, "\n").split("\n"));
}
