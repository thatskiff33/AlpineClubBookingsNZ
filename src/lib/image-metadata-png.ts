import { crc32 } from "node:zlib";

import { orientationOnlyExif, readExifOrientation } from "@/lib/image-metadata-exif";

/**
 * Hidden-data removal for PNG images, behind `stripImageMetadata` in
 * `@/lib/image-metadata` (#2242; #5244 split it out and made it keep the EXIF
 * Orientation). Returns the cleaned bytes, or `null` when the structure cannot
 * be walked with confidence, and the caller refuses the upload.
 */

/**
 * The chunks that draw the picture: the four critical chunks, transparency,
 * colour and pixel-size information, and animation (APNG). Everything else —
 * text, EXIF, timestamps, Content Credentials (`caBX`), vendor chunks — is
 * dropped, so a new metadata chunk is removed without being named here.
 */
const PNG_DRAWING_CHUNKS = new Set([
  "IHDR", "PLTE", "IDAT", "IEND",
  "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs",
  "cICP", "mDCV", "cLLI", "mDCv", "cLLi", // HDR (final and draft names)
  "acTL", "fcTL", "fdAT",
]);

/** A chunk name starting upper-case is critical: a decoder cannot skip it. */
const isCritical = (type: string) => /^[A-Z]/.test(type);

/**
 * Keep only the chunks that draw a PNG, replacing the first eXIf with one
 * holding only its Orientation. Fail-CLOSED: bytes come back only if the chunk
 * walk reaches an IEND chunk; a truncated chunk, an unknown critical chunk or a
 * walk that ends without IEND returns `null`.
 */
export function stripPngMetadata(bytes: Buffer): Buffer | null {
  const SIG = 8;
  if (bytes.length < SIG + 12) return null;
  const kept: Buffer[] = [bytes.subarray(0, SIG)];
  let offset = SIG;
  let orientationWritten = false;
  while (offset + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + len; // len(4) + type(4) + data(len) + crc(4)
    if (chunkEnd > bytes.length) return null; // truncated
    if (PNG_DRAWING_CHUNKS.has(type)) {
      kept.push(bytes.subarray(offset, chunkEnd));
    } else if (isCritical(type)) {
      return null; // a chunk the picture needs but this does not know
    } else if (type === "eXIf" && !orientationWritten) {
      // Replaced in place by a chunk holding only the Orientation.
      orientationWritten = true;
      const orientation = readExifOrientation(bytes.subarray(offset + 8, chunkEnd - 4));
      if (orientation !== null) kept.push(pngChunk("eXIf", orientationOnlyExif(orientation)));
    }
    if (type === "IEND") return Buffer.concat(kept);
    offset = chunkEnd;
  }
  return null; // walk ended without IEND → reject (fail-closed)
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}
