import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { stripImageMetadata } from "@/lib/image-metadata";

// #5244: GIF hidden data (comment, plain-text and application blocks such as
// XMP) is removed; frames, timing and looping survive byte for byte.

async function twoFrameGif(): Promise<Buffer> {
  const frame = (colour: string) =>
    sharp({ create: { width: 30, height: 30, channels: 3, background: colour } }).raw().toBuffer();
  const pixels = Buffer.concat([await frame("red"), await frame("blue")]);
  return sharp(pixels, { raw: { width: 30, height: 60, channels: 3, pageHeight: 30 } })
    .gif({ loop: 0, delay: [200, 300] })
    .toBuffer();
}

function headerLength(gif: Buffer): number {
  const flags = gif[10] ?? 0;
  return 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
}

function subBlocks(text: string): Buffer {
  return Buffer.concat([Buffer.from([text.length]), Buffer.from(text, "latin1"), Buffer.from([0])]);
}

const COMMENT = Buffer.concat([Buffer.from([0x21, 0xfe]), subBlocks("GPS -39.27 175.56 Jane Member")]);
const PLAIN_TEXT = Buffer.concat([
  Buffer.from([0x21, 0x01, 12]),
  Buffer.alloc(12),
  subBlocks("PLAINSECRET"),
]);
const XMP = Buffer.concat([
  Buffer.from([0x21, 0xff, 11]),
  Buffer.from("XMP DataXMP", "latin1"),
  subBlocks("<dc:creator>OWNERNAME</dc:creator>"),
]);

function withHiddenData(gif: Buffer): Buffer {
  const at = headerLength(gif);
  return Buffer.concat([
    gif.subarray(0, at),
    COMMENT,
    XMP,
    gif.subarray(at, gif.length - 1),
    PLAIN_TEXT,
    gif.subarray(gif.length - 1),
    Buffer.from("TRAILING SECRET"),
  ]);
}

function strip(bytes: Buffer): Buffer | null {
  const result = stripImageMetadata(bytes, "image/gif");
  return result.ok ? result.bytes : null;
}

describe("GIF hidden-data removal", () => {
  it("removes comments, plain text, XMP and trailing bytes and keeps the animation", async () => {
    const original = await twoFrameGif();
    const cleaned = strip(withHiddenData(original));

    expect(cleaned).not.toBeNull();
    const text = cleaned!.toString("latin1");
    for (const secret of ["Jane Member", "PLAINSECRET", "OWNERNAME", "XMP DataXMP", "TRAILING SECRET"]) {
      expect(text).not.toContain(secret);
    }
    // Exactly the encoder's own output: picture, timing and loop blocks kept.
    expect(cleaned!.equals(original)).toBe(true);
    const meta = await sharp(cleaned!, { animated: true }).metadata();
    expect(meta.pages).toBe(2);
    expect(meta.loop).toBe(0);
    expect(meta.delay).toEqual([200, 300]);
  });

  it("is identical on a second pass", async () => {
    const once = strip(withHiddenData(await twoFrameGif()))!;
    expect(strip(once)!.equals(once)).toBe(true);
  });

  it("rebuilds a kept looping block, dropping data smuggled in extra sub-blocks", async () => {
    const original = await twoFrameGif();
    const loopAt = original.indexOf("NETSCAPE2.0", 0, "latin1") - 3;
    expect(loopAt).toBeGreaterThan(0);
    const loopEnd = loopAt + 19; // 21 FF 0B + id(11) + 03 01 lo hi + 00
    const smuggled = Buffer.concat([
      original.subarray(0, loopEnd - 1),
      subBlocks("SMUGGLED").subarray(0, -1),
      original.subarray(loopEnd - 1),
    ]);
    const cleaned = strip(smuggled);
    expect(cleaned?.equals(original)).toBe(true);
  });

  it.each([
    ["truncated mid-block", (gif: Buffer) => gif.subarray(0, gif.length - 20)],
    ["missing its trailer", (gif: Buffer) => gif.subarray(0, gif.length - 1)],
    ["holding an unknown block", (gif: Buffer) => {
      const at = headerLength(gif);
      return Buffer.concat([gif.subarray(0, at), Buffer.from([0x99]), gif.subarray(at)]);
    }],
    ["cut inside the header", (gif: Buffer) => gif.subarray(0, 8)],
  ])("refuses a GIF %s", async (_label, damage) => {
    const damaged = damage(await twoFrameGif());
    const result = stripImageMetadata(damaged, "image/gif");
    expect(result.ok).toBe(false);
    expect(result.bytes.equals(damaged)).toBe(true);
  });
});
