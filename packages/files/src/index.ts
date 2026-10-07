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

export const LOCAL_EMBEDDING_MODEL = "packetchat-local-feature-hash";
export const LOCAL_EMBEDDING_DIMENSIONS = 256;
export const LOCAL_EMBEDDING_SCHEMA_VERSION = 3;
export const LOCAL_EMBEDDING_VERSION = `${LOCAL_EMBEDDING_MODEL}-v${LOCAL_EMBEDDING_SCHEMA_VERSION}`;
export const LOCAL_RETRIEVAL_STRATEGY = "packetchat-local-hybrid-v3";
export const LOCAL_EMBEDDING_PROFILE = {
  model: LOCAL_EMBEDDING_MODEL,
  version: LOCAL_EMBEDDING_VERSION,
  dimensions: LOCAL_EMBEDDING_DIMENSIONS,
  kind: "local-feature-hash",
  neuralSemantic: false,
  capabilities: ["bm25", "exact terms", "phrases", "word stems", "concept aliases", "character similarity"]
} as const;
// Vectors remain JSONB so private deployments do not require pgvector or an
// external embedding service. This is an explicitly non-neural local feature
// model: it improves fuzzy and related-term recall, but does not claim general
// semantic understanding.
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
  algorithm?: string;
  features?: string[];
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

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "did", "do", "does", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "should", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "why", "with", "would"
]);

const CONCEPT_GROUPS = {
  auth: ["auth", "authenticate", "authentication", "authorization", "credential", "credentials", "login", "logins", "signin", "signon"],
  issue: ["bug", "bugs", "defect", "defects", "error", "errors", "fail", "failed", "failing", "failure", "failures", "problem", "problems"],
  deploy: ["deploy", "deployed", "deploying", "deployment", "deployments", "release", "released", "releases", "rollout", "ship", "shipping"],
  cost: ["bill", "billing", "cost", "costs", "expense", "expenses", "price", "prices", "pricing"],
  remove: ["archive", "archival", "delete", "deleted", "deletion", "remove", "removed", "removal"],
  create: ["add", "added", "adding", "create", "created", "creation", "new"],
  search: ["find", "finding", "lookup", "retrieve", "retrieval", "search", "searched"],
  document: ["attachment", "attachments", "doc", "docs", "document", "documents", "file", "files"],
  performance: ["fast", "faster", "lag", "latency", "performance", "slow", "slower", "speed"],
  access: ["access", "permission", "permissions", "role", "roles", "security", "secure"],
  account: ["account", "accounts", "member", "members", "user", "users"],
  password: ["passcode", "password", "passwords", "secret"],
  configure: ["config", "configuration", "configure", "configured", "preference", "preferences", "setting", "settings"]
} as const;

const CONCEPT_ALIASES = new Map<string, string>();
for (const [concept, aliases] of Object.entries(CONCEPT_GROUPS)) {
  for (const alias of aliases) CONCEPT_ALIASES.set(alias, concept);
}

function normalizedText(text: string) {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function rawTerms(text: string) {
  return normalizedText(text).match(/[a-z0-9_]{2,}/g) ?? [];
}

function stemTerm(term: string) {
  if (term.length <= 3) return term;
  if (term.endsWith("ies") && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith("ing") && term.length > 5) {
    const stem = term.slice(0, -3);
    return /(.)\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }
  if (term.endsWith("ed") && term.length > 4) {
    const stem = term.slice(0, -2);
    return /(.)\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }
  if (term.endsWith("ments") && term.length > 7) return term.slice(0, -5);
  if (term.endsWith("ment") && term.length > 6) return term.slice(0, -4);
  if (term.endsWith("ness") && term.length > 6) return term.slice(0, -4);
  if (term.endsWith("s") && !term.endsWith("ss") && term.length > 4) return term.slice(0, -1);
  return term;
}

function canonicalTerm(term: string) {
  const stem = stemTerm(term);
  return CONCEPT_ALIASES.get(term) ?? CONCEPT_ALIASES.get(stem) ?? stem;
}

export type LocalTextAnalysis = {
  terms: string[];
  canonicalTerms: string[];
  uniqueTerms: string[];
  uniqueCanonicalTerms: string[];
};

export function analyzeLocalText(text: string): LocalTextAnalysis {
  const terms = rawTerms(text).filter((term) => !STOP_WORDS.has(term));
  const canonicalTerms = terms.map(canonicalTerm);
  return {
    terms,
    canonicalTerms,
    uniqueTerms: [...new Set(terms)],
    uniqueCanonicalTerms: [...new Set(canonicalTerms)]
  };
}

function addFeature(features: Map<string, number>, feature: string, weight: number) {
  features.set(feature, (features.get(feature) ?? 0) + weight);
}

function termTrigrams(term: string) {
  if (term.length < 4) return [];
  const bounded = `^${term}$`;
  const trigrams: string[] = [];
  for (let index = 0; index <= bounded.length - 3; index += 1) trigrams.push(bounded.slice(index, index + 3));
  return trigrams;
}

export function createLocalEmbedding(text: string): LocalEmbedding {
  const vector = Array.from({ length: LOCAL_EMBEDDING_DIMENSIONS }, () => 0);
  const analysis = analyzeLocalText(text);
  const features = new Map<string, number>();

  for (let index = 0; index < analysis.terms.length; index += 1) {
    const term = analysis.terms[index]!;
    const stem = stemTerm(term);
    const canonical = analysis.canonicalTerms[index]!;
    addFeature(features, `term:${term}`, 1.8);
    if (stem !== term) addFeature(features, `stem:${stem}`, 1.1);
    if (canonical !== term) addFeature(features, `concept:${canonical}`, 1.6);
    for (const trigram of termTrigrams(term)) addFeature(features, `char3:${trigram}`, 0.18);

    if (index > 0) {
      addFeature(features, `bigram:${analysis.canonicalTerms[index - 1]}:${canonical}`, 1.2);
    }
  }

  for (const [feature, accumulatedWeight] of features) {
    const hash = fnv1a(feature);
    const index = hash % LOCAL_EMBEDDING_DIMENSIONS;
    const sign = hash & 0x80000000 ? -1 : 1;
    vector[index] += sign * Math.log1p(accumulatedWeight);
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
    createdAt: new Date().toISOString(),
    algorithm: "signed-feature-hashing",
    features: ["terms", "stems", "concept-aliases", "character-trigrams", "bigrams"]
  };
}

export type LocalHybridCandidate<T> = {
  value: T;
  title: string;
  content: string;
  embedding: unknown;
};

export type LocalHybridRanking<T> = {
  value: T;
  score: number;
  lexicalScore: number;
  lexicalNormalized: number;
  relatednessScore: number;
  coverageScore: number;
  phraseScore: number;
  embeddingStatus: "current" | "missing" | "invalid" | "outdated";
  matchedTerms: string[];
};

function countTerms(terms: string[]) {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

function includesSequence(haystack: string[], needle: string[]) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

export function rankLocalHybridResults<T>(query: string, candidates: LocalHybridCandidate<T>[]): LocalHybridRanking<T>[] {
  const queryAnalysis = analyzeLocalText(query);
  if (queryAnalysis.uniqueCanonicalTerms.length === 0 || candidates.length === 0) return [];
  const queryEmbedding = createLocalEmbedding(query);
  const displayTermByConcept = new Map<string, string>();
  for (let index = 0; index < queryAnalysis.canonicalTerms.length; index += 1) {
    const concept = queryAnalysis.canonicalTerms[index]!;
    if (!displayTermByConcept.has(concept)) displayTermByConcept.set(concept, queryAnalysis.terms[index]!);
  }
  const analyzed = candidates.map((candidate, originalIndex) => {
    const content = analyzeLocalText(candidate.content);
    const title = analyzeLocalText(candidate.title);
    return { candidate, originalIndex, content, title, contentCounts: countTerms(content.canonicalTerms), titleCounts: countTerms(title.canonicalTerms) };
  });
  const documentFrequency = new Map<string, number>();
  for (const term of queryAnalysis.uniqueCanonicalTerms) {
    documentFrequency.set(term, analyzed.filter((item) => item.contentCounts.has(term) || item.titleCounts.has(term)).length);
  }
  const averageLength = analyzed.reduce((sum, item) => sum + Math.max(1, item.content.canonicalTerms.length), 0) / analyzed.length;
  const k1 = 1.2;
  const b = 0.75;

  const scored = analyzed.map((item) => {
    let lexicalScore = 0;
    let matched = 0;
    const matchedTerms: string[] = [];
    for (let index = 0; index < queryAnalysis.uniqueCanonicalTerms.length; index += 1) {
      const term = queryAnalysis.uniqueCanonicalTerms[index]!;
      const contentFrequency = item.contentCounts.get(term) ?? 0;
      const titleFrequency = item.titleCounts.get(term) ?? 0;
      const frequency = contentFrequency + titleFrequency * 2.5;
      if (frequency <= 0) continue;
      matched += 1;
      matchedTerms.push(displayTermByConcept.get(term) ?? term);
      const frequencyInDocuments = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(1 + (analyzed.length - frequencyInDocuments + 0.5) / (frequencyInDocuments + 0.5));
      const lengthAdjustment = frequency + k1 * (1 - b + b * (item.content.canonicalTerms.length / Math.max(1, averageLength)));
      lexicalScore += inverseDocumentFrequency * ((frequency * (k1 + 1)) / lengthAdjustment);
    }
    const parsed = parseLocalEmbedding(item.candidate.embedding);
    const relatednessScore = parsed.embedding ? Math.max(0, cosineSimilarity(parsed.embedding, queryEmbedding)) : 0;
    const phraseScore = includesSequence(item.title.canonicalTerms, queryAnalysis.canonicalTerms)
      ? 1
      : includesSequence(item.content.canonicalTerms, queryAnalysis.canonicalTerms)
        ? 0.8
        : 0;
    return {
      ...item,
      lexicalScore,
      relatednessScore,
      coverageScore: matched / queryAnalysis.uniqueCanonicalTerms.length,
      phraseScore,
      embeddingStatus: (parsed.embedding ? "current" : parsed.reason ?? "invalid") as LocalHybridRanking<T>["embeddingStatus"],
      matchedTerms
    };
  });
  const maximumLexicalScore = Math.max(0, ...scored.map((item) => item.lexicalScore));

  return scored
    .filter((item) => item.lexicalScore > 0 || item.relatednessScore >= 0.1)
    .map((item) => {
      const lexicalNormalized = maximumLexicalScore > 0 ? item.lexicalScore / maximumLexicalScore : 0;
      return {
        ...item,
        lexicalNormalized,
        score: lexicalNormalized * 0.45 + item.coverageScore * 0.2 + item.relatednessScore * 0.25 + item.phraseScore * 0.1
      };
    })
    .sort((left, right) => right.score - left.score || right.lexicalScore - left.lexicalScore || left.originalIndex - right.originalIndex)
    .map(({ candidate, score, lexicalScore, lexicalNormalized, relatednessScore, coverageScore, phraseScore, embeddingStatus, matchedTerms }) => ({
      value: candidate.value,
      score,
      lexicalScore,
      lexicalNormalized,
      relatednessScore,
      coverageScore,
      phraseScore,
      embeddingStatus,
      matchedTerms
    }));
}

export function parseLocalEmbedding(value: unknown): ParsedLocalEmbedding {
  if (!value) return { embedding: null, reason: "missing" };

  if (Array.isArray(value)) {
    if (value.length === 0 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      return { embedding: null, reason: "invalid" };
    }
    return { embedding: null, reason: "outdated" };
  }

  if (typeof value !== "object") return { embedding: null, reason: "invalid" };

  const candidate = value as Partial<LocalEmbedding>;
  if (
    candidate.model !== LOCAL_EMBEDDING_MODEL ||
    candidate.version !== LOCAL_EMBEDDING_VERSION ||
    candidate.schemaVersion !== LOCAL_EMBEDDING_SCHEMA_VERSION ||
    candidate.dimensions !== LOCAL_EMBEDDING_DIMENSIONS
  ) {
    return { embedding: null, reason: "outdated" };
  }
  if (
    candidate.normalized !== true ||
    !Array.isArray(candidate.vector) ||
    candidate.vector.length !== LOCAL_EMBEDDING_DIMENSIONS ||
    !candidate.vector.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    return { embedding: null, reason: "invalid" };
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
