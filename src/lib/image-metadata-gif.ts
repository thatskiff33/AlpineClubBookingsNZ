/**
 * Hidden-data removal for GIF images (#5244), behind `stripImageMetadata` in
 * `@/lib/image-metadata`.
 *
 * A GIF is a header, an optional global colour table and then a run of blocks
 * ending at the trailer byte `3B`. Hidden data lives in three kinds of
 * extension block: the Comment Extension (`21 FE`), the Plain Text Extension
 * (`21 01`) and Application Extensions (`21 FF`) — XMP, for one, rides in an
 * application block named `XMP DataXMP`. This walks every block and keeps only
 * what draws or animates the picture:
 *  - image descriptors (`2C`) with their local colour table and pixel data,
 *  - graphic-control extensions (`21 F9`), which carry frame delay, disposal
 *    and transparency, rebuilt from their four defined bytes,
 *  - the looping application block (`NETSCAPE2.0`, or its alias
 *    `ANIMEXTS1.0`), rebuilt from its loop count alone,
 * and drops every other extension block and anything after the trailer.
 *
 * The rebuilds matter: a kept block is re-emitted from the fields it defines,
 * not copied, so extra sub-blocks smuggled inside a kept extension cannot ride
 * through. Lossless — the pixel data is copied byte for byte — and a second
 * pass returns identical bytes.
 *
 * Fail-CLOSED: a truncated header or sub-block, an unknown block introducer,
 * a kept extension with a non-standard shape, or a walk that never reaches the
 * trailer returns `null`; the caller refuses the upload.
 */

const HEADER_BYTES = 13; // "GIF8xa" (6) + logical screen descriptor (7)
const IMAGE_DESCRIPTOR = 0x2c;
const EXTENSION = 0x21;
const TRAILER = 0x3b;
const GRAPHIC_CONTROL = 0xf9;
const APPLICATION = 0xff;
const LOOPING_APPLICATIONS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);

/** Thrown for any structural doubt; caught once, at the entry point. */
class MalformedGif extends Error {}

function byteAt(bytes: Buffer, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) throw new MalformedGif("truncated");
  return value;
}

function colourTableBytes(flags: number): number {
  return flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0;
}

/** Offset just past a sub-block chain's zero-length terminator. */
function endOfSubBlocks(bytes: Buffer, start: number): number {
  let offset = start;
  for (;;) {
    const length = byteAt(bytes, offset);
    offset += 1 + length;
    if (length === 0) return offset;
    if (offset > bytes.length) throw new MalformedGif("truncated sub-block");
  }
}

/**
 * The block to keep for an extension, rebuilt from its defined fields, or
 * `null` to drop it. Only the two extensions that affect drawing are kept.
 */
function keptExtension(bytes: Buffer, offset: number, end: number): Buffer | null {
  const label = byteAt(bytes, offset + 1);
  const firstLength = byteAt(bytes, offset + 2);
  if (label === GRAPHIC_CONTROL) {
    if (firstLength !== 4) throw new MalformedGif("graphic control size");
    return Buffer.concat([
      bytes.subarray(offset, offset + 7), // 21 F9 04 + flags, delay(2), transparent index
      Buffer.from([0]),
    ]);
  }
  if (label !== APPLICATION || firstLength !== 11) return null;
  const identifier = bytes.toString("latin1", offset + 3, offset + 14);
  if (!LOOPING_APPLICATIONS.has(identifier)) return null;
  // Looping block: one 3-byte data sub-block, 01 then the loop count (LE16).
  const dataStart = offset + 14;
  if (byteAt(bytes, dataStart) !== 3 || byteAt(bytes, dataStart + 1) !== 1) {
    throw new MalformedGif("looping block shape");
  }
  if (dataStart + 4 > end) throw new MalformedGif("truncated looping block");
  return Buffer.concat([
    bytes.subarray(offset, dataStart + 4),
    Buffer.from([0]),
  ]);
}

function walkGif(bytes: Buffer): Buffer {
  const version = bytes.toString("latin1", 0, 6);
  if (version !== "GIF87a" && version !== "GIF89a") throw new MalformedGif("signature");
  const screenFlags = byteAt(bytes, 10);
  let offset = HEADER_BYTES + colourTableBytes(screenFlags);
  if (offset > bytes.length) throw new MalformedGif("truncated colour table");
  const kept: Buffer[] = [bytes.subarray(0, offset)];

  for (;;) {
    const introducer = byteAt(bytes, offset);
    if (introducer === TRAILER) {
      kept.push(Buffer.from([TRAILER]));
      return Buffer.concat(kept);
    }
    if (introducer === IMAGE_DESCRIPTOR) {
      const imageFlags = byteAt(bytes, offset + 9);
      const lzwCodeSize = offset + 10 + colourTableBytes(imageFlags);
      byteAt(bytes, lzwCodeSize);
      const end = endOfSubBlocks(bytes, lzwCodeSize + 1);
      kept.push(bytes.subarray(offset, end));
      offset = end;
      continue;
    }
    if (introducer === EXTENSION) {
      byteAt(bytes, offset + 1);
      const end = endOfSubBlocks(bytes, offset + 2);
      const block = keptExtension(bytes, offset, end);
      if (block) kept.push(block);
      offset = end;
      continue;
    }
    throw new MalformedGif("unknown block");
  }
}

/**
 * The GIF with every comment, plain-text and non-looping application block
 * removed and anything after the trailer dropped, or `null` when the file's
 * structure cannot be walked with confidence.
 */
export function stripGifMetadata(bytes: Buffer): Buffer | null {
  try {
    return walkGif(bytes);
  } catch (error) {
    if (error instanceof MalformedGif || error instanceof RangeError) return null;
    throw error;
  }
}
