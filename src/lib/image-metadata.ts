import logger from "@/lib/logger";
import { must } from "@/lib/indexed-access";

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
  // `next < text.length` is checked (and short-circuits) before the index
  // read, so the character is always in range.
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
    // `offset + 9 <= bytes.length` (the loop condition) already guarantees
    // `offset + 1` is in range.
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
  // Callers only reach here after checking `bytes.length` covers offset+2.
  const b0 = must(bytes[offset], "readUInt24LE: offset within bytes.length");
  const b1 = must(bytes[offset + 1], "readUInt24LE: offset+1 within bytes.length");
  const b2 = must(bytes[offset + 2], "readUInt24LE: offset+2 within bytes.length");
  return b0 | (b1 << 8) | (b2 << 16);
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
    // `bytes.length < payload + 5` was checked above, so payload+1..+4 are in range.
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
    // Each pattern's 1st group is mandatory, so a match always captures it.
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
    // Both groups are mandatory, so a match always captures them.
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
 * nonstandard structure, a thrown exception, or a content type this module has
 * no stripper for); `bytes` is the ORIGINAL, unchanged. Never treat `ok: false`
 * as "clean": the caller's policy decides whether to reject it (fail-CLOSED —
 * the member-photo route) or to store it and log (fail-OPEN —
 * `storableImageBytes` below).
 */
export type StripImageResult = { ok: boolean; bytes: Buffer };

/**
 * Remove metadata from a JPEG by copying only the colour/rendering marker
 * segments — JFIF (APP0), an ICC-profile APP2, Adobe (APP14) — and the
 * structural markers, dropping every other APPn (EXIF/XMP APP1, IPTC/Photoshop
 * APP13, Ducky APP12, the MPF index APP2, vendor blocks) and every COM comment,
 * any of which can carry creator contact info, location or GPS. The parser runs
 * through the entropy-coded scan(s) to the primary EOI and STOPS there, dropping
 * any bytes appended after it — an MPF multi-picture / motion-photo JPEG appends
 * a second image with its own EXIF/GPS. Fail-CLOSED: `ok` is true ONLY on the
 * primary-EOI-terminated path; any malformed/nonstandard structure returns
 * `ok: false` with the original bytes so the caller rejects the upload.
 */
function stripJpegMetadata(bytes: Buffer): StripImageResult {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return { ok: false, bytes };
  const kept: Buffer[] = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return { ok: false, bytes }; // not at a marker
    // `offset + 2 <= bytes.length` (the loop condition) guarantees offset+1 is in range.
    const marker = must(bytes[offset + 1], "stripJpegMetadata: offset within bytes.length");

    if (marker === 0xd9) {
      // Primary EOI: end of the primary image. Emit it and STOP, dropping any
      // appended trailer (MPF / motion-photo secondary image + its EXIF/GPS).
      // This is the ONLY confirmed-clean exit.
      kept.push(bytes.subarray(offset, offset + 2));
      return { ok: true, bytes: Buffer.concat(kept) };
    }

    if (marker === 0xda) {
      // Start of scan: copy the SOS header + entropy-coded data up to the next
      // real marker (an 0xff not part of 0xff00 byte-stuffing or an RSTn
      // 0xd0-0xd7), then continue so a following EOI truncates any trailer and a
      // following scan (progressive JPEG) is handled normally.
      if (offset + 4 > bytes.length) return { ok: false, bytes };
      const sosLen = bytes.readUInt16BE(offset + 2);
      let scan = offset + 2 + sosLen;
      if (scan > bytes.length) return { ok: false, bytes };
      while (scan + 1 < bytes.length) {
        if (bytes[scan] === 0xff) {
          // The while condition `scan + 1 < bytes.length` guarantees this is in range.
          const m = must(bytes[scan + 1], "stripJpegMetadata scan: scan+1 within bytes.length");
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
            scan += 2; // stuffed byte or restart marker → part of the scan
            continue;
          }
          break; // real marker
        }
        scan += 1;
      }
      kept.push(bytes.subarray(offset, scan));
      offset = scan;
      continue;
    }

    // Length-prefixed marker segment (APPn, COM, DQT, DHT, SOFn, DRI, …).
    if (offset + 4 > bytes.length) return { ok: false, bytes };
    const segLen = bytes.readUInt16BE(offset + 2);
    const segEnd = offset + 2 + segLen;
    if (segLen < 2 || segEnd > bytes.length) return { ok: false, bytes }; // truncated/invalid
    // Allow-list, not deny-list: metadata lives across many APPn markers (APP1
    // EXIF/XMP, APP13 IPTC/Photoshop, APP12 Ducky, vendor APP3-APP11), any of
    // which can carry creator contact info, location or GPS. Preserve ONLY the
    // colour/rendering segments — APP0 (JFIF), APP14 (Adobe), and an APP2 that
    // is an ICC profile (identified by its "ICC_PROFILE\0" tag, so the MPF index
    // APP2 that points at appended images is NOT kept) — and drop every other
    // APPn and every COM comment. Structural markers (DQT, DHT, SOFn, DRI, …)
    // are not APPn/COM and are always kept.
    const isAppSegment = marker >= 0xe0 && marker <= 0xef;
    const isJfifOrAdobe = marker === 0xe0 || marker === 0xee;
    const isIccApp2 =
      marker === 0xe2 &&
      bytes.toString("latin1", offset + 4, offset + 4 + 12) === "ICC_PROFILE\0";
    const drop =
      (isAppSegment && !isJfifOrAdobe && !isIccApp2) || marker === 0xfe; // COM
    if (!drop) {
      kept.push(bytes.subarray(offset, segEnd));
    }
    offset = segEnd;
  }
  return { ok: false, bytes }; // no primary EOI found → reject (fail-closed)
}

const PNG_METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

/**
 * Remove text/EXIF/timestamp ancillary chunks from a PNG (eXIf can carry GPS),
 * keeping all critical and colour chunks. Fail-CLOSED: `ok` is true only if the
 * chunk walk actually reaches an IEND chunk; a truncated chunk or a walk that
 * ends without IEND returns `ok: false` with the original bytes.
 */
function stripPngMetadata(bytes: Buffer): StripImageResult {
  const SIG = 8;
  if (bytes.length < SIG + 12) return { ok: false, bytes };
  const kept: Buffer[] = [bytes.subarray(0, SIG)];
  let offset = SIG;
  while (offset + 12 <= bytes.length) {
    const len = readUInt32BE(bytes, offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + len; // len(4) + type(4) + data(len) + crc(4)
    if (chunkEnd > bytes.length) return { ok: false, bytes }; // truncated
    if (!PNG_METADATA_CHUNKS.has(type)) {
      kept.push(bytes.subarray(offset, chunkEnd));
    }
    if (type === "IEND") return { ok: true, bytes: Buffer.concat(kept) };
    offset = chunkEnd;
  }
  return { ok: false, bytes }; // walk ended without IEND → reject (fail-closed)
}

/**
 * Remove EXIF and XMP chunks from a WebP RIFF container and clear the matching
 * VP8X metadata flag bits, recomputing the RIFF size. Fail-CLOSED: `ok` is true
 * when the chunk walk completes cleanly to EOF — including the "nothing to
 * strip" (`!changed`) case and the legitimate final-odd-pad case. A malformed
 * non-final-chunk overrun (or a bad RIFF/WEBP header) returns `ok: false` with
 * the original bytes.
 */
function stripWebpMetadata(bytes: Buffer): StripImageResult {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return { ok: false, bytes };
  }
  const kept: Buffer[] = [];
  let offset = 12;
  let changed = false;
  while (offset + 8 <= bytes.length) {
    const fourCC = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    let chunkEnd = offset + 8 + padded;
    if (chunkEnd > bytes.length) {
      // A final odd-sized chunk may omit its RIFF pad byte. Accept that exact
      // case (the unpadded end lands on EOF) so a trailing EXIF/XMP chunk is
      // still stripped rather than the whole file being left untouched;
      // anything else is genuinely malformed → reject.
      if (offset + 8 + size === bytes.length) {
        chunkEnd = bytes.length;
      } else {
        return { ok: false, bytes };
      }
    }
    if (fourCC === "EXIF" || fourCC === "XMP ") {
      changed = true;
      offset = chunkEnd;
      continue;
    }
    let chunk = bytes.subarray(offset, chunkEnd);
    if (fourCC === "VP8X" && chunk.length > 8) {
      // Clear the EXIF (0x08) and XMP (0x04) flag bits in the first payload byte.
      // `chunk.length > 8` above guarantees index 8 is in range.
      const flags = must(chunk[8], "stripWebpMetadata: chunk has more than 8 bytes");
      const cleared = flags & ~0b0000_1100;
      if (cleared !== flags) {
        chunk = Buffer.from(chunk);
        chunk[8] = cleared;
        changed = true;
      }
    }
    kept.push(chunk);
    offset = chunkEnd;
  }
  // Clean walk to EOF. Nothing to strip is a confirmed-clean result too.
  if (!changed) return { ok: true, bytes };
  const body = Buffer.concat(kept);
  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(4 + body.length, 4); // "WEBP" tag + chunk bytes
  out.write("WEBP", 8, "ascii");
  body.copy(out, 12);
  return { ok: true, bytes: out };
}

/**
 * Strip privacy-sensitive metadata (EXIF/GPS, XMP, comments) from an uploaded
 * image before it is stored and potentially served publicly. The result carries
 * `ok: true` ONLY when the parser completed a clean structural walk and any
 * metadata present was removed (or there was validly none); `ok: false`
 * (malformed/nonstandard structure, an unsupported type, or a thrown exception)
 * means the strip could not be positively confirmed and `bytes` is the unchanged
 * original. Content re-encoded client-side (the crop canvas) is already
 * metadata-free and passes cleanly; this also covers the direct-upload paths
 * where a phone-camera JPEG could carry GPS coordinates.
 *
 * How an `ok: false` result is handled is the CALLER's policy, and the callers
 * deliberately differ:
 *  - `src/app/api/members/[id]/photo/route.ts` fails CLOSED — it rejects the
 *    upload rather than store personal-data bytes it could not prove were
 *    scrubbed.
 *  - the admin image library, the image manager, and the config-transfer bundle
 *    import all fail OPEN through `storableImageBytes` below, which stores the
 *    original and logs (see that helper for why).
 *
 * The `default` branch covers the three allowed types this module has NO
 * stripper for — gif, avif and svg+xml — and returns `ok: false` with the
 * ORIGINAL bytes. That is not a formality: AVIF is a HEIF container carrying
 * EXIF (including `GPSLatitude`/`GPSLongitude`) as an `Exif` item, SVG carries
 * `<metadata>` RDF with creator identity and, from many editors, the author's
 * local file path, and GIF carries the Comment Extension and XMP via an
 * Application Extension. Reporting those as a confirmed strip would silence the
 * very warning that is meant to make an unstripped upload visible in operations.
 * The branch is UNREACHABLE from the fail-CLOSED member-photo route, which
 * rejects anything outside `ALLOWED_MEMBER_PHOTO_CONTENT_TYPES` (jpeg/png/webp)
 * before it ever calls this, so it cannot start rejecting member photos; on the
 * fail-OPEN callers it stores exactly the same bytes as before and merely starts
 * logging.
 */
export function stripImageMetadata(
  bytes: Buffer,
  contentType: AllowedMediaImageContentType,
): StripImageResult {
  try {
    switch (contentType) {
      case "image/jpeg":
        return stripJpegMetadata(bytes);
      case "image/png":
        return stripPngMetadata(bytes);
      case "image/webp":
        return stripWebpMetadata(bytes);
      default:
        return { ok: false, bytes };
    }
  } catch {
    return { ok: false, bytes };
  }
}

/**
 * Bytes to store on a FAIL-OPEN image path: metadata stripped when the strip can
 * be positively confirmed, otherwise the unchanged original plus a warning.
 *
 * Shared by every fail-open image-storing path so the policy, the log shape and
 * the bytes are identical on all of them:
 *  - `src/app/api/admin/image-library/route.ts` (DB `MediaImage`, served
 *    anonymously from `/api/images/[id]` with `max-age=31536000, immutable`),
 *  - `src/lib/config-transfer/media.ts` (bundle images recreated as the same
 *    kind of anonymously-served `MediaImage`),
 *  - `src/app/api/admin/image-manager/upload/route.ts` (files written under
 *    `public/images`, served directly by Next.js/Caddy).
 *
 * FAIL-OPEN, deliberately, and the asymmetry with the member-photo route (which
 * fails CLOSED and rejects) is intentional: `stripJpegMetadata` rejects some
 * spec-legal JPEG fill-byte sequences (T.81 §B.1.1.2), and blocking a legitimate
 * admin content upload — or an operator's configuration-bundle restore — is the
 * worse outcome on these paths, whereas a member photo is personal data on a
 * narrow, purpose-built path where the reverse is true. An unconfirmed strip is
 * logged so it is visible in operations.
 *
 * `contentType` is nullable so a caller that could not sniff the bytes at all
 * (the image-manager batch uploader trusts the declared MIME + extension and
 * must not start rejecting files) still goes down the logged, store-the-original
 * path rather than silently skipping the strip.
 *
 * Callers MUST derive any stored size/metadata from the RETURNED buffer, not the
 * input, or the recorded byteSize will not describe the bytes actually written.
 */
export function storableImageBytes(
  bytes: Buffer,
  contentType: AllowedMediaImageContentType | null,
  context: Record<string, unknown> & { source: string },
): Buffer {
  const stripped: StripImageResult = contentType
    ? stripImageMetadata(bytes, contentType)
    : { ok: false, bytes };
  if (stripped.ok) return stripped.bytes;
  logger.warn(
    { ...context, contentType, byteSize: bytes.length },
    "Image stored without a confirmed metadata strip",
  );
  return bytes;
}

/**
 * A `data:<type>;base64,<payload>` value, split into its declared media type and
 * its payload. Deliberately permissive about the type: the caller has already
 * validated the value against the club-theme logo pattern, and this helper must
 * never widen or narrow what that pattern accepts — it only strips bytes.
 */
const BASE64_DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

/**
 * Bytes to store for an image held INLINE as a base64 `data:` URI rather than as
 * a `MediaImage` row — today that is `ClubTheme.logoDataUrl`, which the public
 * header, footer and mobile menu render inline on every public page.
 *
 * Same FAIL-OPEN policy, log line and reasoning as `storableImageBytes` above
 * (it delegates to it): a club logo that cannot be confirmed clean is stored
 * unchanged and logged, because blocking a site-style save or an operator's
 * whole configuration restore over one unparseable decorative image is the worse
 * outcome. The inline column is a legacy/escape-hatch path — new logos go
 * through `POST /api/admin/site-style/logo`, which re-encodes through sharp and
 * is metadata-free by construction — but a hand-crafted or bundled inline logo
 * can still be a straight-from-phone photo carrying GPS, and it renders on every
 * public page, so it gets the same treatment as every other stored image.
 *
 * Returns the ORIGINAL string byte for byte whenever nothing was removed (an
 * empty/absent value, a value that is not a base64 data URI, an unsniffable or
 * unstrippable payload, or an image that simply had no metadata). That matters:
 * re-emitting a re-encoded payload that decodes to identical bytes would churn
 * the stored value — and, on the config-transfer import, would turn an
 * "unchanged" dry-run into a spurious "update" — for no privacy gain.
 */
export function storableLogoDataUrl(
  value: string | null | undefined,
  context: Record<string, unknown> & { source: string },
): string | null {
  if (!value) return null; // no logo (null/undefined/empty) — nothing to strip
  const match = BASE64_DATA_URL.exec(value.trim());
  if (!match) {
    // Not a base64 data URI at all. The caller's sanitiser normally rules this
    // out; log rather than throw so a hand-edited row cannot break a save.
    logger.warn(
      { ...context, contentType: null, byteSize: value.length },
      "Image stored without a confirmed metadata strip",
    );
    return value;
  }
  // Both groups are mandatory (no trailing `?`), so a successful match always
  // captures them (the 2nd may capture an empty string, never undefined).
  const declaredType = must(match[1], "storableLogoDataUrl: matched data URI has no media-type capture group");
  const base64 = must(match[2], "storableLogoDataUrl: matched data URI has no base64 capture group");
  const bytes = Buffer.from(base64, "base64");
  const stored = storableImageBytes(bytes, detectImageContentType(bytes), {
    ...context,
    declaredContentType: declaredType,
  });
  if (stored.equals(bytes)) return value;
  // Keep the DECLARED media type: a strip never changes the container format
  // (JPEG keeps its SOI, PNG its signature, WebP its RIFF header), so rewriting
  // the type here could only introduce a mismatch the browser then renders
  // differently.
  return `data:${declaredType};base64,${stored.toString("base64")}`;
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
