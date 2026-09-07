/**
 * Photo validation for maintenance reports (#2780).
 *
 * WHY THIS IS STRICTER THAN THE ISSUE-REPORT SCREENSHOT PARSER IT IS MODELLED
 * ON. `/api/issue-reports` accepts a data URL after matching
 * `^data:(image/...);base64,...$` and checking the decoded length. That is
 * adequate there because the only caller is our own `html2canvas` capture behind
 * a session — the declared MIME type is one we produced ourselves.
 *
 * A maintenance photo arrives from a real camera roll, and on the QR path from
 * an UNAUTHENTICATED stranger, so the declared type is attacker-controlled. This
 * module therefore never trusts it: the type is decided by SNIFFING the decoded
 * bytes, and a declaration that disagrees with the bytes is refused rather than
 * quietly corrected. The stored `photoContentType` is always the sniffed value,
 * so what the admin surface later renders is what the bytes actually are.
 *
 * What this does NOT claim: sniffing a magic number proves a container, not
 * safety. A valid JPEG can still carry a hostile payload for some downstream
 * decoder. The controls that matter for that are elsewhere and are unchanged —
 * the bytes are never executed, never passed to a shell, never written to disk
 * under a caller-supplied name, and are rendered only inside an `<img>` on an
 * authenticated admin page under the app's existing CSP.
 */

/** Sniffable image containers. SVG is deliberately absent — see below. */
export type MaintenancePhotoContentType = "image/jpeg" | "image/png" | "image/webp";

/**
 * Hard byte ceiling on the DECODED image, independent of any club setting.
 *
 * This is a security control rather than a preference, so it is a constant and
 * not a row an admin can raise: it bounds what one unauthenticated request can
 * make the server hold in memory and the database store. 4 MB comfortably fits
 * a phone photo of a broken heater; it is not a photo-library.
 */
export const MAX_MAINTENANCE_PHOTO_BYTES = 4_000_000;

/**
 * Ceiling on the ENCODED data URL, applied before any base64 decoding happens.
 *
 * Base64 inflates by 4/3, so this is the decoded ceiling plus that overhead plus
 * a small allowance for the `data:` prefix. Checking the string length first is
 * what stops a caller making us allocate a large Buffer only to reject it.
 */
export const MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH = Math.ceil(
  (MAX_MAINTENANCE_PHOTO_BYTES * 4) / 3,
) + 256;

/** Exactly one photo per report, on both paths. */
export const MAX_MAINTENANCE_PHOTOS_PER_REPORT = 1;

/**
 * A data URL of a supported image, with a strict base64 alphabet.
 *
 * The declared type is captured only so it can be COMPARED with the sniffed one;
 * it is never what gets stored.
 */
const PHOTO_DATA_URL_PATTERN =
  /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export class MaintenancePhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenancePhotoError";
  }
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Decide the container from the bytes themselves.
 *
 * SVG IS DELIBERATELY NOT SUPPORTED, and this is the reason rather than an
 * oversight: an SVG is a document, it can carry script, and a browser rendering
 * one from a `blob:`/`data:` origin is a well-worn XSS route. There is also no
 * magic number to sniff for it — anything claiming to be SVG would have to be
 * trusted on its declaration, which is exactly what this module exists not to
 * do. A photo of a broken thing is a raster image.
 */
export function sniffMaintenancePhotoContentType(
  bytes: Buffer,
): MaintenancePhotoContentType | null {
  // JPEG: SOI marker FF D8 followed by any marker start FF.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // PNG: the fixed 8-byte signature.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // WebP: "RIFF" <4-byte little-endian length> "WEBP". Both halves are checked,
  // because "RIFF" alone is also WAV, AVI and several other containers.
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export interface ParsedMaintenancePhoto {
  /** The data URL to store, rebuilt from the SNIFFED type rather than echoed. */
  dataUrl: string;
  contentType: MaintenancePhotoContentType;
  byteLength: number;
}

/**
 * Validate one submitted photo, or return null when none was sent.
 *
 * Throws `MaintenancePhotoError` with a message that is safe to show a
 * submitter: every branch says what to do about it and none of them reveals
 * anything about the server.
 */
export function parseMaintenancePhoto(
  photoDataUrl: string | null | undefined,
): ParsedMaintenancePhoto | null {
  if (!photoDataUrl) {
    return null;
  }

  // Length first, so an oversized payload never reaches Buffer.from.
  if (photoDataUrl.length > MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH) {
    throw new MaintenancePhotoError(
      "That photo is too large. Please send one under 4 MB.",
    );
  }

  const match = PHOTO_DATA_URL_PATTERN.exec(photoDataUrl);
  if (!match) {
    throw new MaintenancePhotoError(
      "That photo could not be read. Please attach a JPEG, PNG or WebP image.",
    );
  }

  const [, capturedType, capturedBase64] = match;
  // Both capture groups have no `?` quantifier, so a match always carries
  // them; this is the same "could not be read" outcome the function already
  // gives for a pattern that fails to match at all.
  if (capturedType === undefined || capturedBase64 === undefined) {
    throw new MaintenancePhotoError(
      "That photo could not be read. Please attach a JPEG, PNG or WebP image.",
    );
  }

  const declaredType = capturedType === "image/jpg" ? "image/jpeg" : capturedType;
  const bytes = Buffer.from(capturedBase64, "base64");

  if (bytes.length === 0) {
    throw new MaintenancePhotoError(
      "That photo could not be read. Please attach a JPEG, PNG or WebP image.",
    );
  }

  if (bytes.length > MAX_MAINTENANCE_PHOTO_BYTES) {
    throw new MaintenancePhotoError(
      "That photo is too large. Please send one under 4 MB.",
    );
  }

  const sniffedType = sniffMaintenancePhotoContentType(bytes);
  if (!sniffedType) {
    throw new MaintenancePhotoError(
      "That photo could not be read. Please attach a JPEG, PNG or WebP image.",
    );
  }

  // A declaration that disagrees with the bytes is refused outright rather than
  // silently corrected. Silently correcting would accept a file whose sender
  // believed it was something else, which is the shape a polyglot upload takes.
  if (sniffedType !== declaredType) {
    throw new MaintenancePhotoError(
      "That photo could not be read. Please attach a JPEG, PNG or WebP image.",
    );
  }

  return {
    // Rebuilt from the sniffed type and the re-encoded bytes: whatever padding
    // or casing the caller sent, what we store is canonical and matches the
    // content type beside it.
    dataUrl: `data:${sniffedType};base64,${bytes.toString("base64")}`,
    contentType: sniffedType,
    byteLength: bytes.length,
  };
}
