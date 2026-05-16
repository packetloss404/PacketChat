import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { getConfig } from "@packetchat/config";
import { createRequire } from "node:module";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
import Tesseract from "tesseract.js";

let s3: S3Client | undefined;

export function getS3Client(): S3Client {
  if (!s3) {
    const config = getConfig();
    s3 = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY
      }
    });
  }

  return s3;
}

export async function checkObjectStorage(): Promise<void> {
  const config = getConfig();
  const client = getS3Client();
  await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_UPLOADS }));
  await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_EXPORTS }));
  await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_ARTIFACTS }));
}

export class FileLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLimitError";
  }
}

export type DownloadObjectOptions = {
  maxBytes?: number;
};

type S3ObjectBody = NonNullable<GetObjectCommandOutput["Body"]>;

function assertByteLimit(bytes: number, maxBytes: number, label: string) {
  if (bytes > maxBytes) {
    throw new FileLimitError(`${label} exceeds the ${maxBytes} byte limit`);
  }
}

function isAsyncIterableBody(body: S3ObjectBody) {
  return typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function bodyChunkToBuffer(chunk: Uint8Array | string) {
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

async function readObjectBody(body: S3ObjectBody, maxBytes?: number) {
  if (isAsyncIterableBody(body)) {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      const buffer = bodyChunkToBuffer(chunk);
      totalBytes += buffer.byteLength;
      if (maxBytes !== undefined) assertByteLimit(totalBytes, maxBytes, "Object body");
      chunks.push(buffer);
    }

    return Buffer.concat(chunks, totalBytes);
  }

  const transformToByteArray = (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray;
  if (typeof transformToByteArray === "function") {
    const bytes = await transformToByteArray.call(body);
    if (maxBytes !== undefined) assertByteLimit(bytes.byteLength, maxBytes, "Object body");
    return Buffer.from(bytes);
  }

  throw new Error("Unsupported object body returned by object storage");
}

export async function downloadObject(bucket: string, key: string, options: DownloadObjectOptions = {}): Promise<Buffer> {
  const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body;
  if (!body) throw new Error("Object body was empty");

  if (options.maxBytes !== undefined) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new Error("downloadObject maxBytes must be a positive integer");
    }
    if (response.ContentLength !== undefined) assertByteLimit(response.ContentLength, options.maxBytes, "Object");
  }

  return readObjectBody(body, options.maxBytes);
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export const LOCAL_EMBEDDING_MODEL = "packetchat-local-hash";
export const LOCAL_EMBEDDING_DIMENSIONS = 128;
export const LOCAL_EMBEDDING_SCHEMA_VERSION = 2;
export const LOCAL_EMBEDDING_VERSION = `${LOCAL_EMBEDDING_MODEL}-v${LOCAL_EMBEDDING_SCHEMA_VERSION}`;
// Embeddings remain JSONB for now: the local stack cannot assume pgvector is installed
// in every Postgres target, and this deterministic model is intentionally small.
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;
export const MAX_PDF_TEXT_PAGES = 100;
const MAX_TEXT_DECODE_BYTES = MAX_EXTRACTED_TEXT_CHARS * 4;
const MAX_JSON_FORMAT_BYTES = 1_000_000;
const MAX_OFFICE_XML_PARTS = 250;
const MAX_OFFICE_XML_PART_BYTES = 5_000_000;
const MAX_OFFICE_XML_TOTAL_BYTES = 10_000_000;
const MIN_PDF_TEXT_CHARS = 20;
const SCANNED_PDF_MESSAGE = "Scanned PDF OCR not available without rasterizer. Upload an image file for local OCR or a PDF with embedded text.";

const requirePackage = createRequire(import.meta.url);
const tesseractEnglishData = requirePackage("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };

export type ExtractedSupportedText = {
  text: string;
  detectedType: string;
  truncated?: true;
};

export type LocalEmbedding = {
  schemaVersion: number;
  model: string;
  version: string;
  dimensions: number;
  vector: number[];
  normalized: true;
  createdAt: string;
};

export type ParsedLocalEmbedding = {
  embedding: LocalEmbedding | null;
  reason?: "missing" | "invalid" | "outdated";
};

function xmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function limitedExtractedText(text: string, forceTruncated = false): { text: string; truncated?: true } {
  if (forceTruncated || text.length > MAX_EXTRACTED_TEXT_CHARS) {
    return { text: text.slice(0, MAX_EXTRACTED_TEXT_CHARS), truncated: true };
  }

  return { text };
}

function extractionResult(text: string, detectedType: string, forceTruncated = false): ExtractedSupportedText {
  return extractionFromLimited(limitedExtractedText(text, forceTruncated), detectedType);
}

function extractionFromLimited(limited: { text: string; truncated?: true }, detectedType: string): ExtractedSupportedText {
  return {
    text: limited.text,
    detectedType,
    ...(limited.truncated ? { truncated: true as const } : {})
  };
}

function decodeBoundedUtf8(bytes: Buffer) {
  const boundedBytes = bytes.byteLength > MAX_TEXT_DECODE_BYTES ? bytes.subarray(0, MAX_TEXT_DECODE_BYTES) : bytes;
  const text = boundedBytes.toString("utf8");
  return limitedExtractedText(text, boundedBytes.byteLength < bytes.byteLength);
}

type OfficeXmlPart = JSZip.JSZipObject & { _data?: { uncompressedSize?: number } };

function officeXmlUncompressedSize(file: OfficeXmlPart, name: string) {
  const rawSize = file._data?.uncompressedSize;
  if (typeof rawSize !== "number" || !Number.isFinite(rawSize)) {
    throw new FileLimitError(`Office XML part ${name} is missing size metadata`);
  }
  return rawSize;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function embeddingTerms(text: string) {
  return text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
}

export function createLocalEmbedding(text: string): LocalEmbedding {
  const vector = Array.from({ length: LOCAL_EMBEDDING_DIMENSIONS }, () => 0);
  const terms = embeddingTerms(text);

  for (const term of terms) {
    const hash = fnv1a(term);
    const index = hash % LOCAL_EMBEDDING_DIMENSIONS;
    const sign = hash & 0x80000000 ? -1 : 1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = Number((vector[index] / magnitude).toFixed(6));
    }
  }

  return {
    schemaVersion: LOCAL_EMBEDDING_SCHEMA_VERSION,
    model: LOCAL_EMBEDDING_MODEL,
    version: LOCAL_EMBEDDING_VERSION,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    vector,
    normalized: true,
    createdAt: new Date().toISOString()
  };
}

export function parseLocalEmbedding(value: unknown): ParsedLocalEmbedding {
  if (!value) return { embedding: null, reason: "missing" };

  if (Array.isArray(value)) {
    if (value.length !== LOCAL_EMBEDDING_DIMENSIONS || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      return { embedding: null, reason: "invalid" };
    }

    return {
      embedding: {
        schemaVersion: 1,
        model: LOCAL_EMBEDDING_MODEL,
        version: "local-hash-v1",
        dimensions: LOCAL_EMBEDDING_DIMENSIONS,
        vector: value,
        normalized: true,
        createdAt: ""
      },
      reason: "outdated"
    };
  }

  if (typeof value !== "object") return { embedding: null, reason: "invalid" };

  const candidate = value as Partial<LocalEmbedding>;
  if (
    candidate.model !== LOCAL_EMBEDDING_MODEL ||
    candidate.version !== LOCAL_EMBEDDING_VERSION ||
    candidate.schemaVersion !== LOCAL_EMBEDDING_SCHEMA_VERSION ||
    candidate.dimensions !== LOCAL_EMBEDDING_DIMENSIONS ||
    !Array.isArray(candidate.vector) ||
    candidate.vector.length !== LOCAL_EMBEDDING_DIMENSIONS ||
    !candidate.vector.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    return { embedding: null, reason: "outdated" };
  }

  return { embedding: candidate as LocalEmbedding };
}

export function cosineSimilarity(a: LocalEmbedding | number[] | null | undefined, b: LocalEmbedding | number[] | null | undefined) {
  const left = Array.isArray(a) ? a : a?.vector;
  const right = Array.isArray(b) ? b : b?.vector;
  if (!left || !right || left.length !== right.length) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator > 0 ? dot / denominator : 0;
}

async function extractPdfText(bytes: Buffer) {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText({ first: MAX_PDF_TEXT_PAGES });
    const limited = limitedExtractedText(result.text, result.total > MAX_PDF_TEXT_PAGES);
    if (limited.text.replace(/\s+/g, "").length < MIN_PDF_TEXT_CHARS) {
      throw new Error(SCANNED_PDF_MESSAGE);
    }
    return limited;
  } finally {
    await parser.destroy();
  }
}

async function extractImageText(bytes: Buffer) {
  const result = await Tesseract.recognize(bytes, "eng", {
    langPath: tesseractEnglishData.langPath,
    gzip: tesseractEnglishData.gzip,
    cacheMethod: "none"
  });

  return limitedExtractedText(result.data.text);
}

async function extractOfficeOpenXmlText(bytes: Buffer, detectedType: string) {
  const zip = await JSZip.loadAsync(bytes);
  const fileNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const include = (name: string) => {
    if (detectedType === "docx") return /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name);
    if (detectedType === "pptx") return /^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name);
    if (detectedType === "xlsx") return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
    return false;
  };

  const includedFileNames = fileNames.filter(include).sort();
  if (includedFileNames.length > MAX_OFFICE_XML_PARTS) {
    throw new FileLimitError(`Office document has too many text parts (${includedFileNames.length}; limit ${MAX_OFFICE_XML_PARTS})`);
  }

  const parts: string[] = [];
  let totalTextChars = 0;
  let totalXmlBytes = 0;
  let truncated = false;

  for (const name of includedFileNames) {
    const file = zip.files[name] as OfficeXmlPart;
    const uncompressedSize = officeXmlUncompressedSize(file, name);
    if (uncompressedSize > MAX_OFFICE_XML_PART_BYTES) {
      throw new FileLimitError(`Office XML part ${name} exceeds the ${MAX_OFFICE_XML_PART_BYTES} byte limit`);
    }
    totalXmlBytes += uncompressedSize;
    if (totalXmlBytes > MAX_OFFICE_XML_TOTAL_BYTES) {
      throw new FileLimitError(`Office XML content exceeds the ${MAX_OFFICE_XML_TOTAL_BYTES} byte limit`);
    }

    const content = await file.async("string");

    const text = xmlText(content);
    if (!text) continue;

    const separatorChars = parts.length > 0 ? 2 : 0;
    const remainingChars = MAX_EXTRACTED_TEXT_CHARS - totalTextChars - separatorChars;
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }

    if (text.length > remainingChars) {
      parts.push(text.slice(0, remainingChars));
      truncated = true;
      break;
    }

    parts.push(text);
    totalTextChars += separatorChars + text.length;
  }

  return limitedExtractedText(parts.join("\n\n"), truncated);
}

export async function extractSupportedText(input: {
  bytes: Buffer;
  fileName?: string | null;
  mimeType?: string | null;
}): Promise<ExtractedSupportedText> {
  const mimeType = input.mimeType?.toLowerCase() ?? "";
  const fileName = input.fileName?.toLowerCase() ?? "";
  const isText = mimeType.startsWith("text/");
  const isMarkdown = mimeType === "text/markdown" || fileName.endsWith(".md") || fileName.endsWith(".markdown");
  const isJson = mimeType === "application/json" || fileName.endsWith(".json");
  const isCsv = mimeType === "text/csv" || mimeType === "application/csv" || fileName.endsWith(".csv");
  const isPlainText = isText || fileName.endsWith(".txt");
  const isPdf = mimeType === "application/pdf" || fileName.endsWith(".pdf");
  const isImage =
    ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mimeType) ||
    [".png", ".jpg", ".jpeg", ".webp"].some((extension) => fileName.endsWith(extension));
  const isDocx = mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || fileName.endsWith(".docx");
  const isPptx = mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || fileName.endsWith(".pptx");
  const isXlsx = mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || fileName.endsWith(".xlsx");
  const isLegacyOffice = ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(mimeType);

  if (isLegacyOffice || fileName.endsWith(".doc") || fileName.endsWith(".xls") || fileName.endsWith(".ppt")) {
    throw new Error("Unsupported legacy Office file type for knowledge ingestion. Convert to .docx, .xlsx, or .pptx and try again.");
  }

  if (isJson) {
    const raw = decodeBoundedUtf8(input.bytes);
    if (!raw.truncated && input.bytes.byteLength <= MAX_JSON_FORMAT_BYTES) {
      try {
        return extractionResult(JSON.stringify(JSON.parse(raw.text), null, 2), "json");
      } catch {
        return extractionFromLimited(raw, "json");
      }
    }

    return extractionFromLimited(raw, "json");
  }

  if (isCsv) return extractionFromLimited(decodeBoundedUtf8(input.bytes), "csv");
  if (isMarkdown) return extractionFromLimited(decodeBoundedUtf8(input.bytes), "markdown");
  if (isPlainText) return extractionFromLimited(decodeBoundedUtf8(input.bytes), "text");
  if (isPdf) return extractionFromLimited(await extractPdfText(input.bytes), "pdf");
  if (isImage) return extractionFromLimited(await extractImageText(input.bytes), "image-ocr");
  if (isDocx) return extractionFromLimited(await extractOfficeOpenXmlText(input.bytes, "docx"), "docx");
  if (isPptx) return extractionFromLimited(await extractOfficeOpenXmlText(input.bytes, "pptx"), "pptx");
  if (isXlsx) return extractionFromLimited(await extractOfficeOpenXmlText(input.bytes, "xlsx"), "xlsx");

  throw new Error(`Unsupported file type for knowledge ingestion: ${input.mimeType || fileName || "unknown MIME type"}`);
}
