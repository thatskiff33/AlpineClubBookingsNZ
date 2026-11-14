import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

import * as directoriesRoute from "@/app/api/admin/image-manager/directories/route";
import * as imagesRoute from "@/app/api/admin/image-manager/images/route";
import { IMAGES_ROOT, IMAGE_DERIVATIVES_DIRECTORY } from "@/lib/image-storage";

// #4935 (INV-PUB-005): the Image Manager shows originals only, and every
// action on an original or a folder carries its website-sized copies. Real
// files under a unique folder of the real (gitignored) images root.

const folder = `vitest-manager-${process.pid}`;
const absDir = path.join(IMAGES_ROOT, folder);
const SIZES = IMAGE_DERIVATIVES_DIRECTORY;

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};

function request(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function exists(p: string) {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

async function seedAlbum(dir: string) {
  await fs.mkdir(path.join(dir, SIZES), { recursive: true });
  await fs.writeFile(path.join(dir, "lodge.jpg"), "original");
  await fs.writeFile(path.join(dir, SIZES, "lodge.jpg.400.webp"), "copy");
  await fs.writeFile(path.join(dir, SIZES, "lodge.jpg.800.webp"), "copy");
  await fs.writeFile(path.join(dir, SIZES, "other.jpg.400.webp"), "copy");
}

beforeEach(async () => {
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  await seedAlbum(path.join(absDir, "album"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(absDir, { recursive: true, force: true });
});

describe("Image Manager listings hide the copies", () => {
  it("lists folders without any copies folder", async () => {
    const res = await directoriesRoute.GET();
    const { directories } = (await res.json()) as { directories: string[] };
    expect(directories.filter((dir) => dir.startsWith(folder))).toEqual([
      folder,
      `${folder}/album`,
    ]);
  });

  it("lists an album's originals only", async () => {
    const res = await imagesRoute.GET(
      request("GET", `/api/admin/image-manager/images?dir=${folder}/album`),
    );
    const { images } = (await res.json()) as { images: { filename: string }[] };
    expect(images.map((image) => image.filename)).toEqual(["lodge.jpg"]);
  });

  it.each([`${folder}/album/${SIZES}`, `${folder}/album/.SIZES`, `${folder}\\album\\${SIZES}`])(
    "refuses to list %s as an album",
    async (dir) => {
      const res = await imagesRoute.GET(
        request("GET", `/api/admin/image-manager/images?dir=${encodeURIComponent(dir)}`),
      );
      expect(res.status).toBe(400);
    },
  );
});

describe("Image Manager actions carry the copies", () => {
  it("deleting an image deletes its copies, and only its copies", async () => {
    const res = await imagesRoute.DELETE(
      request("DELETE", "/api/admin/image-manager/images", {
        dir: `${folder}/album`,
        filename: "lodge.jpg",
      }),
    );
    expect(res.status).toBe(200);
    expect(await fs.readdir(path.join(absDir, "album"))).toEqual([SIZES]);
    expect(await fs.readdir(path.join(absDir, "album", SIZES))).toEqual([
      "other.jpg.400.webp",
    ]);
  });

  it("refuses to delete a copy directly", async () => {
    const res = await imagesRoute.DELETE(
      request("DELETE", "/api/admin/image-manager/images", {
        dir: `${folder}/album/${SIZES}`,
        filename: "lodge.jpg.400.webp",
      }),
    );
    expect(res.status).toBe(400);
    expect(await exists(path.join(absDir, "album", SIZES, "lodge.jpg.400.webp"))).toBe(true);
  });

  it("says so when the original went but its copies could not be removed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readdir = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));

    const res = await imagesRoute.DELETE(
      request("DELETE", "/api/admin/image-manager/images", {
        dir: `${folder}/album`,
        filename: "lodge.jpg",
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/copies could not be removed/);
    expect(readdir).toHaveBeenCalledWith(path.join(absDir, "album", SIZES), {
      withFileTypes: true,
    });
    expect(await exists(path.join(absDir, "album", "lodge.jpg"))).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  // #5087 review: after a partial failure the photo has left the listing, so
  // the only retry is the same DELETE. It must reach the copies again.
  it("a repeated delete of a photo already gone still removes its copies", async () => {
    await fs.rm(path.join(absDir, "album", "lodge.jpg"));
    const res = await imagesRoute.DELETE(
      request("DELETE", "/api/admin/image-manager/images", {
        dir: `${folder}/album`,
        filename: "lodge.jpg",
      }),
    );
    expect(res.status).toBe(200);
    expect(await fs.readdir(path.join(absDir, "album", SIZES))).toEqual([
      "other.jpg.400.webp",
    ]);
  });

  it("renaming a folder carries its copies", async () => {
    const res = await directoriesRoute.PATCH(
      request("PATCH", "/api/admin/image-manager/directories", {
        path: `${folder}/album`,
        newName: "winter",
      }),
    );
    expect(res.status).toBe(200);
    expect(
      (await fs.readdir(path.join(absDir, "winter", SIZES))).sort(),
    ).toEqual(["lodge.jpg.400.webp", "lodge.jpg.800.webp", "other.jpg.400.webp"]);
  });

  it("deleting a folder deletes its copies", async () => {
    const res = await directoriesRoute.DELETE(
      request("DELETE", "/api/admin/image-manager/directories", {
        path: `${folder}/album`,
      }),
    );
    expect(res.status).toBe(200);
    expect(await exists(path.join(absDir, "album"))).toBe(false);
  });

  it("refuses to create, rename into, rename or delete a copies folder", async () => {
    const attempts = [
      directoriesRoute.POST(
        request("POST", "/api/admin/image-manager/directories", {
          parent: folder,
          name: SIZES,
        }),
      ),
      directoriesRoute.POST(
        request("POST", "/api/admin/image-manager/directories", {
          parent: `${folder}/album/${SIZES}`,
          name: "inside",
        }),
      ),
      directoriesRoute.PATCH(
        request("PATCH", "/api/admin/image-manager/directories", {
          path: `${folder}/album`,
          newName: SIZES,
        }),
      ),
      directoriesRoute.PATCH(
        request("PATCH", "/api/admin/image-manager/directories", {
          path: `${folder}/album/${SIZES}`,
          newName: "renamed",
        }),
      ),
      directoriesRoute.DELETE(
        request("DELETE", "/api/admin/image-manager/directories", {
          path: `${folder}/album/${SIZES}`,
        }),
      ),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(400);
    }
    expect(await fs.readdir(absDir)).toEqual(["album"]);
    expect((await fs.readdir(path.join(absDir, "album", SIZES))).length).toBe(3);
  });
});
