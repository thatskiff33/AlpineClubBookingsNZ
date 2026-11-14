import { describe, expect, it } from "vitest";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  ALLOWED_IMAGE_MIME,
  IMAGES_ROOT,
  imageContentTypeForExt,
  imagePublicUrl,
  isCurrentDerivative,
  isSafeDirectoryName,
  isStorageUnavailableCode,
  resolveInImagesRoot,
  storageUnavailableMessage,
} from "@/lib/image-storage";

describe("image-storage", () => {
  describe("allowlists", () => {
    it("never permits SVG (stored XSS guard)", () => {
      // SVG can carry inline <script>; images served without a restrictive CSP
      // would execute in the site origin. This property moved here from the
      // route files, so assert it at the source of truth.
      expect(ALLOWED_IMAGE_EXTS.has(".svg")).toBe(false);
      expect(ALLOWED_IMAGE_MIME.has("image/svg+xml")).toBe(false);
    });

    it("permits the raster formats the Image Manager supports", () => {
      for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]) {
        expect(ALLOWED_IMAGE_EXTS.has(ext)).toBe(true);
      }
    });

    // #5087 review (INV-SSOT): an allowed extension with no served content
    // type would be stored but served as application/octet-stream.
    it("gives every allowed extension a content type, and allows exactly those MIME types", () => {
      for (const ext of ALLOWED_IMAGE_EXTS) {
        expect(imageContentTypeForExt(ext)).not.toBeNull();
      }
      expect([...ALLOWED_IMAGE_MIME].sort()).toEqual([
        "image/avif",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
      ]);
    });
  });

  describe("isCurrentDerivative", () => {
    it("treats a copy as current only when it is no older than its original", () => {
      expect(isCurrentDerivative({ mtimeMs: 2000 }, 1000)).toBe(true);
      expect(isCurrentDerivative({ mtimeMs: 1000 }, 1000)).toBe(true);
      expect(isCurrentDerivative({ mtimeMs: 999 }, 1000)).toBe(false);
    });
  });

  describe("resolveInImagesRoot", () => {
    it("resolves a valid nested path inside the root", () => {
      const resolved = resolveInImagesRoot("brand/logo.png");
      expect(resolved).toBe(path.join(IMAGES_ROOT, "brand", "logo.png"));
    });

    it("allows the empty path (the root itself)", () => {
      expect(resolveInImagesRoot("")).toBe(IMAGES_ROOT);
    });

    it("rejects path traversal that escapes the root", () => {
      expect(resolveInImagesRoot("../secrets")).toBeNull();
      expect(resolveInImagesRoot("../../etc/passwd")).toBeNull();
      expect(resolveInImagesRoot("foo/../../bar")).toBeNull();
    });
  });

  // #2841 (CodeQL js/path-injection, alerts 32/33/34 on the directories route).
  // The charset filter these endpoints shared banned separators but not dots, so
  // "." and ".." — the two names path.join expands as operators — reached the
  // path builder and left the downstream containment check as the only barrier.
  describe("isSafeDirectoryName", () => {
    it("accepts the ordinary names the Image Manager UI produces", () => {
      for (const name of [
        "brand",
        "Trip Photos 2026",
        "lodge-exterior",
        "winter_2026",
        // Dots are fine in a name — only a name made ENTIRELY of dots is
        // refused, so these stay legitimate.
        ".hidden",
        "v1.2",
        "photos.2026.winter",
      ]) {
        expect(isSafeDirectoryName(name), name).toBe(true);
      }
    });

    it("rejects the dot-only names that path.join expands", () => {
      // ".." resolves to the PARENT of the directory it is joined to, and "."
      // resolves to that directory itself. Neither is a name.
      expect(isSafeDirectoryName("..")).toBe(false);
      expect(isSafeDirectoryName(".")).toBe(false);
    });

    it("rejects longer dot runs too, though path.join does not expand them", () => {
      // Measured: path.join(root, "...") yields root/... , a literal segment —
      // so this is not a traversal defence. It is refused because it costs
      // nothing and because Windows strips trailing dots from a name, which
      // would create a directory that cannot then be found under that name.
      expect(isSafeDirectoryName("...")).toBe(false);
      expect(isSafeDirectoryName("....")).toBe(false);
    });

    it("rejects separators, reserved characters and control characters", () => {
      for (const name of [
        "a/b",
        "a\\b",
        "../escape",
        "a<b",
        'a"b',
        "a:b",
        "a|b",
        "a?b",
        "a*b",
        "a>b",
        "a\u0000b",
        "a\u001Fb",
      ]) {
        expect(isSafeDirectoryName(name), JSON.stringify(name)).toBe(false);
      }
    });

    it("rejects an empty name", () => {
      expect(isSafeDirectoryName("")).toBe(false);
    });
  });

  describe("imagePublicUrl", () => {
    it("maps a stored file to its /api/images/uploaded URL", () => {
      const abs = path.join(IMAGES_ROOT, "brand", "logo.png");
      expect(imagePublicUrl(abs)).toBe("/api/images/uploaded/brand/logo.png");
    });

    it("returns the prefix for the root itself", () => {
      expect(imagePublicUrl(IMAGES_ROOT)).toBe("/api/images/uploaded");
    });
  });

  describe("storage error helpers", () => {
    it("classifies volume-unavailable error codes", () => {
      for (const code of ["EACCES", "EROFS", "ENOENT"]) {
        expect(isStorageUnavailableCode(code)).toBe(true);
      }
      expect(isStorageUnavailableCode("EEXIST")).toBe(false);
      expect(isStorageUnavailableCode(undefined)).toBe(false);
    });

    it("builds an actionable message naming the storage path and code", () => {
      const msg = storageUnavailableMessage("EROFS");
      expect(msg).toContain("EROFS");
      expect(msg).toContain(IMAGES_ROOT);
      expect(msg).toContain("uid 1001");
    });

    it("falls back to 'unknown' when no code is given", () => {
      expect(storageUnavailableMessage(undefined)).toContain("unknown");
    });
  });
});
