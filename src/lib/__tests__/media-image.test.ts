import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { pngDataUrl } from "@/lib/__tests__/helpers/png-fixture";
import {
  ALLOWED_MEDIA_IMAGE_CONTENT_TYPES,
  MAX_MEDIA_IMAGE_BYTES,
  detectImageContentType,
  extractImageDimensions,
  mediaImageServingUrl,
  sanitiseMediaImageFilename,
  IMAGE_NOT_CLEAN_MESSAGE,
  cleanImageForStorage,
  storableLogoDataUrl,
  stripImageMetadata,
} from "@/lib/media-image";

function buildPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function buildGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function buildJpeg(width: number, height: number): Buffer {
  // SOI, then an SOF0 marker with a minimal frame header.
  const sof0 = Buffer.alloc(10);
  sof0.writeUInt8(0xff, 0);
  sof0.writeUInt8(0xc0, 1);
  sof0.writeUInt16BE(8, 2); // segment length (excluding marker bytes)
  sof0.writeUInt8(0x08, 4); // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0.writeUInt8(0, 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof0]);
}

function buildWebp(): Buffer {
  const buf = Buffer.alloc(12);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(4, 4);
  buf.write("WEBP", 8, "ascii");
  return buf;
}

function buildAvif(): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(0, 0);
  buf.write("ftyp", 4, "ascii");
  buf.write("avif", 8, "ascii");
  return buf;
}

const SVG_WITH_DIMENSIONS = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 240 160"><rect /></svg>',
  "utf8",
);

const SVG_WITH_VIEWBOX_ONLY = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"><rect /></svg>',
  "utf8",
);

const SVG_WITH_SCRIPT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  "utf8",
);

describe("detectImageContentType", () => {
  it("recognises a PNG signature", () => {
    expect(detectImageContentType(buildPng(10, 20))).toBe("image/png");
  });

  it("recognises a JPEG signature", () => {
    expect(detectImageContentType(buildJpeg(10, 20))).toBe("image/jpeg");
  });

  it("recognises GIF87a and GIF89a signatures", () => {
    expect(detectImageContentType(buildGif(10, 20))).toBe("image/gif");
    const gif87 = buildGif(10, 20);
    gif87.write("GIF87a", 0, "ascii");
    expect(detectImageContentType(gif87)).toBe("image/gif");
  });

  it("recognises a WebP RIFF/WEBP container", () => {
    expect(detectImageContentType(buildWebp())).toBe("image/webp");
  });

  it("recognises an AVIF ftyp box", () => {
    expect(detectImageContentType(buildAvif())).toBe("image/avif");
  });

  it("recognises an SVG root element, with or without an XML prolog", () => {
    expect(detectImageContentType(SVG_WITH_DIMENSIONS)).toBe("image/svg+xml");
    expect(detectImageContentType(SVG_WITH_VIEWBOX_ONLY)).toBe("image/svg+xml");
  });

  it("rejects an SVG-disguised script payload that is not actually an SVG", () => {
    expect(
      detectImageContentType(Buffer.from("<script>alert(1)</script>", "utf8")),
    ).toBeNull();
  });

  it("recognises an SVG preceded by a BOM and comments", () => {
    const withComments = Buffer.from(
      "﻿<!-- comment one -->\n<!-- comment two -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect /></svg>",
      "utf8",
    );
    expect(detectImageContentType(withComments)).toBe("image/svg+xml");
  });

  it("does not hang on many unterminated comment markers (ReDoS guard)", () => {
    const adversarial = Buffer.from("<!--".repeat(2000), "utf8");
    // Monotonic, not `Date.now()`: #2481 freezes `Date` for every test file, so
    // a `Date.now()` stopwatch would make this ReDoS guard a permanent
    // `0 < 100` — green even while an attacker-supplied upload burns CPU.
    const start = process.hrtime.bigint();
    expect(detectImageContentType(adversarial)).toBeNull();
    expect(realElapsedMs(start)).toBeLessThan(100);
  });

  it("rejects unrecognised content even if the declared type claims to be an image", () => {
    expect(detectImageContentType(Buffer.from("not an image", "utf8"))).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(detectImageContentType(Buffer.alloc(0))).toBeNull();
  });

  it("every detectable type is in the allowlist", () => {
    for (const type of [
      detectImageContentType(buildPng(1, 1)),
      detectImageContentType(buildJpeg(1, 1)),
      detectImageContentType(buildGif(1, 1)),
      detectImageContentType(buildWebp()),
      detectImageContentType(buildAvif()),
      detectImageContentType(SVG_WITH_DIMENSIONS),
    ]) {
      expect(type).not.toBeNull();
      expect(ALLOWED_MEDIA_IMAGE_CONTENT_TYPES).toContain(type);
    }
  });
});

describe("extractImageDimensions", () => {
  it("reads width/height from a PNG IHDR chunk", () => {
    expect(extractImageDimensions(buildPng(640, 480), "image/png")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads width/height from a GIF header", () => {
    expect(extractImageDimensions(buildGif(320, 240), "image/gif")).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("reads width/height from a JPEG SOF0 marker", () => {
    expect(extractImageDimensions(buildJpeg(800, 600), "image/jpeg")).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("reads width/height attributes from an SVG root element", () => {
    expect(
      extractImageDimensions(SVG_WITH_DIMENSIONS, "image/svg+xml"),
    ).toEqual({ width: 120, height: 80 });
  });

  it("falls back to viewBox dimensions when width/height attributes are absent", () => {
    expect(
      extractImageDimensions(SVG_WITH_VIEWBOX_ONLY, "image/svg+xml"),
    ).toEqual({ width: 300, height: 150 });
  });

  it("returns null for formats without a cheap dimension reader", () => {
    expect(extractImageDimensions(buildWebp(), "image/webp")).toBeNull();
    expect(extractImageDimensions(buildAvif(), "image/avif")).toBeNull();
  });

  it("returns null when an SVG has no width/height or viewBox", () => {
    expect(extractImageDimensions(SVG_WITH_SCRIPT, "image/svg+xml")).toBeNull();
  });
});

describe("sanitiseMediaImageFilename", () => {
  it("strips directory components", () => {
    expect(sanitiseMediaImageFilename("../../etc/passwd.png")).toBe(
      "passwd.png",
    );
    expect(sanitiseMediaImageFilename("C:\\Users\\me\\photo.jpg")).toBe(
      "photo.jpg",
    );
  });

  it("replaces unsafe characters", () => {
    expect(sanitiseMediaImageFilename("my photo (1)!.png")).toBe(
      "my_photo_1_.png",
    );
  });

  it("falls back to a default name when nothing safe remains", () => {
    expect(sanitiseMediaImageFilename("???")).toBe("upload");
  });

  it("truncates very long filenames", () => {
    const longName = `${"a".repeat(300)}.png`;
    expect(sanitiseMediaImageFilename(longName).length).toBeLessThanOrEqual(200);
  });
});

describe("mediaImageServingUrl", () => {
  it("builds the public serving path", () => {
    expect(mediaImageServingUrl("abc123")).toBe("/api/images/abc123");
  });
});

describe("MAX_MEDIA_IMAGE_BYTES", () => {
  it("is 2MB", () => {
    expect(MAX_MEDIA_IMAGE_BYTES).toBe(2 * 1024 * 1024);
  });
});

// ─── WebP dimension parsing (decode-bomb backstop, review #7) ────────────────

function buildWebpVp8x(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10); // 4 flags/reserved + 3 (w-1) + 3 (h-1), LE
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  const buf = Buffer.alloc(20 + payload.length);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(4 + 8 + payload.length, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(payload.length, 16);
  payload.copy(buf, 20);
  return buf;
}

describe("extractImageDimensions — WebP (VP8X)", () => {
  it("parses the canvas dimensions from a VP8X chunk", () => {
    expect(extractImageDimensions(buildWebpVp8x(1024, 768), "image/webp")).toEqual(
      { width: 1024, height: 768 },
    );
  });

  it("reads an oversized canvas so the caller's backstop can reject it", () => {
    expect(
      extractImageDimensions(buildWebpVp8x(16384, 16384), "image/webp"),
    ).toEqual({ width: 16384, height: 16384 });
  });
});

// ─── Metadata stripping (privacy, review #6) ─────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); // stripper does not validate the CRC
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
}

function webpChunk(fourCC: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourCC, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}

function jpegAppSegment(marker: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}

const JPEG_SOF0 = (() => {
  const s = Buffer.alloc(11);
  s.writeUInt8(0xff, 0);
  s.writeUInt8(0xc0, 1);
  s.writeUInt16BE(9, 2);
  s.writeUInt8(8, 4);
  s.writeUInt16BE(16, 5); // height
  s.writeUInt16BE(16, 7); // width
  s.writeUInt8(1, 9);
  return s;
})();
const JPEG_SOS_EOI = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9]);

const SECRET = "GPS:-41.29,174.78";

describe("stripImageMetadata", () => {
  it("removes the EXIF APP1 segment from a JPEG but keeps the frame (ok:true)", () => {
    const soi = Buffer.from([0xff, 0xd8]);
    const exifPayload = Buffer.from(`Exif\0\0${SECRET}`, "latin1");
    const app1Len = Buffer.alloc(2);
    app1Len.writeUInt16BE(exifPayload.length + 2, 0);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), app1Len, exifPayload]);
    const sof0 = (() => {
      const s = Buffer.alloc(11);
      s.writeUInt8(0xff, 0);
      s.writeUInt8(0xc0, 1);
      s.writeUInt16BE(9, 2);
      s.writeUInt8(8, 4);
      s.writeUInt16BE(16, 5); // height
      s.writeUInt16BE(16, 7); // width
      s.writeUInt8(1, 9);
      return s;
    })();
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9]);
    const jpeg = Buffer.concat([soi, app1, sof0, sos]);

    const result = stripImageMetadata(jpeg, "image/jpeg");
    expect(result.ok).toBe(true);
    const stripped = result.bytes;

    expect(stripped.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(stripped.length).toBeLessThan(jpeg.length);
    // Still a JPEG whose dimensions survive.
    expect(stripped[0]).toBe(0xff);
    expect(stripped[1]).toBe(0xd8);
    expect(extractImageDimensions(stripped, "image/jpeg")).toEqual({
      width: 16,
      height: 16,
    });
  });

  it("strips a valid JPEG carrying EXIF/GPS to ok:true with the GPS gone", () => {
    // A structurally clean, EOI-terminated JPEG whose only extra segment is an
    // EXIF APP1 carrying GPS. The confirmed-clean (ok:true) path must remove it.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0xe1, Buffer.from(`Exif\0\0${SECRET}`, "latin1")),
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);

    const result = stripImageMetadata(jpeg, "image/jpeg");

    expect(result.ok).toBe(true);
    expect(result.bytes.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(extractImageDimensions(result.bytes, "image/jpeg")).toEqual({
      width: 16,
      height: 16,
    });
  });

  it("rejects (ok:false) a renderable JPEG whose trailing FF D9 EOI is removed, leaving bytes unchanged", () => {
    // THE core regression guard for the fail-open leak: a JPEG that still sniffs
    // as image/jpeg, still parses a frame, still renders in a browser — but has
    // NO primary EOI. The old code returned it unchanged (EXIF/GPS intact) and
    // the route stored & served it. Fail-closed: ok:false, original bytes back.
    const withEoi = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0xe1, Buffer.from(`Exif\0\0${SECRET}`, "latin1")),
      JPEG_SOF0,
      JPEG_SOS_EOI, // ...ends 0xff 0xd9
    ]);
    // Drop the trailing EOI marker (last two bytes: FF D9).
    const noEoi = withEoi.subarray(0, withEoi.length - 2);

    const result = stripImageMetadata(noEoi, "image/jpeg");

    expect(result.ok).toBe(false);
    // Bytes handed back unchanged (route rejects, so they are never stored).
    expect(result.bytes.equals(noEoi)).toBe(true);
    expect(result.bytes.includes(Buffer.from(SECRET, "latin1"))).toBe(true);
  });

  it("rejects (ok:false) non-image garbage", () => {
    const garbage = Buffer.from("this is not an image at all", "utf8");
    const result = stripImageMetadata(garbage, "image/jpeg");
    expect(result.ok).toBe(false);
    expect(result.bytes.equals(garbage)).toBe(true);
  });

  it("removes eXIf and tEXt chunks from a PNG, keeping critical chunks (ok:true)", () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(16, 0);
    ihdrData.writeUInt32BE(16, 4);
    const png = Buffer.concat([
      sig,
      pngChunk("IHDR", ihdrData),
      pngChunk("eXIf", Buffer.from(SECRET, "latin1")),
      pngChunk("tEXt", Buffer.from(`Comment\0${SECRET}`, "latin1")),
      pngChunk("IDAT", Buffer.from([0x00])),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);

    const result = stripImageMetadata(png, "image/png");
    expect(result.ok).toBe(true);
    const stripped = result.bytes;

    expect(stripped.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(stripped.includes(Buffer.from("IHDR", "ascii"))).toBe(true);
    expect(stripped.includes(Buffer.from("IDAT", "ascii"))).toBe(true);
    expect(stripped.includes(Buffer.from("IEND", "ascii"))).toBe(true);
    expect(stripped.includes(Buffer.from("eXIf", "ascii"))).toBe(false);
  });

  it("rejects (ok:false) a PNG with no IEND (truncated), leaving bytes unchanged", () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(16, 0);
    ihdrData.writeUInt32BE(16, 4);
    // IHDR + a metadata chunk carrying GPS, then EOF — no IEND terminator.
    const png = Buffer.concat([
      sig,
      pngChunk("IHDR", ihdrData),
      pngChunk("eXIf", Buffer.from(SECRET, "latin1")),
    ]);

    const result = stripImageMetadata(png, "image/png");

    expect(result.ok).toBe(false);
    expect(result.bytes.equals(png)).toBe(true);
  });

  it("removes the EXIF chunk from a WebP RIFF container (ok:true)", () => {
    const body = Buffer.concat([
      webpChunk("VP8L", Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00])),
      webpChunk("EXIF", Buffer.from(SECRET, "latin1")),
    ]);
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      (() => {
        const s = Buffer.alloc(4);
        s.writeUInt32LE(4 + body.length, 0);
        return s;
      })(),
      Buffer.from("WEBP", "ascii"),
      body,
    ]);

    const result = stripImageMetadata(webp, "image/webp");
    expect(result.ok).toBe(true);
    const stripped = result.bytes;

    expect(stripped.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(stripped.toString("ascii", 0, 4)).toBe("RIFF");
    expect(stripped.toString("ascii", 8, 12)).toBe("WEBP");
    expect(stripped.includes(Buffer.from("VP8L", "ascii"))).toBe(true);
    // RIFF size header is recomputed to match the shortened body.
    expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8);
  });

  it("returns ok:true for a clean WebP with no EXIF/XMP (nothing to strip)", () => {
    // A well-formed RIFF/WEBP with a single VP8L chunk and no metadata: the walk
    // completes cleanly to EOF, so the confirmed-clean path returns ok:true and
    // the original bytes (nothing was changed).
    const body = webpChunk("VP8L", Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]));
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      (() => {
        const s = Buffer.alloc(4);
        s.writeUInt32LE(4 + body.length, 0);
        return s;
      })(),
      Buffer.from("WEBP", "ascii"),
      body,
    ]);

    const result = stripImageMetadata(webp, "image/webp");

    expect(result.ok).toBe(true);
    expect(result.bytes.equals(webp)).toBe(true);
  });

  it("rejects (ok:false) a malformed WebP whose non-final chunk overruns EOF", () => {
    // A VP8L chunk that declares a size far larger than the bytes present, with
    // more (would-be) chunks implied after it: the overrun is not the tolerated
    // final-odd-pad case, so it is genuinely malformed → reject.
    const header = Buffer.alloc(8);
    header.write("VP8L", 0, "ascii");
    header.writeUInt32LE(999, 4); // claims 999 payload bytes that don't exist
    const body = Buffer.concat([header, Buffer.from([0x2f, 0x00])]);
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      (() => {
        const s = Buffer.alloc(4);
        s.writeUInt32LE(4 + body.length, 0);
        return s;
      })(),
      Buffer.from("WEBP", "ascii"),
      body,
    ]);

    const result = stripImageMetadata(webp, "image/webp");

    expect(result.ok).toBe(false);
    expect(result.bytes.equals(webp)).toBe(true);
  });

  it("drops APP13 IPTC (and any non-colour APPn) while preserving JFIF/ICC (allow-list, ok:true)", () => {
    const iptcSecret = "IPTC-HOME-42-BAKER-ST";
    const soi = Buffer.from([0xff, 0xd8]);
    const app0Jfif = jpegAppSegment(
      0xe0,
      Buffer.from("JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00", "latin1"),
    ); // colour/structural — must be kept
    const app13Iptc = jpegAppSegment(
      0xed,
      Buffer.from(`Photoshop 3.0\0${iptcSecret}`, "latin1"),
    ); // IPTC — must be dropped
    const app2Icc = jpegAppSegment(0xe2, Buffer.from("ICC_PROFILE\0keep-colour")); // kept
    const jpeg = Buffer.concat([
      soi,
      app0Jfif,
      app13Iptc,
      app2Icc,
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);

    const result = stripImageMetadata(jpeg, "image/jpeg");
    expect(result.ok).toBe(true);
    const stripped = result.bytes;

    // IPTC PII gone; JFIF and ICC colour segments preserved; frame intact.
    expect(stripped.includes(Buffer.from(iptcSecret, "latin1"))).toBe(false);
    expect(stripped.includes(Buffer.from("JFIF", "latin1"))).toBe(true);
    expect(stripped.includes(Buffer.from("ICC_PROFILE", "latin1"))).toBe(true);
    expect(stripped.includes(Buffer.from("Photoshop", "latin1"))).toBe(false);
    expect(extractImageDimensions(stripped, "image/jpeg")).toEqual({
      width: 16,
      height: 16,
    });
  });

  it("strips a trailing WebP EXIF chunk even when it omits its RIFF pad byte (ok:true)", () => {
    // Final EXIF chunk with an odd payload length and NO pad byte (built by hand
    // — webpChunk would add the pad).
    const exifData = Buffer.from(SECRET, "latin1"); // odd length
    const exifHeader = Buffer.alloc(8);
    exifHeader.write("EXIF", 0, "ascii");
    exifHeader.writeUInt32LE(exifData.length, 4);
    const exifNoPad = Buffer.concat([exifHeader, exifData]);
    const body = Buffer.concat([
      webpChunk("VP8L", Buffer.from([0x2f, 0x00, 0x00, 0x00])),
      exifNoPad,
    ]);
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      (() => {
        const s = Buffer.alloc(4);
        s.writeUInt32LE(4 + body.length, 0);
        return s;
      })(),
      Buffer.from("WEBP", "ascii"),
      body,
    ]);

    const result = stripImageMetadata(webp, "image/webp");
    expect(result.ok).toBe(true);
    const stripped = result.bytes;

    expect(stripped.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(stripped.toString("ascii", 8, 12)).toBe("WEBP");
    expect(stripped.includes(Buffer.from("VP8L", "ascii"))).toBe(true);
  });

  it("truncates at the primary EOI, dropping an appended MPF/motion-photo image and its EXIF (ok:true)", () => {
    const gps1 = "GPS-PRIMARY-41.29";
    const gps2 = "GPS-SECONDARY-41.29";
    const oneJpeg = (gps: string) =>
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        jpegAppSegment(0xe1, Buffer.from(`Exif\0\0${gps}`, "latin1")),
        JPEG_SOF0,
        JPEG_SOS_EOI,
      ]);
    // Primary image + an appended secondary image (as MPF / motion-photo JPEGs do).
    const mpf = Buffer.concat([oneJpeg(gps1), oneJpeg(gps2)]);

    const result = stripImageMetadata(mpf, "image/jpeg");
    expect(result.ok).toBe(true);
    const stripped = result.bytes;

    // Primary EXIF stripped AND the appended secondary image (with its own GPS)
    // dropped entirely by truncating at the primary EOI.
    expect(stripped.includes(Buffer.from(gps1, "latin1"))).toBe(false);
    expect(stripped.includes(Buffer.from(gps2, "latin1"))).toBe(false);
    expect(stripped[stripped.length - 2]).toBe(0xff);
    expect(stripped[stripped.length - 1]).toBe(0xd9);
    expect(extractImageDimensions(stripped, "image/jpeg")).toEqual({
      width: 16,
      height: 16,
    });
  });

  it("drops a non-ICC APP2 (MPF index) while keeping an ICC-profile APP2 (ok:true)", () => {
    const mpfSecret = "MPF-POINTS-AT-SECONDARY";
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0xe2, Buffer.from(`MPF\0${mpfSecret}`, "latin1")), // drop
      jpegAppSegment(0xe2, Buffer.from("ICC_PROFILE\0colour-data", "latin1")), // keep
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);

    const result = stripImageMetadata(jpeg, "image/jpeg");
    expect(result.ok).toBe(true);
    const stripped = result.bytes;

    expect(stripped.includes(Buffer.from(mpfSecret, "latin1"))).toBe(false);
    expect(stripped.includes(Buffer.from("ICC_PROFILE", "latin1"))).toBe(true);
  });

  it("rejects (ok:false) a malformed JPEG, leaving bytes unchanged", () => {
    const garbage = Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56]);
    const result = stripImageMetadata(garbage, "image/jpeg");
    expect(result.ok).toBe(false);
    expect(result.bytes.equals(garbage)).toBe(true);
  });

  it("accepts 0xFF fill bytes before a marker and drops them (ok:true)", () => {
    // T.81 §B.1.1.2 allows any number of 0xFF fill bytes before a marker. The
    // parser used to refuse them — the false refusal that once justified storing
    // unconfirmed images unchanged.
    const fill = Buffer.from([0xff, 0xff, 0xff]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      fill,
      jpegAppSegment(0xe1, Buffer.from(`Exif\0\0${SECRET}`, "latin1")),
      fill,
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);

    const result = stripImageMetadata(jpeg, "image/jpeg");

    expect(result.ok).toBe(true);
    expect(result.bytes.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(result.bytes.equals(Buffer.concat([Buffer.from([0xff, 0xd8]), JPEG_SOF0, JPEG_SOS_EOI]))).toBe(true);
  });

  // A phone stores a portrait as landscape pixels plus EXIF Orientation; losing
  // it turns the photo sideways. Each format keeps the Orientation alone.
  it.each(["jpeg", "png", "webp"] as const)(
    "keeps the EXIF Orientation of a %s and nothing else from its EXIF",
    async (format) => {
      const photo = await sharp({ create: { width: 6, height: 4, channels: 3, background: "red" } })
        .withMetadata({ orientation: 6, exif: { IFD0: { Artist: "OWNERNAME", Make: "SECRETCAM" } } })
        .toFormat(format)
        .toBuffer();
      expect((await sharp(photo).metadata()).orientation).toBe(6);

      const result = stripImageMetadata(photo, `image/${format}`);

      expect(result.ok).toBe(true);
      const text = result.bytes.toString("latin1");
      expect(text).not.toContain("OWNERNAME");
      expect(text).not.toContain("SECRETCAM");
      const meta = await sharp(result.bytes).metadata();
      expect(meta.orientation).toBe(6);
      expect(meta.autoOrient).toEqual({ width: 4, height: 6 });
    },
  );

  it.each(["jpeg", "png", "webp"] as const)(
    "drops EXIF entirely from an upright %s",
    async (format) => {
      const photo = await sharp({ create: { width: 6, height: 4, channels: 3, background: "red" } })
        .withExif({ IFD0: { Artist: "OWNERNAME" } })
        .toFormat(format)
        .toBuffer();

      const result = stripImageMetadata(photo, `image/${format}`);

      expect(result.ok).toBe(true);
      expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    },
  );

  it.each(["jpeg", "png", "webp"] as const)(
    "returns identical bytes on a second pass over a %s",
    async (format) => {
      const photo = await sharp({ create: { width: 6, height: 4, channels: 3, background: "red" } })
        .withMetadata({ orientation: 8, exif: { IFD0: { Artist: "OWNERNAME" } } })
        .toFormat(format)
        .toBuffer();
      const once = stripImageMetadata(photo, `image/${format}`);
      expect(once.ok).toBe(true);

      const twice = stripImageMetadata(once.bytes, `image/${format}`);

      expect(twice.ok).toBe(true);
      expect(twice.bytes.equals(once.bytes)).toBe(true);
    },
  );

  // Keep-lists, not deny-lists: a metadata chunk nobody has named yet, such as
  // Content Credentials (C2PA), is removed without being listed.
  it("drops an unlisted PNG metadata chunk and refuses an unknown critical one", () => {
    const ihdr = Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0]);
    const png = (extra: Buffer) => Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      extra,
      pngChunk("IDAT", Buffer.from([0x00])),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);

    const credentials = stripImageMetadata(png(pngChunk("caBX", Buffer.from(SECRET))), "image/png");
    expect(credentials.ok).toBe(true);
    expect(credentials.bytes.includes(Buffer.from(SECRET))).toBe(false);
    expect(stripImageMetadata(png(pngChunk("ZZZZ", Buffer.from("x"))), "image/png").ok).toBe(false);
  });

  it("drops an unlisted WebP chunk, at the top level and inside an animation frame", async () => {
    const frame = (colour: string) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background: colour } }).raw().toBuffer();
    const animated = await sharp(Buffer.concat([await frame("red"), await frame("blue")]), {
      raw: { width: 8, height: 16, channels: 3, pageHeight: 8 },
    }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    // A C2PA chunk at the top level, and an unknown chunk inside the first frame.
    const anmf = animated.indexOf("ANMF", 12, "ascii");
    const size = animated.readUInt32LE(anmf + 4);
    const smuggled = webpChunk("XYZW", Buffer.from(SECRET));
    const grownFrame = Buffer.concat([
      Buffer.from("ANMF", "ascii"),
      Buffer.alloc(4),
      animated.subarray(anmf + 8, anmf + 8 + size),
      smuggled,
    ]);
    grownFrame.writeUInt32LE(size + smuggled.length, 4);
    const body = Buffer.concat([
      animated.subarray(12, anmf),
      grownFrame,
      animated.subarray(anmf + 8 + size),
      webpChunk("C2PA", Buffer.from(`author=${SECRET}`)),
    ]);
    const header = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
    header.writeUInt32LE(4 + body.length, 4);

    const result = stripImageMetadata(Buffer.concat([header, body]), "image/webp");

    expect(result.ok).toBe(true);
    expect(result.bytes.includes(Buffer.from(SECRET))).toBe(false);
    expect(result.bytes.equals(animated)).toBe(true);
    expect((await sharp(result.bytes, { animated: true }).metadata()).pages).toBe(2);
  });

  it("rebuilds JFIF without its thumbnail and refuses a reserved marker", () => {
    const thumbnail = Buffer.concat([
      Buffer.from("JFIF\0\x01\x01\x00\x00\x01\x00\x01\x02\x01", "latin1"),
      Buffer.from(SECRET.slice(0, 6), "latin1"), // a 2x1 RGB thumbnail
    ]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0xe0, thumbnail),
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);

    const result = stripImageMetadata(jpeg, "image/jpeg");

    expect(result.ok).toBe(true);
    expect(result.bytes.includes(Buffer.from(SECRET.slice(0, 6), "latin1"))).toBe(false);
    expect(result.bytes.subarray(2, 20)).toEqual(Buffer.concat([
      Buffer.from([0xff, 0xe0, 0x00, 0x10]),
      Buffer.from("JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00", "latin1"),
    ]));
    const reserved = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0xf7, Buffer.from(SECRET)),
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);
    expect(stripImageMetadata(reserved, "image/jpeg").ok).toBe(false);
    const lowReserved = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0x02, Buffer.from(SECRET)),
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);
    expect(stripImageMetadata(lowReserved, "image/jpeg").ok).toBe(false);
  });

  it("keeps only the defined bytes of an Adobe segment", () => {
    const adobe = Buffer.from("Adobe\x00\x64\x00\x00\x00\x00\x01", "latin1");
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0xee, Buffer.concat([adobe, Buffer.from(SECRET)])),
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);

    const result = stripImageMetadata(jpeg, "image/jpeg");

    expect(result.ok).toBe(true);
    expect(result.bytes.includes(Buffer.from(SECRET))).toBe(false);
    expect(result.bytes.includes(adobe)).toBe(true);
  });

  it("covers every allowed content type and refuses garbage for each", () => {
    // A new entry in ALLOWED_MEDIA_IMAGE_CONTENT_TYPES must get a cleaner (the
    // switch is exhaustive); garbage is never reported clean, never thrown.
    for (const contentType of ALLOWED_MEDIA_IMAGE_CONTENT_TYPES) {
      const garbage = Buffer.from("not-an-image");
      const result = stripImageMetadata(garbage, contentType);
      expect(result.ok, contentType).toBe(false);
      expect(result.bytes.equals(garbage)).toBe(true);
    }
  });
});

describe("cleanImageForStorage (every image-storing path, #5244)", () => {
  const GPS = Buffer.from("GPS:-41.29,174.78", "latin1");

  it("returns the CLEANED bytes when the strip is confirmed", () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), GPS])),
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);

    const result = cleanImageForStorage(jpeg, "image/jpeg");

    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes.includes(GPS)).toBe(false);
  });

  it("FAILS CLOSED: refuses with the plain message when the strip is unconfirmed", () => {
    // No primary EOI → the parser cannot confirm a clean walk. Nothing is
    // stored; the uploader is told why and what to do.
    const noEoi = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegAppSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), GPS])),
      JPEG_SOF0,
    ]);

    expect(cleanImageForStorage(noEoi, "image/jpeg")).toEqual({
      ok: false,
      message: IMAGE_NOT_CLEAN_MESSAGE,
    });
  });

  it("refuses bytes whose type could not be sniffed", () => {
    expect(cleanImageForStorage(Buffer.from("not-an-image-at-all"), null)).toEqual({
      ok: false,
      message: IMAGE_NOT_CLEAN_MESSAGE,
    });
  });
});

describe("storableLogoDataUrl (inline club logo, #2242, #5244)", () => {
  const GPS = Buffer.from("GPS:-41.29,174.78", "latin1");

  function dataUrl(type: string, bytes: Buffer): string {
    return `data:${type};base64,${bytes.toString("base64")}`;
  }

  /** A minimal JPEG carrying EXIF/GPS, terminated so the strip is confirmable. */
  const EXIF_JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegAppSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), GPS])),
    JPEG_SOF0,
    JPEG_SOS_EOI,
  ]);

  function storedValue(value: string | null | undefined): string | null {
    const result = storableLogoDataUrl(value);
    if (!result.ok) throw new Error(`refused: ${result.message}`);
    return result.value;
  }

  it("strips EXIF/GPS from an inline logo and keeps the declared media type", () => {
    // ClubTheme.logoDataUrl renders inline in the public header, footer and
    // mobile menu, so an unstripped phone photo would publish its coordinates on
    // every public page.
    const before = dataUrl("image/jpeg", EXIF_JPEG);

    const after = storedValue(before);

    expect(after).toMatch(/^data:image\/jpeg;base64,/);
    const decoded = Buffer.from((after as string).split(",")[1], "base64");
    expect(decoded.includes(GPS)).toBe(false);
    // Still a JPEG: the strip is byte surgery, never a re-encode.
    expect(detectImageContentType(decoded)).toBe("image/jpeg");
  });

  it("is idempotent, so re-saving or re-importing converges", () => {
    const once = storedValue(dataUrl("image/jpeg", EXIF_JPEG));
    expect(storedValue(once)).toBe(once);
  });

  it("returns the ORIGINAL string byte for byte when nothing was removed", () => {
    // Anything else would churn the stored value on every save, and would turn
    // an "unchanged" config-transfer dry-run into a spurious update.
    const clean = pngDataUrl();
    expect(storedValue(clean)).toBe(clean);
  });

  it("passes an absent logo through as no logo", () => {
    expect(storedValue(null)).toBeNull();
    expect(storedValue(undefined)).toBeNull();
    expect(storedValue("")).toBeNull();
  });

  it.each([
    ["an unsniffable payload", "data:image/png;base64,AAAA"],
    ["a JPEG the parser cannot confirm", dataUrl(
      "image/jpeg",
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        jpegAppSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), GPS])),
        JPEG_SOF0,
      ]),
    )],
    ["a value that is not a base64 data URI", "https://example.test/logo.png"],
  ])("refuses %s with the plain message", (_label, value) => {
    expect(storableLogoDataUrl(value)).toEqual({ ok: false, message: IMAGE_NOT_CLEAN_MESSAGE });
  });
});
