import { must } from "@/lib/indexed-access";
import { stripAvifMetadata } from "@/lib/image-metadata-avif";
import { stripGifMetadata } from "@/lib/image-metadata-gif";
import { stripJpegMetadata } from "@/lib/image-metadata-jpeg";
import { stripPngMetadata } from "@/lib/image-metadata-png";
import { stripSvgMetadata } from "@/lib/image-metadata-svg";
import { stripWebpMetadata } from "@/lib/image-metadata-webp";

/**
 * Shared constants and helpers for the database-backed image library
 * (#731). Images are stored as Bytes in the MediaImage table and served
 * publicly from /api/images/[id].
 */

// 2MB cap, matching the spirit of MAX_LOGO_DATA_URL_BYTES for site-style
// logo uploads.
export const MAX_MEDIA_IMAGE_BYTES = 2 * 1024 * 1024;

// Upper bound on the multipart request body itself (file bytes plus form
// field/boundary overhead), used to reject oversized uploads before the
// body is fully buffered.
export const MAX_MEDIA_IMAGE_REQUEST_BYTES = MAX_MEDIA_IMAGE_BYTES + 64 * 1024;

// test seam
export const ALLOWED_MEDIA_IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
] as const;

export type AllowedMediaImageContentType =
  (typeof ALLOWED_MEDIA_IMAGE_CONTENT_TYPES)[number];

const MAX_MEDIA_IMAGE_FILENAME_LENGTH = 200;
export const MAX_MEDIA_IMAGE_ALT_TEXT_LENGTH = 280;

const BOM = "﻿";

function startsWithCaseInsensitive(
  text: string,
  search: string,
  index: number,
): boolean {
  return (
    text.slice(index, index + search.length).toLowerCase() ===
    search.toLowerCase()
  );
}

function skipWhitespace(text: string, index: number): number {
  let next = index;
  while (next < text.length && /\s/.test(must(text[next], "skipWhitespace: index within text.length"))) {
    next += 1;
  }
  return next;
}

/**
 * Check whether `head` is the start of an SVG document: optionally
 * preceded by a BOM, an XML prolog, and/or comments, followed by a
 * `<svg` root element. Written as a manual scanner (rather than a single
 * regex) to avoid catastrophic backtracking on adversarial input such as
 * many repeated, unterminated `<!--` sequences.
 */
function isSvgPrefix(head: string): boolean {
  let index = 0;
  if (head.startsWith(BOM, index)) {
    index += 1;
  }
  index = skipWhitespace(head, index);

  if (startsWithCaseInsensitive(head, "<?xml", index)) {
    const end = head.indexOf("?>", index + 5);
    if (end === -1) {
      return false;
    }
    index = skipWhitespace(head, end + 2);
  }

  for (;;) {
    if (!head.startsWith("<!--", index)) {
      break;
    }
    const end = head.indexOf("-->", index + 4);
    if (end === -1) {
      return false;
    }
    index = skipWhitespace(head, end + 3);
  }

  if (!startsWithCaseInsensitive(head, "<svg", index)) {
    return false;
  }
  const afterTag = head[index + 4];
  return afterTag === undefined ? false : /[\s>]/.test(afterTag);
}

/**
 * Sniff the real image type from file bytes, ignoring the declared
 * Content-Type / filename extension. Returns null if the bytes do not
 * match a recognised, allowed image format.
 */
export function detectImageContentType(
  bytes: Buffer,
): AllowedMediaImageContentType | null {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))
  ) {
    return "image/avif";
  }

  // SVG is text, not a binary signature: look for an <svg> root element
  // (optionally preceded by a BOM, XML prolog, and/or comments) within the
  // first slice of the file.
  const head = bytes.subarray(0, 2048).toString("utf8");
  if (isSvgPrefix(head)) {
    return "image/svg+xml";
  }

  return null;
}

export type ImageDimensions = { width: number; height: number };

function readUInt32BE(bytes: Buffer, offset: number): number {
  return bytes.readUInt32BE(offset);
}

function extractPngDimensions(bytes: Buffer): ImageDimensions | null {
  // PNG signature (8 bytes) + IHDR chunk length (4) + "IHDR" (4) + width (4) + height (4).
  if (bytes.length < 24) return null;
  return {
    width: readUInt32BE(bytes, 16),
    height: readUInt32BE(bytes, 20),
  };
}

function extractGifDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) return null;
  return {
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
  };
}

function extractJpegDimensions(bytes: Buffer): ImageDimensions | null {
  let offset = 2; // skip the SOI marker (0xFFD8)
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = must(bytes[offset + 1], "extractJpegDimensions: offset within bytes.length");
    // Start-of-frame markers (baseline/progressive/etc), excluding DHT/JPG/DAC.
    const isSofMarker =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSofMarker) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return { width, height };
    }

    if (marker === 0xd8 || marker === 0xd9) {
      break; // SOI/EOI: no frame found
    }

    const segmentLength = bytes.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return must(bytes[offset], "readUInt24LE: offset within bytes.length") | (must(bytes[offset + 1], "readUInt24LE: offset+1 within bytes.length") << 8) | (must(bytes[offset + 2], "readUInt24LE: offset+2 within bytes.length") << 16);
}

/**
 * Parse the canvas dimensions from a WebP file's first chunk without an image
 * library. Covers the three container forms: VP8X (extended/animated — the one
 * that can declare a huge canvas), VP8 (lossy) and VP8L (lossless). Returns
 * null for an unrecognised/truncated form so callers apply their own policy.
 */
function extractWebpDimensions(bytes: Buffer): ImageDimensions | null {
  // "RIFF"(4) + size(4) + "WEBP"(4) already validated by the sniffer; the first
  // chunk header (FourCC(4) + size(4)) begins at 12, its payload at 20.
  if (bytes.length < 20) return null;
  const fourCC = bytes.toString("ascii", 12, 16);
  const payload = 20;

  if (fourCC === "VP8X") {
    // 4 bytes flags/reserved, then 24-bit (width-1) and 24-bit (height-1), LE.
    if (bytes.length < payload + 10) return null;
    return {
      width: readUInt24LE(bytes, payload + 4) + 1,
      height: readUInt24LE(bytes, payload + 7) + 1,
    };
  }

  if (fourCC === "VP8 ") {
    // Lossy: 3-byte frame tag, then the start code 0x9d 0x01 0x2a, then the
    // 14-bit width and height (LE).
    if (bytes.length < payload + 10) return null;
    if (
      bytes[payload + 3] !== 0x9d ||
      bytes[payload + 4] !== 0x01 ||
      bytes[payload + 5] !== 0x2a
    ) {
      return null;
    }
    return {
      width: bytes.readUInt16LE(payload + 6) & 0x3fff,
      height: bytes.readUInt16LE(payload + 8) & 0x3fff,
    };
  }

  if (fourCC === "VP8L") {
    // Lossless: 0x2f signature byte, then 14-bit (width-1) and 14-bit (height-1)
    // packed little-endian across the next 4 bytes.
    if (bytes.length < payload + 5) return null;
    if (bytes[payload] !== 0x2f) return null;
    const b1 = must(bytes[payload + 1], "extractWebpDimensions VP8L: payload+1 within bytes.length");
    const b2 = must(bytes[payload + 2], "extractWebpDimensions VP8L: payload+2 within bytes.length");
    const b3 = must(bytes[payload + 3], "extractWebpDimensions VP8L: payload+3 within bytes.length");
    const b4 = must(bytes[payload + 4], "extractWebpDimensions VP8L: payload+4 within bytes.length");
    const bits = ((b4 << 24) | (b3 << 16) | (b2 << 8) | b1) >>> 0;
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }

  return null;
}

function extractSvgDimensions(bytes: Buffer): ImageDimensions | null {
  const head = bytes.subarray(0, 4096).toString("utf8");
  const svgTagMatch = head.match(/<svg[^>]*>/i);
  if (!svgTagMatch) return null;
  const svgTag = svgTagMatch[0];

  const widthMatch = svgTag.match(/\bwidth="([0-9.]+)(?:px)?"/i);
  const heightMatch = svgTag.match(/\bheight="([0-9.]+)(?:px)?"/i);
  if (widthMatch && heightMatch) {
    const width = Math.round(Number.parseFloat(must(widthMatch[1], "extractSvgDimensions: width match has no capture group")));
    const height = Math.round(Number.parseFloat(must(heightMatch[1], "extractSvgDimensions: height match has no capture group")));
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const viewBoxMatch = svgTag.match(
    /\bviewBox="\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*"/i,
  );
  if (viewBoxMatch) {
    const width = Math.round(Number.parseFloat(must(viewBoxMatch[1], "extractSvgDimensions: viewBox match has no width capture group")));
    const height = Math.round(Number.parseFloat(must(viewBoxMatch[2], "extractSvgDimensions: viewBox match has no height capture group")));
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  return null;
}

/**
 * Best-effort dimension extraction for formats where it is cheap to do
 * without an image-processing dependency. Returns null when the format
 * isn't supported (AVIF) or the bytes can't be parsed.
 */
export function extractImageDimensions(
  bytes: Buffer,
  contentType: AllowedMediaImageContentType,
): ImageDimensions | null {
  try {
    switch (contentType) {
      case "image/png":
        return extractPngDimensions(bytes);
      case "image/gif":
        return extractGifDimensions(bytes);
      case "image/jpeg":
        return extractJpegDimensions(bytes);
      case "image/webp":
        return extractWebpDimensions(bytes);
      case "image/svg+xml":
        return extractSvgDimensions(bytes);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Result of an attempted metadata strip. `ok: true` means the parser completed
 * a clean structural walk AND any privacy-sensitive metadata present was removed
 * (or there was validly none) — `bytes` is safe to store & serve publicly.
 * `ok: false` means the strip could not be positively confirmed (malformed or
 * nonstandard structure, a thrown exception, or an animated AVIF); `bytes` is
 * the ORIGINAL, unchanged, and must never be stored (#5244).
 */
export type StripImageResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; bytes: Buffer; reason: "unconfirmed" | "animated-avif" };

function unconfirmed(bytes: Buffer): StripImageResult {
  return { ok: false, bytes, reason: "unconfirmed" };
}

function confirmed(original: Buffer, cleaned: Buffer | null): StripImageResult {
  return cleaned ? { ok: true, bytes: cleaned } : unconfirmed(original);
}

/**
 * Strip privacy-sensitive metadata (EXIF/GPS, XMP, comments, embedded text) from
 * an uploaded image before it is stored and potentially served publicly. Every
 * allowed type has a cleaner, so the switch is exhaustive (#5244):
 *  - JPEG, PNG and WebP keep only the segments and chunks that draw the
 *    picture, plus an EXIF Orientation (`@/lib/image-metadata-exif`);
 *  - GIF keeps only picture, frame-timing and looping blocks
 *    (`@/lib/image-metadata-gif`);
 *  - AVIF blanks every non-picture item, property and box in place
 *    (`@/lib/image-metadata-avif`); an animated AVIF is refused;
 *  - SVG is rebuilt from drawing elements and attributes
 *    (`@/lib/image-metadata-svg`).
 *
 * The result carries `ok: true` ONLY when the parser completed a clean
 * structural walk and any metadata present was removed (or there was validly
 * none); `ok: false` means the strip could not be positively confirmed and
 * `bytes` is the unchanged original. Every caller refuses an `ok: false` image,
 * through `cleanImageForStorage` / `storableLogoDataUrl` or (the member-photo
 * route) directly. Each cleaner is lossless and returns identical bytes on a
 * second pass.
 */
export function stripImageMetadata(
  bytes: Buffer,
  contentType: AllowedMediaImageContentType,
): StripImageResult {
  try {
    switch (contentType) {
      case "image/jpeg":
        return confirmed(bytes, stripJpegMetadata(bytes));
      case "image/png":
        return confirmed(bytes, stripPngMetadata(bytes));
      case "image/webp":
        return confirmed(bytes, stripWebpMetadata(bytes));
      case "image/gif":
        return confirmed(bytes, stripGifMetadata(bytes));
      case "image/avif": {
        const outcome = stripAvifMetadata(bytes);
        if (outcome.ok) return outcome;
        return outcome.reason === "animated"
          ? { ok: false, bytes, reason: "animated-avif" }
          : unconfirmed(bytes);
      }
      case "image/svg+xml":
        return confirmed(bytes, stripSvgMetadata(bytes, cleanEmbeddedRaster));
    }
  } catch {
    return unconfirmed(bytes);
  }
}

const EMBEDDABLE_RASTER_TYPES: ReadonlySet<AllowedMediaImageContentType> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Cleans a raster image embedded in an SVG; never another SVG or an AVIF. */
function cleanEmbeddedRaster(bytes: Buffer): { bytes: Buffer; contentType: string } | null {
  const contentType = detectImageContentType(bytes);
  if (!contentType || !EMBEDDABLE_RASTER_TYPES.has(contentType)) return null;
  const stripped = stripImageMetadata(bytes, contentType);
  return stripped.ok ? { bytes: stripped.bytes, contentType } : null;
}

/**
 * Shown to whoever uploaded an image the app could not confirm clean, on every
 * path that refuses one (#5244). Plain English for a club volunteer.
 */
export const IMAGE_NOT_CLEAN_MESSAGE =
  "This image was not saved: it may hold hidden details, such as where it was taken, the device or the owner's name, and they could not be removed. Open it in an image editor, export a fresh copy and upload that instead.";

/** The refusal for an animated AVIF, which has no cleaner. */
export const ANIMATED_AVIF_NOT_CLEAN_MESSAGE =
  "Animated AVIF images cannot be checked for hidden details, such as where they were taken, the device or the owner's name, so this one was not saved. Upload it as an animated GIF or a still image instead.";

export type CleanImageResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; message: string };

/**
 * The bytes to store for an uploaded image, with every hidden detail removed —
 * or a refusal, with the message to show the uploader, when that cannot be
 * confirmed (#5244). The one storage policy for every path that keeps an
 * uploaded image:
 *  - `src/app/api/admin/image-library/route.ts` (DB `MediaImage`, served
 *    anonymously from `/api/images/[id]` with `max-age=31536000, immutable`),
 *  - `src/lib/config-transfer/media.ts` (bundle images recreated as the same
 *    kind of anonymously-served `MediaImage`),
 *  - `src/app/api/admin/image-manager/upload/route.ts` (files written under
 *    `public/images`, served directly by Next.js/Caddy),
 *  - `storableLogoDataUrl` below (the inline club logo).
 *
 * FAIL-CLOSED: nothing is ever stored unconfirmed. `contentType` is nullable so
 * a caller whose bytes sniffed as no allowed type gets the same refusal.
 *
 * Callers MUST derive any stored size/dimensions from the RETURNED buffer, not
 * the input, or the recorded values will not describe the bytes written.
 */
export function cleanImageForStorage(
  bytes: Buffer,
  contentType: AllowedMediaImageContentType | null,
): CleanImageResult {
  if (!contentType) return { ok: false, message: IMAGE_NOT_CLEAN_MESSAGE };
  const stripped = stripImageMetadata(bytes, contentType);
  if (stripped.ok) return { ok: true, bytes: stripped.bytes };
  return {
    ok: false,
    message:
      stripped.reason === "animated-avif"
        ? ANIMATED_AVIF_NOT_CLEAN_MESSAGE
        : IMAGE_NOT_CLEAN_MESSAGE,
  };
}

/**
 * A `data:<type>;base64,<payload>` value, split into its declared media type and
 * its payload. Deliberately permissive about the type: the caller has already
 * validated the value against the club-theme logo pattern, and this helper must
 * never widen or narrow what that pattern accepts — it only strips bytes.
 */
const BASE64_DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

/**
 * The value to store for an image held INLINE as a base64 `data:` URI rather
 * than as a `MediaImage` row — today that is `ClubTheme.logoDataUrl`, which the
 * public header, footer and mobile menu render inline on every public page.
 *
 * Same FAIL-CLOSED policy as `cleanImageForStorage` (it delegates to it): a
 * logo that cannot be confirmed clean — including a value that is not a base64
 * data URI at all — is refused, and the site-style save or configuration
 * restore reports the message (#5244). New logos normally go through
 * `POST /api/admin/site-style/logo`, which re-encodes through sharp and is
 * metadata-free by construction; this inline column is the legacy/escape-hatch
 * path, and a hand-crafted or bundled logo can still be a phone photo carrying
 * GPS.
 *
 * `value` is `null` for no logo (null/undefined/empty). Otherwise it is the
 * ORIGINAL string byte for byte whenever nothing was removed. That matters:
 * re-emitting a re-encoded payload that decodes to identical bytes would churn
 * the stored value — and, on the config-transfer import, would turn an
 * "unchanged" dry-run into a spurious "update" — for no privacy gain.
 */
export function storableLogoDataUrl(
  value: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (!value) return { ok: true, value: null };
  const match = BASE64_DATA_URL.exec(value.trim());
  if (!match) return { ok: false, message: IMAGE_NOT_CLEAN_MESSAGE };
  const declaredType = must(match[1], "storableLogoDataUrl: matched data URI has no media-type capture group");
  const base64 = must(match[2], "storableLogoDataUrl: matched data URI has no base64 capture group");
  const bytes = Buffer.from(base64, "base64");
  const cleaned = cleanImageForStorage(bytes, detectImageContentType(bytes));
  if (!cleaned.ok) return cleaned;
  if (cleaned.bytes.equals(bytes)) return { ok: true, value };
  // Keep the DECLARED media type: a strip never changes the container format
  // (JPEG keeps its SOI, PNG its signature, WebP its RIFF header), so rewriting
  // the type here could only introduce a mismatch the browser then renders
  // differently.
  return { ok: true, value: `data:${declaredType};base64,${cleaned.bytes.toString("base64")}` };
}

/**
 * Strip directory components and unsafe characters from an uploaded
 * filename, keeping it short enough for storage and display.
 */
export function sanitiseMediaImageFilename(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").trim();
  const safe = /[A-Za-z0-9]/.test(cleaned) ? cleaned : "upload";
  return safe.slice(0, MAX_MEDIA_IMAGE_FILENAME_LENGTH);
}

export function mediaImageServingUrl(id: string): string {
  return `/api/images/${id}`;
}
