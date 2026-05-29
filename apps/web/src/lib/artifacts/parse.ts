export type ParsedArtifact = {
  identifier: string;
  type: string;
  title?: string;
  content: string;
};

export type ParseArtifactsResult = {
  artifacts: ParsedArtifact[];
  strippedText: string;
  malformed: number;
};

const OPEN_FENCE = /^:::artifact\{(.*)\}\s*$/;
const CLOSE_FENCE = /^:::\s*$/;

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

export function parseArtifacts(text: string): ParseArtifactsResult {
  const lines = text.split("\n");
  const artifacts: ParsedArtifact[] = [];
  const keptLines: string[] = [];
  let malformed = 0;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const openMatch = OPEN_FENCE.exec(line);
    if (!openMatch) {
      keptLines.push(line);
      index += 1;
      continue;
    }

    // Found a potential opening fence; look for the closing fence.
    let closeIndex = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      if (CLOSE_FENCE.test(lines[scan])) {
        closeIndex = scan;
        break;
      }
    }

    if (closeIndex === -1) {
      // Unterminated fence: malformed, leave the opening line untouched.
      malformed += 1;
      keptLines.push(line);
      index += 1;
      continue;
    }

    const attributes = parseAttributes(openMatch[1]);
    const identifier = attributes.identifier;
    const type = attributes.type;

    if (!identifier || !type) {
      // Missing required attribute: malformed, leave the whole block untouched.
      malformed += 1;
      for (let copy = index; copy <= closeIndex; copy += 1) {
        keptLines.push(lines[copy]);
      }
      index = closeIndex + 1;
      continue;
    }

    const innerLines = lines.slice(index + 1, closeIndex);
    const content = innerLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");

    const artifact: ParsedArtifact = { identifier, type, content };
    if (typeof attributes.title === "string") {
      artifact.title = attributes.title;
    }
    artifacts.push(artifact);

    index = closeIndex + 1;
  }

  const strippedText = collapseBlankGaps(keptLines.join("\n"));

  return { artifacts, strippedText, malformed };
}

function collapseBlankGaps(text: string): string {
  // Collapse runs of 3+ newlines (created by removed blocks) into a single
  // blank line, then trim leading/trailing whitespace.
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
