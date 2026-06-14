import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  ALLOWED_IMAGE_MIME,
  IMAGES_ROOT,
  ImageStorageUnavailableError,
  ensureImageDir,
  imagePublicUrl,
  resolveInImagesRoot,
} from "@/lib/image-storage";

describe("image-storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  describe("ensureImageDir", () => {
    it("creates a directory when the volume is writable", async () => {
      const base = path.join(IMAGES_ROOT, "__ensure_test__");
      const target = path.join(base, "nested", "dir");
      try {
        await expect(ensureImageDir(target)).resolves.toBeUndefined();
        const stat = await fs.stat(target);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    });

    it("refuses to create a directory outside the images root", async () => {
      const mkdir = vi.spyOn(fs, "mkdir");
      await expect(
        ensureImageDir(path.join(os.tmpdir(), "escape")),
      ).rejects.toThrow(/outside the images root/);
      // The containment guard must short-circuit before any filesystem write.
      expect(mkdir).not.toHaveBeenCalled();
    });

    it("throws a clear error when the storage volume is read-only", async () => {
      const err = Object.assign(new Error("read-only file system"), {
        code: "EROFS",
      });
      vi.spyOn(fs, "mkdir").mockRejectedValueOnce(err);

      await expect(
        ensureImageDir(path.join(IMAGES_ROOT, "x")),
      ).rejects.toBeInstanceOf(ImageStorageUnavailableError);
    });

    it("surfaces the underlying error code on the thrown error", async () => {
      const err = Object.assign(new Error("permission denied"), {
        code: "EACCES",
      });
      vi.spyOn(fs, "mkdir").mockRejectedValueOnce(err);

      await expect(
        ensureImageDir(path.join(IMAGES_ROOT, "x")),
      ).rejects.toMatchObject({ code: "EACCES" });
    });
  });
});
