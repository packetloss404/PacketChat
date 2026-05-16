export const MAX_MULTIPART_OVERHEAD_BYTES = 1_048_576;

export type UploadContentLengthValidation =
  | { ok: true; contentLength: number }
  | { ok: false; status: 400 | 411 | 413; message: string };

export function validateUploadContentLength(headers: Headers, maxUploadBytes: number): UploadContentLengthValidation {
  const value = headers.get("content-length");
  if (value === null) return { ok: false, status: 411, message: "Content-Length is required" };

  const contentLength = Number(value);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return { ok: false, status: 400, message: "Invalid Content-Length" };
  }

  if (contentLength > maxUploadBytes + MAX_MULTIPART_OVERHEAD_BYTES) {
    return { ok: false, status: 413, message: "Upload request is too large" };
  }

  return { ok: true, contentLength };
}
