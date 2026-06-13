import "server-only";

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

export const MAX_MEDIA_IMAGE_FILENAME_LENGTH = 200;
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
  while (next < text.length && /\s/.test(text[next])) {
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
    const marker = bytes[offset + 1];
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

function extractSvgDimensions(bytes: Buffer): ImageDimensions | null {
  const head = bytes.subarray(0, 4096).toString("utf8");
  const svgTagMatch = head.match(/<svg[^>]*>/i);
  if (!svgTagMatch) return null;
  const svgTag = svgTagMatch[0];

  const widthMatch = svgTag.match(/\bwidth="([0-9.]+)(?:px)?"/i);
  const heightMatch = svgTag.match(/\bheight="([0-9.]+)(?:px)?"/i);
  if (widthMatch && heightMatch) {
    const width = Math.round(Number.parseFloat(widthMatch[1]));
    const height = Math.round(Number.parseFloat(heightMatch[1]));
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const viewBoxMatch = svgTag.match(
    /\bviewBox="\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*"/i,
  );
  if (viewBoxMatch) {
    const width = Math.round(Number.parseFloat(viewBoxMatch[1]));
    const height = Math.round(Number.parseFloat(viewBoxMatch[2]));
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  return null;
}

/**
 * Best-effort dimension extraction for formats where it is cheap to do
 * without an image-processing dependency. Returns null when the format
 * isn't supported (WebP/AVIF) or the bytes can't be parsed.
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
