import { crc32 } from "node:zlib";

import { orientationOnlyExif, readExifOrientation } from "@/lib/image-metadata-exif";

/**
 * Hidden-data removal for PNG images, behind `stripImageMetadata` in
 * `@/lib/image-metadata` (#2242; #5244 split it out and made it keep the EXIF
 * Orientation). Returns the cleaned bytes, or `null` when the structure cannot
 * be walked with confidence, and the caller refuses the upload.
 */

const PNG_METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

/**
 * Remove text/EXIF/timestamp ancillary chunks from a PNG (eXIf can carry GPS),
 * keeping all critical and colour chunks; the first eXIf is replaced by one
 * holding only its Orientation. Fail-CLOSED: bytes come back only if
 * the chunk walk actually reaches an IEND chunk; a truncated chunk or a walk
 * that ends without IEND returns `null`.
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
    if (!PNG_METADATA_CHUNKS.has(type)) {
      kept.push(bytes.subarray(offset, chunkEnd));
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
