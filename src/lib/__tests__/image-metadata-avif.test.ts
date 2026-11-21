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
