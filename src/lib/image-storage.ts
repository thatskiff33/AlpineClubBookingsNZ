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
