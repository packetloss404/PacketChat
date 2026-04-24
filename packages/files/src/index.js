import { GetObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { getConfig } from "@packetchat/config";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
let s3;
export function getS3Client() {
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
export async function checkObjectStorage() {
    const config = getConfig();
    const client = getS3Client();
    await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_UPLOADS }));
    await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_EXPORTS }));
    await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_ARTIFACTS }));
}
export async function downloadObject(bucket, key) {
    const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = response.Body;
    if (!body)
        throw new Error("Object body was empty");
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
}
const EMBEDDING_DIMENSIONS = 128;
const EMBEDDING_VERSION = "local-hash-v1";
function xmlText(xml) {
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
function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
function embeddingTerms(text) {
    return text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
}
export function createLocalEmbedding(text) {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
    const terms = embeddingTerms(text);
    for (const term of terms) {
        const hash = fnv1a(term);
        const index = hash % EMBEDDING_DIMENSIONS;
        const sign = hash & 0x80000000 ? -1 : 1;
        vector[index] += sign;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (magnitude > 0) {
        for (let index = 0; index < vector.length; index += 1) {
            vector[index] = Number((vector[index] / magnitude).toFixed(6));
        }
    }
    return { version: EMBEDDING_VERSION, dimensions: EMBEDDING_DIMENSIONS, vector };
}
export function cosineSimilarity(a, b) {
    const left = Array.isArray(a) ? a : a?.vector;
    const right = Array.isArray(b) ? b : b?.vector;
    if (!left || !right || left.length !== right.length)
        return 0;
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
async function extractPdfText(bytes) {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
        const result = await parser.getText();
        return result.text;
    }
    finally {
        await parser.destroy();
    }
}
async function extractOfficeOpenXmlText(bytes, detectedType) {
    const zip = await JSZip.loadAsync(bytes);
    const fileNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    const include = (name) => {
        if (detectedType === "docx")
            return /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name);
        if (detectedType === "pptx")
            return /^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name);
        if (detectedType === "xlsx")
            return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
        return false;
    };
    const parts = [];
    for (const name of fileNames.filter(include).sort()) {
        const content = await zip.files[name].async("string");
        const text = xmlText(content);
        if (text)
            parts.push(text);
    }
    return parts.join("\n\n");
}
export async function extractSupportedText(input) {
    const mimeType = input.mimeType?.toLowerCase() ?? "";
    const fileName = input.fileName?.toLowerCase() ?? "";
    const isText = mimeType.startsWith("text/");
    const isMarkdown = mimeType === "text/markdown" || fileName.endsWith(".md") || fileName.endsWith(".markdown");
    const isJson = mimeType === "application/json" || fileName.endsWith(".json");
    const isCsv = mimeType === "text/csv" || mimeType === "application/csv" || fileName.endsWith(".csv");
    const isPlainText = isText || fileName.endsWith(".txt");
    const isPdf = mimeType === "application/pdf" || fileName.endsWith(".pdf");
    const isDocx = mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || fileName.endsWith(".docx");
    const isPptx = mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || fileName.endsWith(".pptx");
    const isXlsx = mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || fileName.endsWith(".xlsx");
    if (fileName.endsWith(".doc") || fileName.endsWith(".xls") || fileName.endsWith(".ppt")) {
        throw new Error("Unsupported legacy Office file type for knowledge ingestion. Convert to .docx, .xlsx, or .pptx and try again.");
    }
    if (isJson) {
        const raw = input.bytes.toString("utf8");
        try {
            return { text: JSON.stringify(JSON.parse(raw), null, 2), detectedType: "json" };
        }
        catch {
            return { text: raw, detectedType: "json" };
        }
    }
    if (isCsv)
        return { text: input.bytes.toString("utf8"), detectedType: "csv" };
    if (isMarkdown)
        return { text: input.bytes.toString("utf8"), detectedType: "markdown" };
    if (isPlainText)
        return { text: input.bytes.toString("utf8"), detectedType: "text" };
    if (isPdf)
        return { text: await extractPdfText(input.bytes), detectedType: "pdf" };
    if (isDocx)
        return { text: await extractOfficeOpenXmlText(input.bytes, "docx"), detectedType: "docx" };
    if (isPptx)
        return { text: await extractOfficeOpenXmlText(input.bytes, "pptx"), detectedType: "pptx" };
    if (isXlsx)
        return { text: await extractOfficeOpenXmlText(input.bytes, "xlsx"), detectedType: "xlsx" };
    throw new Error(`Unsupported file type for knowledge ingestion: ${input.mimeType || fileName || "unknown MIME type"}`);
}
