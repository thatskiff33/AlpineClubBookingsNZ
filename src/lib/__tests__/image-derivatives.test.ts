import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

import {
  IMAGE_DERIVATIVE_WIDTHS,
  plannedDerivativeWidths,
  writeImageDerivatives,
} from "@/lib/image-derivatives";
import { backfillImageDerivatives } from "@/lib/image-derivatives-backfill";
import {
  IMAGE_DERIVATIVES_DIRECTORY,
  listImageDerivatives,
  removeImageDerivatives,
} from "@/lib/image-storage";

// #4935 (INV-PUB-005). Real sharp, real files in a temporary directory: the
// properties that matter — which widths exist, that nothing is upscaled, that
// no metadata survives — are properties of the bytes on disk.

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-derivatives-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

function solid(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: "#4a7a5a" },
  });
}

async function copiesOnDisk(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(dir, IMAGE_DERIVATIVES_DIRECTORY))).sort();
  } catch {
    return [];
  }
}

async function widthOf(fileName: string): Promise<number | undefined> {
  return (
    await sharp(path.join(dir, IMAGE_DERIVATIVES_DIRECTORY, fileName)).metadata()
  ).width;
}

describe("plannedDerivativeWidths", () => {
  it("plans only widths narrower than the source — never an upscale", () => {
    expect(plannedDerivativeWidths(3000)).toEqual([...IMAGE_DERIVATIVE_WIDTHS]);
    expect(plannedDerivativeWidths(1000)).toEqual([400, 800]);
    expect(plannedDerivativeWidths(400)).toEqual([]);
  });
});

describe("writeImageDerivatives", () => {
  it("writes a WebP copy at each fixed width below the source, at that width", async () => {
    const bytes = await solid(2000, 1500).jpeg().toBuffer();
    const widths = await writeImageDerivatives(bytes, dir, "lodge.jpg", { root: dir });

    expect(widths).toEqual([400, 800, 1600]);
    expect(await copiesOnDisk()).toEqual([
      "lodge.jpg.1600.webp",
      "lodge.jpg.400.webp",
      "lodge.jpg.800.webp",
    ]);
    expect(await widthOf("lodge.jpg.800.webp")).toBe(800);
    const meta = await sharp(
      path.join(dir, IMAGE_DERIVATIVES_DIRECTORY, "lodge.jpg.1600.webp"),
    ).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.height).toBe(1200);
  });

  it("does not upscale: a 900 px photo gets 400 and 800 only, and a 300 px one nothing", async () => {
    expect(
      await writeImageDerivatives(await solid(900, 600).png().toBuffer(), dir, "mid.png", { root: dir }),
    ).toEqual([400, 800]);
    expect(
      await writeImageDerivatives(await solid(300, 200).png().toBuffer(), dir, "tiny.png", { root: dir }),
    ).toEqual([]);
    expect(await copiesOnDisk()).toEqual(["mid.png.400.webp", "mid.png.800.webp"]);
  });

  it("stores no copy of a GIF (it may be animated) or an AVIF", async () => {
    const gif = await solid(2000, 1500).gif().toBuffer();
    expect(await writeImageDerivatives(gif, dir, "anim.gif", { root: dir })).toEqual([]);
    expect(await writeImageDerivatives(gif, dir, "photo.avif", { root: dir })).toEqual([]);
    expect(await copiesOnDisk()).toEqual([]);
  });

  it("carries no EXIF or other metadata into a copy", async () => {
    const bytes = await solid(1000, 800)
      .jpeg()
      .withExif({ IFD0: { Copyright: "GPS-41.29,174.78" } })
      .toBuffer();
    expect((await sharp(bytes).metadata()).exif).toBeDefined();

    await writeImageDerivatives(bytes, dir, "phone.jpg", { root: dir });
    for (const name of await copiesOnDisk()) {
      const file = await fs.readFile(path.join(dir, IMAGE_DERIVATIVES_DIRECTORY, name));
      const meta = await sharp(file).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(file.includes(Buffer.from("GPS-41.29"))).toBe(false);
    }
  });

  it("sizes a portrait phone photo by its displayed width", async () => {
    // 1200 wide as stored, 900 wide once its EXIF orientation (6 = rotate 90)
    // is applied — so it gets 400 and 800, rotated, not 400/800 of a sideways
    // image.
    const bytes = await solid(1200, 900).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(await writeImageDerivatives(bytes, dir, "portrait.jpg", { root: dir })).toEqual([400, 800]);
    const meta = await sharp(
      path.join(dir, IMAGE_DERIVATIVES_DIRECTORY, "portrait.jpg.800.webp"),
    ).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBeGreaterThan(800);
  });

  it("fails open on a corrupt image: logs, writes nothing, never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const corrupt = Buffer.concat([
      (await solid(1000, 800).jpeg().toBuffer()).subarray(0, 200),
      Buffer.alloc(200, 0x61),
    ]);
    await expect(writeImageDerivatives(corrupt, dir, "broken.jpg", { root: dir })).resolves.toEqual([]);
    expect(await copiesOnDisk()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("refuses an image past the decode pixel limit (fail-open, nothing written)", async () => {
    // 8000 x 6500 = 52 MP, over the shared 50 MP ceiling. A flat colour keeps
    // the PNG itself small — exactly the decompression-bomb shape.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bomb = await solid(8000, 6500).png({ compressionLevel: 9 }).toBuffer();
    expect(await writeImageDerivatives(bomb, dir, "bomb.png", { root: dir })).toEqual([]);
    expect(await copiesOnDisk()).toEqual([]);
    expect(String(warn.mock.calls[0]?.slice(1))).toMatch(/pixel limit/i);
  });

  it("replaces a photo's copies rather than accumulating them", async () => {
    await writeImageDerivatives(await solid(2000, 1500).jpeg().toBuffer(), dir, "lodge.jpg", { root: dir });
    // The officer replaces lodge.jpg with a narrower photo: its 1600 px copy
    // would otherwise keep serving the OLD photo.
    await writeImageDerivatives(await solid(1000, 750).jpeg().toBuffer(), dir, "lodge.jpg", { root: dir });
    expect(await copiesOnDisk()).toEqual(["lodge.jpg.400.webp", "lodge.jpg.800.webp"]);

    // And a replacement that cannot be copied leaves none of the old ones.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeImageDerivatives(Buffer.from("not an image"), dir, "lodge.jpg", { root: dir });
    expect(await copiesOnDisk()).toEqual([]);
  });

  // #5087 review: two uploads of one name interleave. A copied its photo but
  // B replaced the original meanwhile, so A's copies would show the wrong
  // photo beside B's. A must take every copy of the name with it.
  it("removes its copies when the original was replaced while they were written", async () => {
    const original = path.join(dir, "lodge.jpg");
    const photoA = await solid(2000, 1500).jpeg().toBuffer();
    await fs.writeFile(original, photoA);
    const identityA = await fs.stat(original);
    // B renames its photo over lodge.jpg: a new file, so a new inode.
    const partB = path.join(dir, ".lodge.jpg.b.part");
    await fs.writeFile(partB, await solid(1000, 750).jpeg().toBuffer());
    await fs.rename(partB, original);

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      await writeImageDerivatives(photoA, dir, "lodge.jpg", {
        root: dir,
        original: identityA,
      }),
    ).toEqual([]);
    expect(await copiesOnDisk()).toEqual([]);
  });

  it("keeps its copies when the original is still the file it copied", async () => {
    const original = path.join(dir, "lodge.jpg");
    const bytes = await solid(2000, 1500).jpeg().toBuffer();
    await fs.writeFile(original, bytes);
    expect(
      await writeImageDerivatives(bytes, dir, "lodge.jpg", {
        root: dir,
        original: await fs.stat(original),
      }),
    ).toEqual([400, 800, 1600]);
    expect(await copiesOnDisk()).toHaveLength(3);
  });

  it("leaves no temporary file behind", async () => {
    await writeImageDerivatives(await solid(900, 600).jpeg().toBuffer(), dir, "a.jpg", { root: dir });
    expect((await copiesOnDisk()).some((name) => name.endsWith(".part"))).toBe(false);
  });
});

// The copy helpers re-check containment at their own filesystem calls rather
// than trusting the caller's resolver (CodeQL js/path-injection on #5087).
describe("copies folder containment", () => {
  it("writes nothing for a folder outside the trusted root", async () => {
    const root = path.join(dir, "images");
    await fs.mkdir(root);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bytes = await solid(2000, 1500).jpeg().toBuffer();
    expect(await writeImageDerivatives(bytes, dir, "lodge.jpg", { root })).toEqual([]);
    expect(await copiesOnDisk()).toEqual([]);
  });

  it("refuses to list or remove copies outside the trusted root", async () => {
    await writeImageDerivatives(await solid(900, 600).jpeg().toBuffer(), dir, "a.jpg", { root: dir });
    const root = path.join(dir, "images");
    await expect(listImageDerivatives(dir, { root })).rejects.toThrow(/outside the images root/);
    await expect(removeImageDerivatives(dir, "a.jpg", { root })).rejects.toThrow(/outside the images root/);
    expect(await copiesOnDisk()).toEqual(["a.jpg.400.webp", "a.jpg.800.webp"]);
  });

  it("refuses a sibling folder that merely shares the root's name as a prefix", async () => {
    const root = path.join(dir, "images");
    const sibling = path.join(dir, "imagesEvil");
    await expect(listImageDerivatives(sibling, { root })).rejects.toThrow(/outside the images root/);
  });
});

describe("backfillImageDerivatives", () => {
  async function seed(): Promise<void> {
    await fs.mkdir(path.join(dir, "lodge"));
    await solid(2000, 1500).jpeg().toFile(path.join(dir, "lodge", "a.jpg"));
    await solid(300, 200).png().toFile(path.join(dir, "lodge", "small.png"));
    await solid(1000, 800).jpeg().toFile(path.join(dir, "top.jpg"));
  }

  it("makes the missing copies, and a second run finds nothing to do", async () => {
    await seed();

    const dryRun = await backfillImageDerivatives({ root: dir, apply: false });
    expect(dryRun.refreshed.sort()).toEqual([path.join("lodge", "a.jpg"), "top.jpg"]);
    expect(await copiesOnDisk()).toEqual([]); // a dry run writes nothing

    const first = await backfillImageDerivatives({ root: dir, apply: true });
    expect(first.refreshed).toHaveLength(2);
    expect(first.failed).toEqual([]);
    expect(await copiesOnDisk()).toEqual(["top.jpg.400.webp", "top.jpg.800.webp"]);

    const sizesDir = path.join(dir, "lodge", IMAGE_DERIVATIVES_DIRECTORY);
    const before = await fs.readdir(sizesDir);
    const mtimes = await Promise.all(
      before.map(async (name) => (await fs.stat(path.join(sizesDir, name))).mtimeMs),
    );

    const second = await backfillImageDerivatives({ root: dir, apply: true });
    expect(second).toEqual({
      upToDate: 3,
      refreshed: [],
      failed: [],
      orphansRemoved: [],
    });
    expect(await fs.readdir(sizesDir)).toEqual(before);
    expect(
      await Promise.all(
        before.map(async (name) => (await fs.stat(path.join(sizesDir, name))).mtimeMs),
      ),
    ).toEqual(mtimes);
  });

  it("remakes copies older than their original, and removes copies with no original", async () => {
    await seed();
    await backfillImageDerivatives({ root: dir, apply: true });

    // Replaced by code that predates copies: the original is newer than them.
    // (Measured from the copy's own mtime — the test clock is frozen.)
    const copyMtimeMs = (
      await fs.stat(path.join(dir, IMAGE_DERIVATIVES_DIRECTORY, "top.jpg.400.webp"))
    ).mtimeMs;
    const later = new Date(copyMtimeMs + 60_000);
    await fs.utimes(path.join(dir, "top.jpg"), later, later);
    // Deleted the same way: its copies are left with no original.
    await fs.rm(path.join(dir, "lodge", "a.jpg"));

    const report = await backfillImageDerivatives({ root: dir, apply: true });
    expect(report.refreshed).toEqual(["top.jpg"]);
    expect(report.orphansRemoved).toHaveLength(3);
    expect(await fs.readdir(path.join(dir, "lodge", IMAGE_DERIVATIVES_DIRECTORY))).toEqual([]);
  });
});
