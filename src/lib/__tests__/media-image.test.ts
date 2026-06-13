import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ALLOWED_MEDIA_IMAGE_CONTENT_TYPES,
  MAX_MEDIA_IMAGE_BYTES,
  detectImageContentType,
  extractImageDimensions,
  mediaImageServingUrl,
  sanitiseMediaImageFilename,
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
    const start = Date.now();
    expect(detectImageContentType(adversarial)).toBeNull();
    expect(Date.now() - start).toBeLessThan(100);
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
