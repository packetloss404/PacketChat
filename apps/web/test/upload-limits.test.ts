import assert from "node:assert/strict";
import { test } from "node:test";
import { validateUploadContentLength, MAX_MULTIPART_OVERHEAD_BYTES } from "../src/lib/upload-limits";

test("upload content-length validation requires a declared length", () => {
  const result = validateUploadContentLength(new Headers(), 10);

  assert.deepEqual(result, { ok: false, status: 411, message: "Content-Length is required" });
});

test("upload content-length validation rejects invalid lengths", () => {
  const result = validateUploadContentLength(new Headers({ "content-length": "1.5" }), 10);

  assert.deepEqual(result, { ok: false, status: 400, message: "Invalid Content-Length" });
});

test("upload content-length validation rejects oversized multipart bodies before parsing", () => {
  const maxUploadBytes = 10;
  const result = validateUploadContentLength(
    new Headers({ "content-length": String(maxUploadBytes + MAX_MULTIPART_OVERHEAD_BYTES + 1) }),
    maxUploadBytes
  );

  assert.deepEqual(result, { ok: false, status: 413, message: "Upload request is too large" });
});

test("upload content-length validation allows upload bytes plus multipart overhead", () => {
  const maxUploadBytes = 10;
  const result = validateUploadContentLength(
    new Headers({ "content-length": String(maxUploadBytes + MAX_MULTIPART_OVERHEAD_BYTES) }),
    maxUploadBytes
  );

  assert.deepEqual(result, { ok: true, contentLength: maxUploadBytes + MAX_MULTIPART_OVERHEAD_BYTES });
});
