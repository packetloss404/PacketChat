import { GetObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
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

export async function downloadObject(bucket: string, key: string): Promise<Buffer> {
  const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body;
  if (!body) throw new Error("Object body was empty");

  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

export const LOCAL_EMBEDDING_MODEL = "packetchat-local-hash";
export const LOCAL_EMBEDDING_DIMENSIONS = 128;
export const LOCAL_EMBEDDING_SCHEMA_VERSION = 2;
export const LOCAL_EMBEDDING_VERSION = `${LOCAL_EMBEDDING_MODEL}-v${LOCAL_EMBEDDING_SCHEMA_VERSION}`;
// Embeddings remain JSONB for now: the local stack cannot assume pgvector is installed
// in every Postgres target, and this deterministic model is intentionally small.
const MIN_PDF_TEXT_CHARS = 20;
const SCANNED_PDF_MESSAGE = "Scanned PDF OCR not available without rasterizer. Upload an image file for local OCR or a PDF with embedded text.";

const requirePackage = createRequire(import.meta.url);
const tesseractEnglishData = requirePackage("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };

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
    const result = await parser.getText();
    const text = result.text;
    if (text.replace(/\s+/g, "").length < MIN_PDF_TEXT_CHARS) {
      throw new Error(SCANNED_PDF_MESSAGE);
    }
    return text;
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

  return result.data.text;
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

  const parts: string[] = [];
  for (const name of fileNames.filter(include).sort()) {
    const content = await zip.files[name].async("string");
    const text = xmlText(content);
    if (text) parts.push(text);
  }

  return parts.join("\n\n");
}

export async function extractSupportedText(input: {
  bytes: Buffer;
  fileName?: string | null;
  mimeType?: string | null;
}): Promise<{ text: string; detectedType: string }> {
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
    const raw = input.bytes.toString("utf8");
    try {
      return { text: JSON.stringify(JSON.parse(raw), null, 2), detectedType: "json" };
    } catch {
      return { text: raw, detectedType: "json" };
    }
  }

  if (isCsv) return { text: input.bytes.toString("utf8"), detectedType: "csv" };
  if (isMarkdown) return { text: input.bytes.toString("utf8"), detectedType: "markdown" };
  if (isPlainText) return { text: input.bytes.toString("utf8"), detectedType: "text" };
  if (isPdf) return { text: await extractPdfText(input.bytes), detectedType: "pdf" };
  if (isImage) return { text: await extractImageText(input.bytes), detectedType: "image-ocr" };
  if (isDocx) return { text: await extractOfficeOpenXmlText(input.bytes, "docx"), detectedType: "docx" };
  if (isPptx) return { text: await extractOfficeOpenXmlText(input.bytes, "pptx"), detectedType: "pptx" };
  if (isXlsx) return { text: await extractOfficeOpenXmlText(input.bytes, "xlsx"), detectedType: "xlsx" };

  throw new Error(`Unsupported file type for knowledge ingestion: ${input.mimeType || fileName || "unknown MIME type"}`);
}
