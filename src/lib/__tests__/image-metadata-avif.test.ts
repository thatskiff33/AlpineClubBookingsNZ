import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { cleanImageForStorage, stripImageMetadata } from "@/lib/image-metadata";

// #5244: an AVIF's EXIF (with GPS) and XMP items, and anything else that is
// not the picture, are blanked in place; the decoded picture is unchanged.

const SECRETS = ["SECRETCAM", "Jane Member", "HOMEADDRESS", "XMPOWNERNAME"];

async function avifWithMetadata(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 40, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.6 } },
  })
    .withExif({
      IFD0: { Make: "SECRETCAM", Artist: "Jane Member", Copyright: "HOMEADDRESS" },
      IFD3: { GPSLatitudeRef: "S", GPSLatitude: "39/1 16/1 3/1" },
    })
    .withXmp(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
        '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>XMPOWNERNAME</dc:creator>' +
        "</rdf:Description></rdf:RDF></x:xmpmeta>",
    )
    .avif({ quality: 60 })
    .toBuffer();
}

function strip(bytes: Buffer): Buffer {
  const result = stripImageMetadata(bytes, "image/avif");
  if (!result.ok) throw new Error("expected a confirmed strip");
  return result.bytes;
}

// #5360: the grid-of-tiles layout. Every other case here is the single-picture
// file sharp writes, with a version 0 location table and everything in `mdat`.
// This one is assembled box by box so the layout is exactly the one named.

type ByteRange = readonly [start: number, end: number];

const u8 = (...values: number[]): Buffer => Buffer.from(values);
function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}
function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

/** One container box: a 32-bit size, a four-letter type, then its body. */
function box(type: string, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body);
  return Buffer.concat([u32(content.length + 8), Buffer.from(type, "latin1"), content]);
}

/** A box whose body opens with a version byte and three flag bytes. */
function fullBox(type: string, version: number, ...body: Buffer[]): Buffer {
  return box(type, u8(version, 0, 0, 0), ...body);
}

/** The body of the first `type` box among the boxes in [start, end). */
function boxBody(bytes: Buffer, type: string, start: number, end: number): ByteRange {
  for (let at = start; at < end; at += bytes.readUInt32BE(at)) {
    if (bytes.toString("latin1", at + 4, at + 8) === type) {
      return [at + 8, at + bytes.readUInt32BE(at)];
    }
  }
  throw new Error(`fixture: no ${type} box`);
}

/** A 64 by 64 AV1 picture from sharp: its coded bytes and its `av1C` property. */
async function av1Tile(background: { r: number; g: number; b: number }) {
  const avif = await sharp({ create: { width: 64, height: 64, channels: 3, background } })
    .avif({ quality: 60 })
    .toBuffer();
  // With no alpha and no metadata, sharp's `mdat` holds the one picture alone.
  const meta = boxBody(avif, "meta", 0, avif.length);
  const properties = boxBody(avif, "iprp", meta[0] + 4, meta[1]);
  const config = boxBody(avif, "av1C", ...boxBody(avif, "ipco", ...properties));
  return {
    coded: avif.subarray(...boxBody(avif, "mdat", 0, avif.length)),
    av1C: box("av1C", avif.subarray(...config)),
  };
}

/**
 * A 128 by 64 grid picture of two tiles. The grid's own item (its eight-byte
 * layout record) and the Exif item both sit in `idat`; the tiles sit in
 * `mdat`. The location table is version 1, with a base offset per item.
 */
async function gridAvifWithExifInIdat(): Promise<{
  source: Buffer;
  grid: ByteRange;
  exif: ByteRange;
  tiles: ByteRange;
}> {
  const [left, right] = await Promise.all([
    av1Tile({ r: 200, g: 40, b: 40 }),
    av1Tile({ r: 40, g: 40, b: 200 }),
  ]);
  // Real EXIF, as sharp reads it back out of the single-picture fixture: the
  // six-byte "Exif" marker, then the TIFF data.
  const exifBlock = (await sharp(await avifWithMetadata()).metadata()).exif;
  if (exifBlock?.toString("latin1", 0, 6) !== "Exif\0\0") throw new Error("fixture: no EXIF block");
  // An Exif item is a 32-bit offset to the TIFF header, then the block.
  const exifItem = Buffer.concat([u32(6), exifBlock]);
  // Version 0, 16-bit sizes, one row, two columns, 128 wide, 64 high.
  const gridItem = Buffer.concat([u8(0, 0, 0, 1), u16(128), u16(64)]);

  const GRID = 1;
  const LEFT = 2;
  const RIGHT = 3;
  const EXIF = 4;
  const IN_FILE = 0;
  const IN_IDAT = 1;
  const located = (id: number, method: number, base: number, offset: number, length: number) =>
    Buffer.concat([u16(id), u16(method), u16(0), u32(base), u16(1), u32(offset), u32(length)]);
  const entry = (id: number, type: string, name: string) =>
    fullBox("infe", 2, u16(id), u16(0), Buffer.from(`${type}${name}\0`, "latin1"));
  const meta = (mdatBody: number) =>
    fullBox(
      "meta",
      0,
      fullBox("hdlr", 0, u32(0), Buffer.from("pict", "latin1"), Buffer.alloc(12), u8(0)),
      fullBox("pitm", 0, u16(GRID)),
      fullBox(
        "iloc",
        1,
        u8(0x44, 0x40), // 4-byte offsets, lengths and base offsets; no extent index
        u16(4),
        located(GRID, IN_IDAT, 0, 0, gridItem.length),
        located(LEFT, IN_FILE, mdatBody, 0, left.coded.length),
        located(RIGHT, IN_FILE, mdatBody, left.coded.length, right.coded.length),
        located(EXIF, IN_IDAT, 0, gridItem.length, exifItem.length),
      ),
      fullBox(
        "iinf",
        0,
        u16(4),
        entry(GRID, "grid", ""),
        entry(LEFT, "av01", ""),
        entry(RIGHT, "av01", ""),
        entry(EXIF, "Exif", "Exif"),
      ),
      fullBox(
        "iref",
        0,
        box("dimg", u16(GRID), u16(2), u16(LEFT), u16(RIGHT)),
        box("cdsc", u16(EXIF), u16(1), u16(GRID)),
      ),
      box(
        "iprp",
        box(
          "ipco",
          left.av1C, // 1
          right.av1C, // 2
          fullBox("ispe", 0, u32(64), u32(64)), // 3
          fullBox("pixi", 0, u8(3, 8, 8, 8)), // 4
          fullBox("ispe", 0, u32(128), u32(64)), // 5
        ),
        fullBox(
          "ipma",
          0,
          u32(3),
          Buffer.concat([u16(GRID), u8(2, 5, 4)]),
          Buffer.concat([u16(LEFT), u8(3, 0x81, 3, 4)]),
          Buffer.concat([u16(RIGHT), u8(3, 0x82, 3, 4)]),
        ),
      ),
      box("idat", gridItem, exifItem),
    );

  const ftyp = box("ftyp", Buffer.from("avif", "latin1"), u32(0), Buffer.from("avifmif1miaf", "latin1"));
  // The table's size does not depend on the offsets in it, so measure once.
  const mdatBody = ftyp.length + meta(0).length + 8;
  const source = Buffer.concat([ftyp, meta(mdatBody), box("mdat", left.coded, right.coded)]);
  const exifStart = source.indexOf(exifItem);
  return {
    source,
    grid: [exifStart - gridItem.length, exifStart],
    exif: [exifStart, exifStart + exifItem.length],
    tiles: [mdatBody, source.length],
  };
}

describe("AVIF hidden-data removal", () => {
  it("removes EXIF, GPS and XMP and leaves the picture pixel-identical", async () => {
    const source = await avifWithMetadata();
    const before = await sharp(source).metadata();
    expect(before.exif).toBeDefined();
    expect(source.toString("latin1")).toContain("XMPOWNERNAME");

    const cleaned = strip(source);
    const text = cleaned.toString("latin1");
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    const after = await sharp(cleaned).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect([after.width, after.height, after.hasAlpha]).toEqual([64, 40, true]);
    expect(cleaned.length).toBe(source.length); // overwritten in place
    const [a, b] = await Promise.all([sharp(source).raw().toBuffer(), sharp(cleaned).raw().toBuffer()]);
    expect(b.equals(a)).toBe(true);
  });

  it("is identical on a second pass", async () => {
    const once = strip(await avifWithMetadata());
    expect(strip(once).equals(once)).toBe(true);
  });

  it("zeroes an Exif item held in idat beside a grid picture located by a version 1 table (#5360)", async () => {
    const { source, grid, exif, tiles } = await gridAvifWithExifInIdat();
    // The fixture is sound: a decoder that is not the cleaner reads the whole
    // picture, both tiles, and the EXIF out of `idat`.
    const before = await sharp(source).metadata();
    expect([before.width, before.height]).toEqual([128, 64]);
    expect(before.exif?.toString("latin1")).toContain("SECRETCAM");
    const pixels = await sharp(source).raw().toBuffer();
    expect(pixels.length).toBe(128 * 64 * 3);
    expect(pixels[0]).toBeGreaterThan(pixels[127 * 3] ?? 255); // red on the left tile only

    const cleaned = strip(source);

    const text = cleaned.toString("latin1");
    for (const secret of ["SECRETCAM", "Jane Member", "HOMEADDRESS"]) {
      expect(source.toString("latin1")).toContain(secret);
      expect(text).not.toContain(secret);
    }
    expect(cleaned.subarray(...exif).every((byte) => byte === 0)).toBe(true);
    expect(cleaned.subarray(...grid).equals(source.subarray(...grid))).toBe(true);
    expect(cleaned.subarray(...tiles).equals(source.subarray(...tiles))).toBe(true);
    expect(cleaned.length).toBe(source.length);
    expect((await sharp(cleaned).metadata()).exif).toBeUndefined();
    expect((await sharp(cleaned).raw().toBuffer()).equals(pixels)).toBe(true);
    expect(strip(cleaned).equals(cleaned)).toBe(true);
  });

  it("blanks an unknown top-level box", async () => {
    const source = await avifWithMetadata();
    const extra = Buffer.alloc(20);
    extra.writeUInt32BE(20, 0);
    extra.write("uuid", 4, "latin1");
    extra.write("HIDDENNOTE", 8, "latin1");
    // Appended after mdat, so no item offset moves.
    const cleaned = strip(Buffer.concat([source, extra]));
    expect(cleaned.toString("latin1")).not.toContain("HIDDENNOTE");
    expect(cleaned.toString("latin1", cleaned.length - 16, cleaned.length - 12)).toBe("free");
  });

  it("replaces an unknown file-type brand, which could be any four letters", async () => {
    const source = Buffer.from(await avifWithMetadata());
    const lastBrand = source.readUInt32BE(0) - 4; // ftyp is first; its last brand
    source.write("Jane", lastBrand, "latin1");

    const cleaned = strip(source);

    expect(cleaned.toString("latin1", lastBrand, lastBrand + 4)).toBe("mif1");
    expect(strip(cleaned).equals(cleaned)).toBe(true);
  });

  it.each([
    ["truncated", (avif: Buffer) => avif.subarray(0, avif.length - 50)],
    ["cut inside its first box", (avif: Buffer) => avif.subarray(0, 40)],
    ["without a leading ftyp", (avif: Buffer) => {
      const copy = Buffer.from(avif);
      copy.write("free", 4, "latin1");
      return copy;
    }],
  ])("refuses an AVIF %s", async (_label, damage) => {
    const damaged = damage(await avifWithMetadata());
    const result = stripImageMetadata(damaged, "image/avif");
    expect(result.ok).toBe(false);
    expect(result.bytes.equals(damaged)).toBe(true);
  });

  it("refuses an animated AVIF with its own message", async () => {
    const source = await avifWithMetadata();
    const track = Buffer.alloc(16);
    track.writeUInt32BE(16, 0);
    track.write("moov", 4, "latin1");
    const result = cleanImageForStorage(Buffer.concat([source, track]), "image/avif");
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/^Animated AVIF/) });
  });
});
