"use client";

import { useState, type ReactNode } from "react";

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];

    if (token.startsWith("`")) {
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

const BLOCK_START = /^(```|#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s)/;

export function renderMarkdown(body: string): ReactNode[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
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
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const paraLines: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "" && !BLOCK_START.test(lines[index])) {
      paraLines.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key++}>{renderInline(paraLines.join(" "))}</p>);
  }

  return blocks;
}
