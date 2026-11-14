import fs from "fs/promises";
import path from "path";

// Where uploaded images are stored on disk: `public/images`, so local dev and
// `next start` serve uploads directly at `/images/...`.
//
// Containerised deploys run with a read-only root filesystem, so this path MUST
// be backed by a persistent, writable volume shared across replicas. Relocation
// is done at the deployment layer by mounting that volume here, not via an env
// var (see docker-compose.yml: the `image_uploads` named volume mounted at
// /app/public/images, owned by uid 1001). Keeping the root a trusted constant
// also keeps the path-traversal containment checks below statically verifiable.
export const IMAGES_ROOT = path.join(process.cwd(), "public", "images");

// Public URL prefix that serves IMAGES_ROOT. Stored image URLs use an API route
// so newly uploaded files are readable immediately in production without relying
// on Next.js public-file startup indexing.
const PUBLIC_URL_PREFIX = "/api/images/uploaded";

// The content type each allowed extension is served and parsed as. This map IS
// the allowlist: ALLOWED_IMAGE_EXTS and ALLOWED_IMAGE_MIME below are derived
// from it, so an extension cannot be allowed without a type (the serving route
// and the gallery's dimension read both use this).
//
// SVG is intentionally excluded: it is an XML dialect that can embed inline
// <script> and event-handler attributes. Files under the images root are served
// directly by Next.js/Caddy with no restrictive CSP, so an uploaded SVG opened
// in-browser would execute in the site origin (stored XSS).
export const IMAGE_CONTENT_TYPE_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
} as const satisfies Record<string, string>;

export const ALLOWED_IMAGE_EXTS: ReadonlySet<string> = new Set(
  Object.keys(IMAGE_CONTENT_TYPE_BY_EXT),
);

export const ALLOWED_IMAGE_MIME: ReadonlySet<string> = new Set(
  Object.values(IMAGE_CONTENT_TYPE_BY_EXT),
);

export function imageContentTypeForExt(
  ext: string,
): (typeof IMAGE_CONTENT_TYPE_BY_EXT)[keyof typeof IMAGE_CONTENT_TYPE_BY_EXT] | null {
  return Object.hasOwn(IMAGE_CONTENT_TYPE_BY_EXT, ext)
    ? IMAGE_CONTENT_TYPE_BY_EXT[ext as keyof typeof IMAGE_CONTENT_TYPE_BY_EXT]
    : null;
}

// ---------------------------------------------------------------------------
// Website-sized copies (#4935, INV-PUB-005).
//
// Every directory may hold one reserved hidden folder of width-bounded WebP
// copies of its images, written at upload (src/lib/image-derivatives.ts) and by
// the backfill script. A copy of `lodge.jpg` at 800 px is
// `.sizes/lodge.jpg.800.webp`: the original's FULL name is kept so `lodge.jpg`
// and `lodge.png` never share a copy. The folder lives beside the originals,
// not in a separate tree, so a directory rename or recursive delete carries
// its copies with it for free.
//
// The folder is invisible everywhere an officer or visitor sees a listing:
// the Image Manager's image and directory lists, the photo-gallery listing,
// and as a user-chosen folder name. The serving route needs no special case
// — a copy is an ordinary .webp under IMAGES_ROOT.
// ---------------------------------------------------------------------------

export const IMAGE_DERIVATIVES_DIRECTORY = ".sizes";

/** Whether a directory entry is the reserved copies folder. */
export function isDerivativeDirectoryName(name: string): boolean {
  // Case-insensitive: on a case-insensitive volume `.SIZES` IS the folder.
  return name.toLowerCase() === IMAGE_DERIVATIVES_DIRECTORY;
}

/** Whether a client-supplied relative path reaches into a copies folder. */
function pathReachesDerivativeDirectory(rel: string): boolean {
  return rel.split(/[/\\]/).some(isDerivativeDirectoryName);
}

export function derivativeFileName(fileName: string, width: number): string {
  return `${fileName}.${width}.webp`;
}

const DERIVATIVE_FILE_NAME = /^(.+)\.([1-9][0-9]*)\.webp$/;

export type ImageDerivative = {
  /** The copy's own file name inside the copies folder. */
  fileName: string;
  width: number;
  mtimeMs: number;
};

/**
 * Whether a copy still belongs to its original: written no earlier than it.
 * A copy older than its original was made from an earlier file of the same
 * name (replaced by code that predates copies, during a blue/green cutover or
 * after a rollback). The ONE statement of that rule: the gallery hides such a
 * copy and the backfill refreshes it, so the two must never disagree
 * (INV-PUB-005).
 */
export function isCurrentDerivative(
  copy: Pick<ImageDerivative, "mtimeMs">,
  originalMtimeMs: number,
): boolean {
  return copy.mtimeMs >= originalMtimeMs;
}

/**
 * Every copy in one directory's copies folder, grouped by the original's file
 * name, narrowest first. One `readdir` per directory, so a gallery listing
 * pays it once rather than once per photo. A missing folder is no copies.
 *
 * An unreadable folder is also no copies unless `strict`, which throws it
 * instead: removal must not mistake "could not look" for "nothing there", or
 * a deleted photo's copies would stay public while the delete reported done.
 */
export async function listImageDerivatives(
  absDir: string,
  {
    strict = false,
    root = IMAGES_ROOT,
  }: { strict?: boolean; root?: string } = {},
): Promise<Map<string, ImageDerivative[]>> {
  const result = new Map<string, ImageDerivative[]>();
  // Containment checked here, at the filesystem calls below, not only by the
  // caller's resolver: CodeQL `js/path-injection` cannot follow a guard across
  // a function boundary, and these helpers are reached from public routes.
  const sizesDir = path.resolve(absDir, IMAGE_DERIVATIVES_DIRECTORY);
  if (!sizesDir.startsWith(path.resolve(root) + path.sep)) {
    throw new Error("image-storage: copies folder outside the images root");
  }
  let entries;
  try {
    entries = await fs.readdir(sizesDir, { withFileTypes: true });
  } catch (err) {
    if (strict && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = DERIVATIVE_FILE_NAME.exec(entry.name);
    if (!match?.[1] || !match[2]) continue;
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(path.join(sizesDir, entry.name))).mtimeMs;
    } catch {
      continue; // removed between readdir and stat
    }
    const list = result.get(match[1]) ?? [];
    list.push({ fileName: entry.name, width: Number(match[2]), mtimeMs });
    result.set(match[1], list);
  }
  for (const list of result.values()) list.sort((a, b) => a.width - b.width);
  return result;
}

/**
 * Remove every copy of one original, optionally keeping some widths. Missing
 * files and a missing folder are not errors: the outcome wanted is "no copy of
 * this image remains", and it already holds.
 *
 * `root` is the trusted images folder `absDir` must sit in: `IMAGES_ROOT`
 * unless the operator backfill was pointed at another one. A folder outside it
 * throws before anything is removed.
 */
export async function removeImageDerivatives(
  absDir: string,
  fileName: string,
  {
    keepWidths = [],
    root = IMAGES_ROOT,
  }: { keepWidths?: readonly number[]; root?: string } = {},
): Promise<void> {
  const sizesDir = path.resolve(absDir, IMAGE_DERIVATIVES_DIRECTORY);
  if (!sizesDir.startsWith(path.resolve(root) + path.sep)) {
    throw new Error("image-storage: copies folder outside the images root");
  }
  const copies =
    (await listImageDerivatives(absDir, { strict: true, root })).get(
      fileName,
    ) ?? [];
  for (const copy of copies) {
    if (keepWidths.includes(copy.width)) continue;
    try {
      await fs.unlink(path.join(sizesDir, copy.fileName));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

// Characters a directory name may never contain: path separators (which would
// make one name into several) plus the Windows-reserved set and control
// characters (which produce names the storage volume cannot represent).
const UNSAFE_DIRECTORY_NAME_CHARS = /[/\\<>:"|?*\x00-\x1F]/;

// A name made only of dots. `.` and `..` are not names at all — they are path
// operators, and `path.join` expands them: measured, `path.join(root, "..")`
// yields the PARENT of root and `path.join(root, ".")` yields root itself.
//
// Longer runs (`...`, `....`) are NOT expanded — measured, they join as literal
// segments — and are rejected anyway. Two reasons, neither of them traversal:
// they cost nothing to give up (no real album is named "..."), and Windows
// silently strips trailing dots from a name, so such a directory could be
// created under one name and then not be found under it.
const DOT_ONLY_NAME = /^\.+$/;

/**
 * Whether a client-supplied directory name may be used as a single path
 * segment. This is the ONE statement of that rule — the Image Manager's create
 * and rename endpoints both call it rather than repeating a regex, so the two
 * cannot drift apart.
 *
 * The dot-only rejection is the part added by #2841 (CodeQL `js/path-injection`
 * alerts 32/33/34 on the directories route). The charset filter alone banned
 * separators but not dots, so `..` reached `path.join` and the downstream
 * containment check was the only thing left standing. It held for create
 * (mkdir got a harmless EEXIST) but not for rename, where `newName: "."`
 * resolved a nested directory onto its own parent, passed containment, and
 * reached `fs.rename` — which fails at the OS layer, so it produced a 500
 * where a 400 belongs. A name is now rejected before any path is built.
 */
export function isSafeDirectoryName(name: string): boolean {
  if (name.length === 0) return false;
  if (UNSAFE_DIRECTORY_NAME_CHARS.test(name)) return false;
  if (DOT_ONLY_NAME.test(name)) return false;
  // Reserved for website-sized copies (#4935): a user folder of that name
  // would be hidden from every listing, and its photos with it.
  if (isDerivativeDirectoryName(name)) return false;
  return true;
}

// Resolve a client-supplied relative path safely inside IMAGES_ROOT.
// Returns null if the path would escape the images root (path traversal).
export function resolveInImagesRoot(rel: string): string | null {
  const normalized = path.normalize(rel);
  // This function IS the path-traversal containment check: it resolves under a
  // trusted constant root and returns null (below) for anything that escapes.
  // Why that satisfies both Semgrep and CodeQL's six `js/path-injection`
  // alerts is recorded once in docs/SECURITY-ATTACK-SURFACE.md ->
  // "Image Manager path containment" (#2841).
  const resolved = path.resolve(IMAGES_ROOT, normalized);
  if (
    resolved !== IMAGES_ROOT &&
    !resolved.startsWith(IMAGES_ROOT + path.sep)
  ) {
    return null;
  }
  return resolved;
}

/**
 * `resolveInImagesRoot` for a path naming an album or a photo in one: also
 * null for any path with a copies-folder segment. Every Image Manager endpoint
 * and the gallery listing resolve client input through this, so copies are
 * managed only through their original — never listed, uploaded into, renamed
 * or deleted directly, and never an album (#4935, INV-PUB-005).
 */
export function resolveAlbumPathInImagesRoot(rel: string): string | null {
  return pathReachesDerivativeDirectory(rel) ? null : resolveInImagesRoot(rel);
}

// Map an absolute path under IMAGES_ROOT to its public `/images/...` URL.
export function imagePublicUrl(absPath: string): string {
  const rel = path.relative(IMAGES_ROOT, absPath).replace(/\\/g, "/");
  return rel ? `${PUBLIC_URL_PREFIX}/${rel}` : PUBLIC_URL_PREFIX;
}

// Build the clear, actionable message returned when a write fails because the
// storage volume is missing or read-only. The mkdir/writeFile sinks stay inline
// in the route handlers (right after resolveInImagesRoot's containment check) so
// the path-traversal barrier is intra-route and statically verifiable; this
// helper only formats the error text.
export function storageUnavailableMessage(code: string | undefined): string {
  return (
    `Image storage directory is not writable (${code ?? "unknown"}). ` +
    `Ensure a persistent, writable volume is mounted at ${IMAGES_ROOT} ` +
    `and owned by the app user (uid 1001).`
  );
}

// Error codes that indicate the storage volume itself is unavailable rather than
// an ordinary failure (e.g. EEXIST).
export function isStorageUnavailableCode(code: string | undefined): boolean {
  return code === "EACCES" || code === "EROFS" || code === "ENOENT";
}

// Best-effort ensure of the images root for read paths (listing). A missing or
// read-only directory must not 500 the listing endpoints — callers treat a
// failure here as "no images yet".
export async function ensureImagesRootForRead(): Promise<void> {
  try {
    await fs.mkdir(IMAGES_ROOT, { recursive: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return;
    console.warn(
      "image-storage: images root is not creatable; listing will proceed " +
        "against the existing path if present:",
      IMAGES_ROOT,
      e.code,
    );
  }
}
