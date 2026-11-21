import { crc32 } from "node:zlib";

import { must } from "@/lib/indexed-access";
import { stripAvifMetadata } from "@/lib/image-metadata-avif";
import { orientationOnlyExif, readExifOrientation } from "@/lib/image-metadata-exif";
import { stripGifMetadata } from "@/lib/image-metadata-gif";
import { stripSvgMetadata } from "@/lib/image-metadata-svg";

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

const EXIF_APP1_PREFIX = "Exif\0\0";

/**
 * Remove metadata from a JPEG by copying only the colour/rendering marker
 * segments — JFIF (APP0), an ICC-profile APP2, Adobe (APP14) — and the
 * structural markers, dropping every other APPn (EXIF/XMP APP1, IPTC/Photoshop
 * APP13, Ducky APP12, the MPF index APP2, vendor blocks) and every COM comment,
 * any of which can carry creator contact info, location or GPS. The parser runs
 * through the entropy-coded scan(s) to the primary EOI and STOPS there, dropping
 * any bytes appended after it — an MPF multi-picture / motion-photo JPEG appends
 * a second image with its own EXIF/GPS. The first EXIF APP1 is replaced by one
 * holding only its Orientation, so a phone portrait keeps its rotation; `FF`
 * fill bytes before a marker are accepted and dropped. Fail-CLOSED: `ok` is true
 * ONLY on the primary-EOI-terminated path; any malformed/nonstandard structure
 * returns `ok: false` with the original bytes so the caller rejects the upload.
 */
function stripJpegMetadata(bytes: Buffer): StripImageResult {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return unconfirmed(bytes);
  const kept: Buffer[] = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;
  let orientationWritten = false;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return unconfirmed(bytes); // not at a marker
    // Any run of 0xFF fill bytes may precede a marker (T.81 §B.1.1.2); skip
    // to the last one, dropping the padding.
    while (offset + 2 < bytes.length && bytes[offset + 1] === 0xff) offset += 1;
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
      if (offset + 4 > bytes.length) return unconfirmed(bytes);
      const sosLen = bytes.readUInt16BE(offset + 2);
      let scan = offset + 2 + sosLen;
      if (scan > bytes.length) return unconfirmed(bytes);
      while (scan + 1 < bytes.length) {
        if (bytes[scan] === 0xff) {
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
    if (offset + 4 > bytes.length) return unconfirmed(bytes);
    const segLen = bytes.readUInt16BE(offset + 2);
    const segEnd = offset + 2 + segLen;
    if (segLen < 2 || segEnd > bytes.length) return unconfirmed(bytes); // truncated/invalid
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
    } else if (
      marker === 0xe1 &&
      !orientationWritten &&
      bytes.toString("latin1", offset + 4, offset + 10) === EXIF_APP1_PREFIX
    ) {
      // The first EXIF APP1 is replaced, in place, by one holding only the
      // Orientation, so a phone portrait is not turned sideways.
      orientationWritten = true;
      const orientation = readExifOrientation(bytes.subarray(offset + 10, segEnd));
      if (orientation !== null) kept.push(jpegOrientationSegment(orientation));
    }
    offset = segEnd;
  }
  return unconfirmed(bytes); // no primary EOI found → reject (fail-closed)
}

function jpegOrientationSegment(orientation: number): Buffer {
  const tiff = orientationOnlyExif(orientation);
  const header = Buffer.alloc(4 + EXIF_APP1_PREFIX.length);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(2 + EXIF_APP1_PREFIX.length + tiff.length, 2);
  header.write(EXIF_APP1_PREFIX, 4, "latin1");
  return Buffer.concat([header, tiff]);
}

const PNG_METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

/**
 * Remove text/EXIF/timestamp ancillary chunks from a PNG (eXIf can carry GPS),
 * keeping all critical and colour chunks; the first eXIf is replaced by one
 * holding only its Orientation. Fail-CLOSED: `ok` is true only if the
 * chunk walk actually reaches an IEND chunk; a truncated chunk or a walk that
 * ends without IEND returns `ok: false` with the original bytes.
 */
function stripPngMetadata(bytes: Buffer): StripImageResult {
  const SIG = 8;
  if (bytes.length < SIG + 12) return unconfirmed(bytes);
  const kept: Buffer[] = [bytes.subarray(0, SIG)];
  let offset = SIG;
  let orientationWritten = false;
  while (offset + 12 <= bytes.length) {
    const len = readUInt32BE(bytes, offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + len; // len(4) + type(4) + data(len) + crc(4)
    if (chunkEnd > bytes.length) return unconfirmed(bytes); // truncated
    if (!PNG_METADATA_CHUNKS.has(type)) {
      kept.push(bytes.subarray(offset, chunkEnd));
    } else if (type === "eXIf" && !orientationWritten) {
      // Replaced in place by a chunk holding only the Orientation.
      orientationWritten = true;
      const orientation = readExifOrientation(bytes.subarray(offset + 8, chunkEnd - 4));
      if (orientation !== null) kept.push(pngChunk("eXIf", orientationOnlyExif(orientation)));
    }
    if (type === "IEND") return { ok: true, bytes: Buffer.concat(kept) };
    offset = chunkEnd;
  }
  return unconfirmed(bytes); // walk ended without IEND → reject (fail-closed)
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/**
 * Remove XMP chunks from a WebP RIFF container, replace the first EXIF chunk by
 * one holding only its Orientation (dropping it when there is none), set the
 * matching VP8X metadata flag bits and recompute the RIFF size. Fail-CLOSED:
 * `ok` is true when the chunk walk completes cleanly to EOF — including the
 * "nothing to strip" case (the input is returned as is) and the legitimate
 * final-odd-pad case. A malformed
 * non-final-chunk overrun (or a bad RIFF/WEBP header) returns `ok: false` with
 * the original bytes.
 */
function stripWebpMetadata(bytes: Buffer): StripImageResult {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return unconfirmed(bytes);
  }
  const kept: Buffer[] = [];
  let vp8xIndex: number | null = null;
  let orientation: number | null = null;
  let exifSeen = false;
  let offset = 12;
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
        return unconfirmed(bytes);
      }
    }
    if (fourCC === "EXIF") {
      // Replaced in place by a chunk holding only the Orientation. Some
      // writers prefix the TIFF data with JPEG's "Exif\0\0".
      if (!exifSeen) {
        exifSeen = true;
        let tiff = bytes.subarray(offset + 8, offset + 8 + size);
        if (tiff.toString("latin1", 0, 6) === EXIF_APP1_PREFIX) tiff = tiff.subarray(6);
        orientation = readExifOrientation(tiff);
        if (orientation !== null) {
          const data = orientationOnlyExif(orientation); // even length: no pad
          const header = Buffer.alloc(8);
          header.write("EXIF", 0, "ascii");
          header.writeUInt32LE(data.length, 4);
          kept.push(header, data);
        }
      }
    } else if (fourCC !== "XMP ") {
      if (fourCC === "VP8X" && chunkEnd - offset > 8) vp8xIndex = kept.length;
      kept.push(bytes.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
  }
  if (vp8xIndex !== null) {
    // The VP8X flags byte says which metadata chunks follow: XMP (0x04) never
    // does now, EXIF (0x08) only when an Orientation was kept.
    const vp8x = Buffer.from(must(kept[vp8xIndex], "stripWebpMetadata: VP8X index recorded from kept"));
    const flags = must(vp8x[8], "stripWebpMetadata: VP8X chunk has more than 8 bytes");
    vp8x[8] = (flags & ~0b0000_1100) | (orientation !== null ? 0b0000_1000 : 0);
    kept[vp8xIndex] = vp8x;
  }
  const body = Buffer.concat(kept);
  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(4 + body.length, 4); // "WEBP" tag + chunk bytes
  out.write("WEBP", 8, "ascii");
  body.copy(out, 12);
  // Clean walk to EOF. Nothing to strip is a confirmed-clean result too, and
  // returns the input itself.
  return { ok: true, bytes: out.equals(bytes) ? bytes : out };
}

/**
 * Strip privacy-sensitive metadata (EXIF/GPS, XMP, comments, embedded text) from
 * an uploaded image before it is stored and potentially served publicly. Every
 * allowed type has a cleaner, so the switch is exhaustive (#5244):
 *  - JPEG, PNG and WebP drop their metadata segments and chunks, keeping only
 *    an EXIF Orientation (`@/lib/image-metadata-exif`);
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
        return stripJpegMetadata(bytes);
      case "image/png":
        return stripPngMetadata(bytes);
      case "image/webp":
        return stripWebpMetadata(bytes);
      case "image/gif": {
        const cleaned = stripGifMetadata(bytes);
        return cleaned ? { ok: true, bytes: cleaned } : unconfirmed(bytes);
      }
      case "image/avif": {
        const outcome = stripAvifMetadata(bytes);
        if (outcome.ok) return outcome;
        return outcome.reason === "animated"
          ? { ok: false, bytes, reason: "animated-avif" }
          : unconfirmed(bytes);
      }
      case "image/svg+xml": {
        const cleaned = stripSvgMetadata(bytes, cleanEmbeddedRaster);
        return cleaned ? { ok: true, bytes: cleaned } : unconfirmed(bytes);
      }
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
