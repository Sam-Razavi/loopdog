export type SupportedImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Detects an image's real format from its file signature (magic bytes),
 * rather than trusting a declared content-type. Discord's CDN can serve
 * different bytes than the attachment metadata claims (transcoding a JPEG
 * to WebP, for instance) — sending Anthropic's API a media_type that
 * doesn't match the actual bytes is a hard 400, not a soft mismatch, so the
 * bytes themselves are the only source of truth worth trusting here.
 */
export function sniffImageType(buffer: Buffer): SupportedImageType | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Detects a PDF from its file signature (`%PDF-`), for exactly the same
 * reason sniffImageType exists rather than trusting Discord's declared
 * contentType: a media_type that doesn't match the real bytes is a hard 400
 * from Anthropic's API, not a soft mismatch.
 *
 * Only the signature is checked, deliberately — validating any more of the
 * structure would mean parsing PDF, and the API is the thing that has to
 * accept it anyway. A file that starts with %PDF- but is corrupt further in
 * gets rejected by the API with a real error, which is more useful than a
 * half-parser here guessing wrong.
 */
export function sniffPdf(buffer: Buffer): boolean {
  return (
    buffer.length >= 5 &&
    buffer[0] === 0x25 && // %
    buffer[1] === 0x50 && // P
    buffer[2] === 0x44 && // D
    buffer[3] === 0x46 && // F
    buffer[4] === 0x2d //   -
  );
}
