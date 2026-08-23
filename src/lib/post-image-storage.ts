import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where message-board images live on disk (epic #2992).
 *
 * MODELLED ON `backup-local.ts`, NOT ON `image-storage.ts`, and the difference
 * is the whole point. The Image Manager writes into `public/images`, which
 * Next.js serves verbatim — correct for CMS images that are public by
 * definition. Board images are member-generated content on a board that only
 * signed-in members of the club can read, so a URL guess must not be able to
 * reach one. They therefore live OUTSIDE the application directory, on a mount
 * the web server has no route into, and are served only by a route handler
 * that checks the session first.
 *
 * The mount mirrors the backup mount exactly: `POST_IMAGE_DIR` is the path
 * INSIDE the container (default `/images`), and `POST_IMAGE_HOST_DIR` is the
 * host side that compose binds to it. The app only ever sees the container
 * path — a host path is not meaningful from in here, which is the mistake the
 * backup documentation calls out and the same one applies.
 */

/** Container path the images mount lands on. Matches docker-compose. */
export const POST_IMAGE_DIR_DEFAULT = "/images";

const MAX_PATH_LENGTH = 4096;

/** System trees a data mount must never be pointed at. Mirrors backup-local. */
const DENIED_ROOTS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/proc",
  "/root",
  "/sbin",
  "/sys",
  "/usr",
];

export class PostImagePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostImagePathError";
  }
}

export class PostImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostImageRejectedError";
  }
}

/**
 * What a member may upload.
 *
 * An allowlist of three, checked against the file's own leading bytes rather
 * than the name or the browser-supplied type — both of which the client
 * chooses. SVG is deliberately absent: it is a document that can carry script,
 * and nothing about a lodge photo needs it.
 */
export const ALLOWED_POST_IMAGE_TYPES = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

/** 8 MB. Under the Caddy 10 MB body cap, with headroom for the rest of a post. */
export const MAX_POST_IMAGE_BYTES = 8 * 1024 * 1024;

/** Most a single post may carry. */
export const MAX_POST_IMAGES = 6;

/**
 * Identify an image by its magic bytes.
 *
 * Returns the canonical mime type, or null when the bytes are not one of the
 * three allowed formats. A caller must never fall back to the client's own
 * `file.type` when this returns null: that value is attacker-chosen, and
 * trusting it is how a `.jpg` that is really an HTML document gets stored and
 * later served.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return "image/png";
  // WebP: "RIFF" .... "WEBP"
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  if (
    riff.every((b, i) => bytes[i] === b) &&
    webp.every((b, i) => bytes[8 + i] === b)
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Validate and canonicalise the configured images directory.
 *
 * Same rules as `resolveLocalBackupDirectory`, for the same reasons: a NUL
 * truncates at the syscall boundary so what was checked is not what is opened;
 * `~` is shell expansion rather than a path; a surviving `..` means something
 * pathological; and the application directory is refused outright because
 * anything written under it can be served over the web.
 */
export function resolvePostImageDirectory(
  input: string,
  options: { applicationRoot?: string } = {},
): string {
  const raw = (input ?? "").trim();
  if (raw.length === 0) {
    throw new PostImagePathError("Enter the directory to store post images in.");
  }
  if (raw.length > MAX_PATH_LENGTH) {
    throw new PostImagePathError("That path is too long.");
  }
  if (raw.includes("\0")) {
    throw new PostImagePathError("That path contains an invalid character.");
  }
  if (raw.startsWith("~")) {
    throw new PostImagePathError(
      "Enter a full path starting with / — ~ is not expanded here.",
    );
  }
  if (!path.posix.isAbsolute(raw) && !path.isAbsolute(raw)) {
    throw new PostImagePathError(
      "Enter a full path starting with / (a relative path is not allowed).",
    );
  }

  // Normalised the way the DEPLOYMENT TARGET does, not the developer machine:
  // `path.resolve("/etc")` answers `D:\etc` on Windows and matches none of the
  // denied roots, so a native-only validator passes its tests and enforces
  // nothing on the Linux container that actually runs it.
  const looksPosix = raw.startsWith("/");
  const resolved = looksPosix ? path.posix.normalize(raw) : path.resolve(raw);

  if (raw.split(/[\\/]+/).includes("..")) {
    throw new PostImagePathError("That path may not contain '..'.");
  }
  if (resolved === "/" || /^[A-Za-z]:[\\/]?$/.test(resolved)) {
    throw new PostImagePathError("Choose a directory, not the filesystem root.");
  }

  if (looksPosix) {
    const trimmed = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
    for (const denied of DENIED_ROOTS) {
      if (trimmed === denied || trimmed.startsWith(`${denied}/`)) {
        throw new PostImagePathError(
          `${denied} is a system directory and cannot hold post images. Choose a data directory such as /images.`,
        );
      }
    }
  }

  const appRoot = path.resolve(options.applicationRoot ?? process.cwd());
  const nativeResolved = path.resolve(resolved);
  if (
    nativeResolved === appRoot ||
    nativeResolved.startsWith(appRoot + path.sep)
  ) {
    throw new PostImagePathError(
      "That path is inside the application directory, where images would be served without a session check. Choose a directory outside it.",
    );
  }

  return resolved;
}

/** The configured images root, from the environment, validated. */
export function postImageRoot(): string {
  const configured =
    process.env.POST_IMAGE_DIR?.trim() || POST_IMAGE_DIR_DEFAULT;
  return resolvePostImageDirectory(configured);
}

/**
 * Resolve a stored key to an absolute path, refusing anything that escapes.
 *
 * The key comes out of the database, but this check is not therefore
 * redundant: it is the one place that guarantees a malformed or tampered row
 * cannot read `/etc/passwd`, and it costs a string comparison.
 */
export function resolveStoredImage(storageKey: string): string | null {
  if (!storageKey || storageKey.includes("\0")) return null;
  const root = postImageRoot();
  const absolute = path.resolve(root, storageKey);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

export interface StoredPostImage {
  storageKey: string;
  /** Unguessable id the serving route takes, so keys never appear in a URL. */
  publicId: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

/**
 * Write one uploaded image into the mount.
 *
 * Stored under `posts/<year>/<month>/<random>.<ext>`, dated rather than flat so
 * a club with years of board history does not end up with one directory of
 * hundreds of thousands of entries.
 */
export async function writePostImage(
  data: Uint8Array,
): Promise<StoredPostImage> {
  if (data.byteLength === 0) {
    throw new PostImageRejectedError("That file is empty.");
  }
  if (data.byteLength > MAX_POST_IMAGE_BYTES) {
    throw new PostImageRejectedError(
      `Images must be ${Math.floor(MAX_POST_IMAGE_BYTES / (1024 * 1024))} MB or smaller.`,
    );
  }

  const mimeType = sniffImageType(data);
  if (!mimeType) {
    throw new PostImageRejectedError(
      "That file is not a JPEG, PNG or WebP image.",
    );
  }
  const ext = ALLOWED_POST_IMAGE_TYPES.get(mimeType)!;

  const now = new Date();
  const dir = path.posix.join(
    "posts",
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
  );
  const storageKey = path.posix.join(
    dir,
    `${randomBytes(16).toString("hex")}.${ext}`,
  );

  const absolute = resolveStoredImage(storageKey);
  if (!absolute) {
    throw new PostImageRejectedError("That image could not be stored.");
  }

  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, data);

  return {
    storageKey,
    publicId: randomBytes(16).toString("hex"),
    mimeType,
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

/** Read one stored image back. Returns null when the file is gone. */
export async function readPostImage(
  storageKey: string,
): Promise<Buffer | null> {
  const absolute = resolveStoredImage(storageKey);
  if (!absolute) return null;
  try {
    return await readFile(absolute);
  } catch {
    return null;
  }
}

/**
 * Delete one stored image.
 *
 * Never throws when the file is already gone: retention and moderation both
 * call this, and a cleanup pass that fails because a previous run had already
 * removed the file would stall on its own success.
 */
export async function deletePostImage(storageKey: string): Promise<void> {
  const absolute = resolveStoredImage(storageKey);
  if (!absolute) return;
  await rm(absolute, { force: true });
}

/**
 * Make sure the mount exists and this process can write to it.
 *
 * An actual write rather than an `access()` check, for the reason the backup
 * module gives: the container runs as uid 1001 and a bind-mounted host
 * directory owned by root passes a permission-bit check and still fails the
 * write.
 */
export async function ensurePostImageDirectory(): Promise<void> {
  const root = postImageRoot();
  await mkdir(root, { recursive: true });
  const probe = path.join(root, `.write-test-${process.pid}`);
  await writeFile(probe, "");
  await rm(probe, { force: true });
}
