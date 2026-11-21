import { must } from "@/lib/indexed-access";
import {
  EXIF_APP1_PREFIX,
  orientationOnlyExif,
  readExifOrientation,
} from "@/lib/image-metadata-exif";

/**
 * Hidden-data removal for JPEG images, behind `stripImageMetadata` in
 * `@/lib/image-metadata` (#2242; #5244 split it out, made it keep the EXIF
 * Orientation and accept `FF` fill bytes before a marker). Returns the cleaned
 * bytes, or `null` when the structure cannot be walked with confidence, and the
 * caller refuses the upload.
 */

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
 * fill bytes before a marker are accepted and dropped. Fail-CLOSED: bytes come back
 * ONLY on the primary-EOI-terminated path; any malformed/nonstandard structure
 * returns `null` so the caller refuses the upload.
 */
export function stripJpegMetadata(bytes: Buffer): Buffer | null {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return null;
  const kept: Buffer[] = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;
  let orientationWritten = false;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null; // not at a marker
    // Any run of 0xFF fill bytes may precede a marker (T.81 §B.1.1.2); skip
    // to the last one, dropping the padding.
    while (offset + 2 < bytes.length && bytes[offset + 1] === 0xff) offset += 1;
    const marker = must(bytes[offset + 1], "stripJpegMetadata: offset within bytes.length");

    if (marker === 0xd9) {
      // Primary EOI: end of the primary image. Emit it and STOP, dropping any
      // appended trailer (MPF / motion-photo secondary image + its EXIF/GPS).
      // This is the ONLY confirmed-clean exit.
      kept.push(bytes.subarray(offset, offset + 2));
      return Buffer.concat(kept);
    }

    if (marker === 0xda) {
      // Start of scan: copy the SOS header + entropy-coded data up to the next
      // real marker (an 0xff not part of 0xff00 byte-stuffing or an RSTn
      // 0xd0-0xd7), then continue so a following EOI truncates any trailer and a
      // following scan (progressive JPEG) is handled normally.
      if (offset + 4 > bytes.length) return null;
      const sosLen = bytes.readUInt16BE(offset + 2);
      let scan = offset + 2 + sosLen;
      if (scan > bytes.length) return null;
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

    // Markers with no length, or reserved for extensions this does not walk,
    // cannot be stepped over safely outside a scan: refuse rather than guess.
    if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd8) || (marker >= 0xf0 && marker <= 0xfd)) {
      return null;
    }

    // Length-prefixed marker segment (APPn, COM, DQT, DHT, SOFn, DRI, …).
    if (offset + 4 > bytes.length) return null;
    const segLen = bytes.readUInt16BE(offset + 2);
    const segEnd = offset + 2 + segLen;
    if (segLen < 2 || segEnd > bytes.length) return null; // truncated/invalid
    // Allow-list, not deny-list: metadata lives across many APPn markers (APP1
    // EXIF/XMP, APP13 IPTC/Photoshop, APP12 Ducky, vendor APP3-APP11), any of
    // which can carry creator contact info, location or GPS. Preserve ONLY the
    // colour/rendering segments — APP0 (JFIF) and APP14 (Adobe), both rebuilt
    // from their defined bytes, and an APP2 that is an ICC profile (identified by its "ICC_PROFILE\0" tag, so the MPF index
    // APP2 that points at appended images is NOT kept) — and drop every other
    // APPn and every COM comment. Structural markers (DQT, DHT, SOFn, DRI, …)
    // are not APPn/COM and are always kept.
    const isAppSegment = marker >= 0xe0 && marker <= 0xef;
    const tag = (text: string) => bytes.toString("latin1", offset + 4, offset + 4 + text.length) === text;
    const isJfif = marker === 0xe0 && segLen >= 16 && tag("JFIF\0");
    const isAdobe = marker === 0xee && segLen >= 14 && tag("Adobe");
    const isIccApp2 = marker === 0xe2 && tag("ICC_PROFILE\0");
    const drop =
      (isAppSegment && !isJfif && !isAdobe && !isIccApp2) || marker === 0xfe; // COM
    if (isJfif) {
      // JFIF without its optional thumbnail, which can show the uncropped
      // original: the 14 defined bytes with a 0x0 thumbnail.
      kept.push(Buffer.concat([
        Buffer.from([0xff, 0xe0, 0x00, 0x10]),
        bytes.subarray(offset + 4, offset + 16),
        Buffer.from([0x00, 0x00]),
      ]));
    } else if (isAdobe) {
      // Adobe's 12 defined bytes (tag, version, flags, colour transform) only.
      kept.push(Buffer.concat([
        Buffer.from([0xff, 0xee, 0x00, 0x0e]),
        bytes.subarray(offset + 4, offset + 16),
      ]));
    } else if (!drop) {
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
  return null; // no primary EOI found → reject (fail-closed)
}

function jpegOrientationSegment(orientation: number): Buffer {
  const tiff = orientationOnlyExif(orientation);
  const header = Buffer.alloc(4 + EXIF_APP1_PREFIX.length);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(2 + EXIF_APP1_PREFIX.length + tiff.length, 2);
  header.write(EXIF_APP1_PREFIX, 4, "latin1");
  return Buffer.concat([header, tiff]);
}
