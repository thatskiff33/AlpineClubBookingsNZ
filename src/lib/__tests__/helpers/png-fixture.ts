import { crc32 } from "node:zlib";

/**
 * Structurally complete PNG fixtures (#5244). Every image-storing path refuses
 * an image its metadata strip cannot confirm clean, and the PNG strip confirms
 * only a chunk walk that reaches IEND — so a fixture must be a real chunk
 * sequence, not a signature plus filler.
 */

export function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MINIMUM_BYTES = 57; // signature, IHDR, an empty IDAT, IEND

/**
 * A `width`×`height` PNG of exactly `totalBytes` (at least 57), the extra
 * length carried in its IDAT chunk so the metadata strip keeps every byte.
 */
export function pngBytes(
  { width = 4, height = 4, totalBytes = MINIMUM_BYTES }: {
    width?: number;
    height?: number;
    totalBytes?: number;
  } = {},
): Buffer<ArrayBuffer> {
  const ihdr = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 8, 2, 0, 0, 0]);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  const idatData = Buffer.alloc(Math.max(0, totalBytes - MINIMUM_BYTES));
  const png = Buffer.concat([
    SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idatData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  // Copied into its own ArrayBuffer so it is a valid `File`/`Blob` part.
  const owned = Buffer.alloc(png.length);
  png.copy(owned);
  return owned;
}

export function pngDataUrl(options?: Parameters<typeof pngBytes>[0]): string {
  return `data:image/png;base64,${pngBytes(options).toString("base64")}`;
}
