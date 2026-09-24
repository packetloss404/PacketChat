export type AttachmentInput = { fileName: string; mimeType: string; text: string };
export type StoredAttachmentText = {
  id: string;
  fileName: string;
  mimeType: string | null;
  extractedText: string | null;
};
export type AttachmentContextLimits = { perFileMaxChars: number; totalMaxChars: number };
export type IncludedAttachment = { fileName: string; chars: number; truncated: boolean };
export type AttachmentContextResult = {
  contextText: string;
  included: IncludedAttachment[];
  droppedFiles: string[];
  totalChars: number;
};

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentContextLimits = {
  perFileMaxChars: 12000,
  totalMaxChars: 40000
};

function buildHeader(file: AttachmentInput): string {
  return `--- FILE: ${file.fileName} (${file.mimeType}) ---\n`;
}

/**
 * Keeps only attachments that actually carry extracted text, so uploads whose
 * extraction degraded gracefully (unsupported type, OCR failure, empty file)
 * are stored but silently skipped from the injected context.
 */
export function attachmentInputsFromRows(rows: StoredAttachmentText[]): AttachmentInput[] {
  return rows
    .filter((row): row is StoredAttachmentText & { extractedText: string } =>
      typeof row.extractedText === "string" && row.extractedText.trim().length > 0
    )
    .map((row) => ({
      fileName: row.fileName,
      mimeType: row.mimeType || "text/plain",
      text: row.extractedText.trim()
    }));
}

export function buildAttachmentContext(
  files: AttachmentInput[],
  limits: AttachmentContextLimits = DEFAULT_ATTACHMENT_LIMITS
): AttachmentContextResult {
  const included: IncludedAttachment[] = [];
  const droppedFiles: string[] = [];
  const blocks: string[] = [];
  let totalChars = 0;
  let dropping = false;

  for (const file of files) {
    if (dropping) {
      droppedFiles.push(file.fileName);
      continue;
    }

    const truncated = file.text.length > limits.perFileMaxChars;
    const clipped = truncated ? file.text.slice(0, limits.perFileMaxChars) : file.text;
    const block = `${buildHeader(file)}${clipped}\n`;

    if (totalChars + block.length > limits.totalMaxChars) {
      dropping = true;
      droppedFiles.push(file.fileName);
      continue;
    }

    blocks.push(block);
    totalChars += block.length;
    included.push({ fileName: file.fileName, chars: clipped.length, truncated });
  }

  const contextText = blocks.join("");

  return {
    contextText,
    included,
    droppedFiles,
    totalChars: contextText.length
  };
}
