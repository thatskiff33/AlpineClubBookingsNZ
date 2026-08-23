import { describe, expect, it } from "vitest";

import {
  MAX_POST_IMAGE_BYTES,
  PostImagePathError,
  resolvePostImageDirectory,
  sniffImageType,
} from "@/lib/post-image-storage";

/**
 * Message-board image storage (epic #2992).
 *
 * Everything here is a refusal. The module's whole job is to decide what may be
 * written and where, so the tests that matter are the ones proving it says no —
 * a happy path that writes a JPEG proves almost nothing about a module whose
 * failure mode is serving `/etc/passwd` or storing an HTML document as a photo.
 */

const APP_ROOT = "/app";

describe("resolvePostImageDirectory", () => {
  it("accepts the container mount the compose stack provides", () => {
    expect(
      resolvePostImageDirectory("/images", { applicationRoot: APP_ROOT }),
    ).toBe("/images");
  });

  it("refuses a path inside the application directory", () => {
    // The reason this rule exists: anything under the app root is served by
    // Next.js without a session check, so a members-only image placed there is
    // one URL guess from being public.
    expect(() =>
      resolvePostImageDirectory("/app/public/images", {
        applicationRoot: APP_ROOT,
      }),
    ).toThrow(PostImagePathError);
  });

  it.each([
    ["/etc", "a system directory"],
    ["/etc/ssl/private", "a system subdirectory"],
    ["/usr/lib", "another system tree"],
  ])("refuses %s (%s)", (candidate) => {
    expect(() =>
      resolvePostImageDirectory(candidate, { applicationRoot: APP_ROOT }),
    ).toThrow(PostImagePathError);
  });

  it("refuses the filesystem root", () => {
    expect(() =>
      resolvePostImageDirectory("/", { applicationRoot: APP_ROOT }),
    ).toThrow(PostImagePathError);
  });

  it("refuses a relative path", () => {
    expect(() =>
      resolvePostImageDirectory("images", { applicationRoot: APP_ROOT }),
    ).toThrow(PostImagePathError);
  });

  it("refuses traversal rather than silently normalising it", () => {
    // `path.posix.normalize` would happily turn this into /etc/ssl and return
    // it. Refusing on the INPUT is what makes the attempt visible.
    expect(() =>
      resolvePostImageDirectory("/images/../etc/ssl", {
        applicationRoot: APP_ROOT,
      }),
    ).toThrow(/'\.\.'/);
  });

  it("refuses a NUL byte", () => {
    // A NUL truncates at the syscall boundary, so the path checked here would
    // not be the path opened.
    expect(() =>
      resolvePostImageDirectory("/images\0/etc", {
        applicationRoot: APP_ROOT,
      }),
    ).toThrow(PostImagePathError);
  });

  it("refuses a tilde rather than creating a directory called '~'", () => {
    expect(() =>
      resolvePostImageDirectory("~/images", { applicationRoot: APP_ROOT }),
    ).toThrow(/~ is not expanded/);
  });

  it("refuses an empty value with an operator-readable message", () => {
    expect(() => resolvePostImageDirectory("  ")).toThrow(
      /Enter the directory/,
    );
  });
});

describe("sniffImageType", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);

  it("identifies the three allowed formats from their leading bytes", () => {
    expect(sniffImageType(jpeg)).toBe("image/jpeg");
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(webp)).toBe("image/webp");
  });

  it("rejects an HTML document named like an image", () => {
    // The attack this exists to stop: the client chooses both the filename and
    // the declared mime type, so neither can be believed. Only the bytes can.
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)");
    expect(sniffImageType(html)).toBeNull();
  });

  it("rejects SVG, which is a scriptable document rather than a photo", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/');
    expect(sniffImageType(svg)).toBeNull();
  });

  it("rejects a RIFF container that is not WebP", () => {
    // RIFF also carries WAV and AVI; matching the outer container alone would
    // let either through.
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });

  it("rejects a file too short to identify", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe("upload bounds", () => {
  it("stays under the Caddy request-body cap with room for the post", () => {
    // Caddy refuses at 10 MB. An image cap at or above that would be refused by
    // the proxy before the route could explain why, which reads to a member as
    // the site being broken rather than the file being too big.
    expect(MAX_POST_IMAGE_BYTES).toBeLessThan(10 * 1024 * 1024);
  });
});
