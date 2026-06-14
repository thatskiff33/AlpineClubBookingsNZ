import fs from "fs/promises";
import path from "path";

// Where uploaded images are stored on disk.
//
// Defaults to `public/images` so local dev and `next start` serve uploads
// directly at `/images/...`. Containerised deploys run with a read-only root
// filesystem, so this directory MUST be backed by a persistent, writable volume
// that is shared across replicas (see docker-compose.yml: the `image_uploads`
// named volume mounted at /app/public/images, owned by uid 1001).
//
// IMAGE_STORAGE_DIR can relocate storage, but whatever path is chosen must back
// the `/images` URL prefix (the volume approach above is the supported default).
// An absolute IMAGE_STORAGE_DIR is used as-is; a relative value resolves against
// the working directory.
export const IMAGES_ROOT = (() => {
  const configured = process.env.IMAGE_STORAGE_DIR?.trim();
  if (configured) {
    return path.resolve(process.cwd(), configured);
  }
  return path.join(process.cwd(), "public", "images");
})();

// Public URL prefix that serves IMAGES_ROOT. Stored image URLs are always of the
// form `/images/<relative-path>` regardless of where IMAGES_ROOT lives on disk.
const PUBLIC_URL_PREFIX = "/images";

// SVG is intentionally excluded: it is an XML dialect that can embed inline
// <script> and event-handler attributes. Files under the images root are served
// directly by Next.js/Caddy with no restrictive CSP, so an uploaded SVG opened
// in-browser would execute in the site origin (stored XSS).
export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export const ALLOWED_IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
]);

// Resolve a client-supplied relative path safely inside IMAGES_ROOT.
// Returns null if the path would escape the images root (path traversal).
export function resolveInImagesRoot(rel: string): string | null {
  const normalized = path.normalize(rel);
  const resolved = path.resolve(IMAGES_ROOT, normalized);
  if (resolved !== IMAGES_ROOT && !resolved.startsWith(IMAGES_ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

// Map an absolute path under IMAGES_ROOT to its public `/images/...` URL.
export function imagePublicUrl(absPath: string): string {
  const rel = path.relative(IMAGES_ROOT, absPath).replace(/\\/g, "/");
  return rel ? `${PUBLIC_URL_PREFIX}/${rel}` : PUBLIC_URL_PREFIX;
}

// Raised when the images root cannot be created/written — typically a missing
// or non-writable volume under a read-only container filesystem.
export class ImageStorageUnavailableError extends Error {
  readonly code: string;
  constructor(cause: NodeJS.ErrnoException) {
    super(
      `Image storage directory is not writable (${cause.code ?? "unknown"}). ` +
        `Ensure a persistent, writable volume is mounted at ${IMAGES_ROOT} ` +
        `and owned by the app user (uid 1001).`,
    );
    this.name = "ImageStorageUnavailableError";
    this.code = cause.code ?? "UNKNOWN";
  }
}

// Ensure a directory exists, surfacing a clear error when the underlying volume
// is missing or read-only. Used before writes (upload, create-directory).
export async function ensureImageDir(absDir: string): Promise<void> {
  // Defence-in-depth: never create a directory outside the images root, even if
  // a caller passes an unvalidated path. Keeping the containment check in the
  // same function as the mkdir sink also lets static path-injection analysis see
  // the barrier.
  const resolved = path.resolve(absDir);
  if (resolved !== IMAGES_ROOT && !resolved.startsWith(IMAGES_ROOT + path.sep)) {
    throw new Error("Refusing to create a directory outside the images root");
  }
  try {
    await fs.mkdir(resolved, { recursive: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EEXIST on a recursive mkdir is not an error.
    if (e.code === "EEXIST") return;
    // The path is passed as a separate argument (not interpolated into the
    // format string) so a tainted value can never act as a format directive.
    console.error(
      "image-storage: failed to create directory:",
      resolved,
      e.code,
      e.message,
    );
    throw new ImageStorageUnavailableError(e);
  }
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
