import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { extractSupportedText, MAX_EXTRACTED_TEXT_CHARS } from "../src/index";

test("extractSupportedText truncates oversized text input", async () => {
  const result = await extractSupportedText({
    bytes: Buffer.from("a".repeat(MAX_EXTRACTED_TEXT_CHARS + 1_000), "utf8"),
    fileName: "notes.txt",
    mimeType: "text/plain"
  });

  assert.equal(result.detectedType, "text");
  assert.equal(result.text.length, MAX_EXTRACTED_TEXT_CHARS);
  assert.equal(result.truncated, true);
});

test("extractSupportedText rejects oversized Office XML parts", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document>${"x".repeat(5_000_001)}</w:document>`);
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 }
  });

  await assert.rejects(
    () =>
      extractSupportedText({
        bytes,
        fileName: "large.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      }),
    /Office XML part word\/document\.xml exceeds the 5000000 byte limit/
  );
});
