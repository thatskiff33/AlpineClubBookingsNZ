import { must } from "@/lib/indexed-access";
import {
  EXIF_APP1_PREFIX,
  orientationOnlyExif,
  readExifOrientation,
} from "@/lib/image-metadata-exif";

/**
 * Hidden-data removal for WebP images, behind `stripImageMetadata` in
 * `@/lib/image-metadata` (#2242; #5244 split it out and made it keep the EXIF
 * Orientation). Returns the cleaned bytes, or `null` when the structure cannot
 * be walked with confidence, and the caller refuses the upload.
 */

/**
 * Remove XMP chunks from a WebP RIFF container, replace the first EXIF chunk by
 * one holding only its Orientation (dropping it when there is none), set the
 * matching VP8X metadata flag bits and recompute the RIFF size. Fail-CLOSED:
 * bytes come back when the chunk walk completes cleanly to EOF — including the
 * "nothing to strip" case (the input is returned as is) and the legitimate
 * final-odd-pad case. A malformed
 * non-final-chunk overrun (or a bad RIFF/WEBP header) returns `null`.
 */
export function stripWebpMetadata(bytes: Buffer): Buffer | null {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
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
        return null;
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
  return out.equals(bytes) ? bytes : out;
}
