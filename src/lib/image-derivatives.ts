import { randomUUID } from "crypto";
import type { Stats } from "fs";
import fs from "fs/promises";
import path from "path";

import sharp from "sharp";

import {
  IMAGES_ROOT,
  IMAGE_DERIVATIVES_DIRECTORY,
  derivativeFileName,
  removeImageDerivatives,
} from "@/lib/image-storage";

/**
 * Website-sized copies of Image Manager uploads (#4935, INV-PUB-005).
 *
 * A phone photo is 3–8 MB, and before this a gallery thumbnail downloaded it
 * whole. Each JPEG/PNG/WebP upload now also gets WebP copies at the widths
 * below, in the directory's hidden copies folder (see image-storage.ts); the
 * gallery serves them through `srcset` and the full-size view uses the widest.
 *
 * Made at upload and by the explicit backfill command ONLY — never lazily on a
 * visitor's GET, which would hand any anonymous request a disk-write trigger.
 *
 * No `server-only` guard: the backfill script loads this under `tsx`.
 */

/** Widths a copy is made at. Only those narrower than the source are made. */
export const IMAGE_DERIVATIVE_WIDTHS = [400, 800, 1600] as const;

/**
 * Decode ceiling, in pixels — shared with the message-board pipeline
 * (post-image-storage.ts) so the two cannot drift. A decompression bomb is a
 * small file that expands to an enormous bitmap; the byte caps do nothing
 * about it. sharp refuses past this before allocating.
 */
export const SHARP_MAX_INPUT_PIXELS = 50_000_000;

/** WebP quality for every re-encoded public image (board posts and copies). */
export const SHARP_WEBP_QUALITY = 82;

// GIF may be animated and a still copy would silently drop the animation;
// AVIF is already small. Both are stored and served unchanged.
const UNCOPIED_EXTS = new Set([".gif", ".avif"]);

/** The widths a source this wide gets copies at — never an upscale. */
export function plannedDerivativeWidths(sourceWidth: number): number[] {
  return IMAGE_DERIVATIVE_WIDTHS.filter((width) => width < sourceWidth);
}

function decoder(input: Buffer | string) {
  return sharp(input, {
    limitInputPixels: SHARP_MAX_INPUT_PIXELS,
    failOn: "error",
  });
}

/**
 * The widths this image SHOULD have copies at: empty for GIF/AVIF and for an
 * image no wider than the narrowest width. Reads the header only (sharp's
 * `metadata()` does not decode pixels), so the backfill can ask it of every
 * stored file cheaply. Width is measured as DISPLAYED — after the EXIF
 * orientation a copy is rotated to — so a portrait phone photo is planned by
 * its real width. Throws on an unreadable image; callers decide the policy.
 */
export async function plannedDerivativeWidthsFor(
  input: Buffer | string,
  fileName: string,
): Promise<number[]> {
  if (UNCOPIED_EXTS.has(path.extname(fileName).toLowerCase())) return [];
  const metadata = await decoder(input).metadata();
  const width = metadata.autoOrient?.width ?? metadata.width;
  return width ? plannedDerivativeWidths(width) : [];
}

/**
 * Write the copies of one stored image and return the widths written.
 *
 * `absDir` must already be contained under IMAGES_ROOT (resolveInImagesRoot)
 * and `fileName` must be a bare, sanitised file name — the caller's
 * containment is what keeps every path built here inside the root.
 *
 * Replaces, never accumulates: copies of an earlier file under the same name
 * at widths not written now are removed, so a narrower replacement photo does
 * not keep serving the old photo's wider copies.
 *
 * `original`, when given, is the identity of the stored file `bytes` were read
 * from. Production callers always pass it: it is what lets two writers of the
 * same name settle on one photo's copies (see the check at the end).
 *
 * FAIL-OPEN, matching the upload route: any error (a corrupt image, one past
 * the pixel limit, a full disk) is logged, every copy of this name is removed
 * so the gallery falls back to the original, and the result is `[]`. It never
 * throws, so it can never turn a stored upload into a failed one.
 *
 * Copies are re-encoded from the bytes as stored (already EXIF-stripped by the
 * upload route), and sharp drops all metadata unless `.withMetadata()` asks
 * for it — so no GPS reaches a copy. Do not add that call.
 */
/**
 * Which stored file a set of bytes was: its inode, size and modification
 * time, as `stat` reports them. Taken BEFORE the original can be replaced (the
 * upload stats its `.part` file before the rename, which keeps all three; the
 * backfill stats the handle it reads from), so it names this writer's file,
 * never a concurrent writer's.
 */
export type StoredImageIdentity = Pick<
  Stats,
  "dev" | "ino" | "size" | "mtimeMs"
>;

function sameStoredImage(a: StoredImageIdentity, b: StoredImageIdentity) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}

export async function writeImageDerivatives(
  bytes: Buffer,
  absDir: string,
  fileName: string,
  {
    root = IMAGES_ROOT,
    original,
  }: { root?: string; original?: StoredImageIdentity } = {},
): Promise<number[]> {
  const sizesDir = path.resolve(absDir, IMAGE_DERIVATIVES_DIRECTORY);
  // The caller's containment, re-checked at the writes below: a folder outside
  // the trusted images root (IMAGES_ROOT, or the backfill's --root) gets no
  // copies and no write. Not fail-open: nothing is written, so nothing leaks.
  if (!sizesDir.startsWith(path.resolve(root) + path.sep)) {
    console.warn("image-derivatives: folder outside the images root; no copies made");
    return [];
  }
  try {
    const widths = await plannedDerivativeWidthsFor(bytes, fileName);
    if (widths.length > 0) {
      await fs.mkdir(sizesDir, { recursive: true });
    }
    // One width at a time: each pass decodes the source, and a 10 MB photo
    // decoded three times at once would triple the peak memory.
    for (const width of widths) {
      const encoded = await decoder(bytes)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: SHARP_WEBP_QUALITY })
        .toBuffer();
      await writeFileAtomically(
        path.join(sizesDir, derivativeFileName(fileName, width)),
        encoded,
      );
    }
    await removeImageDerivatives(absDir, fileName, {
      keepWidths: widths,
      root,
    });
    // Two writers of one name interleave their widths: A renames, B renames,
    // B writes every width, then A overwrites some. Every copy is newer than
    // B's original, so the mtime filter cannot catch it and the gallery would
    // mix two photos. Each writer re-checks, after its last write, that the
    // original is still the file it copied; if not, it removes every copy of
    // the name. The later writer's own check then holds, and if any of its
    // copies were removed the gallery serves its original (INV-PUB-005).
    if (original) {
      const current = await fs
        .stat(path.join(absDir, fileName))
        .catch(() => null);
      if (!current || !sameStoredImage(current, original)) {
        console.warn(
          "image-derivatives: original replaced while copies were written; copies removed:",
          fileName,
        );
        await removeImageDerivatives(absDir, fileName, { root });
        return [];
      }
    }
    return widths;
  } catch (err) {
    console.warn(
      "image-derivatives: no website copies made; the original will be served:",
      fileName,
      err instanceof Error ? err.message : err,
    );
    await removeImageDerivatives(absDir, fileName, { root }).catch(
      () => undefined,
    );
    return [];
  }
}

/**
 * Write to a temporary name in the same folder, then rename over the target.
 * A rename is atomic on one filesystem, so a request streaming the previous
 * file keeps its open handle on the old bytes rather than reading a file
 * truncated under it. The temporary name ends `.part`, an extension no listing
 * or the serving route accepts, and starts with a dot.
 */
async function writeFileAtomically(
  target: string,
  data: Buffer,
): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.part`,
  );
  try {
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, target);
  } catch (err) {
    await fs.unlink(temporary).catch(() => undefined);
    throw err;
  }
}
