import { describe, expect, it } from "vitest";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  ALLOWED_IMAGE_MIME,
  IMAGES_ROOT,
  imagePublicUrl,
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

  describe("imagePublicUrl", () => {
    it("maps a stored file to its /images URL", () => {
      const abs = path.join(IMAGES_ROOT, "brand", "logo.png");
      expect(imagePublicUrl(abs)).toBe("/images/brand/logo.png");
    });

    it("returns the prefix for the root itself", () => {
      expect(imagePublicUrl(IMAGES_ROOT)).toBe("/images");
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
