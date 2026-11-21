/**
 * The one EXIF field an image keeps through hidden-data removal (#5244): its
 * Orientation (tag 0x0112). Phone cameras store a portrait photo as landscape
 * pixels plus "rotate 90°" in EXIF; dropping EXIF wholesale turns the photo
 * sideways. JPEG, PNG and WebP read it here before discarding EXIF and write
 * back a minimal EXIF block holding only that value — no camera, owner, date
 * or location.
 *
 * Both functions work on a bare TIFF structure (EXIF's encoding): what follows
 * `Exif\0\0` in a JPEG APP1 segment, the body of a PNG `eXIf` chunk or of a
 * WebP `EXIF` chunk.
 */

/** What precedes the TIFF data in a JPEG APP1 (and, from some writers, a WebP EXIF chunk). */
export const EXIF_APP1_PREFIX = "Exif\0\0";

const ORIENTATION_TAG = 0x0112;
const SHORT = 3;

/** The image's Orientation (2-8), or `null` for upright, absent or unreadable. */
export function readExifOrientation(tiff: Buffer): number | null {
  try {
    const order = tiff.toString("latin1", 0, 2);
    if (order !== "II" && order !== "MM") return null;
    const little = order === "II";
    const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
    const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
    if (u16(2) !== 42) return null;
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i += 1) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) !== ORIENTATION_TAG) continue;
      if (u16(entry + 2) !== SHORT || u32(entry + 4) !== 1) return null;
      const value = u16(entry + 8);
      return value >= 2 && value <= 8 ? value : null;
    }
    return null;
  } catch {
    return null; // out-of-range read: treat as no orientation
  }
}

/**
 * A big-endian TIFF structure holding one IFD with one entry: Orientation.
 * Always the same 26 bytes for a given value, so a second clean is identical.
 */
export function orientationOnlyExif(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 follows the header
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(ORIENTATION_TAG, 10);
  tiff.writeUInt16BE(SHORT, 12);
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18); // value, left-justified in its 4 bytes
  tiff.writeUInt32BE(0, 22); // no next IFD
  return tiff;
}
