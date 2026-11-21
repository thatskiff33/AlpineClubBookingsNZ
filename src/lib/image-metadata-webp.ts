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

/** Top-level chunks that draw the picture; `ANMF` frames are rebuilt below. */
const WEBP_DRAWING_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ICCP"]);
/** What an animation frame (`ANMF`) may hold after its 16-byte header. */
const WEBP_FRAME_CHUNKS = new Set(["ALPH", "VP8 ", "VP8L"]);
const ANMF_HEADER_BYTES = 16;
/** Chunks with a fixed size: anything past it is cut off. */
const FIXED_CHUNK_BYTES: Record<string, number> = { VP8X: 10, ANIM: 6 };

type Chunk = { fourCC: string; start: number; data: number; size: number; end: number };

/**
 * The RIFF chunks in [start, end), or `null` when one overruns. A final
 * odd-sized chunk may omit its pad byte when it ends exactly at `end`.
 */
function riffChunks(bytes: Buffer, start: number, end: number): Chunk[] | null {
  const chunks: Chunk[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = bytes.readUInt32LE(offset + 4);
    let chunkEnd = offset + 8 + size + (size % 2);
    if (chunkEnd > end) {
      if (offset + 8 + size !== end) return null;
      chunkEnd = end;
    }
    chunks.push({
      fourCC: bytes.toString("ascii", offset, offset + 4),
      start: offset,
      data: offset + 8,
      size,
      end: chunkEnd,
    });
    offset = chunkEnd;
  }
  return chunks;
}

function riffChunk(fourCC: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2));
  chunk.write(fourCC, 0, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

/** An animation frame holding only its header and drawing chunks. */
function cleanFrame(bytes: Buffer, frame: Chunk): Buffer | null {
  const body = frame.data + ANMF_HEADER_BYTES;
  const dataEnd = frame.data + frame.size;
  if (body > dataEnd) return null;
  const inner = riffChunks(bytes, body, dataEnd);
  if (!inner) return null;
  const kept = inner.filter((chunk) => WEBP_FRAME_CHUNKS.has(chunk.fourCC));
  // Copied whole only when its chunks are all kept and cover it exactly: up to
  // seven stray bytes after the last chunk are not a chunk the walk can see.
  const coversFrame = (inner.at(-1)?.end ?? body) === dataEnd;
  if (kept.length === inner.length && coversFrame && frame.size % 2 === 0) {
    return bytes.subarray(frame.start, frame.end);
  }
  return riffChunk("ANMF", Buffer.concat([
    bytes.subarray(frame.data, body),
    ...kept.map((chunk) => bytes.subarray(chunk.start, chunk.end)),
  ]));
}

/**
 * Keep only the chunks that draw a WebP — dropping XMP, Content Credentials
 * and any other metadata chunk without naming it — replace the first EXIF chunk
 * by one holding only its Orientation (dropping it when there is none), set the
 * matching VP8X metadata flag bits and recompute the RIFF size. Fail-CLOSED:
 * bytes come back when the chunk walk completes cleanly to EOF — including the
 * "nothing to strip" case (the input is returned as is) and the legitimate
 * final-odd-pad case. A malformed chunk overrun (or a bad RIFF/WEBP header)
 * returns `null`.
 */
export function stripWebpMetadata(bytes: Buffer): Buffer | null {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunks = riffChunks(bytes, 12, bytes.length);
  if (!chunks) return null;
  const kept: Buffer[] = [];
  let vp8xIndex: number | null = null;
  let orientation: number | null = null;
  let exifSeen = false;
  for (const chunk of chunks) {
    if (chunk.fourCC === "EXIF") {
      // Replaced in place by a chunk holding only the Orientation. Some
      // writers prefix the TIFF data with JPEG's "Exif\0\0".
      if (exifSeen) continue;
      exifSeen = true;
      let tiff = bytes.subarray(chunk.data, chunk.data + chunk.size);
      if (tiff.toString("latin1", 0, 6) === EXIF_APP1_PREFIX) tiff = tiff.subarray(6);
      orientation = readExifOrientation(tiff);
      if (orientation !== null) kept.push(riffChunk("EXIF", orientationOnlyExif(orientation)));
    } else if (chunk.fourCC === "ANMF") {
      const frame = cleanFrame(bytes, chunk);
      if (!frame) return null;
      kept.push(frame);
    } else if (WEBP_DRAWING_CHUNKS.has(chunk.fourCC)) {
      const fixed = FIXED_CHUNK_BYTES[chunk.fourCC];
      if (fixed !== undefined && chunk.size < fixed) return null;
      if (chunk.fourCC === "VP8X") vp8xIndex = kept.length;
      kept.push(fixed !== undefined && chunk.size > fixed
        ? riffChunk(chunk.fourCC, bytes.subarray(chunk.data, chunk.data + fixed))
        : bytes.subarray(chunk.start, chunk.end));
    }
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
